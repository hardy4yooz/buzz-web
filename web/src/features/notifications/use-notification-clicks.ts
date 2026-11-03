import { useEffect, useRef, useState } from "react";
import {
  NOTIFY_PENDING_CACHE,
  type NotificationTarget,
  notificationPendingKey,
  pendingTargetForScope,
} from "@/features/notifications/lib/notification-policy";

const CHANNEL_WAIT_MS = 10_000;

/** Reads and deletes the shared pending entry: a click is consumed at most once. */
async function consumePending(scopeId: string): Promise<NotificationTarget | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(NOTIFY_PENDING_CACHE);
    const key = notificationPendingKey(scopeId);
    const response = await cache.match(key);
    if (!response) return null;
    await cache.delete(key);
    return pendingTargetForScope(await response.json(), scopeId, Date.now());
  } catch {
    return null;
  }
}

/**
 * The service worker stores the clicked notification before messaging or opening a window. The
 * payload is only a wake-up: the route comes from the cache entry, which must match the scope that
 * is unlocked right now. A locked vault, another identity, or another Relay never routes.
 */
export function useNotificationClicks({
  scopeId,
  channelsLoaded,
  hasChannel,
  openInbox,
  openMessage,
}: {
  scopeId: string | null;
  channelsLoaded: boolean;
  hasChannel: (channelId: string) => boolean;
  openInbox: () => void;
  openMessage: (channelId: string, eventId: string, threadRootId: string | null) => void;
}): void {
  const [pending, setPending] = useState<NotificationTarget | null>(null);
  const routedRef = useRef<NotificationTarget | null>(null);
  const actionsRef = useRef({ hasChannel, openInbox, openMessage });
  actionsRef.current = { hasChannel, openInbox, openMessage };

  useEffect(() => {
    if (!scopeId || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    const receive = () => {
      void consumePending(scopeId).then((target) => {
        if (!cancelled && target) setPending(target);
      });
    };
    receive();
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type === "buzz:notification-click") receive();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [scopeId]);

  useEffect(() => {
    if (!pending || routedRef.current === pending) return;
    const { hasChannel, openInbox, openMessage } = actionsRef.current;
    if (pending.category === "needs_action") {
      routedRef.current = pending;
      setPending(null);
      openInbox();
      return;
    }
    if (!channelsLoaded) {
      // One timer per click: the callbacks live in a ref so renders cannot restart this wait.
      const timer = window.setTimeout(() => {
        routedRef.current = pending;
        setPending(null);
        openInbox();
      }, CHANNEL_WAIT_MS);
      return () => window.clearTimeout(timer);
    }
    routedRef.current = pending;
    setPending(null);
    if (hasChannel(pending.channelId)) {
      openMessage(pending.channelId, pending.eventId, pending.threadRootId);
    } else {
      openInbox();
    }
  }, [channelsLoaded, pending]);
}
