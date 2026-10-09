import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuzzRelayClient } from "@/shared/api/relay-client";
import type { SignedNostrEvent, UnsignedNostrEvent } from "@/shared/lib/nostr-signer";

const signer = vi.hoisted(() => ({ sign: vi.fn() }));

vi.mock("@/shared/lib/nostr-signer", () => ({
  signNostrEvent: signer.sign,
}));

type SignRequest = {
  resolve: (event: SignedNostrEvent) => void;
  template: UnsignedNostrEvent;
};

const sockets: FakeWebSocket[] = [];
const signRequests: SignRequest[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;

  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: MessageEvent | Event) => void>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
  }

  receive(payload: unknown[]): void {
    this.emit("message", { data: JSON.stringify(payload) } as MessageEvent);
  }

  closeFromRelay(): void {
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }

  private emit(type: string, event: MessageEvent | Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function signedEvent(template: UnsignedNostrEvent, id: string): SignedNostrEvent {
  return {
    ...template,
    id,
    pubkey: "11".repeat(32),
    sig: "22".repeat(64),
  };
}

async function settleAsyncHandler(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function requestCount(socket: FakeWebSocket): number {
  return socket.sent.filter((payload) => JSON.parse(payload)[0] === "REQ").length;
}

function lastSent(socket: FakeWebSocket): unknown[] {
  return JSON.parse(socket.sent[socket.sent.length - 1] ?? "null") as unknown[];
}

async function connectClient(
  client: BuzzRelayClient,
  eventId = "d".repeat(64),
): Promise<FakeWebSocket> {
  const connection = client.connect();
  const socket = sockets[sockets.length - 1];
  if (!socket) throw new Error("missing test WebSocket");
  socket.open();
  socket.receive(["AUTH", "challenge"]);
  const request = signRequests[signRequests.length - 1];
  if (!request) throw new Error("missing AUTH signing request");
  request.resolve(signedEvent(request.template, eventId));
  await settleAsyncHandler();
  socket.receive(["OK", eventId, true, ""]);
  await connection;
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  signRequests.length = 0;
  signer.sign.mockReset();
  signer.sign.mockImplementation(
    (template: UnsignedNostrEvent) =>
      new Promise<SignedNostrEvent>((resolve) => {
        signRequests.push({ resolve, template });
      }),
  );
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BuzzRelayClient authentication reconnects", () => {
  it("does not send a delayed AUTH result on a replacement WebSocket", async () => {
    const client = new BuzzRelayClient("wss://relay.example");
    void client.connect().catch(() => undefined);
    const first = sockets[0];
    first.open();
    first.receive(["AUTH", "old-challenge"]);
    expect(signRequests).toHaveLength(1);

    first.closeFromRelay();
    await settleAsyncHandler();
    await vi.advanceTimersByTimeAsync(1_000);
    const replacement = sockets[1];
    replacement.open();
    replacement.receive(["AUTH", "new-challenge"]);
    expect(signRequests).toHaveLength(2);

    signRequests[0].resolve(signedEvent(signRequests[0].template, "a".repeat(64)));
    await settleAsyncHandler();
    expect(replacement.sent).toEqual([]);

    signRequests[1].resolve(signedEvent(signRequests[1].template, "b".repeat(64)));
    await settleAsyncHandler();
    expect(replacement.sent).toHaveLength(1);
    expect(JSON.parse(replacement.sent[0] ?? "null")).toMatchObject([
      "AUTH",
      { id: "b".repeat(64) },
    ]);
    client.disconnect();
  });

  it("keeps the initial connection pending while a transient close reconnects", async () => {
    const client = new BuzzRelayClient("wss://relay.example");
    let settled = false;
    const connection = client.connect().finally(() => {
      settled = true;
    });
    sockets[0].closeFromRelay();
    await settleAsyncHandler();

    expect(settled).toBe(false);
    expect(client.connectionState).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);
    const replacement = sockets[1];
    replacement.open();
    replacement.receive(["AUTH", "new-challenge"]);
    signRequests[0].resolve(signedEvent(signRequests[0].template, "c".repeat(64)));
    await settleAsyncHandler();
    replacement.receive(["OK", "c".repeat(64), true, ""]);

    await expect(connection).resolves.toBeUndefined();
    expect(client.connectionState).toBe("connected");
    client.disconnect();
  });
});

describe("BuzzRelayClient rate limits", () => {
  it("retries a rate-limited query after the Relay delay", async () => {
    const client = new BuzzRelayClient("wss://relay.example");
    const socket = await connectClient(client);
    const query = client.query({ kinds: [9], limit: 1 });
    let outcome: "resolved" | "rejected" | null = null;
    void query.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await settleAsyncHandler();

    const request = lastSent(socket);
    expect(request[0]).toBe("REQ");
    const subscriptionId = request[1];
    expect(typeof subscriptionId).toBe("string");
    socket.receive(["CLOSED", subscriptionId, "rate-limited: quota exceeded; retry in 1s"]);
    await settleAsyncHandler();

    expect(outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(requestCount(socket)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestCount(socket)).toBe(2);

    socket.receive(["EOSE", subscriptionId]);
    await expect(query).resolves.toEqual([]);
    client.disconnect();
  });

  it("retries a persistent subscription and still receives events", async () => {
    const client = new BuzzRelayClient("wss://relay.example");
    const socket = await connectClient(client);
    const onEvent = vi.fn();
    const unsubscribe = await client.subscribe({ kinds: [9], limit: 0 }, onEvent);
    const request = lastSent(socket);
    const subscriptionId = request[1];

    socket.receive(["CLOSED", subscriptionId, "rate-limited: retry in 500ms"]);
    await vi.advanceTimersByTimeAsync(499);
    expect(requestCount(socket)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestCount(socket)).toBe(2);

    const event = signedEvent(
      { kind: 9, content: "live", tags: [], created_at: 1 },
      "e".repeat(64),
    );
    socket.receive(["EVENT", subscriptionId, event]);
    expect(onEvent).toHaveBeenCalledWith(event);
    unsubscribe();
    client.disconnect();
  });

  it("reports persistent subscription readiness, retry, and terminal closure", async () => {
    const client = new BuzzRelayClient("wss://relay.example");
    const socket = await connectClient(client);
    const onEose = vi.fn();
    const onRetry = vi.fn();
    const onClosed = vi.fn();
    await client.subscribe({ kinds: [24200], limit: 0 }, vi.fn(), {
      onClosed,
      onEose,
      onRetry,
    });
    const subscriptionId = lastSent(socket)[1];

    socket.receive(["EOSE", subscriptionId]);
    expect(onEose).toHaveBeenCalledOnce();
    socket.receive(["CLOSED", subscriptionId, "rate-limited: retry in 500ms"]);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onClosed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    socket.receive(["CLOSED", subscriptionId, "error: unsupported filter"]);
    expect(onClosed).toHaveBeenCalledOnce();
    expect(onClosed.mock.calls[0]?.[0]).toEqual(expect.any(Error));
    client.disconnect();
  });

  it("cancels a pending retry when reconnecting a persistent subscription", async () => {
    const client = new BuzzRelayClient("wss://relay.example");
    const socket = await connectClient(client);
    await client.subscribe({ kinds: [9], limit: 0 }, vi.fn());
    const request = lastSent(socket);
    const subscriptionId = request[1];

    socket.receive(["CLOSED", subscriptionId, "rate-limited: retry in 5s"]);
    socket.closeFromRelay();
    await settleAsyncHandler();
    await vi.advanceTimersByTimeAsync(1_000);

    const replacement = sockets[sockets.length - 1];
    if (!replacement || replacement === socket) throw new Error("missing replacement WebSocket");
    replacement.open();
    replacement.receive(["AUTH", "replacement-challenge"]);
    const authRequest = signRequests[signRequests.length - 1];
    if (!authRequest) throw new Error("missing replacement AUTH request");
    authRequest.resolve(signedEvent(authRequest.template, "f".repeat(64)));
    await settleAsyncHandler();
    replacement.receive(["OK", "f".repeat(64), true, ""]);
    await settleAsyncHandler();

    expect(requestCount(replacement)).toBe(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(requestCount(replacement)).toBe(1);
    client.disconnect();
  });

  it("keeps non-rate-limit subscription closures terminal", async () => {
    const client = new BuzzRelayClient("wss://relay.example");
    const socket = await connectClient(client);
    const query = client.query({ kinds: [9], limit: 1 });
    await settleAsyncHandler();
    const request = lastSent(socket);

    socket.receive(["CLOSED", request[1], "error: invalid filter"]);

    await expect(query).rejects.toThrow("error: invalid filter");
    client.disconnect();
  });
});
