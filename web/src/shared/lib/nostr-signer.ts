import { decode } from "nostr-tools/nip19";
import {
  getConversationKey,
  decrypt as nip44Decrypt,
  encrypt as nip44Encrypt,
} from "nostr-tools/nip44";
import { decrypt as nip49Decrypt, encrypt as nip49Encrypt } from "nostr-tools/nip49";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { t } from "@/shared/i18n";

export type UnsignedNostrEvent = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

export type SignedNostrEvent = UnsignedNostrEvent & {
  id: string;
  pubkey: string;
  sig: string;
};

type Nip07Provider = {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
};

declare global {
  interface Window {
    nostr?: Nip07Provider;
  }
}

export class Nip07UnavailableError extends Error {
  constructor() {
    super(t("error.nip07Missing"));
    this.name = "Nip07UnavailableError";
  }
}

let activeMode: "nip07" | "local" | null = null;
let activeSecretKey: Uint8Array | null = null;
let activePubkey: string | null = null;
let ephemeralSecretKey: Uint8Array | null = null;

function getEphemeralSecretKey(): Uint8Array {
  ephemeralSecretKey ??= generateSecretKey();
  return ephemeralSecretKey;
}

export function hasNip07Provider(): boolean {
  return typeof window !== "undefined" && window.nostr != null;
}

async function waitForNip07Provider(timeoutMs = 2_500): Promise<Nip07Provider> {
  if (typeof window === "undefined") throw new Nip07UnavailableError();
  if (window.nostr) return window.nostr;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (window.nostr) {
        resolve(window.nostr);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Nip07UnavailableError());
        return;
      }
      window.setTimeout(check, 100);
    };
    window.setTimeout(check, 50);
  });
}

export async function activateNip07Signer(): Promise<string> {
  const provider = await waitForNip07Provider();
  const pubkey = (await provider.getPublicKey()).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new Error(t("error.nip07InvalidPubkey"));
  }
  clearActiveSigner();
  activeMode = "nip07";
  activePubkey = pubkey;
  return pubkey;
}

export function activateLocalSigner(secretKey: Uint8Array): string {
  if (secretKey.byteLength !== 32) throw new Error(t("error.secretLength"));
  clearActiveSigner();
  activeSecretKey = new Uint8Array(secretKey);
  activePubkey = getPublicKey(activeSecretKey).toLowerCase();
  activeMode = "local";
  return activePubkey;
}

export function clearActiveSigner(): void {
  activeSecretKey?.fill(0);
  activeSecretKey = null;
  activePubkey = null;
  activeMode = null;
}

export function getActiveSignerPubkey(): string | null {
  return activePubkey;
}

export function getActiveSignerMode(): "nip07" | "local" | null {
  return activeMode;
}

export function canEncryptToSelf(): boolean {
  if (activeMode === "local") return activeSecretKey !== null && activePubkey !== null;
  return activeMode === "nip07" && window.nostr?.nip44 != null && activePubkey !== null;
}

/** Whether the active signer can decrypt agent-to-owner NIP-44 frames. */
export function canDecryptNip44FromPeer(): boolean {
  if (!activePubkey) return false;
  if (activeMode === "local") return activeSecretKey !== null;
  return activeMode === "nip07" && window.nostr?.nip44 != null;
}

export async function encryptNip44ToSelf(plaintext: string): Promise<string> {
  if (!activePubkey) throw new Error(t("error.signerLocked"));
  if (activeMode === "nip07") {
    if (!window.nostr?.nip44) throw new Error(t("error.nip44Unavailable"));
    return window.nostr.nip44.encrypt(activePubkey, plaintext);
  }
  if (activeMode === "local" && activeSecretKey) {
    const conversationKey = getConversationKey(activeSecretKey, activePubkey);
    try {
      return nip44Encrypt(plaintext, conversationKey);
    } finally {
      conversationKey.fill(0);
    }
  }
  throw new Error(t("error.signerLocked"));
}

export async function decryptNip44FromSelf(ciphertext: string): Promise<string> {
  if (!activePubkey) throw new Error(t("error.signerLocked"));
  if (activeMode === "nip07") {
    if (!window.nostr?.nip44) throw new Error(t("error.nip44Unavailable"));
    return window.nostr.nip44.decrypt(activePubkey, ciphertext);
  }
  if (activeMode === "local" && activeSecretKey) {
    const conversationKey = getConversationKey(activeSecretKey, activePubkey);
    try {
      return nip44Decrypt(ciphertext, conversationKey);
    } finally {
      conversationKey.fill(0);
    }
  }
  throw new Error(t("error.signerLocked"));
}

/** Decrypt NIP-44 content sent by a peer to the active owner identity. */
export async function decryptNip44FromPeer(
  peerPubkey: string,
  ciphertext: string,
): Promise<string> {
  if (!activePubkey) throw new Error(t("error.signerLocked"));
  const normalizedPeer = peerPubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedPeer)) throw new Error(t("error.pubkeyInvalid"));
  if (activeMode === "nip07") {
    if (!window.nostr?.nip44) throw new Error(t("error.nip44Unavailable"));
    return window.nostr.nip44.decrypt(normalizedPeer, ciphertext);
  }
  if (activeMode === "local" && activeSecretKey) {
    const conversationKey = getConversationKey(activeSecretKey, normalizedPeer);
    try {
      return nip44Decrypt(ciphertext, conversationKey);
    } finally {
      conversationKey.fill(0);
    }
  }
  throw new Error(t("error.signerLocked"));
}

export function generateIdentitySecretKey(): Uint8Array {
  return generateSecretKey();
}

export function publicKeyFromSecret(secretKey: Uint8Array): string {
  if (secretKey.byteLength !== 32) throw new Error(t("error.secretLength"));
  return getPublicKey(secretKey).toLowerCase();
}

export function createActiveIdentityBackup(password: string): string {
  if (activeMode !== "local" || !activeSecretKey) {
    throw new Error(t("error.backupLocalOnly"));
  }
  return createIdentityBackup(activeSecretKey, password);
}

export function createIdentityBackup(secretKey: Uint8Array, password: string): string {
  if (secretKey.byteLength !== 32) throw new Error(t("error.secretLength"));
  const backup = String(nip49Encrypt(secretKey, password));
  const verified = nip49Decrypt(backup, password);
  try {
    if (verified.byteLength !== secretKey.byteLength) throw new Error(t("error.backupVerify"));
    for (let index = 0; index < secretKey.byteLength; index += 1) {
      if (verified[index] !== secretKey[index]) throw new Error(t("error.backupVerify"));
    }
  } finally {
    verified.fill(0);
  }
  return backup;
}

export function restoreIdentityBackup(value: string, password: string): Uint8Array {
  try {
    const secretKey = nip49Decrypt(value.trim(), password);
    if (secretKey.byteLength !== 32) throw new Error(t("error.secretLength"));
    return secretKey;
  } catch {
    throw new Error(t("error.backupInvalid"));
  }
}

export function parseSecretKey(input: string): Uint8Array {
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  }
  if (value.startsWith("nsec1")) {
    try {
      const decoded = decode(value);
      if (decoded.type === "nsec" && decoded.data instanceof Uint8Array) {
        return new Uint8Array(decoded.data);
      }
    } catch {
      throw new Error(t("error.secretInvalid"));
    }
  }
  throw new Error(t("error.secretInvalid"));
}

function sameUnsignedEvent(expected: UnsignedNostrEvent, actual: SignedNostrEvent): boolean {
  return (
    actual.kind === expected.kind &&
    actual.created_at === expected.created_at &&
    actual.content === expected.content &&
    JSON.stringify(actual.tags) === JSON.stringify(expected.tags)
  );
}

async function signWithNip07(unsigned: UnsignedNostrEvent): Promise<SignedNostrEvent> {
  const provider = await waitForNip07Provider();
  const expectedPubkey = (activePubkey ?? (await provider.getPublicKey())).toLowerCase();
  const signed = await provider.signEvent(unsigned);
  if (
    signed.pubkey.toLowerCase() !== expectedPubkey ||
    !sameUnsignedEvent(unsigned, signed) ||
    !verifyEvent(signed)
  ) {
    throw new Error(t("error.nip07InvalidEvent"));
  }
  return signed;
}

export async function signNostrEvent(
  template: Omit<UnsignedNostrEvent, "created_at"> & { created_at?: number },
  options?: { requireNip07?: boolean; requireActive?: boolean },
): Promise<SignedNostrEvent> {
  const unsigned: UnsignedNostrEvent = {
    ...template,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
  };

  if (options?.requireNip07 || activeMode === "nip07") return signWithNip07(unsigned);
  if (activeMode === "local" && activeSecretKey) return finalizeEvent(unsigned, activeSecretKey);
  if (options?.requireActive) throw new Error(t("error.signerLocked"));
  if (hasNip07Provider()) return signWithNip07(unsigned);
  return finalizeEvent(unsigned, getEphemeralSecretKey());
}
