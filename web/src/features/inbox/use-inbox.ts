import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tagValue, threadReference } from "@/features/chat/lib/chat-model";
import type { BuzzChannel } from "@/features/chat/lib/chat-types";
import {
  buildInboxItems,
  INBOX_EVENT_KINDS,
  threadNotificationRootIds,
  threadRootIds,
} from "@/features/inbox/lib/inbox-model";
import type { NostrEvent, NostrFilter } from "@/shared/api/nostr-types";
import type { BuzzRelayClient } from "@/shared/api/relay-client";
import type { ConfiguredAgent } from "@/shared/config/runtime-config";
import { t } from "@/shared/i18n";

type InboxEventState = {
  events: NostrEvent[];
  scopeKey: string;
};

function mergeEvents(
  current: readonly NostrEvent[],
  incoming: readonly NostrEvent[],
): NostrEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()];
}

export function mergeInboxEventState(
  current: InboxEventState,
  sourceScopeKey: string,
  activeScopeKey: string,
  incoming: readonly NostrEvent[],
): InboxEventState {
  if (sourceScopeKey !== activeScopeKey) return current;
  return {
    scopeKey: sourceScopeKey,
    events: mergeEvents(current.scopeKey === sourceScopeKey ? current.events : [], incoming),
  };
}

export function inboxLiveFilters(
  currentPubkey: string,
  channelIds: readonly string[],
  since: number,
): NostrFilter[] {
  const filters: NostrFilter[] = [
    { kinds: INBOX_EVENT_KINDS, "#p": [currentPubkey], since, limit: 0 },
  ];
  if (channelIds.length) {
    filters.push({ kinds: INBOX_EVENT_KINDS, "#h": [...channelIds], since, limit: 0 });
  }
  return filters;
}

function legacyReadStateKey(relayUrl: string, pubkey: string): string {
  return `buzz:web:inbox-read:${encodeURIComponent(relayUrl)}:${pubkey.toLowerCase()}`;
}

function forcedUnreadStateKey(relayUrl: string, pubkey: string): string {
  return `buzz:web:inbox-forced-unread:v1:${encodeURIComponent(relayUrl)}:${pubkey.toLowerCase()}`;
}

function loadReadIds(key: string): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function topLevelChannelEvents(
  events: readonly NostrEvent[],
  channelId: string,
): NostrEvent[] {
  return events.filter(
    (event) => tagValue(event, "h") === channelId && !threadReference(event).rootId,
  );
}

export function eventReadFrontier(
  event: NostrEvent,
  readContexts: Readonly<Record<string, number>>,
  threadRootId: string | null,
): number {
  const channelId = tagValue(event, "h");
  return Math.max(
    channelId ? (readContexts[channelId] ?? 0) : 0,
    threadRootId ? (readContexts[`thread:${threadRootId}`] ?? 0) : 0,
    readContexts[`msg:${event.id}`] ?? 0,
  );
}

function demoInboxEvents(
  channels: readonly BuzzChannel[],
  currentPubkey: string,
  configuredAgents: readonly ConfiguredAgent[],
): NostrEvent[] {
  const general = channels.find((channel) => channel.type !== "dm")?.id ?? "general";
  const dm = channels.find((channel) => channel.type === "dm")?.id ?? "dm";
  const agent = configuredAgents[0]?.pubkey ?? "a".repeat(64);
  const now = Math.floor(Date.now() / 1000);
  const event = (
    id: string,
    pubkey: string,
    kind: number,
    content: string,
    createdAt: number,
    tags: string[][],
  ): NostrEvent => ({
    id: id.repeat(64).slice(0, 64),
    pubkey,
    kind,
    content,
    created_at: createdAt,
    tags,
    sig: "0".repeat(128),
  });
  const rootId = "c".repeat(64);
  return [
    event("1", agent, 9, "Can you review the deployment checklist?", now - 55, [
      ["h", general],
      ["p", currentPubkey],
    ]),
    event("2", agent, 9, "The Relay health checks are all passing.", now - 115, [
      ["h", dm],
      ["p", currentPubkey],
    ]),
    event("c", currentPubkey, 9, "Please post the verification result here.", now - 240, [
      ["h", general],
    ]),
    event("3", agent, 9, "Verification is complete and the result is attached.", now - 40, [
      ["h", general],
      ["e", rootId, "", "reply"],
    ]),
    event("4", agent, 46010, "Production rollout is waiting for approval.", now - 320, [
      ["h", general],
      ["p", currentPubkey],
      ["d", "d".repeat(64)],
    ]),
  ];
}

export function useInbox({
  client,
  demo,
  relayUrl,
  currentPubkey,
  configuredAgents,
  channels,
  ensureProfiles,
  readContexts,
  markContextRead,
}: {
  client: BuzzRelayClient | null;
  demo: boolean;
  relayUrl: string;
  currentPubkey: string;
  configuredAgents: readonly ConfiguredAgent[];
  channels: readonly BuzzChannel[];
  ensureProfiles: (pubkeys: string[]) => Promise<void>;
  readContexts: Readonly<Record<string, number>>;
  markContextRead: (contextId: string, timestamp: number) => void;
}) {
  const legacyStorageKey = useMemo(
    () => legacyReadStateKey(relayUrl, currentPubkey),
    [currentPubkey, relayUrl],
  );
  const forcedStorageKey = useMemo(
    () => forcedUnreadStateKey(relayUrl, currentPubkey),
    [currentPubkey, relayUrl],
  );
  const eventScopeKey = `${relayUrl}:${currentPubkey.toLowerCase()}`;
  const activeEventScopeRef = useRef(eventScopeKey);
  activeEventScopeRef.current = eventScopeKey;
  const [eventState, setEventState] = useState<InboxEventState>(() => ({
    scopeKey: eventScopeKey,
    events: demo ? demoInboxEvents(channels, currentPubkey, configuredAgents) : [],
  }));
  const events = eventState.scopeKey === eventScopeKey ? eventState.events : [];
  const [legacyReadIds] = useState<Set<string>>(() => loadReadIds(legacyStorageKey));
  const [forcedUnreadIds, setForcedUnreadIds] = useState<Set<string>>(() =>
    loadReadIds(forcedStorageKey),
  );
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | null>(null);
  const [approvalPending, setApprovalPending] = useState<string | null>(null);
  const channelIdsKey = channels
    .map((channel) => channel.id)
    .sort()
    .join(",");
  const rootsByEvent = useMemo(() => threadRootIds(events), [events]);
  const notificationRoots = useMemo(
    () => threadNotificationRootIds(events, currentPubkey, rootsByEvent),
    [currentPubkey, events, rootsByEvent],
  );

  useEffect(() => {
    if (demo && channelIdsKey) {
      setEventState({
        scopeKey: eventScopeKey,
        events: demoInboxEvents(channels, currentPubkey, configuredAgents),
      });
    }
  }, [channelIdsKey, channels, configuredAgents, currentPubkey, demo, eventScopeKey]);

  useEffect(() => {
    try {
      localStorage.setItem(forcedStorageKey, JSON.stringify([...forcedUnreadIds].slice(-2_000)));
    } catch {
      // Private browsing policies may disable local persistence.
    }
  }, [forcedStorageKey, forcedUnreadIds]);

  useEffect(() => {
    if (!legacyReadIds.size || !events.length) return;
    let migrated = false;
    for (const event of events) {
      if (!legacyReadIds.has(event.id)) continue;
      markContextRead(`msg:${event.id}`, event.created_at);
      migrated = true;
    }
    if (migrated) {
      try {
        localStorage.removeItem(legacyStorageKey);
      } catch {
        // A storage policy can prevent cleanup; the grow-only merge remains idempotent.
      }
      legacyReadIds.clear();
    }
  }, [events, legacyReadIds, legacyStorageKey, markContextRead]);

  const refresh = useCallback(async () => {
    if (!client || demo) return;
    const refreshScopeKey = eventScopeKey;
    setLoading(true);
    try {
      const channelIds = channels.map((channel) => channel.id);
      const results = await Promise.all([
        client.query({ kinds: INBOX_EVENT_KINDS, "#p": [currentPubkey], limit: 500 }),
        channelIds.length
          ? client.query({ kinds: INBOX_EVENT_KINDS, "#h": channelIds, limit: 1_000 })
          : Promise.resolve([]),
      ]);
      const nextEvents = mergeEvents([], results.flat());
      setEventState((current) =>
        mergeInboxEventState(current, refreshScopeKey, activeEventScopeRef.current, nextEvents),
      );
      await ensureProfiles(nextEvents.map((event) => event.pubkey));
      if (activeEventScopeRef.current === refreshScopeKey) setError(null);
    } catch (refreshError) {
      if (activeEventScopeRef.current === refreshScopeKey) {
        setError(refreshError instanceof Error ? refreshError.message : t("error.inboxLoad"));
      }
    } finally {
      if (activeEventScopeRef.current === refreshScopeKey) setLoading(false);
    }
  }, [channels, client, currentPubkey, demo, ensureProfiles, eventScopeKey]);

  useEffect(() => {
    if (!client || demo) return;
    let cancelled = false;
    const unsubscribers: Array<() => void> = [];
    const since = Math.floor(Date.now() / 1000) - 3;
    const channelIds = channelIdsKey ? channelIdsKey.split(",") : [];
    const receive = (event: NostrEvent) => {
      setEventState((current) =>
        mergeInboxEventState(current, eventScopeKey, activeEventScopeRef.current, [event]),
      );
      void ensureProfiles([event.pubkey]);
    };
    void refresh();
    const filters = inboxLiveFilters(currentPubkey, channelIds, since);
    for (const filter of filters) {
      void client
        .subscribe(filter, receive)
        .then((unsubscribe) => {
          if (cancelled) unsubscribe();
          else unsubscribers.push(unsubscribe);
        })
        .catch((subscribeError) => {
          if (!cancelled) {
            setError(
              subscribeError instanceof Error ? subscribeError.message : t("error.inboxLoad"),
            );
          }
        });
    }
    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [channelIdsKey, client, currentPubkey, demo, ensureProfiles, eventScopeKey, refresh]);

  const readIds = useMemo(() => {
    const result = new Set<string>();
    for (const event of events) {
      if (
        !forcedUnreadIds.has(event.id) &&
        eventReadFrontier(event, readContexts, rootsByEvent.get(event.id) ?? null) >=
          event.created_at
      ) {
        result.add(event.id);
      }
    }
    return result;
  }, [events, forcedUnreadIds, readContexts, rootsByEvent]);
  const items = useMemo(
    () => buildInboxItems({ events, channels, currentPubkey, readIds }),
    [channels, currentPubkey, events, readIds],
  );
  const unreadCount = items.filter((item) => item.unread).length;
  const markRead = useCallback(
    (id: string) => {
      const event = events.find((candidate) => candidate.id === id);
      if (event) markContextRead(`msg:${id}`, event.created_at);
      setForcedUnreadIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    },
    [events, markContextRead],
  );
  const markUnread = useCallback((id: string) => {
    setForcedUnreadIds((current) => new Set([...current, id]));
  }, []);
  const markAllRead = useCallback(() => {
    const latestByChannel = new Map<string, number>();
    const latestByThread = new Map<string, number>();
    for (const item of items) {
      if (item.threadRootId) {
        latestByThread.set(
          item.threadRootId,
          Math.max(latestByThread.get(item.threadRootId) ?? 0, item.event.created_at),
        );
      } else if (item.channelId) {
        latestByChannel.set(
          item.channelId,
          Math.max(latestByChannel.get(item.channelId) ?? 0, item.event.created_at),
        );
      } else {
        markContextRead(`msg:${item.id}`, item.event.created_at);
      }
    }
    for (const [channelId, timestamp] of latestByChannel) markContextRead(channelId, timestamp);
    for (const [rootId, timestamp] of latestByThread) {
      markContextRead(`thread:${rootId}`, timestamp);
    }
    setForcedUnreadIds(new Set());
  }, [items, markContextRead]);
  const markChannelRead = useCallback(
    (channelId: string, timestamp: number) => {
      if (timestamp <= 0) return;
      markContextRead(channelId, timestamp);
      setForcedUnreadIds((current) => {
        const next = new Set(current);
        for (const event of topLevelChannelEvents(events, channelId)) {
          if (event.created_at <= timestamp) next.delete(event.id);
        }
        return next;
      });
    },
    [events, markContextRead],
  );
  const markThreadRead = useCallback(
    (rootId: string, timestamp: number) => {
      if (timestamp <= 0) return;
      markContextRead(`thread:${rootId}`, timestamp);
      setForcedUnreadIds((current) => {
        const next = new Set(current);
        for (const event of events) {
          if (rootsByEvent.get(event.id) === rootId && event.created_at <= timestamp) {
            next.delete(event.id);
          }
        }
        return next;
      });
    },
    [events, markContextRead, rootsByEvent],
  );
  const channelUnreadCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const current = currentPubkey.toLowerCase();
    const channelTypes = new Map(channels.map((channel) => [channel.id, channel.type]));
    for (const event of events) {
      if (event.pubkey.toLowerCase() === current) continue;
      const channelId = tagValue(event, "h");
      if (!channelId) continue;
      const rootId = rootsByEvent.get(event.id) ?? null;
      if (rootId && channelTypes.get(channelId) !== "dm" && !notificationRoots.has(rootId)) {
        continue;
      }
      const readAt = eventReadFrontier(event, readContexts, rootId);
      if (forcedUnreadIds.has(event.id) || event.created_at > readAt) {
        counts[channelId] = (counts[channelId] ?? 0) + 1;
      }
    }
    return counts;
  }, [
    channels,
    currentPubkey,
    events,
    forcedUnreadIds,
    notificationRoots,
    readContexts,
    rootsByEvent,
  ]);
  const respondToApproval = useCallback(
    async (event: NostrEvent, approved: boolean) => {
      setApprovalPending(event.id);
      try {
        const reference = tagValue(event, "d");
        if (!reference || !/^[0-9a-f]{64}$/i.test(reference)) {
          throw new Error(t("error.approvalReference"));
        }
        if (!demo) {
          if (!client) throw new Error(t("error.relayClient"));
          await client.publish({
            kind: approved ? 46030 : 46031,
            content: "",
            tags: [["d", reference.toLowerCase()]],
          });
        }
        markRead(event.id);
        setEventState((current) =>
          current.scopeKey === eventScopeKey
            ? { ...current, events: current.events.filter((item) => item.id !== event.id) }
            : current,
        );
        setError(null);
      } catch (approvalError) {
        setError(
          approvalError instanceof Error ? approvalError.message : t("error.approvalUpdate"),
        );
      } finally {
        setApprovalPending(null);
      }
    },
    [client, demo, eventScopeKey, markRead],
  );

  return {
    items,
    unreadCount,
    channelUnreadCounts,
    loading,
    error,
    approvalPending,
    refresh,
    markRead,
    markUnread,
    markAllRead,
    markChannelRead,
    markThreadRead,
    respondToApproval,
  };
}
