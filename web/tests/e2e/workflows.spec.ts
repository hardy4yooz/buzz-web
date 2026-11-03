import { expect, type Page, test } from "@playwright/test";

/**
 * Read-only workflow run history. Definitions arrive as kind:30620 events over
 * the Relay WebSocket and runs come from the NIP-98 GET
 * `/workflows/{id}/runs` row API. The Relay here is synthetic: frames and the
 * runs route are mocked, nothing is deployed, and no approvals route is called.
 */

const RELAY = "ws://127.0.0.1:4187";
const ORIGIN = "http://127.0.0.1:4187";
const CHANNEL = "11111111-2222-4333-8444-555555555555";
const WORKFLOW_A = "aaaaaaaa-1111-4111-8111-111111111111";
const WORKFLOW_B = "bbbbbbbb-2222-4222-8222-222222222222";
const RUN_COMPLETED = "cccccccc-1111-4111-8111-111111111111";
const RUN_FAILED = "cccccccc-2222-4222-8222-222222222222";
const RUN_RUNNING = "cccccccc-3333-4333-8333-333333333333";
const RUN_FOR_B = "cccccccc-4444-4444-8444-444444444444";
const OWNER = "b".repeat(64);

const CONFIG = {
  communityName: "Workflow Host",
  relayUrl: RELAY,
  agentControlUrl: null,
  features: { projects: false, forum: false },
  demoMode: false,
  agents: [],
};

const DEFINITION_A = {
  id: "a".repeat(64),
  pubkey: OWNER,
  created_at: 1_760_000_200,
  kind: 30620,
  tags: [
    ["d", WORKFLOW_A],
    ["h", CHANNEL],
  ],
  content: "name: Daily digest\nsteps:\n  - name: fetch\n",
  sig: "0".repeat(128),
};

const DEFINITION_B = {
  id: "e".repeat(64),
  pubkey: OWNER,
  created_at: 1_760_000_100,
  kind: 30620,
  tags: [
    ["d", WORKFLOW_B],
    ["h", CHANNEL],
  ],
  content: "name: Nightly backup\nsteps: []\n",
  sig: "0".repeat(128),
};

const RUN_COMPLETED_ROW = {
  id: RUN_COMPLETED,
  workflow_id: WORKFLOW_A,
  status: "completed",
  current_step: 2,
  execution_trace: [
    { step_id: "fetch", status: "completed", output: { body: "WEBHOOK_BODY" } },
    { step_id: "notify", status: "skipped" },
  ],
  started_at: 1_760_000_000,
  completed_at: 1_760_000_060,
  error_code: null,
  error_message: null,
  created_at: 1_760_000_000,
};

const RUN_FAILED_ROW = {
  id: RUN_FAILED,
  workflow_id: WORKFLOW_A,
  status: "failed",
  current_step: 1,
  execution_trace: [{ step_id: "fetch", status: "completed" }],
  started_at: 1_760_000_100,
  completed_at: null,
  error_code: "approval_not_supported",
  error_message: "APPROVAL_GATE_NOTE",
  created_at: 1_760_000_100,
};

const RUN_RUNNING_ROW = {
  id: RUN_RUNNING,
  workflow_id: WORKFLOW_A,
  status: "running",
  current_step: 0,
  execution_trace: [],
  started_at: 1_760_000_300,
  completed_at: null,
  error_code: null,
  error_message: null,
  created_at: 1_760_000_300,
};

const RUN_FOR_B_ROW = {
  ...RUN_COMPLETED_ROW,
  id: RUN_FOR_B,
  workflow_id: WORKFLOW_B,
  started_at: 1_750_000_000,
  completed_at: 1_750_000_030,
  created_at: 1_750_000_000,
};

type RunReply = { status: number; body: unknown };
type RunResponder = (url: URL) => RunReply;

type RunCall = { path: string; search: string; viewer: string | null };

async function useConfig(page: Page) {
  await page.route("**/config.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CONFIG),
    }),
  );
}

function signedPubkey(headers: Record<string, string>): string | null {
  const authorization = headers.authorization ?? "";
  if (!authorization.startsWith("Nostr ")) return null;
  const decoded = Buffer.from(authorization.slice("Nostr ".length), "base64").toString("utf8");
  return (JSON.parse(decoded) as { pubkey?: string }).pubkey ?? null;
}

async function installRunsRoute(page: Page, responder: RunResponder) {
  const calls: RunCall[] = [];
  await page.route("**/workflows/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push({
      path: url.pathname,
      search: url.search,
      viewer: signedPubkey(await request.allHeaders()),
    });
    const reply = responder(url);
    await route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: JSON.stringify(reply.body),
    });
  });
  return calls;
}

/**
 * Synthetic Relay: NIP-42 AUTH, one readable channel, and the kind:30620
 * definitions the viewer may read. `limit: 1` is the navigation evidence probe;
 * a fuller filter is the tool's own list query. `probeClosed` rejects only the
 * probe, which is what a WS timeout mid-session looks like to the client.
 */
async function mockRelay(
  page: Page,
  options: { probe: boolean; list: boolean; probeClosed?: boolean },
) {
  const seen = { viewer: null as string | null, definitionRequests: 0 };
  await page.routeWebSocket(RELAY, (ws) => {
    ws.send(JSON.stringify(["AUTH", "workflow-challenge"]));
    ws.onMessage((message) => {
      const data = JSON.parse(String(message)) as [string, ...unknown[]];
      if (data[0] === "AUTH") {
        const auth = data[1] as { id: string; pubkey: string };
        seen.viewer = auth.pubkey;
        ws.send(JSON.stringify(["OK", auth.id, true, ""]));
        return;
      }
      if (data[0] !== "REQ") return;
      const [, subscriptionId, filter] = data as [
        string,
        string,
        { kinds?: number[]; limit?: number },
      ];
      const kinds = filter.kinds ?? [];
      if (kinds.includes(30620)) seen.definitionRequests += 1;
      if (kinds.includes(30620) && filter.limit === 1 && options.probeClosed) {
        ws.send(JSON.stringify(["CLOSED", subscriptionId, "error: probe rejected"]));
        return;
      }
      const events: Record<string, unknown>[] = [];
      if (kinds.includes(39000)) {
        events.push({
          id: "f".repeat(64),
          pubkey: "0".repeat(64),
          created_at: 1_700_000_000,
          kind: 39000,
          tags: [
            ["d", CHANNEL],
            ["name", "ops"],
            ["t", "stream"],
          ],
          content: "",
          sig: "0".repeat(128),
        });
      }
      if (kinds.includes(30620)) {
        const definitions =
          filter.limit === 1
            ? options.probe
              ? [DEFINITION_A]
              : []
            : options.list
              ? [DEFINITION_A, DEFINITION_B]
              : [];
        events.push(...definitions);
      }
      for (const event of events) ws.send(JSON.stringify(["EVENT", subscriptionId, event]));
      ws.send(JSON.stringify(["EOSE", subscriptionId]));
    });
  });
  await page.route("**/query", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  return seen;
}

async function createIdentity(page: Page, passphrase: string) {
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("New vault passphrase").fill(passphrase);
  await page.getByLabel("Confirm passphrase").fill(passphrase);
  await page
    .getByLabel(
      "I understand that Buzz cannot recover this identity if I lose the encrypted vault and backup.",
    )
    .check();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: "Profile menu" })).toBeVisible();
}

async function openWorkflows(page: Page) {
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  const panel = page.getByTestId("workspace-tool-workflows");
  await expect(panel).toBeVisible();
  return panel;
}

function readyResponder(url: URL): RunReply {
  if (url.pathname.endsWith(`/${WORKFLOW_B}/runs`)) {
    return { status: 200, body: { runs: [RUN_FOR_B_ROW], next: null } };
  }
  if (url.searchParams.get("before")) {
    return { status: 200, body: { runs: [RUN_RUNNING_ROW], next: null } };
  }
  return {
    status: 200,
    body: {
      runs: [RUN_COMPLETED_ROW, RUN_FAILED_ROW],
      next: { before: "2026-11-01T09:00:00Z", before_id: RUN_FAILED },
    },
  };
}

test("a member reads definitions and on-demand run history", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await useConfig(page);
  const relay = await mockRelay(page, { probe: true, list: true });
  const calls = await installRunsRoute(page, readyResponder);
  await page.goto("/");
  await createIdentity(page, "workflow member passphrase");

  const panel = await openWorkflows(page);
  await expect(panel.getByRole("heading", { level: 2, name: "Workflows" })).toBeVisible();
  await expect(
    panel.getByText("Run history is fetched from the Relay when you open a workflow."),
  ).toBeVisible();
  await expect(panel.getByText("does not update live")).toBeVisible();

  // The newest definition is selected, so its history loads without another click.
  await expect(panel.getByRole("button", { name: /Daily digest/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(panel.getByRole("button", { name: /Nightly backup/ })).toBeVisible();
  await expect(panel.getByText("Completed", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("Failed", { exact: true })).toBeVisible();

  // Expanding a failed run explains the real upstream limitation, not a wait state.
  await panel.getByRole("button", { name: /Failed/ }).click();
  await expect(panel.getByText("Approval gates are not supported by this Relay.")).toBeVisible();
  await expect(panel.getByText("APPROVAL_GATE_NOTE")).toBeVisible();
  await expect(panel.getByText("fetch", { exact: true })).toBeVisible();
  await expect(panel.getByText("Skipped", { exact: true })).toHaveCount(0);
  // A failed run's terminal timestamp is an end time, not a completion claim.
  await expect(panel.getByText("Ended", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "/tmp/opencode/workflow-runs/en-ready-1440.png",
    animations: "disabled",
    fullPage: false,
  });

  // The approvals route is never requested and its bearer capability never rendered.
  const html = await page.content();
  expect(html).not.toContain("approval_ref");
  expect(html).not.toContain("approval_not_supported");
  expect(html).not.toContain(WORKFLOW_A);
  expect(html).not.toContain(RUN_COMPLETED);
  expect(html).not.toContain("WEBHOOK_BODY");

  // One cursor page is readable, then the control disappears.
  await panel.getByRole("button", { name: "Load more runs" }).click();
  await expect(panel.getByText("Running", { exact: true })).toBeVisible();
  await expect(panel.getByText("Step 1")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Load more runs" })).toHaveCount(0);

  // Selecting another definition swaps the history instead of appending it.
  await panel.getByRole("button", { name: /Nightly backup/ }).click();
  await expect(panel.getByRole("heading", { name: "Nightly backup" })).toBeVisible();
  await expect(panel.getByText("Completed", { exact: true }).first()).toBeVisible();

  expect(calls.filter((call) => call.path.endsWith(`/${WORKFLOW_A}/runs`))).toHaveLength(2);
  expect(calls.filter((call) => call.path.endsWith(`/${WORKFLOW_B}/runs`))).toHaveLength(1);
  for (const call of calls) {
    expect(call.viewer).toBe(relay.viewer);
    expect(call.search).toContain("limit=20");
    expect(call.path).toMatch(/\/workflows\/[0-9a-f-]{36}\/runs$/);
  }

  // Run rows never enter browser storage.
  const stored = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
    href: window.location.href,
  }));
  expect(stored.local).not.toContain("APPROVAL_GATE_NOTE");
  expect(stored.session).not.toContain("APPROVAL_GATE_NOTE");
  expect(stored.href).toBe(`${ORIGIN}/`);
  expect(consoleErrors).toEqual([]);
});

test("no readable definition means no tool", async ({ page }) => {
  await useConfig(page);
  const relay = await mockRelay(page, { probe: false, list: false });
  const calls = await installRunsRoute(page, readyResponder);
  await page.goto("/");
  await createIdentity(page, "no workflow passphrase");
  await expect.poll(() => relay.definitionRequests).toBeGreaterThan(0);

  await expect(page.getByText("No accessible channels")).toBeVisible();
  await expect(page.getByRole("button", { name: "Workflows", exact: true })).toHaveCount(0);
  expect(calls).toEqual([]);
});

test("a definition removed between the probe and the list shows the empty state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await useConfig(page);
  await mockRelay(page, { probe: true, list: false });
  await installRunsRoute(page, readyResponder);
  await page.goto("/");
  await createIdentity(page, "vanished workflow passphrase");

  const panel = await openWorkflows(page);
  await expect(
    panel.getByText("No workflow definitions are visible in your channels."),
  ).toBeVisible();
  // One honest empty message: no "select a workflow" prompt for an impossible
  // action, and no second heading repeating the page title.
  await expect(panel.getByText("Select a workflow to view its run history.")).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Workflows", exact: true })).toHaveCount(1);
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  expect(consoleErrors).toEqual([]);
  await page.screenshot({
    path: "/tmp/opencode/workflow-runs/en-empty-1440.png",
    animations: "disabled",
  });
});

test("a failed probe keeps the tool instead of hiding a shipped feature", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await useConfig(page);
  const relay = await mockRelay(page, { probe: true, list: true, probeClosed: true });
  await installRunsRoute(page, readyResponder);
  await page.goto("/");
  await createIdentity(page, "closed probe passphrase");
  await expect.poll(() => relay.definitionRequests).toBeGreaterThan(0);

  // The probe was rejected, so the feature is "unknown", not "absent".
  await expect(page.getByRole("button", { name: "Workflows", exact: true })).toBeVisible();
  const panel = await openWorkflows(page);
  await expect(panel.getByRole("button", { name: /Daily digest/ })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("one unreadable run row does not blank the whole history", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await useConfig(page);
  await mockRelay(page, { probe: true, list: true });
  await installRunsRoute(page, () => ({
    status: 200,
    body: {
      runs: [{ ...RUN_COMPLETED_ROW, current_step: "two" }, RUN_COMPLETED_ROW],
      next: null,
    },
  }));
  await page.goto("/");
  await createIdentity(page, "malformed row passphrase");

  const panel = await openWorkflows(page);
  await expect(panel.getByText("Completed", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("Some runs could not be read and are not shown.")).toBeVisible();
  await expect(panel.getByText("Could not load run history.")).toHaveCount(0);
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  expect(consoleErrors).toEqual([]);
  await page.screenshot({
    path: "/tmp/opencode/workflow-runs/en-dropped-row-1440.png",
    animations: "disabled",
  });
});

test("a workflow with no runs says so", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useConfig(page);
  await mockRelay(page, { probe: true, list: true });
  await installRunsRoute(page, () => ({ status: 200, body: { runs: [], next: null } }));
  await page.goto("/");
  await createIdentity(page, "empty history passphrase");

  const panel = await openWorkflows(page);
  await expect(panel.getByText("This workflow has no recorded runs.")).toBeVisible();
  await expect(panel.getByText("Load more runs")).toHaveCount(0);
});

test("a denied read is not presented as an empty history", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useConfig(page);
  await mockRelay(page, { probe: true, list: true });
  await installRunsRoute(page, () => ({
    status: 403,
    body: { error: "restricted: relay membership required" },
  }));
  await page.goto("/");
  await createIdentity(page, "denied workflow passphrase");

  const panel = await openWorkflows(page);
  await expect(
    panel.getByText("The Relay denied this read. You may not be a member of this community."),
  ).toBeVisible();
  await expect(panel.getByText("This workflow has no recorded runs.")).toHaveCount(0);
  await expect(panel.getByText("403", { exact: false })).toHaveCount(0);
});

test("an unreadable workflow is unavailable, not empty", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useConfig(page);
  await mockRelay(page, { probe: true, list: true });
  await installRunsRoute(page, () => ({
    status: 404,
    body: { error: "workflow not found" },
  }));
  await page.goto("/");
  await createIdentity(page, "missing workflow passphrase");

  const panel = await openWorkflows(page);
  await expect(
    panel.getByText(
      "This workflow is not available. It may have been removed, or you may not have access.",
    ),
  ).toBeVisible();
  await expect(panel.getByText("This workflow has no recorded runs.")).toHaveCount(0);
  await expect(panel.getByText("404", { exact: false })).toHaveCount(0);
});

test("a failed read is retryable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useConfig(page);
  await mockRelay(page, { probe: true, list: true });
  let attempts = 0;
  const calls = await installRunsRoute(page, (url) => {
    attempts += 1;
    if (attempts === 1) return { status: 500, body: { error: "internal server error" } };
    return readyResponder(url);
  });
  await page.goto("/");
  await createIdentity(page, "retry workflow passphrase");

  const panel = await openWorkflows(page);
  await expect(panel.getByText("Could not load run history.")).toBeVisible();
  await page.screenshot({
    path: "/tmp/opencode/workflow-runs/en-error-1440.png",
    animations: "disabled",
  });
  await panel.getByRole("button", { name: "Try again" }).click();
  await expect(panel.getByText("Completed", { exact: true }).first()).toBeVisible();
  expect(calls).toHaveLength(2);
});

test("run history fits a 390px viewport and keeps 44px targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useConfig(page);
  await mockRelay(page, { probe: true, list: true });
  await installRunsRoute(page, readyResponder);
  await page.goto("/");
  await createIdentity(page, "mobile workflow passphrase");

  await page.getByRole("button", { name: "Open channel list" }).click();
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  const panel = page.getByTestId("workspace-tool-workflows");
  await expect(panel.getByText("Completed", { exact: true }).first()).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);

  const close = page.getByRole("button", { name: "Close workflows" });
  const runRow = panel.getByRole("button", { name: /Completed/ }).first();
  const closeBox = await close.boundingBox();
  const runBox = await runRow.boundingBox();
  expect(closeBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(closeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(runBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  await page.screenshot({
    path: "/tmp/opencode/workflow-runs/en-ready-390.png",
    animations: "disabled",
  });
});

test("the workflows tool speaks Simplified Chinese", async ({ browser }) => {
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await useConfig(page);
  await mockRelay(page, { probe: true, list: true });
  await installRunsRoute(page, readyResponder);
  await page.goto("/");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("新保险库口令").fill("zh workflow passphrase");
  await page.getByLabel("确认口令").fill("zh workflow passphrase");
  await page.getByLabel("我明白，如果加密保险库和备份均丢失，Buzz 无法恢复此身份。").check();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await expect(page.getByRole("button", { name: "个人菜单" })).toBeVisible();

  await page.getByRole("button", { name: "工作流", exact: true }).click();
  const panel = page.getByTestId("workspace-tool-workflows");
  await expect(panel.getByRole("heading", { level: 2, name: "工作流" })).toBeVisible();
  await expect(panel.getByText("不会实时更新")).toBeVisible();
  await expect(panel.getByText("已完成", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("失败", { exact: true })).toBeVisible();

  await panel.getByRole("button", { name: /失败/ }).click();
  await expect(panel.getByText("此 Relay 不支持审批门。")).toBeVisible();
  await page.screenshot({
    path: "/tmp/opencode/workflow-runs/zh-ready-1440.png",
    animations: "disabled",
  });
  await context.close();
});

test("the Simplified Chinese tool fits a 390px viewport", async ({ browser }) => {
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await useConfig(page);
  await mockRelay(page, { probe: true, list: true });
  await installRunsRoute(page, readyResponder);
  await page.goto("/");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("新保险库口令").fill("zh mobile workflow passphrase");
  await page.getByLabel("确认口令").fill("zh mobile workflow passphrase");
  await page.getByLabel("我明白，如果加密保险库和备份均丢失，Buzz 无法恢复此身份。").check();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await expect(page.getByRole("button", { name: "个人菜单" })).toBeVisible();

  await page.getByRole("button", { name: "打开频道列表" }).click();
  await page.getByRole("button", { name: "工作流", exact: true }).click();
  const panel = page.getByTestId("workspace-tool-workflows");
  await expect(panel.getByText("已完成", { exact: true }).first()).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  await page.screenshot({
    path: "/tmp/opencode/workflow-runs/zh-ready-390.png",
    animations: "disabled",
  });
  await context.close();
});
