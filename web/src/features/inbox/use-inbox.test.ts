import { describe, expect, it } from "vitest";
import { INBOX_EVENT_KINDS } from "@/features/inbox/lib/inbox-model";
import {
  eventReadFrontier,
  inboxLiveFilters,
  mergeInboxEventState,
  topLevelChannelEvents,
} from "@/features/inbox/use-inbox";
import type { NostrEvent } from "@/shared/api/nostr-types";

function event(id: string, createdAt: number, tags: string[][]): NostrEvent {
  return {
    id: id.repeat(64).slice(0, 64),
    pubkey: "11".repeat(32),
    kind: 9,
    content: id,
    created_at: createdAt,
    tags: [["h", "general"], ...tags],
    sig: "22".repeat(64),
  };
}

describe("Inbox channel read frontier", () => {
  it("does not advance the channel frontier from thread replies", () => {
    const root = event("a", 10, []);
    const reply = event("b", 20, [["e", root.id, "", "reply"]]);
    const nested = event("c", 30, [
      ["e", root.id, "", "root"],
      ["e", reply.id, "", "reply"],
    ]);

    expect(topLevelChannelEvents([root, reply, nested], "general")).toEqual([root]);
  });

  it("uses channel, thread, and per-message read frontiers hierarchically", () => {
    const reply = event("b", 20, [["e", "a".repeat(64), "", "reply"]]);

    expect(eventReadFrontier(reply, { general: 10 }, "a".repeat(64))).toBe(10);
    expect(
      eventReadFrontier(reply, { general: 10, [`thread:${"a".repeat(64)}`]: 25 }, "a".repeat(64)),
    ).toBe(25);
    expect(eventReadFrontier(reply, { general: 10, [`msg:${reply.id}`]: 30 }, "a".repeat(64))).toBe(
      30,
    );
  });
});

describe("Inbox event refresh", () => {
  it("keeps a live reply when an older history request settles afterward", () => {
    const root = event("a", 10, []);
    const reply = event("b", 20, [["e", root.id, "", "reply"]]);
    const scopeKey = "wss://relay.example:current-user";
    const afterLiveReply = mergeInboxEventState({ scopeKey, events: [] }, scopeKey, scopeKey, [
      reply,
    ]);
    const afterHistory = mergeInboxEventState(afterLiveReply, scopeKey, scopeKey, [root]);

    expect(new Set(afterHistory.events.map((item) => item.id))).toEqual(
      new Set([root.id, reply.id]),
    );
  });

  it("ignores an asynchronous refresh from a previous Relay or identity", () => {
    const currentScope = "wss://relay.example:current-user";
    const previousScope = "wss://old.example:previous-user";
    const current = { scopeKey: currentScope, events: [event("c", 30, [])] };

    expect(mergeInboxEventState(current, previousScope, currentScope, [event("d", 40, [])])).toBe(
      current,
    );
  });
});

describe("Inbox live subscriptions", () => {
  it("combines channel IDs into one #h filter while keeping #p as a separate OR filter", () => {
    const filters = inboxLiveFilters("f".repeat(64), ["channel-a", "channel-b"], 42);

    expect(filters).toEqual([
      { kinds: INBOX_EVENT_KINDS, "#p": ["f".repeat(64)], since: 42, limit: 0 },
      { kinds: INBOX_EVENT_KINDS, "#h": ["channel-a", "channel-b"], since: 42, limit: 0 },
    ]);
  });

  it("keeps the direct-mention filter when there are no channels", () => {
    expect(inboxLiveFilters("f".repeat(64), [], 42)).toEqual([
      { kinds: INBOX_EVENT_KINDS, "#p": ["f".repeat(64)], since: 42, limit: 0 },
    ]);
  });
});
