/**
 * Read-only community moderation reads on the public Relay origin.
 *
 * Contract (verified in the Relay source):
 *   GET /moderation/reports?status=&limit=   -> ReportRecord[]
 *   GET /moderation/audit?limit=             -> ActionRecord[]
 *   GET /moderation/restricted               -> BanRecord[]
 * All three require NIP-98 GET auth, Relay membership, and the community
 * `owner`/`admin` `ViewQueue` capability; a denial is 403 and a statement
 * timeout is 503. Nothing here writes, and no row is persisted.
 */

import type { MemberRole } from "@/features/chat/lib/chat-types";
import { relayHttpOrigin } from "@/shared/config/runtime-config";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";

const READ_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export type ModerationSection = "reports" | "audit" | "restricted";

export type ModerationReport = {
  id: string;
  report_event_id: string;
  reporter_pubkey: string;
  target_kind: "event" | "pubkey" | "blob";
  target: string;
  channel_id: string | null;
  report_type: string;
  note: string | null;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  action_id: string | null;
  created_at: string;
};

export type ModerationAction = {
  id: string;
  actor_pubkey: string;
  action: string;
  target_pubkey: string | null;
  target_event_id: string | null;
  channel_id: string | null;
  reason_code: string | null;
  public_reason: string | null;
  private_reason: string | null;
  matched_principal: string | null;
  created_at: string;
};

export type ModerationRestriction = {
  pubkey: string;
  banned: boolean;
  ban_expires_at: string | null;
  ban_reason: string | null;
  muted_until: string | null;
  mute_reason: string | null;
  actor_pubkey: string;
  updated_at: string;
};

export type ModerationRead<T> =
  | { state: "ok"; rows: T[] }
  | { state: "forbidden" }
  | { state: "timeout" }
  | { state: "error" };

/** Presentation gate: community `owner`/`admin` only; a channel role is not enough. */
export function canViewModeration(role: MemberRole | null): boolean {
  return role === "owner" || role === "admin";
}

/** Query keys carry the Relay and the active viewer so identities never share a cache. */
export function moderationQueryKey(
  relayUrl: string,
  viewerPubkey: string,
  view: ModerationSection,
): readonly ["moderation", string, string, ModerationSection] {
  return ["moderation", relayUrl, viewerPubkey, view];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseReport(value: unknown): ModerationReport | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const id = requiredText(row.id);
  const reportEventId = requiredText(row.report_event_id);
  const reporterPubkey = requiredText(row.reporter_pubkey);
  const targetKind = row.target_kind;
  const target = requiredText(row.target);
  const reportType = requiredText(row.report_type);
  const status = requiredText(row.status);
  const createdAt = requiredText(row.created_at);
  if (!id || !reportEventId || !reporterPubkey || !target || !reportType || !status) return null;
  if (!createdAt) return null;
  if (targetKind !== "event" && targetKind !== "pubkey" && targetKind !== "blob") return null;
  return {
    id,
    report_event_id: reportEventId,
    reporter_pubkey: reporterPubkey,
    target_kind: targetKind,
    target,
    channel_id: text(row.channel_id),
    report_type: reportType,
    note: text(row.note),
    status,
    resolved_by: text(row.resolved_by),
    resolved_at: text(row.resolved_at),
    action_id: text(row.action_id),
    created_at: createdAt,
  };
}

function parseAction(value: unknown): ModerationAction | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const id = requiredText(row.id);
  const actorPubkey = requiredText(row.actor_pubkey);
  const action = requiredText(row.action);
  const createdAt = requiredText(row.created_at);
  if (!id || !actorPubkey || !action || !createdAt) return null;
  return {
    id,
    actor_pubkey: actorPubkey,
    action,
    target_pubkey: text(row.target_pubkey),
    target_event_id: text(row.target_event_id),
    channel_id: text(row.channel_id),
    reason_code: text(row.reason_code),
    public_reason: text(row.public_reason),
    private_reason: text(row.private_reason),
    matched_principal: text(row.matched_principal),
    created_at: createdAt,
  };
}

function parseRestriction(value: unknown): ModerationRestriction | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const pubkey = requiredText(row.pubkey);
  const actorPubkey = requiredText(row.actor_pubkey);
  const updatedAt = requiredText(row.updated_at);
  if (!pubkey || !actorPubkey || !updatedAt || typeof row.banned !== "boolean") return null;
  return {
    pubkey,
    banned: row.banned,
    ban_expires_at: text(row.ban_expires_at),
    ban_reason: text(row.ban_reason),
    muted_until: text(row.muted_until),
    mute_reason: text(row.mute_reason),
    actor_pubkey: actorPubkey,
    updated_at: updatedAt,
  };
}

/**
 * Build the signed path with a fixed query order.
 *
 * A blank `status` is omitted on purpose: the Relay compares `status = $2`, so
 * `status=` would filter on the empty string and hide every row.
 */
function readPath(path: string, options: { status?: string; limit?: number }): string {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const params = new URLSearchParams();
  const status = options.status?.trim();
  if (status) params.set("status", status);
  params.set("limit", String(limit));
  return `${path}?${params.toString()}`;
}

async function readModeration<T>(
  relayUrl: string,
  path: string,
  parse: (row: unknown) => T | null,
): Promise<ModerationRead<T>> {
  const url = `${relayHttpOrigin(relayUrl)}${path}`;
  try {
    const authorization = await makeNip98AuthHeader(url, "GET");
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (response.status === 403) return { state: "forbidden" };
    if (response.status === 503) return { state: "timeout" };
    if (!response.ok) return { state: "error" };
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) return { state: "error" };
    const rows: T[] = [];
    for (const item of body) {
      const row = parse(item);
      // One unrecognized row fails the read: an empty queue must never stand in
      // for a response this client cannot read.
      if (row === null) return { state: "error" };
      rows.push(row);
    }
    return { state: "ok", rows };
  } catch {
    return { state: "error" };
  }
}

export function fetchModerationReports(
  relayUrl: string,
  options: { status?: string; limit?: number } = {},
): Promise<ModerationRead<ModerationReport>> {
  return readModeration(relayUrl, readPath("/moderation/reports", options), parseReport);
}

export function fetchModerationAudit(
  relayUrl: string,
  options: { limit?: number } = {},
): Promise<ModerationRead<ModerationAction>> {
  // The audit route accepts `limit` only; `status` is not part of its contract.
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  return readModeration(relayUrl, `/moderation/audit?limit=${limit}`, parseAction);
}

export function fetchModerationRestricted(
  relayUrl: string,
): Promise<ModerationRead<ModerationRestriction>> {
  return readModeration(relayUrl, "/moderation/restricted", parseRestriction);
}
