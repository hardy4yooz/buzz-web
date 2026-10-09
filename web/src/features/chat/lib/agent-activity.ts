import { verifyEvent } from "nostr-tools/pure";
import type { NostrEvent, RelayConnectionState } from "@/shared/api/nostr-types";

export const AGENT_OBSERVER_FRAME_KIND = 24200;
export const OBSERVER_FRESHNESS_MS = 12_000;
export const OBSERVER_VISIBLE_QUIET_MS = 45_000;
export const OBSERVER_PENDING_TTL_MS = 120_000;
const MAX_RECORDS = 128;
const MAX_DEDUPE_KEYS = 512;
const MAX_SUBMISSIONS = 128;
const MAX_HISTORY_ITEMS = 120;
const MAX_CORRELATIONS = 256;
const MAX_BATCH_FRAMES = 64;
const MAX_IDENTIFIER_CHARS = 512;
const MAX_KIND_CHARS = 128;
const MAX_DETAIL_CHARS = 1_000;

export type ObserverFrame = {
  seq: number;
  timestamp: string;
  kind: string;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  payload: unknown;
};

export type ActivityState =
  | "working"
  | "thinking"
  | "tool"
  | "responding"
  | "quiet"
  | "reconnecting"
  | "disconnected"
  | "unavailable";

export type ActivityDetail = "fresh" | "waiting" | "silent" | "connection" | "signer";

export type AgentActivityStatus = {
  agentPubkey: string;
  state: ActivityState;
  detail: ActivityDetail;
  summary: string | null;
  lastUpdatedAt: number | null;
};

type ActivityRecord = {
  agentPubkey: string;
  channelId: string;
  frame: ObserverFrame;
  receivedAt: number;
};

export type ObserverFramePresentation = {
  state: Exclude<ActivityState, "reconnecting" | "disconnected" | "unavailable">;
  title: string;
  detail: string | null;
};

export type AgentActivityItem = ActivityRecord & {
  id: string;
  presentation: ObserverFramePresentation;
};

function normalized(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  return candidate || null;
}

function tagValue(event: NostrEvent, name: string): string | null {
  const tag = event.tags.find((candidate) => candidate[0] === name);
  return typeof tag?.[1] === "string" ? tag[1] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function boundedProtocolString(value: unknown, maximum: number): string | null {
  const text = optionalString(value);
  return text && text.length <= maximum ? text : null;
}

function optionalProtocolString(value: unknown, maximum: number): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  return boundedProtocolString(value, maximum) ?? undefined;
}

/** Validate only the signed envelope; encrypted content is parsed after decrypting. */
export function validateObserverEvent(
  event: NostrEvent,
  ownerPubkey: string,
  knownAgentPubkeys?: ReadonlySet<string>,
): string | null {
  if (event.kind !== AGENT_OBSERVER_FRAME_KIND || typeof event.content !== "string") return null;
  try {
    if (!verifyEvent(event)) return null;
  } catch {
    return null;
  }
  const owner = normalized(ownerPubkey);
  const agent = normalized(tagValue(event, "agent"));
  const frame = normalized(tagValue(event, "frame"));
  const recipient = normalized(tagValue(event, "p"));
  if (
    !owner ||
    !/^[0-9a-f]{64}$/.test(owner) ||
    !agent ||
    !/^[0-9a-f]{64}$/.test(agent) ||
    frame !== "telemetry" ||
    recipient !== owner
  ) {
    return null;
  }
  if (normalized(event.pubkey) !== agent) return null;
  return knownAgentPubkeys && !knownAgentPubkeys.has(agent) ? null : agent;
}

export function parseObserverFrame(value: unknown): ObserverFrame | null {
  if (!isRecord(value)) return null;
  const timestamp = boundedProtocolString(value.timestamp, 64);
  const kind = boundedProtocolString(value.kind, MAX_KIND_CHARS);
  const channelId = optionalProtocolString(value.channelId, MAX_IDENTIFIER_CHARS);
  const sessionId = optionalProtocolString(value.sessionId, MAX_IDENTIFIER_CHARS);
  const turnId = optionalProtocolString(value.turnId, MAX_IDENTIFIER_CHARS);
  if (
    typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0 ||
    !timestamp ||
    !kind ||
    channelId === undefined ||
    sessionId === undefined ||
    turnId === undefined ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    return null;
  }
  return {
    seq: value.seq,
    timestamp,
    kind,
    channelId,
    sessionId,
    turnId,
    payload: value.payload,
  };
}

/** Expand the observer pacer's batch envelope without retaining the envelope itself. */
export function unwrapObserverBatch(frame: ObserverFrame): ObserverFrame[] {
  if (frame.kind.toLowerCase() !== "batch") return [frame];
  const events = isRecord(frame.payload) ? frame.payload.events : null;
  if (!Array.isArray(events)) return [frame];
  const inner = events
    .slice(0, MAX_BATCH_FRAMES)
    .map(parseObserverFrame)
    .filter((candidate): candidate is ObserverFrame => Boolean(candidate));
  return inner.length ? inner : [frame];
}

function payloadString(value: unknown, key: string): string | null {
  return isRecord(value) ? boundedProtocolString(value[key], MAX_KIND_CHARS) : null;
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    const candidate = optionalString(value);
    if (candidate) return candidate;
  }
  return null;
}

function frameUpdate(frame: ObserverFrame): Record<string, unknown> | null {
  const params = isRecord(frame.payload) ? frame.payload.params : null;
  const update = isRecord(params) ? params.update : null;
  return isRecord(update) ? update : null;
}

function toolArgs(update: Record<string, unknown>): Record<string, unknown> {
  for (const candidate of [update.args, update.arguments, update.input, update.rawInput]) {
    if (isRecord(candidate)) return candidate;
  }
  return {};
}

function looksLikeStructuredJson(value: string): boolean {
  const text = value.trim();
  if (
    !(text.startsWith("{") && text.endsWith("}")) &&
    !(text.startsWith("[") && text.endsWith("]"))
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

function sanitizedCommand(value: unknown): string | null {
  const rawCommand = optionalString(value);
  const command =
    rawCommand && rawCommand.length > MAX_DETAIL_CHARS
      ? `${rawCommand.slice(0, MAX_DETAIL_CHARS)}…`
      : rawCommand;
  if (!command || looksLikeStructuredJson(command)) return null;
  return command
    .replace(/\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}\b/gi, "<redacted>")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})\b/g,
      "<redacted>",
    )
    .replace(/\b[0-9a-f]{64}\b/gi, "<redacted>")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(
      /\b(api[_-]?key|access[_-]?token|authorization|password|passwd|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1=<redacted>",
    )
    .replace(/(^|[\s"'=])\/(?:[^\s"']+)/g, "$1<path>")
    .replace(/\b[A-Za-z]:\\(?:[^\s"']+)/g, "<path>");
}

function safeToolTitle(values: unknown[]): string {
  const title = firstString(values);
  return title && /^[A-Za-z0-9_.:-]{1,80}$/.test(title) ? title : "tool_call";
}

function compactSummary(presentation: ObserverFramePresentation): string | null {
  if (presentation.detail) return presentation.detail;
  return presentation.state === "tool" ? presentation.title : null;
}

/** Map wire kinds to non-sensitive lifecycle categories only. */
export function classifyObserverFrame(
  frame: ObserverFrame,
): Exclude<ActivityState, "reconnecting" | "disconnected" | "unavailable"> {
  const kind = frame.kind.toLowerCase();
  if (["turn_completed", "turn_error", "agent_panic"].includes(kind)) return "quiet";
  if (
    ["turn_started", "session_resolved", "turn_liveness", "session_config_captured"].includes(kind)
  ) {
    return "working";
  }

  const payload = frame.payload;
  const method = payloadString(payload, "method");
  const params = isRecord(payload) ? payload.params : null;
  const update = isRecord(params) ? params.update : null;
  const updateType = payloadString(update, "sessionUpdate");
  if (updateType === "agent_thought_chunk") return "thinking";
  if (updateType === "agent_message_chunk") return "responding";
  if (updateType === "tool_call" || updateType === "tool_call_update") return "tool";
  if (method === "session/prompt" || method === "session/update") return "working";
  return kind.includes("thought") ? "thinking" : kind.includes("tool") ? "tool" : "working";
}

/** Describe a frame with the concrete command/tool evidence used by Buzz Desktop. */
export function describeObserverFrame(frame: ObserverFrame): ObserverFramePresentation {
  const state = classifyObserverFrame(frame);
  const payload = isRecord(frame.payload) ? frame.payload : null;
  const update = frameUpdate(frame);
  const updateType = payloadString(update, "sessionUpdate");
  if (update && (updateType === "tool_call" || updateType === "tool_call_update")) {
    const args = toolArgs(update);
    const nestedTool = isRecord(update.tool) ? update.tool : null;
    const title = safeToolTitle([
      update.toolName,
      update.tool_name,
      update.title,
      update.kind,
      update.name,
      nestedTool?.name,
    ]);
    const detail = sanitizedCommand(firstString([args.command, args.cmd]));
    return { state, title, detail };
  }

  const method = payloadString(payload, "method");
  return {
    state,
    title: updateType ?? method ?? frame.kind,
    detail: null,
  };
}

function compareFrames(left: ObserverFrame, right: ObserverFrame): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.seq - right.seq;
}

function recordKey(agentPubkey: string, channelId: string): string {
  return `${agentPubkey}|${channelId}`;
}

function submissionKey(agentPubkey: string, channelId: string): string {
  return `${agentPubkey}|${channelId}`;
}

export class AgentActivityStore {
  private readonly records = new Map<string, ActivityRecord>();
  private readonly dedupeKeys = new Set<string>();
  private readonly submissions = new Map<string, number>();
  private readonly history: ActivityRecord[] = [];
  private readonly correlations = new Map<string, string | null>();

  markSubmitted(
    channelId: string,
    agentPubkeys: readonly string[],
    submittedAt = Date.now(),
  ): void {
    if (!channelId) return;
    for (const value of new Set(agentPubkeys.map((candidate) => candidate.toLowerCase()))) {
      if (/^[0-9a-f]{64}$/.test(value))
        this.submissions.set(submissionKey(value, channelId), submittedAt);
    }
    while (this.submissions.size > MAX_SUBMISSIONS)
      this.submissions.delete(this.submissions.keys().next().value as string);
  }

  ingest(agentPubkey: string, frame: ObserverFrame, receivedAt = Date.now()): boolean {
    const agent = agentPubkey.toLowerCase();
    const dedupeKey = `${agent}|${frame.seq}|${frame.timestamp}`;
    if (this.dedupeKeys.has(dedupeKey)) return false;
    const channelId = this.resolveChannel(agent, frame);
    if (!channelId) return false;
    this.dedupeKeys.add(dedupeKey);
    while (this.dedupeKeys.size > MAX_DEDUPE_KEYS)
      this.dedupeKeys.delete(this.dedupeKeys.values().next().value as string);

    const record = { agentPubkey: agent, channelId, frame, receivedAt };
    this.history.push(record);
    this.history.sort((left, right) => {
      const byFrame = compareFrames(left.frame, right.frame);
      return byFrame || left.receivedAt - right.receivedAt;
    });
    if (this.history.length > MAX_HISTORY_ITEMS) {
      this.history.splice(0, this.history.length - MAX_HISTORY_ITEMS);
    }

    const key = recordKey(agent, channelId);
    const current = this.records.get(key);
    if (!current || compareFrames(frame, current.frame) > 0) this.records.set(key, record);
    while (this.records.size > MAX_RECORDS)
      this.records.delete(this.records.keys().next().value as string);
    return true;
  }

  private resolveChannel(agentPubkey: string, frame: ObserverFrame): string | null {
    if (frame.channelId) {
      this.rememberCorrelation(agentPubkey, frame, frame.channelId);
      return frame.channelId;
    }
    const turnChannel = frame.turnId
      ? this.correlatedChannel(`${agentPubkey}|turn|${frame.turnId}`)
      : undefined;
    if (turnChannel !== undefined) return turnChannel;
    return frame.sessionId
      ? (this.correlatedChannel(`${agentPubkey}|session|${frame.sessionId}`) ?? null)
      : null;
  }

  private rememberCorrelation(agentPubkey: string, frame: ObserverFrame, channelId: string): void {
    if (frame.turnId) this.rememberChannel(`${agentPubkey}|turn|${frame.turnId}`, channelId);
    if (frame.sessionId)
      this.rememberChannel(`${agentPubkey}|session|${frame.sessionId}`, channelId);
    while (this.correlations.size > MAX_CORRELATIONS) {
      this.correlations.delete(this.correlations.keys().next().value as string);
    }
  }

  private correlatedChannel(key: string): string | null | undefined {
    return this.correlations.has(key) ? (this.correlations.get(key) ?? null) : undefined;
  }

  private rememberChannel(key: string, channelId: string): void {
    const current = this.correlations.get(key);
    if (current === undefined) this.correlations.set(key, channelId);
    else if (current !== channelId) this.correlations.set(key, null);
  }

  getItems(
    channelId: string,
    agentPubkeys: readonly string[],
    limit = MAX_HISTORY_ITEMS,
  ): AgentActivityItem[] {
    const agents = new Set(agentPubkeys.map((value) => value.toLowerCase()));
    return this.history
      .filter((record) => record.channelId === channelId && agents.has(record.agentPubkey))
      .slice(-Math.max(0, Math.min(limit, MAX_HISTORY_ITEMS)))
      .map((record) => ({
        ...record,
        id: `${record.agentPubkey}:${record.frame.seq}:${record.frame.timestamp}`,
        presentation: describeObserverFrame(record.frame),
      }));
  }

  getStatuses(
    channelId: string,
    agentPubkeys: readonly string[],
    connection: RelayConnectionState,
    nip44Available: boolean,
    now = Date.now(),
  ): AgentActivityStatus[] {
    const statuses: AgentActivityStatus[] = [];
    const agents = [...new Set(agentPubkeys.map((value) => value.toLowerCase()))].filter((value) =>
      /^[0-9a-f]{64}$/.test(value),
    );
    for (const agentPubkey of agents) {
      const submittedAt = this.submissions.get(submissionKey(agentPubkey, channelId));
      const pending = submittedAt !== undefined && now - submittedAt <= OBSERVER_PENDING_TTL_MS;
      const candidates = [...this.records.values()].filter(
        (record) => record.agentPubkey === agentPubkey && record.channelId === channelId,
      );
      const sortedCandidates = candidates.sort((left, right) => {
        const byFrame = compareFrames(left.frame, right.frame);
        return byFrame || left.receivedAt - right.receivedAt;
      });
      const newestRecord = sortedCandidates[sortedCandidates.length - 1];
      const record =
        pending && submittedAt !== undefined && (newestRecord?.receivedAt ?? 0) < submittedAt
          ? undefined
          : newestRecord;
      const recent = record !== undefined && now - record.receivedAt <= OBSERVER_VISIBLE_QUIET_MS;
      if (!pending && !recent) continue;
      if (!nip44Available && pending) {
        statuses.push({
          agentPubkey,
          state: "unavailable",
          detail: "signer",
          summary: null,
          lastUpdatedAt: null,
        });
        continue;
      }
      if (connection === "disconnected" && (pending || recent)) {
        statuses.push({
          agentPubkey,
          state: "disconnected",
          detail: "connection",
          summary: record ? describeObserverFrame(record.frame).detail : null,
          lastUpdatedAt: record?.receivedAt ?? null,
        });
        continue;
      }
      if ((connection === "connecting" || connection === "reconnecting") && (pending || recent)) {
        statuses.push({
          agentPubkey,
          state: "reconnecting",
          detail: "connection",
          summary: record ? describeObserverFrame(record.frame).detail : null,
          lastUpdatedAt: record?.receivedAt ?? null,
        });
        continue;
      }
      if (!record) {
        statuses.push({
          agentPubkey,
          state: now - (submittedAt ?? now) <= 3_000 ? "working" : "quiet",
          detail: "waiting",
          summary: null,
          lastUpdatedAt: null,
        });
        continue;
      }
      const state =
        now - record.receivedAt <= OBSERVER_FRESHNESS_MS
          ? classifyObserverFrame(record.frame)
          : "quiet";
      const presentation = describeObserverFrame(record.frame);
      statuses.push({
        agentPubkey,
        state,
        detail: state === "quiet" ? "silent" : "fresh",
        summary: compactSummary(presentation),
        lastUpdatedAt: record.receivedAt,
      });
    }
    return statuses;
  }
}
