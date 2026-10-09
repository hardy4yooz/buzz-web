import { nsecEncode } from "nostr-tools/nip19";
import { getConversationKey, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateLocalSigner,
  activateNip07Signer,
  canDecryptNip44FromPeer,
  clearActiveSigner,
  createIdentityBackup,
  decryptNip44FromPeer,
  parseSecretKey,
  restoreIdentityBackup,
  signNostrEvent,
} from "@/shared/lib/nostr-signer";

afterEach(() => clearActiveSigner());

describe("browser Nostr signer", () => {
  it("imports nsec and signs a verifiable event", async () => {
    const secret = generateSecretKey();
    const decoded = parseSecretKey(nsecEncode(secret));
    const pubkey = activateLocalSigner(decoded);
    const signed = await signNostrEvent(
      { kind: 9, content: "hello", tags: [["h", "channel"]] },
      { requireActive: true },
    );

    expect(signed.pubkey).toBe(pubkey);
    expect(verifyEvent(signed)).toBe(true);
  });

  it("rejects malformed private keys", () => {
    expect(() => parseSecretKey("not-a-secret")).toThrow(/nsec/);
    expect(() => parseSecretKey("nsec1malformed")).toThrow(/nsec/);
  });

  it("creates a NIP-49 backup and restores only with the correct passphrase", () => {
    const secret = generateSecretKey();
    const backup = createIdentityBackup(secret, "correct horse battery staple");
    const restored = restoreIdentityBackup(backup, "correct horse battery staple");
    try {
      expect(backup).toMatch(/^ncryptsec1/);
      expect(restored).toEqual(secret);
      expect(() => restoreIdentityBackup(backup, "wrong passphrase")).toThrow();
    } finally {
      secret.fill(0);
      restored.fill(0);
    }
  }, 30_000);

  it("decrypts agent-to-owner NIP-44 content with an imported local signer", async () => {
    const ownerSecret = generateSecretKey();
    const agentSecret = generateSecretKey();
    const ownerPubkey = activateLocalSigner(ownerSecret);
    const agentPubkey = getPublicKey(agentSecret);
    const conversationKey = getConversationKey(agentSecret, ownerPubkey);
    const ciphertext = nip44Encrypt(JSON.stringify({ kind: "working" }), conversationKey);
    conversationKey.fill(0);
    try {
      expect(canDecryptNip44FromPeer()).toBe(true);
      await expect(decryptNip44FromPeer(agentPubkey, ciphertext)).resolves.toBe(
        JSON.stringify({ kind: "working" }),
      );
    } finally {
      ownerSecret.fill(0);
      agentSecret.fill(0);
    }
  });

  it("routes peer decryption through NIP-07 when the extension provides NIP-44", async () => {
    const decrypt = vi.fn().mockResolvedValue("decrypted");
    vi.stubGlobal("window", {
      nostr: {
        getPublicKey: vi.fn().mockResolvedValue("11".repeat(32)),
        signEvent: vi.fn(),
        nip44: { decrypt, encrypt: vi.fn() },
      },
    });
    await activateNip07Signer();
    await expect(decryptNip44FromPeer("22".repeat(32), "ciphertext")).resolves.toBe("decrypted");
    expect(decrypt).toHaveBeenCalledWith("22".repeat(32), "ciphertext");
    vi.unstubAllGlobals();
  });
});
