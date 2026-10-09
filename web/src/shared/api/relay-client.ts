import { makeAuthEvent } from "nostr-tools/nip42";
import type {
  EventTemplate,
  NostrEvent,
  NostrFilter,
  RelayConnectionState,
  RelayPublishResult,
} from "@/shared/api/nostr-types";
import { relayHttpOrigin } from "@/shared/config/runtime-config";
import { t } from "@/shared/i18n";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { signNostrEvent } from "@/shared/lib/nostr-signer";

type Subscription = {
  filter: NostrFilter;
  onEvent: (event: NostrEvent) => void;
  onClosed?: (error: Error) => void;
  onEose?: () => void;
  onRetry?: () => void;
  persistent: boolean;
  events?: NostrEvent[];
  resolve?: (events: NostrEvent[]) => void;
  reject?: (error: Error) => void;
  timeout?: number;
  retryTimer?: number;
};

type PendingPublish = {
  event: NostrEvent;
  resolve: (result: RelayPublishResult) => void;
  reject: (error: Error) => void;
  timeout: number;
};

const OPERATION_TIMEOUT_MS = 25_000;
const RECONNECT_MAX_MS = 30_000;
const RATE_LIMIT_RETRY_DEFAULT_MS = 1_000;
const RATE_LIMIT_RETRY_MIN_MS = 250;
const RATE_LIMIT_RETRY_MAX_MS = 30_000;

function rateLimitRetryDelay(message: string): number | null {
  if (!/^\s*rate-limited\s*:/i.test(message)) return null;
  const retry = message.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|m)\b/i);
  if (!retry) return RATE_LIMIT_RETRY_DEFAULT_MS;
  const value = Number.parseFloat(retry[1] ?? "");
  const unit = retry[2]?.toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return Math.min(
    Math.max(Math.ceil(value * multiplier), RATE_LIMIT_RETRY_MIN_MS),
    RATE_LIMIT_RETRY_MAX_MS,
  );
}

export class BuzzRelayClient {
  readonly relayUrl: string;
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private authEventId: string | null = null;
  private authTimeout: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1_000;
  private manuallyClosed = false;
  private terminal = false;
  private state: RelayConnectionState = "idle";
  private stateListeners = new Set<(state: RelayConnectionState) => void>();
  private subscriptions = new Map<string, Subscription>();
  private pendingPublishes = new Map<string, PendingPublish>();

  constructor(relayUrl: string) {
    this.relayUrl = relayUrl;
  }

  get connectionState(): RelayConnectionState {
    return this.state;
  }

  onStateChange(listener: (state: RelayConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: RelayConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  async connect(): Promise<void> {
    if (this.terminal) throw new Error(t("error.relayIdentityRejected"));
    if (this.state === "connected" && this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.manuallyClosed = false;
    this.setState(this.state === "idle" ? "connecting" : "reconnecting");

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      this.authTimeout = window.setTimeout(() => {
        this.failConnection(new Error(t("error.relayAuthTimeout")));
      }, OPERATION_TIMEOUT_MS);
      this.openSocket();
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.terminal = false;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearAuthTimeout();
    const error = new Error(t("error.relaySessionClosed"));
    this.rejectConnect?.(error);
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.authEventId = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "sign out");
    this.setState("idle");
    for (const [id, subscription] of this.subscriptions) {
      this.clearSubscriptionRetry(subscription);
      if (!subscription.persistent) {
        subscription.reject?.(error);
        this.clearSubscription(id, subscription);
      }
    }
    for (const pending of this.pendingPublishes.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingPublishes.clear();
  }

  private openSocket(): void {
    if (this.manuallyClosed || this.terminal) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.relayUrl);
    } catch {
      this.failConnection(new Error(t("error.relayConnect")));
      return;
    }
    this.socket = socket;
    socket.addEventListener("message", (message) => {
      void this.handleMessage(socket, message.data);
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket || this.state === "connected") return;
      socket.close();
      this.handleClose(socket);
    });
    socket.addEventListener("close", () => this.handleClose(socket));
  }

  async query(filter: NostrFilter): Promise<NostrEvent[]> {
    await this.connect();
    const id = `query-${crypto.randomUUID()}`;
    return new Promise<NostrEvent[]>((resolve, reject) => {
      const subscription: Subscription = {
        filter,
        persistent: false,
        events: [],
        onEvent: () => undefined,
        resolve,
        reject,
      };
      subscription.timeout = window.setTimeout(() => {
        this.clearSubscription(id, subscription);
        reject(new Error(t("error.relayQueryTimeout")));
      }, OPERATION_TIMEOUT_MS);
      this.subscriptions.set(id, subscription);
      this.send(["REQ", id, filter]);
    });
  }

  async queryHttp(filters: NostrFilter[]): Promise<NostrEvent[]> {
    const url = `${relayHttpOrigin(this.relayUrl)}/query`;
    const body = JSON.stringify(filters);
    const authorization = await makeNip98AuthHeader(url, "POST", { body });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(
        `${t("error.relayQueryHttp", { status: response.status })}${detail ? `: ${detail}` : ""}`,
      );
    }
    return (await response.json()) as NostrEvent[];
  }

  async subscribe(
    filter: NostrFilter,
    onEvent: (event: NostrEvent) => void,
    lifecycle: {
      onClosed?: (error: Error) => void;
      onEose?: () => void;
      onRetry?: () => void;
    } = {},
  ): Promise<() => void> {
    await this.connect();
    const id = `live-${crypto.randomUUID()}`;
    this.subscriptions.set(id, { filter, onEvent, persistent: true, ...lifecycle });
    this.send(["REQ", id, filter]);
    return () => {
      const subscription = this.subscriptions.get(id);
      if (subscription) this.clearSubscription(id, subscription);
    };
  }

  async publish(template: EventTemplate): Promise<RelayPublishResult> {
    const event = await signNostrEvent(template, { requireActive: true });
    return this.publishSigned(event);
  }

  async publishSigned(event: NostrEvent): Promise<RelayPublishResult> {
    await this.connect();
    return new Promise<RelayPublishResult>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingPublishes.delete(event.id);
        reject(new Error(t("error.relayPublishTimeout")));
      }, OPERATION_TIMEOUT_MS);
      this.pendingPublishes.set(event.id, { event, resolve, reject, timeout });
      this.send(["EVENT", event]);
    });
  }

  private send(payload: unknown[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(t("error.relaySocketUnavailable"));
    }
    this.socket.send(JSON.stringify(payload));
  }

  private async handleMessage(socket: WebSocket, raw: unknown): Promise<void> {
    const text = typeof raw === "string" ? raw : raw instanceof Blob ? await raw.text() : "";
    if (!text || this.socket !== socket) return;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(data) || typeof data[0] !== "string") return;
    const type = data[0];
    if (type === "AUTH" && typeof data[1] === "string") {
      try {
        const event = await signNostrEvent(makeAuthEvent(this.relayUrl, data[1]), {
          requireActive: true,
        });
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
        this.authEventId = event.id;
        socket.send(JSON.stringify(["AUTH", event]));
      } catch (authError) {
        if (this.socket !== socket) return;
        this.failConnection(
          authError instanceof Error ? authError : new Error(t("error.relayAuthFailed")),
          socket,
        );
      }
      return;
    }
    if (type === "OK" && typeof data[1] === "string" && typeof data[2] === "boolean") {
      this.handleOk(socket, data[1], data[2], typeof data[3] === "string" ? data[3] : "");
      return;
    }
    if (type === "EVENT" && typeof data[1] === "string" && data[2]) {
      const subscription = this.subscriptions.get(data[1]);
      if (!subscription) return;
      const event = data[2] as NostrEvent;
      if (subscription.persistent) subscription.onEvent(event);
      else subscription.events?.push(event);
      return;
    }
    if (type === "EOSE" && typeof data[1] === "string") {
      const subscription = this.subscriptions.get(data[1]);
      if (!subscription) return;
      if (subscription.persistent) {
        subscription.onEose?.();
        return;
      }
      const events = subscription.events ?? [];
      subscription.resolve?.(events);
      this.clearSubscription(data[1], subscription);
      return;
    }
    if (type === "CLOSED" && typeof data[1] === "string") {
      const subscription = this.subscriptions.get(data[1]);
      if (!subscription) return;
      const message = typeof data[2] === "string" ? data[2] : "";
      const retryDelay = rateLimitRetryDelay(message);
      if (retryDelay !== null) {
        subscription.onRetry?.();
        this.scheduleSubscriptionRetry(data[1], subscription, retryDelay);
        return;
      }
      const error = new Error(message || t("error.relaySubscriptionClosed"));
      subscription.reject?.(error);
      subscription.onClosed?.(error);
      this.clearSubscription(data[1], subscription);
    }
  }

  private handleOk(socket: WebSocket, eventId: string, accepted: boolean, message: string): void {
    if (eventId === this.authEventId) {
      this.clearAuthTimeout();
      if (!accepted) {
        this.terminal = true;
        this.failConnection(new Error(message || t("error.relayAuthFailed")), socket);
        return;
      }
      this.authEventId = null;
      this.reconnectDelay = 1_000;
      this.setState("connected");
      this.resolveConnect?.();
      this.resolveConnect = null;
      this.rejectConnect = null;
      for (const [id, subscription] of this.subscriptions) {
        if (subscription.persistent) {
          this.clearSubscriptionRetry(subscription);
          this.send(["REQ", id, subscription.filter]);
        }
      }
      return;
    }

    const pending = this.pendingPublishes.get(eventId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    this.pendingPublishes.delete(eventId);
    if (accepted) pending.resolve({ event: pending.event, message });
    else pending.reject(new Error(message || t("error.relayEventRejected")));
  }

  private clearSubscription(id: string, subscription: Subscription): void {
    if (subscription.timeout !== undefined) window.clearTimeout(subscription.timeout);
    this.clearSubscriptionRetry(subscription);
    this.subscriptions.delete(id);
    if (this.socket?.readyState === WebSocket.OPEN) this.send(["CLOSE", id]);
  }

  private scheduleSubscriptionRetry(id: string, subscription: Subscription, delay: number): void {
    if (subscription.retryTimer !== undefined) return;
    subscription.retryTimer = window.setTimeout(() => {
      subscription.retryTimer = undefined;
      if (
        this.subscriptions.get(id) !== subscription ||
        this.state !== "connected" ||
        this.socket?.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      if (!subscription.persistent) subscription.events = [];
      this.send(["REQ", id, subscription.filter]);
    }, delay);
  }

  private clearSubscriptionRetry(subscription: Subscription): void {
    if (subscription.retryTimer === undefined) return;
    window.clearTimeout(subscription.retryTimer);
    subscription.retryTimer = undefined;
  }

  private clearAuthTimeout(): void {
    if (this.authTimeout !== null) window.clearTimeout(this.authTimeout);
    this.authTimeout = null;
  }

  private failConnection(error: Error, socket: WebSocket | null = this.socket): void {
    if (socket && this.socket !== socket) return;
    this.clearAuthTimeout();
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.rejectConnect?.(error);
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.authEventId = null;
    const activeSocket = this.socket;
    this.socket = null;
    activeSocket?.close();
    this.setState("disconnected");
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.authEventId = null;
    for (const [id, subscription] of this.subscriptions) {
      this.clearSubscriptionRetry(subscription);
      if (!subscription.persistent) {
        subscription.reject?.(new Error(t("error.relayQueryInterrupted")));
        this.clearSubscription(id, subscription);
      }
    }
    for (const pending of this.pendingPublishes.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error(t("error.relayPublishInterrupted")));
    }
    this.pendingPublishes.clear();
    if (this.manuallyClosed || this.terminal) {
      this.setState(this.manuallyClosed ? "idle" : "disconnected");
      return;
    }
    this.setState("reconnecting");
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.connectPromise) this.openSocket();
      else void this.connect().catch(() => undefined);
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}
