import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InboxItem } from "@/features/inbox/lib/inbox-model";
import {
  createArming,
  createEnabledArming,
  isNotificationEligible,
  markNotificationSeen,
  type NotificationArming,
  notificationMessage,
  notificationPreferenceKey,
  notificationScopeId,
  notificationScopePrefix,
  observeInbox,
} from "@/features/notifications/lib/notification-policy";
import {
  deriveNotificationState,
  type NotificationProbe,
  type NotificationUiState,
} from "@/features/notifications/lib/notification-state";
import { t } from "@/shared/i18n";

const WORKER_READY_TIMEOUT_MS = 5_000;
const WORKER_PING_TIMEOUT_MS = 1_000;
const WORKER_ACK_TIMEOUT_MS = 2_000;

export type NotificationController = {
  state: NotificationUiState;
  scopeId: string | null;
  enable: () => void;
  disable: () => void;
  retry: () => void;
};

function notificationsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    typeof crypto !== "undefined" &&
    typeof crypto.subtle !== "undefined"
  );
}

function readPreference(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function writePreference(key: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(key, "true");
    else localStorage.removeItem(key);
  } catch {
    // A storage policy can refuse persistence; the in-memory state still applies.
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), ms);
    void promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function postToWorker(
  worker: ServiceWorker,
  message: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let timer: number | undefined;
    const finish = (value: Record<string, unknown> | null) => {
      if (timer !== undefined) window.clearTimeout(timer);
      channel.port1.close();
      resolve(value);
    };
    timer = window.setTimeout(() => finish(null), timeoutMs);
    channel.port1.onmessage = (event: MessageEvent) => {
      finish(
        event.data && typeof event.data === "object"
          ? (event.data as Record<string, unknown>)
          : null,
      );
    };
    try {
      worker.postMessage(message, [channel.port2]);
    } catch {
      finish(null);
    }
  });
}

/**
 * Closes only this relay+viewer scope. Notifications belonging to another identity or another
 * Relay in the same browser profile are never touched.
 */
async function closeScopeNotifications(scopeId: string): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;
    const prefix = notificationScopePrefix(scopeId);
    const notifications = await registration.getNotifications();
    await Promise.allSettled(
      notifications
        .filter((notification) => notification.tag.startsWith(prefix))
        .map((notification) => Promise.resolve(notification.close())),
    );
  } catch {
    // Cleanup is best effort; a leftover notification still carries no content.
  }
}

export function useForegroundNotifications({
  relayUrl,
  pubkey,
  communityName,
  items,
  loading,
}: {
  relayUrl: string;
  pubkey: string;
  communityName: string;
  items: readonly InboxItem[];
  loading: boolean;
}): NotificationController {
  const supported = useMemo(notificationsSupported, []);
  const preferenceKey = useMemo(
    () => notificationPreferenceKey(relayUrl, pubkey),
    [pubkey, relayUrl],
  );
  const [preference, setPreference] = useState(() => supported && readPreference(preferenceKey));
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    supported ? Notification.permission : "default",
  );
  const [probe, setProbe] = useState<NotificationProbe>("idle");
  const [scopeId, setScopeId] = useState<string | null>(null);
  const armingRef = useRef<NotificationArming>(createArming(Date.now()));
  const workerRef = useRef<ServiceWorker | null>(null);

  useEffect(() => {
    let cancelled = false;
    void notificationScopeId(relayUrl, pubkey)
      .then((value) => {
        if (!cancelled) setScopeId(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pubkey, relayUrl]);

  const probeWorker = useCallback(async () => {
    if (!notificationsSupported()) return;
    setProbe("checking");
    const registration = await withTimeout(navigator.serviceWorker.ready, WORKER_READY_TIMEOUT_MS);
    const worker = registration?.active ?? null;
    if (!worker) {
      workerRef.current = null;
      setProbe("failed");
      return;
    }
    const reply = await postToWorker(worker, { type: "buzz:ping:v1" }, WORKER_PING_TIMEOUT_MS);
    if (reply?.type === "buzz:pong:v1") {
      workerRef.current = worker;
      setProbe("ready");
    } else {
      workerRef.current = null;
      setProbe("failed");
    }
  }, []);

  useEffect(() => {
    if (!supported || !preference || permission !== "granted") {
      workerRef.current = null;
      setProbe("idle");
      return;
    }
    void probeWorker();
  }, [permission, preference, probeWorker, supported]);

  useEffect(() => {
    if (!supported) return;
    const refresh = () => setPermission(Notification.permission);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [supported]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== preferenceKey) return;
      // A sibling turning the preference on starts a new watermark here too, otherwise every item
      // this tab missed while notifications were off would burst at once.
      if (event.newValue === "true") {
        // Same contract as enable(): arm at once so a load in flight cannot fold fresh events away.
        armingRef.current = createEnabledArming(Date.now());
      }
      setPreference(readPreference(preferenceKey));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [preferenceKey]);

  useEffect(() => {
    const next = observeInbox(armingRef.current, {
      loading,
      itemIds: items.map((item) => item.id),
    });
    if (next !== armingRef.current) armingRef.current = next;
  }, [items, loading]);

  useEffect(() => {
    if (!scopeId || probe !== "ready" || !preference || permission !== "granted") return;
    if (document.visibilityState === "visible") return;
    const arming = armingRef.current;
    if (!arming.armed) return;
    const context = {
      currentPubkey: pubkey,
      preference,
      permission,
      workerReady: true,
      hidden: true,
      armed: true,
      watermark: arming.watermark,
      seenIds: arming.seenIds,
    };
    const leader = workerRef.current;
    if (!leader) return;
    const eligible = items.filter((item) => isNotificationEligible(item, context));
    if (!eligible.length) return;
    const title = communityName.trim() || t("app.title");
    const body = t("notify.body");
    for (const item of eligible) {
      // Attempted once per tab: a failed delivery is not retried, the inbox stays authoritative.
      armingRef.current = markNotificationSeen(armingRef.current, item.id);
      void postToWorker(
        leader,
        notificationMessage(item, scopeId, title, body),
        WORKER_ACK_TIMEOUT_MS,
      ).then((reply) => {
        const result = typeof reply?.result === "string" ? reply.result : null;
        if (result === "shown" || result === "duplicate" || result === "stale") return;
        void probeWorker();
      });
    }
  }, [communityName, items, permission, preference, probe, probeWorker, pubkey, scopeId]);

  useEffect(() => {
    if (!scopeId) return;
    return () => {
      void closeScopeNotifications(scopeId);
    };
  }, [scopeId]);

  const enable = useCallback(() => {
    if (!supported) return;
    // The permission prompt must start inside the click task, before any await.
    const request = Notification.requestPermission();
    void request
      .then(async (result) => {
        setPermission(result);
        if (result !== "granted") {
          writePreference(preferenceKey, false);
          setPreference(false);
          return;
        }
        writePreference(preferenceKey, true);
        // The user asked for notifications now: arm immediately, never behind a load.
        armingRef.current = createEnabledArming(Date.now());
        setPreference(true);
        await probeWorker();
      })
      .catch(() => setPreference(readPreference(preferenceKey)));
  }, [preferenceKey, probeWorker, supported]);

  const disable = useCallback(() => {
    writePreference(preferenceKey, false);
    setPreference(false);
    setProbe("idle");
    workerRef.current = null;
    armingRef.current = createArming(Date.now());
    if (scopeId) void closeScopeNotifications(scopeId);
  }, [preferenceKey, scopeId]);

  const retry = useCallback(() => {
    void probeWorker();
  }, [probeWorker]);

  return {
    state: deriveNotificationState({ supported, preference, permission, probe }),
    scopeId,
    enable,
    disable,
    retry,
  };
}
