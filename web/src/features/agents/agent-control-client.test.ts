import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";
import { startRelayAgent } from "@/features/agents/agent-control-client";
import { activateLocalSigner, clearActiveSigner } from "@/shared/lib/nostr-signer";

describe("startRelayAgent", () => {
  it("sends an owner-signed NIP-98 request for the exact agent", async () => {
    const secretKey = generateSecretKey();
    const ownerPubkey = getPublicKey(secretKey);
    const agentPubkey = "a".repeat(64);
    activateLocalSigner(secretKey);
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ status: "accepted" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await startRelayAgent("https://buzz.example.com/app/api/agent-control/", agentPubkey);
      const call = fetchMock.mock.calls[0];
      expect(call).toBeDefined();
      if (!call) throw new Error("fetch was not called");
      const [url, request] = call;
      expect(url).toBe("https://buzz.example.com/app/api/agent-control/start");
      expect(request?.body).toBe(JSON.stringify({ pubkey: agentPubkey }));
      const authorization = new Headers(request?.headers).get("Authorization") ?? "";
      const signed = JSON.parse(atob(authorization.slice("Nostr ".length))) as {
        pubkey: string;
        kind: number;
        tags: string[][];
      };
      expect(signed.pubkey).toBe(ownerPubkey);
      expect(signed.kind).toBe(27235);
      expect(signed.tags).toContainEqual([
        "u",
        "https://buzz.example.com/app/api/agent-control/start",
      ]);
      expect(signed.tags).toContainEqual(["method", "POST"]);
      expect(signed.tags.find((tag) => tag[0] === "payload")?.[1]).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      clearActiveSigner();
      vi.unstubAllGlobals();
    }
  });

  it("waits out the server's worst-case start sequence", async () => {
    activateLocalSigner(generateSecretKey());
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ status: "accepted" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await startRelayAgent("https://buzz.example.com/app/api/agent-control", "b".repeat(64));
      const request = fetchMock.mock.calls[0]?.[1];
      // Server worst case is 5s is-active + 15s start + 5s is-active before it responds.
      expect(timeoutSpy).toHaveBeenCalledWith(35_000);
      expect(request?.signal).toBe(timeoutSpy.mock.results[0]?.value);
    } finally {
      timeoutSpy.mockRestore();
      clearActiveSigner();
      vi.unstubAllGlobals();
    }
  });
});
