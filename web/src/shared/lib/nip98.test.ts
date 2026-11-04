import { generateSecretKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { activateLocalSigner, clearActiveSigner } from "@/shared/lib/nostr-signer";

type SignedHeader = { kind: number; content: string; tags: string[][] };

function decodeHeader(authorization: string): SignedHeader {
  expect(authorization.startsWith("Nostr ")).toBe(true);
  return JSON.parse(atob(authorization.slice("Nostr ".length))) as SignedHeader;
}

function tagValue(header: SignedHeader, name: string): string | undefined {
  return header.tags.find((tag) => tag[0] === name)?.[1];
}

describe("makeNip98AuthHeader", () => {
  afterEach(() => {
    clearActiveSigner();
  });

  it("signs each bodyless request with a fresh nonce", async () => {
    activateLocalSigner(generateSecretKey());
    const url = "https://buzz.example.com/git/owner/repo/info/refs?service=git-upload-pack";

    const first = decodeHeader(await makeNip98AuthHeader(url, "GET"));
    const second = decodeHeader(await makeNip98AuthHeader(url, "GET"));

    expect(first.kind).toBe(27235);
    expect(first.content).toBe("");
    expect(first.tags).toContainEqual(["u", url]);
    expect(first.tags).toContainEqual(["method", "GET"]);
    expect(tagValue(first, "nonce")).toBeTruthy();
    expect(tagValue(second, "nonce")).toBeTruthy();
    // A reused nonce means an identical signed event, which the relay replay guard rejects.
    expect(second.tags).not.toEqual(first.tags);
    expect(tagValue(first, "payload")).toBeUndefined();
  });

  it("keeps the payload digest when a body is signed", async () => {
    activateLocalSigner(generateSecretKey());
    const body = JSON.stringify({ pubkey: "a".repeat(64) });

    const header = decodeHeader(
      await makeNip98AuthHeader("https://buzz.example.com/api/invite", "POST", { body }),
    );

    expect(tagValue(header, "payload")).toMatch(/^[0-9a-f]{64}$/);
    expect(tagValue(header, "nonce")).toBeTruthy();
  });
});
