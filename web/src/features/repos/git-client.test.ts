import { beforeEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({
  names: [] as string[],
  constructorNames: [] as string[],
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
      fsState.constructorNames.push(this.constructor.name);
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

const nip98State = vi.hoisted(() => ({
  pubkey: "",
  calls: 0,
}));

const nip98Mock = vi.hoisted(() => ({ header: vi.fn() }));

vi.mock("@/shared/lib/nip98", () => ({
  makeNip98AuthHeader: nip98Mock.header,
}));

vi.mock("@/shared/config/runtime-config", () => ({
  relayHttpOrigin: () => "https://relay.example.com",
}));

import { t } from "@/shared/i18n";
import * as gitClient from "./git-client";

const relay = "wss://relay.example.com";
const owner = "b".repeat(64);
const repo = "beta";
const viewerA = "1".repeat(64);
const viewerB = "2".repeat(64);

function httpError(statusCode?: number): Error {
  return Object.assign(new Error("HttpError"), {
    code: "HttpError",
    data: statusCode === undefined ? {} : { statusCode },
  });
}

function lastDbName(): string | undefined {
  return fsState.names[fsState.names.length - 1];
}

function headerFor(pubkey: string): string {
  return `Nostr ${btoa(JSON.stringify({ pubkey }))}`;
}

beforeEach(() => {
  fsState.names.length = 0;
  fsState.constructorNames.length = 0;
  fsState.statRejects = true;
  gitMocks.fetch.mockReset();
  gitMocks.clone.mockReset();
  nip98State.pubkey = viewerA;
  nip98State.calls = 0;
  nip98Mock.header.mockReset();
  nip98Mock.header.mockImplementation(async () => {
    nip98State.calls += 1;
    return headerFor(nip98State.pubkey);
  });
});

describe("denied Git authorization", () => {
  it.each([[401], [403], [404], [undefined]])(
    "T1: an existing clone plus a denied HTTP fetch (%s) rejects instead of returning cached bytes",
    async (statusCode) => {
      fsState.statRejects = false;
      gitMocks.fetch.mockRejectedValue(httpError(statusCode));

      await expect(gitClient.ensureClone(relay, viewerA, owner, repo, "main")).rejects.toThrow(
        t("error.repoAccessDenied"),
      );
      expect(gitMocks.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("T1: a failed first clone rejects instead of returning an empty clone", async () => {
    fsState.statRejects = true;
    gitMocks.clone.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(gitClient.ensureClone(relay, viewerA, owner, repo, "main")).rejects.toThrow(
      t("error.repoAccessDenied"),
    );
  });
});

describe("viewer-scoped cache namespace", () => {
  it("T2: A and B get different v2 databases and neither can match the legacy name", () => {
    const nameA = gitClient.gitDbName(relay, viewerA, owner, repo);
    const nameB = gitClient.gitDbName(relay, viewerB, owner, repo);

    expect(nameA).not.toBe(nameB);
    expect(nameA.startsWith("buzz-git-v2-")).toBe(true);
    expect(nameB.startsWith("buzz-git-v2-")).toBe(true);

    const legacy = new RegExp(`^buzz-git-[0-9a-z]+-${owner}-${repo}$`);
    expect(nameA).not.toMatch(legacy);
    expect(nameB).not.toMatch(legacy);

    const segments = nameA.slice("buzz-git-v2-".length).split("-");
    expect(segments[1]).toBe(viewerA);
    expect(segments[2]).toBe(owner);
  });

  it("T3: a transport TypeError still serves the viewer's own offline cache", async () => {
    fsState.statRejects = false;
    gitMocks.fetch.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await gitClient.ensureClone(relay, viewerA, owner, repo, "main");

    expect(result.dir).toBe(`/${owner}/${repo}`);
    expect(lastDbName()).toMatch(new RegExp(`^buzz-git-v2-[0-9a-z]+-${viewerA}-${owner}-${repo}$`));
  });
});

describe("fetch failure classification", () => {
  it("T4: every HTTP failure, abort, and unknown error denies; only a transport TypeError is offline", () => {
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    const cases: Array<[unknown, "deny" | "offline"]> = [
      [httpError(401), "deny"],
      [httpError(403), "deny"],
      [httpError(404), "deny"],
      [httpError(), "deny"],
      [httpError(500), "deny"],
      [httpError(502), "deny"],
      [httpError(503), "deny"],
      [aborted, "deny"],
      [new Error("unknown"), "deny"],
      [new TypeError("Failed to fetch"), "offline"],
    ];

    for (const [error, expected] of cases) {
      expect(gitClient.classifyGitFetchFailure(error)).toBe(expected);
    }
  });
});

describe("viewer validation", () => {
  it("T5: an empty or non-hex viewer cannot form a shared namespace", async () => {
    const invalidViewers = ["", "not-a-pubkey", "1".repeat(63), "g".repeat(64)];

    for (const viewer of invalidViewers) {
      expect(() => gitClient.gitDbName(relay, viewer, owner, repo)).toThrow(
        t("error.repoAccessDenied"),
      );
      await expect(gitClient.ensureClone(relay, viewer, owner, repo, "main")).rejects.toThrow(
        t("error.repoAccessDenied"),
      );
    }
    expect(nip98State.calls).toBe(0);
  });
});

describe("signed authorization identity", () => {
  it("T6: malformed or foreign NIP-98 headers are denied before transport", async () => {
    fsState.statRejects = false;

    nip98Mock.header.mockResolvedValueOnce("Nostr not-json");
    await expect(gitClient.ensureClone(relay, viewerA, owner, repo, "main")).rejects.toThrow(
      t("error.repoAccessDenied"),
    );

    nip98Mock.header.mockResolvedValueOnce(headerFor(viewerB));
    await expect(gitClient.ensureClone(relay, viewerA, owner, repo, "main")).rejects.toThrow(
      t("error.repoAccessDenied"),
    );

    expect(gitMocks.fetch).not.toHaveBeenCalled();
    expect(gitMocks.clone).not.toHaveBeenCalled();
  });
});
