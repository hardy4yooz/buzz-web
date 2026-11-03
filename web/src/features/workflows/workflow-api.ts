/**
 * Read-only workflow history for signed-in members.
 *
 * Contract (verified in the Relay source):
 *   kind:30620 NIP-33 definition, `d` = workflow UUID, `h` = channel -> WS query
 *   GET /workflows/{workflow_id}/runs?limit=&before=&before_id=
 *     -> { runs: RunRow[], next: { before, before_id } | null }
 *
 * The runs route requires NIP-98 GET, Relay membership, and read access to the
 * workflow's channel. A denial is 403, an unknown or unreadable workflow is
 * 404, and a bad cursor is 400. A failed read is a 500 (`internal_error`), not
 * a 503: the only 503 this route can produce comes from the ban check, so every
 * 5xx is treated as one generic retryable failure. Execution events are declared
 * by the Relay but never published, so nothing here is live. Approval data
 * (`approval_ref` is a bearer capability) is never requested.
 */

import { relayHttpOrigin } from "@/shared/config/runtime-config";
import type { MessageKey } from "@/shared/i18n";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import type { NostrEvent, NostrFilter } from "@/shared/lib/nostr-client";

const READ_TIMEOUT_MS = 15_000;
const DEFINITION_LIMIT = 200;
const MAX_STEPS = 50;

export const WORKFLOW_DEFINITION_KIND = 30620;
export const WORKFLOW_DEFINITION_FILTER: NostrFilter = {
  kinds: [WORKFLOW_DEFINITION_KIND],
  limit: DEFINITION_LIMIT,
};
export const WORKFLOW_RUNS_LIMIT = 20;
export const MAX_RUNS_LIMIT = 100;
export const WORKFLOW_YAML_NAME_MAX = 120;
export const WORKFLOW_STEP_ID_MAX = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WorkflowDefinition = {
  /** Workflow UUID. Used to address the runs route; never rendered. */
  id: string;
  /** Top-level YAML `name`, or null when the definition did not supply one. */
  name: string | null;
  channelId: string | null;
  updatedAt: number;
};

export type WorkflowRunStep = { stepId: string; status: string };

export type WorkflowRun = {
  /** Run UUID. React key only; never rendered. */
  key: string;
  /** Relay value; render through `runStatusKey`, never verbatim. */
  status: string;
  currentStep: number | null;
  /** Unix seconds, or null when the Relay did not record a readable time. */
  startedAt: number | null;
  completedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  steps: WorkflowRunStep[];
};

export type RunCursor = { before: string; beforeId: string };

/**
 * Navigation gating: which answer the evidence probe gave. `checking` is the
 * pre-answer state, `absent` a successful probe with zero definitions, `error`
 * a probe that never produced an answer.
 */
export type WorkflowGate = "checking" | "present" | "absent" | "error";

export function workflowGateAfterProbe(definitionCount: number | null): WorkflowGate {
  if (definitionCount === null) return "error";
  return definitionCount > 0 ? "present" : "absent";
}

/** A failed probe must not hide a feature the Relay may still host. */
export function workflowRowVisible(gate: WorkflowGate): boolean {
  return gate === "present" || gate === "error";
}

export type WorkflowRunsPage =
  | { state: "ok"; runs: WorkflowRun[]; next: RunCursor | null; dropped: number }
  | { state: "forbidden" }
  | { state: "unavailable" }
  | { state: "error" };

export type RunsView =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "unavailable" }
  | { kind: "error" }
  | { kind: "empty" }
  | {
      kind: "ready";
      runs: WorkflowRun[];
      next: RunCursor | null;
      failedPage: boolean;
      dropped: number;
    };

/** Query keys carry the Relay and the active viewer so identities never share rows. */
export function workflowDefinitionsQueryKey(
  relayUrl: string,
  viewerPubkey: string,
): readonly ["workflows", string, string, "definitions"] {
  return ["workflows", relayUrl, viewerPubkey, "definitions"];
}

export function workflowRunsQueryKey(
  relayUrl: string,
  viewerPubkey: string,
  workflowId: string,
): readonly ["workflows", string, string, "runs", string] {
  return ["workflows", relayUrl, viewerPubkey, "runs", workflowId];
}

function tagValue(event: NostrEvent, name: string): string | null {
  if (!Array.isArray(event.tags)) return null;
  for (const tag of event.tags) {
    if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === "string" && tag[1]) {
      return tag[1];
    }
  }
  return null;
}

/**
 * The definition content is YAML and this client ships no YAML parser, so only
 * the top-level `name:` scalar is read. A nested `name:` (a step) is ignored.
 */
export function workflowNameFromYaml(content: string): string | null {
  const match = /^(?![\t ])name:[ \t]*(.*)$/m.exec(content);
  if (!match) return null;
  let value = (match[1] ?? "").trim();
  const quote = value[0];
  if ((quote === "'" || quote === '"') && value.endsWith(quote) && value.length > 1) {
    value = value.slice(1, -1).trim();
  }
  return value ? value.slice(0, WORKFLOW_YAML_NAME_MAX) : null;
}

export function isWorkflowId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** A malformed definition is dropped; it cannot be addressed or named. */
export function parseWorkflowDefinitions(events: readonly NostrEvent[]): WorkflowDefinition[] {
  const newest = new Map<string, WorkflowDefinition>();
  for (const event of events) {
    if (event.kind !== WORKFLOW_DEFINITION_KIND) continue;
    if (typeof event.created_at !== "number" || !Number.isFinite(event.created_at)) continue;
    if (typeof event.content !== "string") continue;
    const id = tagValue(event, "d");
    const channelId = tagValue(event, "h");
    if (!isWorkflowId(id) || !channelId) continue;
    const definition: WorkflowDefinition = {
      id,
      name: workflowNameFromYaml(event.content),
      channelId,
      updatedAt: event.created_at,
    };
    const dedupeKey = `${event.pubkey}:${id}`;
    const current = newest.get(dedupeKey);
    if (!current || definition.updatedAt > current.updatedAt) newest.set(dedupeKey, definition);
  }
  return [...newest.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function runStatusKey(status: string): MessageKey {
  switch (status) {
    case "pending":
      return "workflows.runStatus.pending";
    case "running":
      return "workflows.runStatus.running";
    case "completed":
      return "workflows.runStatus.completed";
    case "failed":
      return "workflows.runStatus.failed";
    case "cancelled":
      return "workflows.runStatus.cancelled";
    // `waiting_approval` is stored upstream but never produced (WF-08), so it is
    // shown as unknown rather than implying a live approval loop.
    default:
      return "workflows.runStatus.unknown";
  }
}

export function runErrorKey(code: string | null): MessageKey | null {
  if (!code) return null;
  switch (code) {
    case "approval_not_supported":
      return "workflows.error.approvalNotSupported";
    case "step_timeout":
      return "workflows.error.stepTimeout";
    case "webhook_failed":
      return "workflows.error.webhookFailed";
    case "capacity_exceeded":
      return "workflows.error.capacityExceeded";
    case "owner_unauthorized":
      return "workflows.error.ownerUnauthorized";
    case "invalid_definition":
      return "workflows.error.invalidDefinition";
    case "invalid_yaml":
      return "workflows.error.invalidYaml";
    case "condition_evaluation_failed":
      return "workflows.error.conditionFailed";
    case "template_resolution_failed":
      return "workflows.error.templateFailed";
    case "database_error":
      return "workflows.error.databaseError";
    case "action_not_implemented":
      return "workflows.error.actionNotImplemented";
    default:
      return "workflows.error.generic";
  }
}

export function stepStatusKey(status: string): MessageKey {
  switch (status) {
    case "completed":
      return "workflows.stepStatus.completed";
    case "skipped":
      return "workflows.stepStatus.skipped";
    case "failed":
      return "workflows.stepStatus.failed";
    default:
      return "workflows.stepStatus.unknown";
  }
}

export function timestampMillis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * 1_000 : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseSteps(value: unknown): WorkflowRunStep[] {
  if (!Array.isArray(value)) return [];
  const steps: WorkflowRunStep[] = [];
  for (const entry of value.slice(0, MAX_STEPS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const stepId = text(row.step_id);
    const status = text(row.status);
    if (stepId && status) {
      steps.push({ stepId: stepId.slice(0, WORKFLOW_STEP_ID_MAX), status });
    }
  }
  return steps;
}

function parseRun(value: unknown, workflowId: string): WorkflowRun | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const key = text(row.id);
  const owner = text(row.workflow_id);
  const status = text(row.status);
  const createdAt = row.created_at;
  if (!key || owner !== workflowId || !status) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  let currentStep: number | null = null;
  if (row.current_step !== null && row.current_step !== undefined) {
    if (typeof row.current_step !== "number" || !Number.isInteger(row.current_step)) return null;
    if (row.current_step < 0) return null;
    currentStep = row.current_step;
  }
  return {
    key,
    status,
    currentStep,
    startedAt:
      typeof row.started_at === "number" && Number.isFinite(row.started_at) ? row.started_at : null,
    completedAt:
      typeof row.completed_at === "number" && Number.isFinite(row.completed_at)
        ? row.completed_at
        : null,
    errorCode: text(row.error_code),
    errorMessage: text(row.error_message),
    steps: parseSteps(row.execution_trace),
  };
}

function parseCursor(value: unknown): RunCursor | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const before = text(row.before);
  const beforeId = row.before_id;
  if (!before || !isWorkflowId(beforeId)) return undefined;
  return { before, beforeId };
}

/**
 * The page envelope must be readable, but a single row the client cannot read
 * is skipped and counted instead of failing the whole history: one malformed
 * `current_step` would otherwise make every run permanently unreadable.
 */
function parseRunsBody(body: unknown, workflowId: string): WorkflowRunsPage {
  if (typeof body !== "object" || body === null) return { state: "error" };
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.runs)) return { state: "error" };
  const next = parseCursor(record.next);
  if (next === undefined) return { state: "error" };
  const runs: WorkflowRun[] = [];
  let dropped = 0;
  for (const item of record.runs) {
    const run = parseRun(item, workflowId);
    if (!run) {
      dropped += 1;
      continue;
    }
    runs.push(run);
  }
  return { state: "ok", runs, next, dropped };
}

/**
 * `GET /workflows/{id}/runs` with a NIP-98 GET signature over the exact path.
 * The Relay answers 404 for both a missing workflow and one the viewer cannot
 * read, so the UI must not turn that into "no runs".
 */
export async function fetchWorkflowRuns(
  relayUrl: string,
  workflowId: string,
  options: { cursor?: RunCursor | null; limit?: number } = {},
): Promise<WorkflowRunsPage> {
  if (!isWorkflowId(workflowId)) return { state: "error" };
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? WORKFLOW_RUNS_LIMIT), 1),
    MAX_RUNS_LIMIT,
  );
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.cursor) {
    params.set("before", options.cursor.before);
    params.set("before_id", options.cursor.beforeId);
  }
  const url = `${relayHttpOrigin(relayUrl)}/workflows/${workflowId}/runs?${params.toString()}`;
  try {
    const authorization = await makeNip98AuthHeader(url, "GET");
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) return { state: "forbidden" };
    if (response.status === 404) return { state: "unavailable" };
    if (!response.ok) return { state: "error" };
    const body: unknown = await response.json().catch(() => null);
    return parseRunsBody(body, workflowId);
  } catch {
    return { state: "error" };
  }
}

/** Picks one honest view: no page is never "empty", and a failed page is flagged. */
export function selectRunsView(
  pages: readonly WorkflowRunsPage[] | undefined,
  pending: boolean,
): RunsView {
  if (!pages || pages.length === 0) return pending ? { kind: "loading" } : { kind: "error" };
  const first = pages[0];
  if (!first) return { kind: "error" };
  if (first.state === "forbidden") return { kind: "forbidden" };
  if (first.state === "unavailable") return { kind: "unavailable" };
  if (first.state === "error") return { kind: "error" };
  const runs = [...first.runs];
  let next = first.next;
  let dropped = first.dropped;
  let failedPage = false;
  for (const page of pages.slice(1)) {
    if (page.state !== "ok") {
      failedPage = true;
      break;
    }
    runs.push(...page.runs);
    next = page.next;
    dropped += page.dropped;
  }
  // A page whose rows were all unreadable is a notice, not "no runs".
  if (runs.length === 0 && dropped === 0) return { kind: "empty" };
  return { kind: "ready", runs, next, failedPage, dropped };
}
