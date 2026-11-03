import { generateSecretKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWorkflowRuns,
  MAX_RUNS_LIMIT,
  parseWorkflowDefinitions,
  runErrorKey,
  runStatusKey,
  selectRunsView,
  stepStatusKey,
  timestampMillis,
  WORKFLOW_DEFINITION_FILTER,
  WORKFLOW_DEFINITION_KIND,
  WORKFLOW_RUNS_LIMIT,
  WORKFLOW_STEP_ID_MAX,
  WORKFLOW_YAML_NAME_MAX,
  type WorkflowRun,
  type WorkflowRunsPage,
  workflowDefinitionsQueryKey,
  workflowGateAfterProbe,
  workflowRowVisible,
  workflowRunsQueryKey,
} from "@/features/workflows/workflow-api";
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { activateLocalSigner, clearActiveSigner } from "@/shared/lib/nostr-signer";

const RELAY = "wss://relay.example.com";
const ORIGIN = "https://relay.example.com";
const VIEWER = "d".repeat(64);
const WORKFLOW_ID = "0b0f3f4e-6a64-4c1e-9d3f-5b1f2c8aa111";
const OTHER_WORKFLOW_ID = "0b0f3f4e-6a64-4c1e-9d3f-5b1f2c8aa222";
const CHANNEL_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_CHANNEL_ID = "99999999-2222-4333-8444-555555555555";
const RUN_ID = "0b0f3f4e-6a64-4c1e-9d3f-5b1f2c8aa333";

const RUN = {
  id: RUN_ID,
  workflow_id: WORKFLOW_ID,
  status: "completed",
  current_step: 2,
  execution_trace: [
    { step_id: "fetch", status: "completed", output: { body: "WEBHOOK_BODY" } },
    { step_id: "notify", status: "skipped" },
  ],
  started_at: 1_700_000_000,
  completed_at: 1_700_000_060,
  error_code: null,
  error_message: null,
  created_at: 1_700_000_000,
};

function definition(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1_700_000_000,
    kind: WORKFLOW_DEFINITION_KIND,
    tags: [
      ["d", WORKFLOW_ID],
      ["h", CHANNEL_ID],
    ],
    content: "name: Daily digest\nsteps: []\n",
    sig: "0".repeat(128),
    ...overrides,
  } as NostrEvent;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function signedHeader(init?: RequestInit): { pubkey: string; tags: string[][] } {
  const authorization = new Headers(init?.headers).get("Authorization") ?? "";
  expect(authorization.startsWith("Nostr ")).toBe(true);
  return JSON.parse(atob(authorization.slice("Nostr ".length))) as {
    pubkey: string;
    tags: string[][];
  };
}

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    response(),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  clearActiveSigner();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workflow definition discovery", () => {
  it("uses the channel-scoped NIP-33 kind the Relay stores", () => {
    expect(WORKFLOW_DEFINITION_KIND).toBe(30620);
    expect(WORKFLOW_DEFINITION_FILTER).toEqual({ kinds: [30620], limit: 200 });
  });

  it("maps the definition event and keeps the newest revision per author and id", () => {
    const definitions = parseWorkflowDefinitions([
      definition({ created_at: 1_700_000_100, content: "name: Newer\nsteps: []\n" }),
      definition({ created_at: 1_700_000_000, content: "name: Older\nsteps: []\n" }),
      definition({
        id: "c".repeat(64),
        pubkey: "e".repeat(64),
        created_at: 1_700_000_200,
        tags: [
          ["d", OTHER_WORKFLOW_ID],
          ["h", OTHER_CHANNEL_ID],
        ],
        content: "name: Someone else\nsteps: []\n",
      }),
    ]);

    expect(definitions).toEqual([
      {
        id: OTHER_WORKFLOW_ID,
        name: "Someone else",
        channelId: OTHER_CHANNEL_ID,
        updatedAt: 1_700_000_200,
      },
      { id: WORKFLOW_ID, name: "Newer", channelId: CHANNEL_ID, updatedAt: 1_700_000_100 },
    ]);
  });

  it("drops definitions the client cannot address or display honestly", () => {
    const definitions = parseWorkflowDefinitions([
      // Not a UUID: the runs route only accepts UUIDs.
      definition({
        tags: [
          ["d", "not-a-uuid"],
          ["h", CHANNEL_ID],
        ],
      }),
      // No channel tag: the Relay always scopes a definition to one channel.
      definition({ tags: [["d", WORKFLOW_ID]] }),
      // No id tag at all.
      definition({ tags: [["h", CHANNEL_ID]] }),
      // Non-string content cannot be given a name.
      definition({ content: undefined }),
      definition({ id: "f".repeat(64), tags: [["d", OTHER_WORKFLOW_ID]] }),
    ]);

    expect(definitions).toEqual([]);
  });

  it("reads only a top-level YAML name and unquotes it", () => {
    const [plain, quoted, nested, empty] = parseWorkflowDefinitions([
      definition({
        created_at: 1_700_000_300,
        content: "name: Daily digest\nsteps: []\n",
      }),
      definition({
        id: "c".repeat(64),
        created_at: 1_700_000_200,
        tags: [
          ["d", "0b0f3f4e-6a64-4c1e-9d3f-5b1f2c8aa301"],
          ["h", CHANNEL_ID],
        ],
        content: "name: 'Nightly backup'\nsteps:\n  - name: Not the workflow\n",
      }),
      definition({
        id: "d".repeat(64),
        created_at: 1_700_000_100,
        tags: [
          ["d", "0b0f3f4e-6a64-4c1e-9d3f-5b1f2c8aa302"],
          ["h", CHANNEL_ID],
        ],
        content: "steps:\n  - name: Not the workflow\n",
      }),
      definition({
        id: "e".repeat(64),
        created_at: 1_700_000_000,
        tags: [
          ["d", "0b0f3f4e-6a64-4c1e-9d3f-5b1f2c8aa303"],
          ["h", CHANNEL_ID],
        ],
        content: "name: '   '\n",
      }),
    ]);
    expect(plain?.name).toBe("Daily digest");
    expect(quoted?.name).toBe("Nightly backup");
    expect(nested?.name).toBeNull();
    expect(empty?.name).toBeNull();
  });

  it("bounds a name the YAML supplied", () => {
    const [long] = parseWorkflowDefinitions([
      definition({ content: `name: ${"x".repeat(WORKFLOW_YAML_NAME_MAX + 40)}\n` }),
    ]);
    expect(long?.name).toHaveLength(WORKFLOW_YAML_NAME_MAX);
  });
});

describe("workflow query keys", () => {
  it("scopes definitions and runs to the Relay and the active viewer", () => {
    expect(workflowDefinitionsQueryKey(RELAY, VIEWER)).toEqual([
      "workflows",
      RELAY,
      VIEWER,
      "definitions",
    ]);
    expect(workflowRunsQueryKey(RELAY, VIEWER, WORKFLOW_ID)).toEqual([
      "workflows",
      RELAY,
      VIEWER,
      "runs",
      WORKFLOW_ID,
    ]);
    expect(workflowDefinitionsQueryKey("wss://other.example.com", VIEWER)).not.toEqual(
      workflowDefinitionsQueryKey(RELAY, VIEWER),
    );
    expect(workflowRunsQueryKey(RELAY, "e".repeat(64), WORKFLOW_ID)).not.toEqual(
      workflowRunsQueryKey(RELAY, VIEWER, WORKFLOW_ID),
    );
    expect(workflowRunsQueryKey(RELAY, VIEWER, OTHER_WORKFLOW_ID)).not.toEqual(
      workflowRunsQueryKey(RELAY, VIEWER, WORKFLOW_ID),
    );
  });
});

describe("workflow navigation gate", () => {
  it("hides the row only when a successful probe found no definitions", () => {
    expect(workflowGateAfterProbe(0)).toBe("absent");
    expect(workflowRowVisible("absent")).toBe(false);
    expect(workflowGateAfterProbe(2)).toBe("present");
    expect(workflowRowVisible("present")).toBe(true);
  });

  it("keeps the row visible when the probe failed", () => {
    // A failed probe is "unknown", not "this Relay has no workflows": hiding a
    // shipped feature on a timeout is the bug this state exists to prevent.
    expect(workflowGateAfterProbe(null)).toBe("error");
    expect(workflowRowVisible("error")).toBe(true);
  });

  it("does not reveal the row before the first probe answers", () => {
    expect(workflowRowVisible("checking")).toBe(false);
  });

  it("lets a later successful probe refine a failed one", () => {
    expect(workflowGateAfterProbe(1)).toBe("present");
    expect(workflowGateAfterProbe(0)).toBe("absent");
  });
});

describe("run status and failure mapping", () => {
  it("labels every status the Relay can store", () => {
    expect(runStatusKey("pending")).toBe("workflows.runStatus.pending");
    expect(runStatusKey("running")).toBe("workflows.runStatus.running");
    expect(runStatusKey("completed")).toBe("workflows.runStatus.completed");
    expect(runStatusKey("failed")).toBe("workflows.runStatus.failed");
    expect(runStatusKey("cancelled")).toBe("workflows.runStatus.cancelled");
  });

  it("never presents an approval wait the Relay cannot produce", () => {
    // Approval gates are unimplemented upstream (WF-08); an unrecognized status
    // is shown as unknown rather than implying a live approval loop.
    expect(runStatusKey("waiting_approval")).toBe("workflows.runStatus.unknown");
    expect(runStatusKey("something_new")).toBe("workflows.runStatus.unknown");
  });

  it("maps stable failure codes and falls back to a generic label", () => {
    expect(runErrorKey(null)).toBeNull();
    expect(runErrorKey("approval_not_supported")).toBe("workflows.error.approvalNotSupported");
    expect(runErrorKey("step_timeout")).toBe("workflows.error.stepTimeout");
    expect(runErrorKey("webhook_failed")).toBe("workflows.error.webhookFailed");
    expect(runErrorKey("capacity_exceeded")).toBe("workflows.error.capacityExceeded");
    expect(runErrorKey("owner_unauthorized")).toBe("workflows.error.ownerUnauthorized");
    expect(runErrorKey("invalid_definition")).toBe("workflows.error.invalidDefinition");
    expect(runErrorKey("invalid_yaml")).toBe("workflows.error.invalidYaml");
    expect(runErrorKey("condition_evaluation_failed")).toBe("workflows.error.conditionFailed");
    expect(runErrorKey("template_resolution_failed")).toBe("workflows.error.templateFailed");
    expect(runErrorKey("database_error")).toBe("workflows.error.databaseError");
    expect(runErrorKey("action_not_implemented")).toBe("workflows.error.actionNotImplemented");
    expect(runErrorKey("a_new_code")).toBe("workflows.error.generic");
  });

  it("maps step statuses, including ones this client has not seen", () => {
    expect(stepStatusKey("completed")).toBe("workflows.stepStatus.completed");
    expect(stepStatusKey("skipped")).toBe("workflows.stepStatus.skipped");
    expect(stepStatusKey("failed")).toBe("workflows.stepStatus.failed");
    expect(stepStatusKey("brand_new")).toBe("workflows.stepStatus.unknown");
  });

  it("converts only finite unix seconds and treats other values as unknown", () => {
    expect(timestampMillis(1_700_000_000)).toBe(1_700_000_000_000);
    expect(timestampMillis(null)).toBeNull();
    expect(timestampMillis(undefined)).toBeNull();
    expect(timestampMillis("1700000000")).toBeNull();
    expect(timestampMillis(Number.NaN)).toBeNull();
    expect(timestampMillis(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("fetchWorkflowRuns", () => {
  it("signs a NIP-98 GET for the exact runs URL and parses the page", async () => {
    activateLocalSigner(generateSecretKey());
    const fetchMock = stubFetch(() => jsonResponse({ runs: [RUN], next: null }));

    const result = await fetchWorkflowRuns(RELAY, WORKFLOW_ID);

    expect(result).toEqual({
      state: "ok",
      runs: [
        {
          key: RUN_ID,
          status: "completed",
          currentStep: 2,
          startedAt: 1_700_000_000,
          completedAt: 1_700_000_060,
          errorCode: null,
          errorMessage: null,
          steps: [
            { stepId: "fetch", status: "completed" },
            { stepId: "notify", status: "skipped" },
          ],
        },
      ],
      next: null,
      dropped: 0,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${ORIGIN}/workflows/${WORKFLOW_ID}/runs?limit=${WORKFLOW_RUNS_LIMIT}`);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    const signed = signedHeader(init);
    expect(signed.tags).toContainEqual([
      "u",
      `${ORIGIN}/workflows/${WORKFLOW_ID}/runs?limit=${WORKFLOW_RUNS_LIMIT}`,
    ]);
    expect(signed.tags).toContainEqual(["method", "GET"]);
    expect(signed.tags).toContainEqual(["nonce", expect.any(String)]);
    expect(signed.tags.some((tag) => tag[0] === "payload")).toBe(false);
  });

  it("passes the returned cursor through in the signed URL", async () => {
    activateLocalSigner(generateSecretKey());
    const cursor = { before: "2026-11-01T10:00:00Z", beforeId: RUN_ID };
    const fetchMock = stubFetch(() =>
      jsonResponse({ runs: [], next: { before: "2026-11-01T09:00:00Z", before_id: RUN_ID } }),
    );

    const result = await fetchWorkflowRuns(RELAY, WORKFLOW_ID, { cursor });

    expect(result).toEqual({
      state: "ok",
      runs: [],
      next: { before: "2026-11-01T09:00:00Z", beforeId: RUN_ID },
      dropped: 0,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      `${ORIGIN}/workflows/${WORKFLOW_ID}/runs?limit=${WORKFLOW_RUNS_LIMIT}` +
        "&before=2026-11-01T10%3A00%3A00Z&before_id=" +
        RUN_ID,
    );
    expect(signedHeader(init).tags).toContainEqual(["u", url]);
  });

  it("clamps the limit to the Relay's accepted range", async () => {
    activateLocalSigner(generateSecretKey());
    const fetchMock = stubFetch(() => jsonResponse({ runs: [], next: null }));

    await fetchWorkflowRuns(RELAY, WORKFLOW_ID, { limit: 0 });
    await fetchWorkflowRuns(RELAY, WORKFLOW_ID, { limit: 10_000 });
    await fetchWorkflowRuns(RELAY, WORKFLOW_ID, { limit: 12.9 });

    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls[0]).toBe(`${ORIGIN}/workflows/${WORKFLOW_ID}/runs?limit=1`);
    expect(urls[1]).toBe(`${ORIGIN}/workflows/${WORKFLOW_ID}/runs?limit=${MAX_RUNS_LIMIT}`);
    expect(urls[2]).toBe(`${ORIGIN}/workflows/${WORKFLOW_ID}/runs?limit=12`);
  });

  it("refuses to call the Relay with an id it cannot route", async () => {
    activateLocalSigner(generateSecretKey());
    const fetchMock = stubFetch(() => jsonResponse({ runs: [], next: null }));

    await expect(fetchWorkflowRuns(RELAY, "not-a-uuid")).resolves.toEqual({ state: "error" });
    await expect(fetchWorkflowRuns(RELAY, "")).resolves.toEqual({ state: "error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports denials and unavailable workflows, and treats every 5xx as retryable", async () => {
    activateLocalSigner(generateSecretKey());
    const cases: [number, WorkflowRunsPage][] = [
      [401, { state: "forbidden" }],
      [403, { state: "forbidden" }],
      [404, { state: "unavailable" }],
      [400, { state: "error" }],
      [500, { state: "error" }],
      // This route maps a failed read to 500; a 503 here is the ban-check
      // failure, not a run-history statement timeout, so it stays retryable.
      [503, { state: "error" }],
    ];
    for (const [status, expected] of cases) {
      vi.unstubAllGlobals();
      stubFetch(() => jsonResponse({ error: "detail" }, status));
      await expect(fetchWorkflowRuns(RELAY, WORKFLOW_ID)).resolves.toEqual(expected);
    }
  });

  it("treats a network failure or an aborted request as a generic error", async () => {
    activateLocalSigner(generateSecretKey());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    );

    await expect(fetchWorkflowRuns(RELAY, WORKFLOW_ID)).resolves.toEqual({ state: "error" });
  });

  it("fails a read it cannot fully understand instead of showing a partial history", async () => {
    activateLocalSigner(generateSecretKey());
    const bodies = [
      { rows: [] },
      { runs: {} },
      { runs: [RUN], next: { before: "2026-11-01T10:00:00Z" } },
      { runs: [RUN], next: { before: 7, before_id: RUN_ID } },
      { runs: [RUN], next: { before: "2026-11-01T10:00:00Z", before_id: "x" } },
    ];
    for (const body of bodies) {
      vi.unstubAllGlobals();
      stubFetch(() => jsonResponse(body));
      await expect(fetchWorkflowRuns(RELAY, WORKFLOW_ID)).resolves.toEqual({ state: "error" });
    }
  });

  it("skips a run row it cannot read and keeps the rows around it", async () => {
    activateLocalSigner(generateSecretKey());
    const unreadable = [
      { ...RUN, status: 7 },
      { ...RUN, status: "" },
      { ...RUN, created_at: "yesterday" },
      { ...RUN, current_step: "two" },
      { ...RUN, workflow_id: OTHER_WORKFLOW_ID },
    ];
    for (const row of unreadable) {
      vi.unstubAllGlobals();
      stubFetch(() => jsonResponse({ runs: [row, RUN], next: null }));
      const result = await fetchWorkflowRuns(RELAY, WORKFLOW_ID);
      expect(result.state).toBe("ok");
      if (result.state !== "ok") throw new Error("expected an ok read");
      expect(result.runs.map((run) => run.key)).toEqual([RUN_ID]);
      expect(result.dropped).toBe(1);
    }
  });

  it("keeps an unreadable-only page as a notice, never as an empty history", async () => {
    activateLocalSigner(generateSecretKey());
    stubFetch(() =>
      jsonResponse({
        runs: [
          { ...RUN, status: 7 },
          { ...RUN, created_at: null },
        ],
        next: null,
      }),
    );

    const result = await fetchWorkflowRuns(RELAY, WORKFLOW_ID);
    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected an ok read");
    expect(result.runs).toEqual([]);
    expect(result.dropped).toBe(2);
    expect(selectRunsView([result], false)).toEqual({
      kind: "ready",
      runs: [],
      next: null,
      failedPage: false,
      dropped: 2,
    });
  });

  it("clamps a hostile step id to the display bound", async () => {
    activateLocalSigner(generateSecretKey());
    stubFetch(() =>
      jsonResponse({
        runs: [
          {
            ...RUN,
            execution_trace: [{ step_id: "s".repeat(400), status: "completed" }],
          },
        ],
        next: null,
      }),
    );

    const result = await fetchWorkflowRuns(RELAY, WORKFLOW_ID);
    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected an ok read");
    expect(result.runs[0]?.steps[0]?.stepId).toHaveLength(WORKFLOW_STEP_ID_MAX);
  });

  it("keeps a run with an unknown status or unknown timestamps", async () => {
    activateLocalSigner(generateSecretKey());
    stubFetch(() =>
      jsonResponse({
        runs: [
          {
            ...RUN,
            status: "waiting_approval",
            current_step: null,
            started_at: "not-a-time",
            completed_at: null,
            error_code: "a_new_code",
            error_message: "DIAGNOSTIC_TEXT",
            execution_trace: "not-a-trace",
          },
        ],
        next: null,
      }),
    );

    const result = await fetchWorkflowRuns(RELAY, WORKFLOW_ID);
    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected an ok read");
    expect(result.runs[0]).toEqual({
      key: RUN_ID,
      status: "waiting_approval",
      currentStep: null,
      startedAt: null,
      completedAt: null,
      errorCode: "a_new_code",
      errorMessage: "DIAGNOSTIC_TEXT",
      steps: [],
    });
  });

  it("never keeps fields outside the run contract", async () => {
    activateLocalSigner(generateSecretKey());
    stubFetch(() =>
      jsonResponse({
        runs: [
          {
            ...RUN,
            approval_ref: "BEARER_CAPABILITY",
            webhook_secret: "SECRET",
            unknown: "FIELD",
          },
        ],
        next: null,
      }),
    );

    const result = await fetchWorkflowRuns(RELAY, WORKFLOW_ID);
    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected an ok read");
    expect(Object.keys(result.runs[0] ?? {}).sort()).toEqual(
      [
        "completedAt",
        "currentStep",
        "errorCode",
        "errorMessage",
        "key",
        "startedAt",
        "status",
        "steps",
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toContain("BEARER_CAPABILITY");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

describe("selectRunsView", () => {
  const run = (key: string): WorkflowRun => ({
    key,
    status: "completed",
    currentStep: 1,
    startedAt: 1_700_000_000,
    completedAt: 1_700_000_030,
    errorCode: null,
    errorMessage: null,
    steps: [],
  });
  const next = { before: "2026-11-01T09:00:00Z", beforeId: RUN_ID };

  it("distinguishes loading from every failed read state", () => {
    expect(selectRunsView(undefined, true)).toEqual({ kind: "loading" });
    expect(selectRunsView([], false)).toEqual({ kind: "error" });
    expect(selectRunsView([{ state: "forbidden" }], false)).toEqual({ kind: "forbidden" });
    expect(selectRunsView([{ state: "unavailable" }], false)).toEqual({ kind: "unavailable" });
    expect(selectRunsView([{ state: "error" }], false)).toEqual({ kind: "error" });
  });

  it("never presents an empty page as ready and keeps the cursor", () => {
    expect(selectRunsView([{ state: "ok", runs: [], next: null, dropped: 0 }], false)).toEqual({
      kind: "empty",
    });
    expect(selectRunsView([{ state: "ok", runs: [run("a")], next, dropped: 0 }], false)).toEqual({
      kind: "ready",
      runs: [run("a")],
      next,
      failedPage: false,
      dropped: 0,
    });
  });

  it("appends later pages, reports a failed page, and counts unreadable rows", () => {
    const view = selectRunsView(
      [
        { state: "ok", runs: [run("a")], next, dropped: 1 },
        { state: "ok", runs: [run("b")], next: null, dropped: 2 },
      ],
      false,
    );
    expect(view).toEqual({
      kind: "ready",
      runs: [run("a"), run("b")],
      next: null,
      failedPage: false,
      dropped: 3,
    });

    const failed = selectRunsView(
      [{ state: "ok", runs: [run("a")], next, dropped: 0 }, { state: "error" }],
      false,
    );
    expect(failed).toEqual({
      kind: "ready",
      runs: [run("a")],
      next,
      failedPage: true,
      dropped: 0,
    });
  });
});
