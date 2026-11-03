import { createHash } from "node:crypto";
import {
  type BrowserContext,
  expect,
  type Page,
  test,
  type WebSocketRoute,
  type Worker,
} from "@playwright/test";

/**
 * Browser coverage for open-tab notifications.
 *
 * The Relay is emulated at the WebSocket boundary (the same technique as the repository cache
 * tests), so the production inbox, service worker, and settings code run unmodified. Two facts
 * cannot be produced in headless Chromium and are declared stubs rather than weakened assertions:
 * - tab visibility is stubbed with a `document.visibilityState` getter;
 * - an OS notification click is impossible, so a click is exercised by seeding the pending entry
 *   the worker writes and dispatching the worker's wake-up message.
 */

const RELAY = "wss://relay.example.com";
const ORIGIN = "http://127.0.0.1:4187";
const CHANNEL = "11111111-2222-4333-8444-555555555555";
const OTHER_CHANNEL = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const AUTHOR = "c".repeat(64);
const PENDING_CACHE = "buzz-notify-pending-v1";

type FixtureEvent = {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
};

type Filter = {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  [tag: string]: unknown;
};

const CONFIG = {
  communityName: "Buzz Community",
  relayUrl: RELAY,
  agentControlUrl: null,
  features: { projects: false, forum: false },
  demoMode: false,
  agents: [],
};

function fixtureEvent(
  id: string,
  kind: number,
  createdAt: number,
  tags: string[][],
  content = "",
): FixtureEvent {
  return {
    id: id.repeat(64).slice(0, 64),
    pubkey: AUTHOR,
    kind,
    created_at: createdAt,
    tags,
    content,
    sig: "0".repeat(128),
  };
}

function mention(id: string, createdAt: number, channelId = CHANNEL): FixtureEvent {
  return fixtureEvent(id, 9, createdAt, [
    ["h", channelId],
    ["p", "@viewer"],
  ]);
}

function matches(filter: Filter, event: FixtureEvent): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(value)) continue;
    const tagName = key.slice(1);
    if (!event.tags.some((tag) => tag[0] === tagName && value.includes(tag[1]))) return false;
  }
  return true;
}

/** Emulates the Relay: AUTH, stored history on REQ, and live EVENT pushes. */
class FakeRelay {
  private events: FixtureEvent[] = [];
  private readonly sockets = new Map<
    WebSocketRoute,
    { viewer: string | null; subscriptions: Map<string, Filter> }
  >();

  async install(context: BrowserContext) {
    await context.routeWebSocket(RELAY, (socket) => this.attach(socket));
  }

  seed(...events: FixtureEvent[]) {
    this.events.push(...events);
  }

  push(event: FixtureEvent) {
    this.events.push(event);
    for (const [socket, state] of this.sockets) {
      const materialized = this.materialize(event, state.viewer);
      for (const [id, filter] of state.subscriptions) {
        if (matches(filter, materialized)) {
          socket.send(JSON.stringify(["EVENT", id, materialized]));
        }
      }
    }
  }

  /** Fixtures address the viewer as `@viewer`; the signed AUTH event identifies them. */
  private materialize(event: FixtureEvent, viewer: string | null): FixtureEvent {
    if (!viewer) return event;
    return {
      ...event,
      tags: event.tags.map((tag) => tag.map((value) => (value === "@viewer" ? viewer : value))),
    };
  }

  private attach(socket: WebSocketRoute) {
    const state = { viewer: null as string | null, subscriptions: new Map<string, Filter>() };
    this.sockets.set(socket, state);
    socket.send(JSON.stringify(["AUTH", "notification-spec-challenge"]));
    socket.onMessage((raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!Array.isArray(data) || typeof data[0] !== "string") return;
      if (data[0] === "AUTH" && data[1] && typeof data[1] === "object") {
        const auth = data[1] as { id?: string; pubkey?: string };
        if (typeof auth.pubkey === "string") state.viewer = auth.pubkey.toLowerCase();
        socket.send(JSON.stringify(["OK", auth.id ?? "", true, ""]));
        return;
      }
      if (data[0] === "REQ") {
        const id = String(data[1]);
        state.subscriptions.set(id, data[2] as Filter);
        for (const event of this.events) {
          const materialized = this.materialize(event, state.viewer);
          if (matches(data[2] as Filter, materialized)) {
            socket.send(JSON.stringify(["EVENT", id, materialized]));
          }
        }
        socket.send(JSON.stringify(["EOSE", id]));
        return;
      }
      if (data[0] === "CLOSE") state.subscriptions.delete(String(data[1]));
    });
    socket.onClose(() => this.sockets.delete(socket));
  }
}

async function useConfig(page: Page) {
  await page.route("**/config.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CONFIG) }),
  );
  await page.route("**/query", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
}

async function hideTab(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
    Object.defineProperty(document, "hidden", { get: () => true });
  });
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

async function unlockIdentity(page: Page, passphrase: string) {
  await page.getByLabel("Vault passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("button", { name: "Profile menu" })).toBeVisible();
}

async function ensureSettings(page: Page) {
  const panel = page.getByTestId("workspace-tool-settings");
  if (!(await panel.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Profile menu" }).click();
    await page
      .getByRole("menu", { name: "Profile menu" })
      .getByRole("menuitem", { name: "Settings" })
      .click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

async function openNotifications(page: Page, name = "Notifications") {
  const panel = await ensureSettings(page);
  await panel.getByRole("button", { name }).click();
  const section = page.getByTestId("settings-notifications");
  await expect(section).toBeVisible();
  return section;
}

async function activePubkey(page: Page): Promise<string> {
  const panel = await ensureSettings(page);
  await panel.getByRole("button", { name: "Identity" }).click();
  const value =
    (
      await panel
        .locator("dt")
        .filter({ hasText: "Public key" })
        .locator("xpath=following-sibling::dd[1]")
        .textContent()
    )?.trim() ?? "";
  expect(value).toMatch(/^[0-9a-f]{64}$/);
  return value;
}

function scopeFor(pubkey: string): string {
  return createHash("sha256")
    .update(`${RELAY}\n${pubkey.toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

function preferenceKey(pubkey: string): string {
  return `buzz:web:notify:v1:${encodeURIComponent(RELAY)}:${pubkey.toLowerCase()}`;
}

async function serviceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers();
  return existing[0] ?? context.waitForEvent("serviceworker");
}

/** Counts real showNotification calls inside the worker, so a double show cannot hide in the tag. */
async function patchShowCounter(context: BrowserContext) {
  const worker = await serviceWorker(context);
  await worker.evaluate(() => {
    const scope = self as unknown as {
      __buzzShows?: Array<{ title: string; data: unknown }>;
      __buzzPatched?: boolean;
      registration: ServiceWorkerRegistration;
    };
    if (scope.__buzzPatched) return;
    scope.__buzzPatched = true;
    scope.__buzzShows = [];
    const proto = Object.getPrototypeOf(scope.registration) as ServiceWorkerRegistration;
    const original = proto.showNotification;
    proto.showNotification = function (
      this: ServiceWorkerRegistration,
      title: string,
      options?: NotificationOptions,
    ) {
      scope.__buzzShows?.push({ title, data: options?.data ?? null });
      return original.call(this, title, options);
    };
  });
}

async function showCount(context: BrowserContext): Promise<number> {
  const worker = await serviceWorker(context);
  return worker.evaluate(
    () => (self as unknown as { __buzzShows?: unknown[] }).__buzzShows?.length ?? 0,
  );
}

async function shownNotifications(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return [];
    const notifications = await registration.getNotifications();
    return notifications.map((notification) => ({
      tag: notification.tag,
      title: notification.title,
      body: notification.body,
      data: notification.data as Record<string, unknown> | null,
    }));
  });
}

async function seedPending(
  page: Page,
  keyScope: string,
  record: { storedAt: number; target: Record<string, unknown> },
) {
  await page.evaluate(
    async ({ cache, key, payload }) => {
      const storage = await caches.open(cache);
      await storage.put(
        key,
        new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }),
      );
    },
    {
      cache: PENDING_CACHE,
      key: `${keyScope}__buzz-notify-pending__/${keyScope}`,
      payload: { v: 1, ...record },
    },
  );
}

async function pendingKeyCount(page: Page): Promise<number> {
  return page.evaluate(async (cache) => {
    const storage = await caches.open(cache);
    return (await storage.keys()).length;
  }, PENDING_CACHE);
}

async function wakeUpClick(page: Page) {
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent("message", { data: { type: "buzz:notification-click" } }),
    );
  });
}

/** Posts the page-to-worker notification message and returns the worker's reply. */
async function notifyWorker(
  page: Page,
  message: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  return page.evaluate(async (payload) => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (!worker) return null;
    return await new Promise<Record<string, unknown> | null>((resolve) => {
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => resolve(null), 5_000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timer);
        resolve(event.data && typeof event.data === "object" ? event.data : null);
      };
      worker.postMessage(payload, [channel.port2]);
    });
  }, message);
}

test.describe("open-tab notifications", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  test("settings derive the state and only a click asks for permission", async ({
    context,
    page,
  }) => {
    const relay = new FakeRelay();
    await relay.install(context);
    await useConfig(page);
    await page.goto("/");
    await createIdentity(page, "notification spec passphrase");

    const section = await openNotifications(page);
    await expect(section).toHaveAttribute("data-notify-state", "off");
    await expect(section.getByRole("button", { name: "Enable notifications" })).toBeEnabled();
    expect(await page.evaluate(() => Notification.permission)).toBe("default");

    const pubkey = await activePubkey(page);
    await openNotifications(page);
    await context.grantPermissions(["notifications"], { origin: ORIGIN });
    await expect.poll(() => page.evaluate(() => Notification.permission)).toBe("granted");
    await section.getByRole("button", { name: /^(Enable notifications|Turn on)$/ }).click();
    await expect(section).toHaveAttribute("data-notify-state", "ready");
    expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey(pubkey))).toBe(
      "true",
    );

    await section.getByRole("button", { name: "Turn off" }).click();
    await expect(section).toHaveAttribute("data-notify-state", "granted_off");
    expect(
      await page.evaluate((key) => localStorage.getItem(key), preferenceKey(pubkey)),
    ).toBeNull();
  });

  test("denied and unavailable are never rendered as enabled", async ({
    browser,
    context,
    page,
  }) => {
    const relay = new FakeRelay();
    await relay.install(context);
    await useConfig(page);
    await page.goto("/");
    await createIdentity(page, "blocked spec passphrase");
    const blocked = await openNotifications(page);
    await expect(blocked).toHaveAttribute("data-notify-state", "off");
    // Headless Chromium answers the real prompt with "denied"; that must become "blocked".
    await blocked.getByRole("button", { name: "Enable notifications" }).click();
    await expect(blocked).toHaveAttribute("data-notify-state", "blocked");
    await expect(blocked.getByRole("button", { name: "Enable notifications" })).toBeDisabled();

    const unsupportedContext = await browser.newContext({ locale: "en-US" });
    const unsupportedPage = await unsupportedContext.newPage();
    await unsupportedPage.addInitScript(() => {
      Reflect.deleteProperty(window, "Notification");
    });
    await useConfig(unsupportedPage);
    await unsupportedPage.goto("/");
    await createIdentity(unsupportedPage, "unsupported spec passphrase");
    const unsupported = await openNotifications(unsupportedPage);
    await expect(unsupported).toHaveAttribute("data-notify-state", "unsupported");
    await unsupportedContext.close();

    const noWorkerContext = await browser.newContext({ locale: "en-US" });
    const noWorkerPage = await noWorkerContext.newPage();
    await noWorkerPage.addInitScript(() => {
      navigator.serviceWorker.register = () =>
        Promise.reject(new Error("service worker disabled for this test"));
    });
    await useConfig(noWorkerPage);
    await noWorkerContext.grantPermissions(["notifications"], { origin: ORIGIN });
    await noWorkerPage.goto("/");
    await createIdentity(noWorkerPage, "no worker spec passphrase");
    const unavailable = await openNotifications(noWorkerPage);
    await unavailable.getByRole("button", { name: "Turn on" }).click();
    await expect(unavailable).toHaveAttribute("data-notify-state", "unavailable", {
      timeout: 20_000,
    });
    await expect(unavailable.getByRole("button", { name: "Retry" })).toBeEnabled();
    await noWorkerContext.close();
  });

  test("a new event notifies once, history stays silent, and cleanup stays in scope", async ({
    context,
    page,
  }) => {
    const relay = new FakeRelay();
    const now = Math.floor(Date.now() / 1_000);
    relay.seed(mention("1", now - 120));
    await relay.install(context);
    await useConfig(page);
    await hideTab(page);
    await context.grantPermissions(["notifications"], { origin: ORIGIN });
    await page.goto("/");
    await createIdentity(page, "notify spec passphrase");
    const scope = scopeFor(await activePubkey(page));

    // Pre-existing history reached the inbox before it armed, so it must stay silent.
    await expect(page.getByTestId("inbox-unread-count")).toHaveText("1");
    const section = await openNotifications(page);
    await section.getByRole("button", { name: /^(Enable notifications|Turn on)$/ }).click();
    await expect(section).toHaveAttribute("data-notify-state", "ready");
    await patchShowCounter(context);
    expect(await shownNotifications(page)).toHaveLength(0);
    expect(await showCount(context)).toBe(0);

    // An eligible event that arrives now notifies exactly once.
    const first = mention("3", Math.floor(Date.now() / 1_000) + 1);
    relay.push(first);
    await expect.poll(() => shownNotifications(page).then((list) => list.length)).toBe(1);
    const [notification] = await shownNotifications(page);
    expect(notification.tag).toBe(`buzz:v1:${scope}:ch:${CHANNEL}`);
    expect(notification.data).toMatchObject({
      v: 1,
      scopeId: scope,
      eventId: first.id,
      channelId: CHANNEL,
      category: "mention",
      createdAt: first.created_at,
    });
    expect(notification.title).toBe("Buzz Community");
    expect(notification.body).toBe("New activity in Buzz");
    expect(JSON.stringify(notification)).not.toContain(AUTHOR);
    expect(await showCount(context)).toBe(1);

    // The page marks an event seen before posting, so re-delivery never reaches the worker.
    relay.push(first);
    await page.waitForTimeout(1_000);
    expect(await shownNotifications(page)).toHaveLength(1);
    expect(await showCount(context)).toBe(1);

    const newer = mention("4", first.created_at + 1);
    relay.push(newer);
    await expect
      .poll(() => shownNotifications(page).then((list) => list[0]?.data?.eventId))
      .toBe(newer.id);
    expect(await shownNotifications(page)).toHaveLength(1);

    // The same page-side guard keeps the newer notification when the older event arrives again.
    relay.push(first);
    await page.waitForTimeout(1_000);
    expect((await shownNotifications(page))[0]?.data?.eventId).toBe(newer.id);
    expect(await showCount(context)).toBe(2);

    // Another identity's notification in the same profile must survive this scope's cleanup.
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.showNotification("Other", {
        tag: "buzz:v1:0000000000000000:ch:elsewhere",
        data: { v: 1, scopeId: "0000000000000000" },
      });
    });

    await openNotifications(page);
    await section.getByRole("button", { name: "Turn off" }).click();
    await expect(section).toHaveAttribute("data-notify-state", "granted_off");
    await expect
      .poll(() => shownNotifications(page).then((list) => list.map((item) => item.tag)))
      .toEqual(["buzz:v1:0000000000000000:ch:elsewhere"]);
  });

  test("two hidden tabs produce one notification for one event", async ({ context, page }) => {
    const relay = new FakeRelay();
    await relay.install(context);
    await useConfig(page);
    await hideTab(page);
    await context.grantPermissions(["notifications"], { origin: ORIGIN });
    await page.goto("/");
    await createIdentity(page, "two tab spec passphrase");
    const section = await openNotifications(page);
    await section.getByRole("button", { name: /^(Enable notifications|Turn on)$/ }).click();
    await expect(section).toHaveAttribute("data-notify-state", "ready");

    const second = await context.newPage();
    await useConfig(second);
    await hideTab(second);
    await second.goto("/");
    await unlockIdentity(second, "two tab spec passphrase");
    const secondSection = await openNotifications(second);
    await expect(secondSection).toHaveAttribute("data-notify-state", "ready");

    await patchShowCounter(context);
    relay.push(mention("5", Math.floor(Date.now() / 1_000) + 1, OTHER_CHANNEL));
    await expect.poll(() => shownNotifications(page).then((list) => list.length)).toBe(1);
    await page.waitForTimeout(1_500);
    expect(await showCount(context)).toBe(1);
    expect(await shownNotifications(second)).toHaveLength(1);
  });

  test("enabling in one tab re-arms a sibling and keeps pre-enablement history silent", async ({
    context,
    page,
  }) => {
    const relay = new FakeRelay();
    await relay.install(context);
    await useConfig(page);
    await hideTab(page);
    await context.grantPermissions(["notifications"], { origin: ORIGIN });
    await page.goto("/");
    await createIdentity(page, "sibling arm passphrase");

    // The sibling mounts while the preference is still off, so it arms with its own watermark.
    const sibling = await context.newPage();
    await useConfig(sibling);
    await hideTab(sibling);
    await sibling.goto("/");
    await unlockIdentity(sibling, "sibling arm passphrase");
    const siblingSection = await openNotifications(sibling);
    await expect(siblingSection).toHaveAttribute("data-notify-state", "granted_off");

    // A mention arrives while notifications are off: pre-enablement history for the sibling.
    // Created at push time, so it is <= the enable second; the strict watermark comparison keeps it
    // silent.
    relay.push(mention("7", Math.floor(Date.now() / 1_000)));
    await expect(sibling.getByTestId("inbox-unread-count")).toHaveText("1", { timeout: 15_000 });

    // Enabling in the first tab must re-arm the sibling instead of replaying that item.
    const section = await openNotifications(page);
    await section.getByRole("button", { name: "Turn on" }).click();
    await expect(section).toHaveAttribute("data-notify-state", "ready");
    await expect(siblingSection).toHaveAttribute("data-notify-state", "ready");
    await sibling.waitForTimeout(2_000);
    expect(await shownNotifications(sibling)).toHaveLength(0);
  });

  test("the worker dedupes and rejects malformed payloads", async ({ context, page }) => {
    const scope = "0123456789abcdef";
    const createdAt = Math.floor(Date.now() / 1_000);
    const payload = (id: string, at: number) => ({
      type: "buzz:notify:v1",
      v: 1,
      tag: `buzz:v1:${scope}:ch:${CHANNEL}`,
      scopeId: scope,
      eventId: id.repeat(64).slice(0, 64),
      channelId: CHANNEL,
      threadRootId: null,
      category: "mention",
      createdAt: at,
      title: "Buzz Community",
      body: "New activity in Buzz",
    });
    await useConfig(page);
    await context.grantPermissions(["notifications"], { origin: ORIGIN });
    await page.goto("/");

    // Every malformed variant is rejected at the worker boundary and stores nothing.
    const invalid = [
      { ...payload("a", createdAt), v: 2 },
      { ...payload("a", createdAt), scopeId: "not-hex" },
      { ...payload("a", createdAt), category: "other" },
      { ...payload("a", createdAt), tag: `buzz:v1:${scope}:ch:elsewhere` },
    ];
    for (const malformed of invalid) {
      expect(await notifyWorker(page, malformed)).toMatchObject({ result: "invalid" });
    }
    expect(await shownNotifications(page)).toHaveLength(0);

    expect(await notifyWorker(page, payload("a", createdAt))).toMatchObject({ result: "shown" });
    expect(await notifyWorker(page, payload("a", createdAt))).toMatchObject({
      result: "duplicate",
    });

    // An older event for the same channel tag is refused and the shown event stays.
    expect(await notifyWorker(page, payload("b", createdAt - 100))).toMatchObject({
      result: "stale",
    });
    const stored = await shownNotifications(page);
    expect(stored).toHaveLength(1);
    expect(stored[0].data?.eventId).toBe("a".repeat(64));
  });

  test("clicks route only for the unlocked scope and are consumed once", async ({
    context,
    page,
  }) => {
    const relay = new FakeRelay();
    const now = Math.floor(Date.now() / 1_000);
    relay.seed(
      fixtureEvent("6", 39000, now - 300, [
        ["d", CHANNEL],
        ["name", "general"],
        ["t", "stream"],
        ["p", "@viewer"],
      ]),
      fixtureEvent("7", 39002, now - 300, [
        ["d", CHANNEL],
        ["p", "@viewer", "", "owner"],
      ]),
      fixtureEvent("8", 9, now - 120, [
        ["h", CHANNEL],
        ["p", "@viewer"],
      ]),
      fixtureEvent(
        "2",
        46010,
        now - 60,
        [
          ["h", CHANNEL],
          ["p", "@viewer"],
          ["d", "d".repeat(64)],
        ],
        '{"title":"Approval needed"}',
      ),
    );
    await relay.install(context);
    await useConfig(page);
    await page.goto("/");
    await createIdentity(page, "click spec passphrase");
    const scope = scopeFor(await activePubkey(page));
    await page
      .getByTestId("workspace-tool-settings")
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "general", exact: true })).toBeVisible();
    // Opening the channel marks its timeline read, so only the approval stays unread.
    await expect(page.getByTestId("inbox-unread-count")).toHaveText("1");

    const messageId = "8".repeat(64);
    const target = {
      v: 1,
      scopeId: scope,
      eventId: messageId,
      channelId: CHANNEL,
      threadRootId: null,
      category: "mention",
      createdAt: now - 120,
    };
    const approvalTarget = {
      ...target,
      eventId: "2".repeat(64),
      category: "needs_action",
      createdAt: now - 60,
    };
    const inbox = page.getByTestId("workspace-tool-inbox");
    const message = page.locator(`[data-message-id="${messageId}"]`);
    await expect(message).toHaveCount(1);

    // A click whose payload belongs to another identity is deleted and never routed.
    await seedPending(page, scope, {
      storedAt: Date.now(),
      target: { ...target, scopeId: "0000000000000000" },
    });
    await wakeUpClick(page);
    await page.waitForTimeout(750);
    await expect(inbox).toHaveCount(0);
    await expect(message).not.toHaveAttribute("data-highlighted", "true");
    expect(await pendingKeyCount(page)).toBe(0);

    // An expired click is dropped.
    await seedPending(page, scope, { storedAt: Date.now() - 6 * 60 * 1_000, target });
    await wakeUpClick(page);
    await page.waitForTimeout(750);
    await expect(inbox).toHaveCount(0);
    await expect(message).not.toHaveAttribute("data-highlighted", "true");
    expect(await pendingKeyCount(page)).toBe(0);

    // A fresh click reveals the exact message and is consumed exactly once.
    await seedPending(page, scope, { storedAt: Date.now(), target });
    await wakeUpClick(page);
    await expect(message).toHaveAttribute("data-highlighted", "true");
    expect(await pendingKeyCount(page)).toBe(0);
    await wakeUpClick(page);
    await page.waitForTimeout(750);
    await expect(message).toHaveAttribute("data-highlighted", "true");

    // An approval click opens the Inbox instead of a message.
    await seedPending(page, scope, { storedAt: Date.now(), target: approvalTarget });
    await wakeUpClick(page);
    await expect(inbox).toBeVisible();
    await expect(inbox.getByText("Approval needed").first()).toBeVisible();
    expect(await pendingKeyCount(page)).toBe(0);
  });

  test("Chinese copy is rendered for the notification settings", async ({ browser }) => {
    const context = await browser.newContext({ locale: "zh-CN" });
    const page = await context.newPage();
    const relay = new FakeRelay();
    await relay.install(context);
    await useConfig(page);
    await context.grantPermissions(["notifications"], { origin: ORIGIN });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await page.getByRole("button", { name: "新建", exact: true }).click();
    await page.getByLabel("新保险库口令").fill("notification zh passphrase");
    await page.getByLabel("确认口令").fill("notification zh passphrase");
    await page.getByLabel("我明白，如果加密保险库和备份均丢失，Buzz 无法恢复此身份。").check();
    await page.getByRole("button", { name: "新建", exact: true }).click();
    await expect(page.getByRole("button", { name: "个人菜单" })).toBeVisible();
    await page.getByRole("button", { name: "个人菜单" }).click();
    await page
      .getByRole("menu", { name: "个人菜单" })
      .getByRole("menuitem", { name: "设置" })
      .click();
    const settingsPanel = page.getByTestId("workspace-tool-settings");
    await settingsPanel.getByRole("button", { name: "通知" }).click();
    const section = page.getByTestId("settings-notifications");
    await expect(section).toBeVisible();
    await expect(section).toHaveAttribute("data-notify-state", "granted_off");
    await expect(
      section.getByText("当 Buzz Web 在后台且有待处理事项时，显示桌面通知。"),
    ).toBeVisible();
    await expect(section.getByText("通知不会包含消息内容、频道名称或发送者。")).toBeVisible();
    await section.getByRole("button", { name: "开启" }).click();
    await expect(section).toHaveAttribute("data-notify-state", "ready");
    await expect(section.getByText("已开启")).toBeVisible();
    await context.close();
  });
});
