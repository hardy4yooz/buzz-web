import { describe, expect, it } from "vitest";
import type { InboxCategory, InboxItem } from "@/features/inbox/lib/inbox-model";
import {
  createArming,
  createEnabledArming,
  isNotificationEligible,
  markNotificationSeen,
  type NotificationContext,
  notificationMessage,
  notificationPendingKey,
  notificationPreferenceKey,
  notificationScopeId,
  notificationScopePrefix,
  notificationTag,
  observeInbox,
  parseNotificationTarget,
  pendingTargetForScope,
} from "@/features/notifications/lib/notification-policy";
import type { NostrEvent } from "@/shared/api/nostr-types";
import hookSource from "../use-foreground-notifications.ts?raw";

const RELAY = "wss://relay.example.com";
const PUBKEY = "a".repeat(64);
const OTHER_PUBKEY = "b".repeat(64);
const CHANNEL = "11111111-2222-4333-8444-555555555555";

function inboxItem(
  overrides: Partial<InboxItem> & { category?: InboxCategory; createdAt?: number } = {},
): InboxItem {
  const createdAt = overrides.createdAt ?? 1_000;
  const event: NostrEvent = {
    id: overrides.id ?? "1".repeat(64),
    pubkey: OTHER_PUBKEY,
    kind: 9,
    content: "hello",
    created_at: createdAt,
    tags: [["h", CHANNEL]],
    sig: "0".repeat(128),
  };
  return {
    id: event.id,
    event,
    category: overrides.category ?? "mention",
    channelId: CHANNEL,
    threadRootId: null,
    unread: true,
    ...overrides,
  };
}

function context(overrides: Partial<NotificationContext> = {}): NotificationContext {
  return {
    currentPubkey: PUBKEY,
    preference: true,
    permission: "granted",
    workerReady: true,
    hidden: true,
    armed: true,
    watermark: 900,
    seenIds: new Set<string>(),
    ...overrides,
  };
}

describe("notificationScopeId", () => {
  it("derives a stable 16 character hex scope from relay and viewer", async () => {
    const scope = await notificationScopeId(RELAY, PUBKEY);
    expect(scope).toMatch(/^[0-9a-f]{16}$/);
    expect(await notificationScopeId(RELAY, PUBKEY)).toBe(scope);
    expect(await notificationScopeId(RELAY, PUBKEY.toUpperCase())).toBe(scope);
  });

  it("isolates relay and viewer scopes from each other", async () => {
    const scope = await notificationScopeId(RELAY, PUBKEY);
    expect(await notificationScopeId("wss://other.example.com", PUBKEY)).not.toBe(scope);
    expect(await notificationScopeId(RELAY, OTHER_PUBKEY)).not.toBe(scope);
  });
});

describe("notification tags", () => {
  it("carries the scope in the tag so cleanup stays scoped", async () => {
    const scope = await notificationScopeId(RELAY, PUBKEY);
    const other = await notificationScopeId(RELAY, OTHER_PUBKEY);
    expect(notificationTag(scope, CHANNEL)).toBe(`buzz:v1:${scope}:ch:${CHANNEL}`);
    expect(notificationTag(scope, CHANNEL).startsWith(notificationScopePrefix(scope))).toBe(true);
    expect(notificationTag(other, CHANNEL).startsWith(notificationScopePrefix(scope))).toBe(false);
  });

  it("keeps pending entries per scope", async () => {
    expect(notificationPendingKey("0123456789abcdef")).toContain("0123456789abcdef");
    expect(notificationPendingKey("0123456789abcdef")).not.toBe(
      notificationPendingKey("fedcba9876543210"),
    );
  });

  it("scopes the stored preference to relay and viewer", () => {
    const key = notificationPreferenceKey(RELAY, PUBKEY);
    expect(key).toContain(encodeURIComponent(RELAY));
    expect(key.endsWith(PUBKEY)).toBe(true);
    expect(notificationPreferenceKey(RELAY, PUBKEY.toUpperCase())).toBe(key);
    expect(notificationPreferenceKey(RELAY, OTHER_PUBKEY)).not.toBe(key);
    expect(notificationPreferenceKey("wss://other.example.com", PUBKEY)).not.toBe(key);
  });
});

describe("isNotificationEligible", () => {
  it("notifies for a new hidden unread mention", () => {
    expect(isNotificationEligible(inboxItem(), context())).toBe(true);
  });

  it("covers every inbox category", () => {
    for (const category of ["mention", "dm", "thread", "needs_action"] as const) {
      expect(isNotificationEligible(inboxItem({ category }), context())).toBe(true);
    }
  });

  it("stays silent unless every condition holds", () => {
    const cases: Array<[string, Partial<NotificationContext>]> = [
      ["visible tab", { hidden: false }],
      ["preference off", { preference: false }],
      ["permission default", { permission: "default" }],
      ["permission denied", { permission: "denied" }],
      ["worker not ready", { workerReady: false }],
      ["not armed", { armed: false }],
    ];
    for (const [label, overrides] of cases) {
      expect(isNotificationEligible(inboxItem(), context(overrides)), label).toBe(false);
    }
  });

  it("never notifies for history at or before the watermark", () => {
    expect(isNotificationEligible(inboxItem({ createdAt: 900 }), context())).toBe(false);
    expect(isNotificationEligible(inboxItem({ createdAt: 899 }), context())).toBe(false);
    expect(isNotificationEligible(inboxItem({ createdAt: 901 }), context())).toBe(true);
  });

  it("skips read, seen, self-authored, and channel-less items", () => {
    expect(isNotificationEligible(inboxItem({ unread: false }), context())).toBe(false);
    expect(
      isNotificationEligible(inboxItem(), context({ seenIds: new Set(["1".repeat(64)]) })),
    ).toBe(false);
    const own = inboxItem();
    own.event.pubkey = PUBKEY;
    expect(isNotificationEligible(own, context())).toBe(false);
    expect(isNotificationEligible(inboxItem({ channelId: null }), context())).toBe(false);
  });
});

describe("arming", () => {
  it("arms the enable path at once so an event during a re-load still notifies", () => {
    const enabled = createEnabledArming(1_700_000_000_900);
    expect(enabled).toEqual({ watermark: 1_700_000_000, seenIds: new Set(), armed: true });
    // A re-load must not fold that event into seenIds, or the only chance to notify is lost.
    expect(observeInbox(enabled, { loading: true, itemIds: ["history"] })).toBe(enabled);

    const at = { armed: enabled.armed, watermark: enabled.watermark, seenIds: enabled.seenIds };
    expect(isNotificationEligible(inboxItem({ createdAt: 1_700_000_001 }), context(at))).toBe(true);
    // The click second itself is history: eligibility compares strictly newer than the watermark.
    expect(isNotificationEligible(inboxItem({ createdAt: 1_700_000_000 }), context(at))).toBe(
      false,
    );
  });

  it("seeds history seen while loading and arms without moving the watermark", () => {
    const armed = createArming(1_700_000_000_000);
    expect(armed).toEqual({ watermark: 1_700_000_000, seenIds: new Set(), armed: false });
    const loading = observeInbox(armed, { loading: true, itemIds: ["old"] });
    expect(loading.armed).toBe(false);
    expect(loading.seenIds.has("old")).toBe(true);
    const ready = observeInbox(loading, { loading: false, itemIds: ["old", "snapshot"] });
    expect(ready.armed).toBe(true);
    expect(ready.watermark).toBe(1_700_000_000);
    expect(ready.seenIds.has("snapshot")).toBe(true);
  });

  it("arms immediately when the first snapshot is already loaded", () => {
    const armed = observeInbox(createArming(1_700_000_000_000), {
      loading: false,
      itemIds: ["demo"],
    });
    expect(armed.armed).toBe(true);
    expect(armed.seenIds.has("demo")).toBe(true);
  });

  it("never re-seeds after arming so later events stay eligible", () => {
    const ready = observeInbox(createArming(1_700_000_000_000), {
      loading: false,
      itemIds: ["demo"],
    });
    const refreshed = observeInbox(ready, { loading: true, itemIds: ["demo", "newer"] });
    const settled = observeInbox(refreshed, { loading: false, itemIds: ["demo", "newer"] });
    expect(settled.watermark).toBe(1_700_000_000);
    expect(settled.seenIds.has("newer")).toBe(false);
    expect(markNotificationSeen(settled, "newer").seenIds.has("newer")).toBe(true);
  });
});

describe("notificationMessage", () => {
  it("sends opaque ids and generic copy the worker can validate", async () => {
    const scope = await notificationScopeId(RELAY, PUBKEY);
    const message = notificationMessage(inboxItem(), scope, "T".repeat(200), "B".repeat(400));
    expect(message).toMatchObject({
      type: "buzz:notify:v1",
      v: 1,
      tag: `buzz:v1:${scope}:ch:${CHANNEL}`,
      scopeId: scope,
      eventId: "1".repeat(64),
      channelId: CHANNEL,
      threadRootId: null,
      category: "mention",
      createdAt: 1_000,
    });
    expect((message.title as string).length).toBe(120);
    expect((message.body as string).length).toBe(200);
    expect(JSON.stringify(message)).not.toContain(OTHER_PUBKEY);
  });
});

describe("parseNotificationTarget", () => {
  const valid = {
    v: 1,
    scopeId: "0123456789abcdef",
    eventId: "1".repeat(64),
    channelId: CHANNEL,
    threadRootId: "2".repeat(64),
    category: "thread",
    createdAt: 1_700_000_000,
  };

  it("accepts a well formed target", () => {
    expect(parseNotificationTarget(valid)).toEqual(valid);
    expect(parseNotificationTarget({ ...valid, threadRootId: null })?.threadRootId).toBeNull();
  });

  it("only accepts fresh pending clicks from the current scope", () => {
    const now = 1_700_000_100_000;
    const pending = { v: 1, storedAt: now - 1_000, target: valid };
    expect(pendingTargetForScope(pending, "0123456789abcdef", now)).toEqual(valid);
    expect(pendingTargetForScope(pending, "fedcba9876543210", now)).toBeNull();
    expect(pendingTargetForScope(pending, "0123456789abcdef", now + 5 * 60 * 1_000)).toBeNull();
    expect(pendingTargetForScope(pending, "0123456789abcdef", now - 5 * 60 * 1_000)).toBeNull();
    expect(
      pendingTargetForScope({ ...pending, storedAt: "now" }, "0123456789abcdef", now),
    ).toBeNull();
    expect(pendingTargetForScope({ ...pending, target: {} }, "0123456789abcdef", now)).toBeNull();
    expect(pendingTargetForScope(null, "0123456789abcdef", now)).toBeNull();
  });

  it("rejects malformed, oversized, and out of contract targets", () => {
    const invalid = [
      null,
      "string",
      {},
      { ...valid, v: 2 },
      { ...valid, scopeId: "0123456789abcde" },
      { ...valid, scopeId: "0123456789abcdeZ" },
      { ...valid, eventId: "1".repeat(63) },
      { ...valid, eventId: null },
      { ...valid, channelId: "with space" },
      { ...valid, channelId: "" },
      { ...valid, channelId: "x".repeat(129) },
      { ...valid, threadRootId: "2".repeat(63) },
      { ...valid, category: "unknown" },
      { ...valid, createdAt: 1.5 },
      { ...valid, createdAt: "1700000000" },
    ];
    for (const value of invalid) {
      expect(parseNotificationTarget(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("hook wiring", () => {
  // No DOM harness exists in this suite, so the arming call sites are pinned structurally: both the
  // enable click and the sibling storage re-arm must use the already-armed factory, otherwise a load
  // in flight at that moment folds fresh events into `seenIds` and they are never notified.
  it("arms both call sites without passing a fresh unarmed createArming to observeInbox", () => {
    expect(hookSource).not.toMatch(/observeInbox\(\s*createArming/);
    expect(hookSource.match(/createEnabledArming\(Date\.now\(\)\)/g)).toHaveLength(2);
  });
});
