import { expect, type Page, test } from "@playwright/test";

/**
 * Community moderation reads (reports / audit / restricted) are NIP-98 signed
 * GETs on the public Relay origin. This suite exercises the presentation gate,
 * every read state, and the absence of persistence. The Relay is synthetic:
 * WebSocket frames and the three HTTP routes are mocked, nothing is deployed.
 */

const RELAY = "ws://127.0.0.1:4187";
const ORIGIN = "http://127.0.0.1:4187";
const GENERAL = "11111111-2222-4333-8444-555555555555";
const CONFIG = {
  communityName: "Moderation Host",
  relayUrl: RELAY,
  agentControlUrl: null,
  features: { projects: false, forum: false },
  demoMode: false,
  agents: [],
};

const REPORTER = "2".repeat(64);
const TARGET_EVENT = "3".repeat(64);
const TARGET_MEMBER = "4".repeat(64);
const MODERATOR = "5".repeat(64);

const REPORT_A = {
  id: "0b0f3f4e-6a64-4c1e-9d3f-5b1f2c8aa111",
  report_event_id: "a".repeat(64),
  reporter_pubkey: REPORTER,
  target_kind: "event",
  target: TARGET_EVENT,
  channel_id: null,
  report_type: "spam",
  note: "ALPHA_REPORT_LINKS",
  status: "open",
  resolved_by: null,
  resolved_at: null,
  action_id: null,
  created_at: "2026-11-01T10:00:00Z",
};
const REPORT_B = {
  ...REPORT_A,
  id: "0b0f3f4e-6a64-4c1e-9d3f-5b1f2c8aa222",
  report_event_id: "b".repeat(64),
  target_kind: "pubkey",
  target: TARGET_MEMBER,
  report_type: "malware",
  note: null,
  status: "resolved",
};
const ACTION = {
  id: "0b0f3f4e-6a64-4c1e-9d3f-5b1f2c8aa333",
  actor_pubkey: MODERATOR,
  action: "ban",
  target_pubkey: TARGET_MEMBER,
  target_event_id: null,
  channel_id: null,
  reason_code: "spam",
  public_reason: "Repeated spam",
  private_reason: "PRIVATE_ALPHA_NOTE",
  matched_principal: "self",
  created_at: "2026-11-02T09:30:00Z",
};
const RESTRICTION = {
  pubkey: TARGET_MEMBER,
  banned: true,
  ban_expires_at: null,
  ban_reason: "Harassment",
  muted_until: "2026-12-01T00:00:00Z",
  mute_reason: "Cooling-off period",
  actor_pubkey: MODERATOR,
  updated_at: "2026-11-02T09:30:00Z",
};

type ModerationReply = { status: number; body: unknown };
type Responder = (path: string, viewerPubkey: string) => ModerationReply;

type ModerationCall = {
  path: string;
  query: string;
  method: string;
  signedUrl: string | null;
  viewer: string | null;
};

async function useConfig(page: Page) {
  await page.route("**/config.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CONFIG),
    }),
  );
}

function signedEventFrom(headers: Record<string, string>): {
  pubkey?: string;
  u?: string;
  kind?: number;
} {
  const authorization = headers.authorization ?? "";
  if (!authorization.startsWith("Nostr ")) return {};
  const decoded = Buffer.from(authorization.slice("Nostr ".length), "base64").toString("utf8");
  const event = JSON.parse(decoded) as { pubkey?: string; kind?: number; tags?: string[][] };
  return {
    pubkey: event.pubkey,
    kind: event.kind,
    u: event.tags?.find((tag) => tag[0] === "u")?.[1],
  };
}

async function installModerationRoute(page: Page, responder: Responder) {
  const calls: ModerationCall[] = [];
  await page.route("**/moderation/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const signed = signedEventFrom(await request.allHeaders());
    calls.push({
      path: url.pathname,
      query: url.search,
      method: request.method(),
      signedUrl: signed.u ?? null,
      viewer: signed.pubkey ?? null,
    });
    const reply = responder(url.pathname, signed.pubkey ?? "");
    await route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: JSON.stringify(reply.body),
    });
  });
  return calls;
}

/**
 * Synthetic Relay: NIP-42 AUTH handshake, an optional NIP-43 community role
 * snapshot for the connecting identity, and an optional channel where the
 * viewer is a channel admin but holds no community role.
 */
async function mockRelay(
  page: Page,
  options: { communityRole?: "owner" | "admin"; channelAdmin?: boolean } = {},
) {
  const seen: { viewer: string | null; replayedFrames: number } = {
    viewer: null,
    replayedFrames: 0,
  };
  await page.routeWebSocket(RELAY, (ws) => {
    ws.send(JSON.stringify(["AUTH", "moderation-challenge"]));
    ws.onMessage((message) => {
      const data = JSON.parse(String(message)) as [string, ...unknown[]];
      if (data[0] === "AUTH") {
        const auth = data[1] as { id: string; pubkey: string };
        seen.viewer = auth.pubkey;
        ws.send(JSON.stringify(["OK", auth.id, true, ""]));
        return;
      }
      if (data[0] !== "REQ") return;
      const [, subscriptionId, filter] = data as [string, string, { kinds?: number[] }];
      const kinds = filter.kinds ?? [];
      const viewer = seen.viewer ?? "";
      const events: Record<string, unknown>[] = [];
      if (kinds.includes(13534) && options.communityRole && viewer) {
        events.push({
          id: "c".repeat(64),
          pubkey: "f".repeat(64),
          created_at: 1_700_000_000,
          kind: 13534,
          tags: [["-"], ["member", viewer, options.communityRole]],
          content: "",
          sig: "0".repeat(128),
        });
      }
      if (kinds.includes(39000) && options.channelAdmin) {
        events.push({
          id: "d".repeat(64),
          pubkey: "f".repeat(64),
          created_at: 1_700_000_000,
          kind: 39000,
          tags: [
            ["d", GENERAL],
            ["name", "ops"],
            ["t", "stream"],
          ],
          content: "",
          sig: "0".repeat(128),
        });
      }
      if (kinds.includes(39002) && options.channelAdmin && viewer) {
        events.push({
          id: "e".repeat(64),
          pubkey: "f".repeat(64),
          created_at: 1_700_000_000,
          kind: 39002,
          tags: [
            ["d", GENERAL],
            ["p", viewer, "admin"],
          ],
          content: "",
          sig: "0".repeat(128),
        });
      }
      for (const event of events) ws.send(JSON.stringify(["EVENT", subscriptionId, event]));
      ws.send(JSON.stringify(["EOSE", subscriptionId]));
    });
  });
  // Presence/filter HTTP reads are not part of the moderation contract.
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

async function openModeration(page: Page) {
  await page.getByRole("button", { name: "Moderation", exact: true }).click();
  const panel = page.getByTestId("workspace-tool-moderation");
  await expect(panel).toBeVisible();
  return panel;
}

const okRows: Responder = (path) => {
  if (path === "/moderation/reports") return { status: 200, body: [REPORT_A, REPORT_B] };
  if (path === "/moderation/audit") return { status: 200, body: [ACTION] };
  return { status: 200, body: [RESTRICTION] };
};

test("community owner reads the queue, audit log, and restricted members", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useConfig(page);
  const relay = await mockRelay(page, { communityRole: "owner" });
  const calls = await installModerationRoute(page, okRows);
  await page.goto("/");
  await createIdentity(page, "moderation owner passphrase");

  const panel = await openModeration(page);
  await expect(panel.getByText("ALPHA_REPORT_LINKS")).toBeVisible();
  await expect(panel.getByText("Spam", { exact: true })).toBeVisible();

  // Programs the tab ↔ panel relation and keeps only the selected tab in the tab order.
  const reportsTab = panel.getByRole("tab", { name: "Reports" });
  const auditTab = panel.getByRole("tab", { name: "Audit log" });
  const restrictedTab = panel.getByRole("tab", { name: "Restricted" });
  const tabpanel = panel.getByRole("tabpanel");
  await expect(reportsTab).toHaveAttribute("aria-controls", "moderation-panel");
  await expect(auditTab).toHaveAttribute("aria-controls", "moderation-panel");
  await expect(reportsTab).toHaveAttribute("tabindex", "0");
  await expect(auditTab).toHaveAttribute("tabindex", "-1");
  await expect(tabpanel).toHaveAttribute("id", "moderation-panel");
  await expect(tabpanel).toHaveAttribute("aria-labelledby", "moderation-tab-reports");
  await page.screenshot({
    path: "test-results/visual/moderation-owner-desktop.png",
    animations: "disabled",
  });

  await panel.getByRole("tab", { name: "Audit log" }).click();
  await expect(panel.getByText("Banned a member", { exact: true })).toBeVisible();
  await expect(panel.getByText("PRIVATE_ALPHA_NOTE", { exact: false })).toBeVisible();

  await panel.getByRole("tab", { name: "Restricted" }).click();
  await expect(panel.getByText("Harassment", { exact: false })).toBeVisible();

  // Tabs are keyboard reachable and activate with Enter; arrows move the selection.
  await reportsTab.focus();
  await page.keyboard.press("Enter");
  await expect(reportsTab).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByText("ALPHA_REPORT_LINKS")).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(auditTab).toBeFocused();
  await expect(auditTab).toHaveAttribute("aria-selected", "true");
  await expect(auditTab).toHaveAttribute("tabindex", "0");
  await expect(reportsTab).toHaveAttribute("tabindex", "-1");
  await expect(tabpanel).toHaveAttribute("aria-labelledby", "moderation-tab-audit");

  await page.keyboard.press("End");
  await expect(restrictedTab).toBeFocused();
  await expect(restrictedTab).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Home");
  await expect(reportsTab).toBeFocused();
  await expect(reportsTab).toHaveAttribute("aria-selected", "true");

  expect(calls.map((call) => [call.method, call.path, call.query])).toEqual([
    ["GET", "/moderation/reports", "?limit=100"],
    ["GET", "/moderation/audit", "?limit=100"],
    ["GET", "/moderation/restricted", ""],
  ]);
  for (const call of calls) {
    expect(call.viewer).toBe(relay.viewer);
    expect(call.signedUrl).toBe(`${ORIGIN}${call.path}${call.query}`);
  }

  // Reads never enter browser storage and never change the page URL.
  const stored = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
    href: window.location.href,
  }));
  expect(stored.local).not.toContain("ALPHA_REPORT_LINKS");
  expect(stored.local).not.toContain("PRIVATE_ALPHA_NOTE");
  expect(stored.session).not.toContain("PRIVATE_ALPHA_NOTE");
  expect(stored.href).toBe(`${ORIGIN}/`);
});

test("a channel admin without a community role does not get the tool", async ({ page }) => {
  await useConfig(page);
  await mockRelay(page, { channelAdmin: true });
  const calls = await installModerationRoute(page, okRows);
  await page.goto("/");
  await createIdentity(page, "channel admin passphrase");

  // The channel loaded and the 39002 admin grant reached the client: only a channel
  // admin sees member management for it. Without the grant this dialog has no "Add member".
  await expect(page.getByRole("heading", { name: "ops" })).toBeVisible();
  await page.getByRole("button", { name: "Members: 1" }).click();
  const members = page.getByRole("dialog", { name: "Members · 1" });
  await expect(members.getByText("Admin", { exact: true })).toBeVisible();
  await expect(members.getByRole("button", { name: "Add member" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Moderation", exact: true })).toHaveCount(0);
  expect(calls).toEqual([]);
});

test("a 403 from the Relay shows the not-authorized state", async ({ page }) => {
  await useConfig(page);
  await mockRelay(page, { communityRole: "admin" });
  await installModerationRoute(page, () => ({
    status: 403,
    body: { error: "restricted: moderator access required" },
  }));
  await page.goto("/");
  await createIdentity(page, "forbidden passphrase");

  const panel = await openModeration(page);
  await expect(
    panel.getByText("You are not authorized to view the moderation queue for this community."),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(panel.getByText("403", { exact: false })).toHaveCount(0);
});

test("a 503 statement timeout is retryable", async ({ page }) => {
  await useConfig(page);
  await mockRelay(page, { communityRole: "owner" });
  let attempts = 0;
  const calls = await installModerationRoute(page, (path, viewer) => {
    if (path === "/moderation/reports" && attempts++ === 0) {
      return { status: 503, body: { error: "query timed out" } };
    }
    return okRows(path, viewer);
  });
  await page.goto("/");
  await createIdentity(page, "timeout passphrase");

  const panel = await openModeration(page);
  await expect(
    panel.getByText("The Relay timed out while reading moderation data. Try again."),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Try again" }).click();
  await expect(panel.getByText("ALPHA_REPORT_LINKS")).toBeVisible();
  expect(calls.filter((call) => call.path === "/moderation/reports")).toHaveLength(2);
});

test("an empty queue shows the empty state", async ({ page }) => {
  await useConfig(page);
  await mockRelay(page, { communityRole: "owner" });
  await installModerationRoute(page, () => ({ status: 200, body: [] }));
  await page.goto("/");
  await createIdentity(page, "empty queue passphrase");

  const panel = await openModeration(page);
  await expect(panel.getByText("No reports in the queue.")).toBeVisible();
  await panel.getByRole("tab", { name: "Restricted" }).click();
  await expect(panel.getByText("No banned or timed-out members.")).toBeVisible();
});

test("queue rows fit a 390px viewport without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useConfig(page);
  await mockRelay(page, { communityRole: "owner" });
  await installModerationRoute(page, okRows);
  await page.goto("/");
  await createIdentity(page, "mobile owner passphrase");

  await page.getByRole("button", { name: "Open channel list" }).click();
  await page.getByRole("button", { name: "Moderation", exact: true }).click();
  const panel = page.getByTestId("workspace-tool-moderation");
  await expect(panel.getByText("ALPHA_REPORT_LINKS")).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  await page.screenshot({
    path: "test-results/visual/moderation-owner-mobile.png",
    animations: "disabled",
  });
});

test("mobile retry and close controls meet the 44px target, desktop keeps 32px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useConfig(page);
  await mockRelay(page, { communityRole: "owner" });
  await installModerationRoute(page, (path, viewer) =>
    path === "/moderation/reports"
      ? { status: 503, body: { error: "query timed out" } }
      : okRows(path, viewer),
  );
  await page.goto("/");
  await createIdentity(page, "touch target passphrase");

  await page.getByRole("button", { name: "Open channel list" }).click();
  await page.getByRole("button", { name: "Moderation", exact: true }).click();
  const panel = page.getByTestId("workspace-tool-moderation");
  const retry = panel.getByRole("button", { name: "Try again" });
  const close = page.getByRole("button", { name: "Close moderation" });
  await expect(retry).toBeVisible();
  await expect(close).toBeVisible();

  const mobileRetry = await retry.boundingBox();
  const mobileClose = await close.boundingBox();
  expect(mobileRetry?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(mobileRetry?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(mobileClose?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(mobileClose?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: "test-results/visual/moderation-touch-390.png",
    animations: "disabled",
  });

  // Desktop keeps the original compact controls.
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopRetry = await retry.boundingBox();
  const desktopClose = await close.boundingBox();
  expect(desktopRetry?.height ?? 0).toBeCloseTo(32, 0);
  expect(desktopClose?.width ?? 0).toBeCloseTo(32, 0);
  expect(desktopClose?.height ?? 0).toBeCloseTo(32, 0);
});

test("the moderation tool speaks Simplified Chinese", async ({ browser }) => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  await useConfig(page);
  await mockRelay(page, { communityRole: "owner" });
  await installModerationRoute(page, okRows);
  await page.goto("/");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("新保险库口令").fill("zh moderation passphrase");
  await page.getByLabel("确认口令").fill("zh moderation passphrase");
  await page.getByLabel("我明白，如果加密保险库和备份均丢失，Buzz 无法恢复此身份。").check();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await expect(page.getByRole("button", { name: "个人菜单" })).toBeVisible();

  await page.getByRole("button", { name: "社区管理", exact: true }).click();
  const panel = page.getByTestId("workspace-tool-moderation");
  await expect(panel.getByRole("heading", { name: "社区管理" })).toBeVisible();
  await expect(panel.getByText("ALPHA_REPORT_LINKS")).toBeVisible();
  await expect(panel.getByText("待处理", { exact: true })).toBeVisible();
  await expect(panel.getByText("垃圾信息", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/visual/moderation-owner-zh.png",
    animations: "disabled",
  });
  await context.close();
});

test("switching identity never shows the previous identity's rows", async ({ page }) => {
  await useConfig(page);
  await mockRelay(page, { communityRole: "owner" });
  const first = { pubkey: "" };
  await installModerationRoute(page, (path, viewer) => {
    if (path === "/moderation/reports") {
      first.pubkey ||= viewer;
      if (viewer === first.pubkey) return { status: 200, body: [REPORT_A] };
      return { status: 200, body: [] };
    }
    return { status: 200, body: [] };
  });
  await page.goto("/");
  await createIdentity(page, "first moderation identity");

  let panel = await openModeration(page);
  await expect(panel.getByText("ALPHA_REPORT_LINKS")).toBeVisible();

  await page.getByRole("button", { name: "Close moderation" }).click();
  await page.getByRole("button", { name: "Profile menu" }).click();
  await page
    .getByRole("menu", { name: "Profile menu" })
    .getByRole("menuitem", { name: "Switch identity" })
    .click();
  await createIdentity(page, "second moderation identity");

  panel = await openModeration(page);
  await expect(panel.getByText("ALPHA_REPORT_LINKS")).toHaveCount(0);
  await expect(panel.getByText("No reports in the queue.")).toBeVisible();
});
