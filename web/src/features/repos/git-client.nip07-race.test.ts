import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/shared/i18n";
import type { SignedNostrEvent, UnsignedNostrEvent } from "@/shared/lib/nostr-signer";

const fsState = vi.hoisted(() => ({
  names: [] as string[],
  statRejects: true,
}));

const gitMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  clone: vi.fn(),
}));

vi.mock("@isomorphic-git/lightning-fs", () => {
  class RecordingLightningFS {
    promises = {
      stat: async () => {
        if (fsState.statRejects) throw new Error("ENOENT");
        return {};
      },
    };

    constructor(name: string) {
      fsState.names.push(name);
    }
  }

  return { default: RecordingLightningFS };
});

vi.mock("isomorphic-git", () => ({
  fetch: gitMocks.fetch,
  clone: gitMocks.clone,
  log: vi.fn(),
  readBlob: vi.fn(),
  readTree: vi.fn(),
  resolveRef: vi.fn(),
}));

vi.mock("isomorphic-git/http/web", () => ({ default: {} }));

vi.mock("@/shared/config/runtime-config", () => ({
  relayHttpOrigin: () => "https://relay.example.com",
}));

import {
  activateLocalSigner,
  activateNip07Signer,
  clearActiveSigner,
} from "@/shared/lib/nostr-signer";
import { ensureClone } from "./git-client";

const relay = "wss://relay.example.com";
const owner = "b".repeat(64);
const repo = "beta";
const secretA = generateSecretKey();
const secretB = generateSecretKey();
const viewerA = getPublicKey(secretA);
const viewerB = getPublicKey(secretB);
const signedBy: string[] = [];

type FakeProvider = {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent>;
};

function makeProvider(secretKey: Uint8Array, options: { failSign?: boolean } = {}): FakeProvider {
  const pubkey = getPublicKey(secretKey);
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (event) => {
      if (options.failSign) throw new Error("provider signing failed");
      signedBy.push(pubkey);
      return finalizeEvent(event, secretKey);
    },
  };
}

function installWindow(): Window {
  const fake = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
  } as unknown as Window;
  vi.stubGlobal("window", fake);
  return fake;
}

function expectNoTransport(): void {
  expect(gitMocks.fetch).not.toHaveBeenCalled();
  expect(gitMocks.clone).not.toHaveBeenCalled();
}

beforeEach(() => {
  fsState.names.length = 0;
  fsState.statRejects = true;
  gitMocks.fetch.mockReset();
  gitMocks.clone.mockReset();
  signedBy.length = 0;
  clearActiveSigner();
});

afterEach(() => {
  clearActiveSigner();
  vi.unstubAllGlobals();
});

describe("NIP-98 identity binding to the captured cache viewer", () => {
  it("C1: an identity switch during NIP-07 provider polling is denied before any Git transport", async () => {
    const win = installWindow();
    win.nostr = makeProvider(secretA);
    await activateNip07Signer();
    win.nostr = undefined;
    fsState.statRejects = false;

    // Provider is absent, so signing yields to waitForNip07Provider polling.
    const pending = ensureClone(relay, viewerA, owner, repo, "main");

    // The user signs out and activates B while that poll is still pending.
    clearActiveSigner();
    win.nostr = makeProvider(secretB);
    await activateNip07Signer();

    await expect(pending).rejects.toThrow(t("error.repoAccessDenied"));
    expectNoTransport();
    expect(signedBy).toEqual([viewerB]);
    expect(fsState.names[0]).toContain(`-${viewerA}-`);
  });

  it("control: the captured viewer's own local signer still clones", async () => {
    activateLocalSigner(secretA);
    gitMocks.clone.mockResolvedValue(undefined);

    const result = await ensureClone(relay, viewerA, owner, repo, "main");

    expect(result.dir).toBe(`/${owner}/${repo}`);
    expect(gitMocks.clone).toHaveBeenCalledTimes(1);
    expect(fsState.names[0]).toContain(`-${viewerA}-`);
  });

  it("control: a local signer for another identity is denied before transport", async () => {
    activateLocalSigner(secretB);
    fsState.statRejects = false;

    await expect(ensureClone(relay, viewerA, owner, repo, "main")).rejects.toThrow(
      t("error.repoAccessDenied"),
    );
    expectNoTransport();
  });

  it("control: a signing failure is denied before transport", async () => {
    const win = installWindow();
    win.nostr = makeProvider(secretA, { failSign: true });
    await activateNip07Signer();
    fsState.statRejects = true;

    await expect(ensureClone(relay, viewerA, owner, repo, "main")).rejects.toThrow(
      t("error.repoAccessDenied"),
    );
    expectNoTransport();
  });
});
