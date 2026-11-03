import type { InboxCategory, InboxItem } from "@/features/inbox/lib/inbox-model";

/** Categories that may raise a foreground notification. */
export const NOTIFY_ELIGIBLE_CATEGORIES: readonly InboxCategory[] = [
  "mention",
  "dm",
  "thread",
  "needs_action",
];

export const NOTIFY_TAG_PREFIX = "buzz:v1:";
export const NOTIFY_PENDING_CACHE = "buzz-notify-pending-v1";
export const NOTIFY_PENDING_TTL_MS = 5 * 60 * 1_000;
export const NOTIFY_TITLE_LIMIT = 120;
export const NOTIFY_BODY_LIMIT = 200;

const HEX_16 = /^[0-9a-f]{16}$/;
const HEX_64 = /^[0-9a-f]{64}$/i;
const CHANNEL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type NotificationContext = {
  currentPubkey: string;
  preference: boolean;
  permission: NotificationPermission;
  workerReady: boolean;
  hidden: boolean;
  armed: boolean;
  watermark: number;
  seenIds: ReadonlySet<string>;
};

export type NotificationArming = {
  watermark: number;
  seenIds: ReadonlySet<string>;
  armed: boolean;
};

export type NotificationTarget = {
  v: 1;
  scopeId: string;
  eventId: string;
  channelId: string;
  threadRootId: string | null;
  category: InboxCategory;
  createdAt: number;
};

/** Opaque per relay+viewer scope so notifications and cleanup never cross identities. */
export async function notificationScopeId(relayUrl: string, pubkey: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${relayUrl}\n${pubkey.toLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function notificationTag(scopeId: string, channelId: string): string {
  return `${notificationScopePrefix(scopeId)}ch:${channelId}`;
}

export function notificationScopePrefix(scopeId: string): string {
  return `${NOTIFY_TAG_PREFIX}${scopeId}:`;
}

export function notificationPendingKey(scopeId: string): string {
  return `${scopeId}__buzz-notify-pending__/${scopeId}`;
}

export function notificationPreferenceKey(relayUrl: string, pubkey: string): string {
  return `buzz:web:notify:v1:${encodeURIComponent(relayUrl)}:${pubkey.toLowerCase()}`;
}

export function createArming(now: number): NotificationArming {
  return { watermark: Math.floor(now / 1_000), seenIds: new Set(), armed: false };
}

/**
 * Seeds pre-existing history while the inbox is loading, then arms once. After arming the
 * watermark and seen set stay fixed so reconnects and refreshes cannot replay notifications.
 */
export function observeInbox(
  arming: NotificationArming,
  { loading, itemIds }: { loading: boolean; itemIds: readonly string[] },
): NotificationArming {
  if (arming.armed) return arming;
  const seenIds = new Set(arming.seenIds);
  for (const id of itemIds) seenIds.add(id);
  return { ...arming, seenIds, armed: !loading };
}

export function markNotificationSeen(
  arming: NotificationArming,
  eventId: string,
): NotificationArming {
  if (arming.seenIds.has(eventId)) return arming;
  const seenIds = new Set(arming.seenIds);
  seenIds.add(eventId);
  return { ...arming, seenIds };
}

export function isNotificationEligible(item: InboxItem, context: NotificationContext): boolean {
  return (
    context.preference &&
    context.permission === "granted" &&
    context.workerReady &&
    context.hidden &&
    context.armed &&
    item.unread &&
    item.channelId !== null &&
    NOTIFY_ELIGIBLE_CATEGORIES.includes(item.category) &&
    item.event.pubkey.toLowerCase() !== context.currentPubkey.toLowerCase() &&
    item.event.created_at > context.watermark &&
    !context.seenIds.has(item.id)
  );
}

/** Page to service worker payload: opaque ids plus already localized generic copy only. */
export function notificationMessage(
  item: InboxItem,
  scopeId: string,
  title: string,
  body: string,
): Record<string, unknown> {
  return {
    type: "buzz:notify:v1",
    v: 1,
    tag: notificationTag(scopeId, item.channelId ?? ""),
    scopeId,
    eventId: item.id,
    channelId: item.channelId ?? "",
    threadRootId: item.threadRootId,
    category: item.category,
    createdAt: item.event.created_at,
    title: title.slice(0, NOTIFY_TITLE_LIMIT),
    body: body.slice(0, NOTIFY_BODY_LIMIT),
  };
}

/**
 * A click left in the shared cache is untrusted: it must be fresh and belong to the scope that is
 * currently unlocked, otherwise a locked or switched identity could be routed into a message.
 */
export function pendingTargetForScope(
  value: unknown,
  scopeId: string,
  now: number,
): NotificationTarget | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  const { storedAt } = record;
  if (typeof storedAt !== "number" || !Number.isInteger(storedAt)) return null;
  const age = now - storedAt;
  if (age < 0 || age > NOTIFY_PENDING_TTL_MS) return null;
  const target = parseNotificationTarget(record.target);
  if (!target || target.scopeId !== scopeId) return null;
  return target;
}

/** Click data arrives from the OS notification store and is treated as untrusted input. */
export function parseNotificationTarget(value: unknown): NotificationTarget | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const { v, scopeId, eventId, channelId, threadRootId, category, createdAt } = record;
  if (v !== 1) return null;
  if (typeof scopeId !== "string" || !HEX_16.test(scopeId)) return null;
  if (typeof eventId !== "string" || !HEX_64.test(eventId)) return null;
  if (typeof channelId !== "string" || !CHANNEL_ID.test(channelId)) return null;
  if (threadRootId !== null && (typeof threadRootId !== "string" || !HEX_64.test(threadRootId))) {
    return null;
  }
  if (!NOTIFY_ELIGIBLE_CATEGORIES.includes(category as InboxCategory)) return null;
  if (typeof createdAt !== "number" || !Number.isInteger(createdAt) || createdAt <= 0) return null;
  return {
    v: 1,
    scopeId,
    eventId,
    channelId,
    threadRootId,
    category: category as InboxCategory,
    createdAt,
  };
}
