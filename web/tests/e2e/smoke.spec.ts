import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
  type EventTemplate,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

const DEMO_CONFIG = {
  communityName: "Buzz Community",
  relayUrl: "wss://relay.example.com",
  agentControlUrl: "https://buzz.example.com/app/api/agent-control",
  features: { projects: true, forum: true },
  demoMode: true,
  agents: [
    {
      pubkey: "a".repeat(64),
      name: "Codex(remote)",
      startable: true,
    },
    {
      pubkey: "b".repeat(64),
      name: "Grok(remote)",
      startable: true,
    },
  ],
};

async function enableDemo(
  page: Page,
  { features = DEMO_CONFIG.features }: { features?: { projects: boolean; forum: boolean } } = {},
) {
  await page.route("**/config.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...DEMO_CONFIG, features }),
    });
  });
}

async function expectNoViewportOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
}

test("chat workspace loads with Buzz branding and relay data", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await enableDemo(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /app-icon\.png$/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    /app-icon\.png$/,
  );
  await expect(page.getByRole("img", { name: "Buzz" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "general" })).toBeVisible();
  await expect(page.getByText("Relay is healthy", { exact: false })).toBeVisible();
  await expect(page.getByText("Codex(remote)").first()).toBeVisible();
  await expect(page.getByTestId("system-message-row")).toHaveCount(3);
  await expect(page.getByText("created this channel", { exact: true })).toBeVisible();
  await expect(page.getByText("added by You", { exact: true })).toHaveCount(2);
  await expect(page.getByText(/"channel_created"/)).toHaveCount(0);
  const membersButton = page.getByRole("button", { name: "Members: 3" });
  await expect(membersButton).toContainText("3");
  await membersButton.click();
  const members = page.getByRole("dialog", { name: "Members · 3" });
  await expect(members).toBeVisible();
  await members.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: /Huddle/i })).toHaveCount(0);

  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog", { name: "Search messages" });
  await expect(search.getByRole("button", { name: "Browse channels" })).toBeVisible();
  await expect(search.getByRole("button", { name: "Create channel" })).toBeVisible();
  await expect(search.getByRole("button", { name: "New direct message" })).toBeVisible();
  await expect(search.getByPlaceholder("Search this Relay")).toBeFocused();
  await expect(search.getByText("general", { exact: true })).toBeVisible();
  await search.getByPlaceholder("Search this Relay").fill("Relay");
  await expect(search.getByText(/Relay is healthy/)).toBeVisible();
  await search.getByPlaceholder("Search this Relay").fill("");
  await expect(search.getByText("general", { exact: true })).toBeVisible();
  await search.getByRole("button", { name: "Close" }).click();

  await page.keyboard.press("Control+f");
  const channelSearch = page.getByRole("dialog", { name: "Search #general" });
  await expect(channelSearch.getByPlaceholder("Search this channel")).toBeFocused();
  await channelSearch.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Channel details" }).click();
  const details = page.getByRole("complementary", { name: "Channel details" });
  await expect(details.getByRole("button", { name: "Refresh" })).toBeVisible();
  await expect(details.getByRole("button", { name: "Add to favorites" })).toBeVisible();
  await expect(details.getByRole("button", { name: "Mute channel" })).toBeVisible();
  await expect(details.getByRole("button", { name: "Archive channel" })).toBeVisible();
  await expect(
    details.getByText("Build, operate, and learn together", { exact: true }),
  ).toBeVisible();
  await details.getByRole("button", { name: "Close channel details" }).click();
  await expectNoViewportOverflow(page);
  await page.screenshot({
    path: "test-results/visual/buzz-web-desktop.png",
    animations: "disabled",
  });
});

test("desktop navigation opens a remote-agent DM", async ({ page }) => {
  await enableDemo(page);
  await page.goto("/");
  const dmButton = page.getByRole("button", { name: "Codex(remote)", exact: true });
  await expect(dmButton.getByRole("img", { name: "online" })).toBeVisible();
  await dmButton.click();
  await expect(page.getByRole("heading", { name: "Codex(remote)" })).toBeVisible();
  await expect(page.getByLabel("Send a message to Codex(remote)")).toBeVisible();
});

test("agent activity exposes a redacted fixture view at desktop and mobile widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await enableDemo(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Codex(remote)", exact: true }).click();
  await page.getByLabel("Send a message to Codex(remote)").fill("Run the fixture verification.");
  await page.getByRole("button", { name: "Send" }).click();

  const indicator = page.getByTestId("agent-activity-indicator");
  await expect(indicator).toContainText("Using a tool — npm test -- --runInBand");
  await indicator.getByRole("button", { name: "View activity" }).click();

  const panel = page.getByRole("complementary", { name: "Agent activity" });
  await expect(panel.getByText("npm test -- --runInBand", { exact: true })).toBeVisible();
  await expect(panel).not.toContainText("rawInput");

  await page.screenshot({
    path: "test-results/visual/agent-activity-desktop.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  await expectNoViewportOverflow(page);
  await page.screenshot({
    path: "test-results/visual/agent-activity-mobile.png",
    animations: "disabled",
  });
});

test("new direct message uses the workspace To picker", async ({ page }) => {
  await enableDemo(page);
  await page.goto("/");

  await page.getByRole("button", { name: "New direct message" }).click();
  const newDm = page.getByTestId("workspace-tool-new-dm");
  await expect(newDm.getByRole("heading", { name: "New direct message" })).toBeVisible();
  await newDm.getByLabel("Search members or agents").fill("Codex");
  await newDm.getByRole("button", { name: /Codex\(remote\)/ }).click();

  await expect(newDm).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Codex(remote)" })).toBeVisible();
});

test("Relay feature state controls preview navigation without local settings", async ({ page }) => {
  await enableDemo(page, { features: { projects: false, forum: false } });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Projects" })).toHaveCount(0);
  await expect(page.getByText("Forums", { exact: true })).toHaveCount(0);

  await expect(page.getByRole("button", { name: "Profile menu" })).toBeVisible();
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+,");
  const settings = page.getByTestId("workspace-tool-settings");
  await expect(settings.getByRole("navigation", { name: "Settings" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Profile", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Appearance" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Invites" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Identity" })).toBeVisible();
  await expect(settings.getByText("Experiments", { exact: true })).toHaveCount(0);
  await expect(settings.getByRole("checkbox")).toHaveCount(0);
});

test("mobile layout exposes the channel drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enableDemo(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "general" })).toBeVisible();
  const message = page.locator("article").filter({
    hasText: "Relay is healthy. Postgres, Redis, MinIO, and Git are available.",
  });
  await expect(message.getByRole("button", { name: "Open message actions" })).toBeVisible();
  await expect(message.getByRole("button", { name: "Reaction 👀" })).toBeHidden();
  await message.getByRole("button", { name: "Open message actions" }).click();
  const actions = message.getByRole("menu", { name: "More message actions" });
  await expect(actions.getByRole("menuitem", { name: "Reaction 👀" })).toBeVisible();
  await expect(actions.getByRole("menuitem", { name: "Reply in thread" })).toBeVisible();
  await expectNoViewportOverflow(page);
  await page.screenshot({
    path: "test-results/visual/buzz-web-mobile-actions.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expectNoViewportOverflow(page);
  await page.screenshot({
    path: "test-results/visual/buzz-web-mobile.png",
    animations: "disabled",
  });
  const composer = page.getByLabel("Send a message to #general");
  await composer.fill("@");
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toBeVisible();
  await expectNoViewportOverflow(page);
  await composer.fill("");
  await page.getByRole("button", { name: "Open channel list" }).click();
  await expect(page.getByText("Buzz Community")).toBeVisible();
  await expect(page.getByRole("button", { name: "New direct message" })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Resize channel panel" })).toBeHidden();
  await page.screenshot({
    path: "test-results/visual/buzz-web-mobile-drawer.png",
    animations: "disabled",
  });
});

test("mobile Inbox and Agents views remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enableDemo(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Inbox" }).last().click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText("Can you review the deployment checklist?").first()).toBeVisible();
  await expectNoViewportOverflow(page);
  await page.screenshot({
    path: "test-results/visual/buzz-web-inbox-mobile.png",
    animations: "disabled",
  });

  await page.getByRole("button", { name: "Agents" }).last().click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(page.getByText("Codex(remote)").first()).toBeVisible();
  await expectNoViewportOverflow(page);
  await page.screenshot({
    path: "test-results/visual/buzz-web-agents-mobile.png",
    animations: "disabled",
  });
});

test("unsupported media is rejected before contacting the Relay", async ({ page }) => {
  let uploadRequests = 0;
  await enableDemo(page);
  await page.route("**/upload", async (route) => {
    uploadRequests += 1;
    await route.fulfill({ status: 500 });
  });
  await page.goto("/");

  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "camera.heic",
      mimeType: "image/heic",
      buffer: Buffer.from([0, 0, 0, 20]),
    });
  await expect(page.getByText("This media format isn't supported for upload.")).toBeVisible();
  expect(uploadRequests).toBe(0);
});

test("desktop channel panel resizes and restores its saved width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await enableDemo(page);
  await page.goto("/");

  const separator = page.getByRole("separator", { name: "Resize channel panel" });
  await expect(separator).toBeVisible();
  const before = await separator.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0,
  );
  expect(before).toBeGreaterThanOrEqual(186);
  expect(before).toBeLessThanOrEqual(190);
  const handle = await separator.boundingBox();
  expect(handle).not.toBeNull();
  await page.mouse.move((handle?.x ?? 0) + 4, (handle?.y ?? 0) + 100);
  await page.mouse.down();
  await page.mouse.move((handle?.x ?? 0) + 72, (handle?.y ?? 0) + 100);
  await page.mouse.up();

  const resized = await separator.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0,
  );
  expect(resized).toBeGreaterThan(before + 55);
  expect(resized).toBeLessThanOrEqual(360);

  await page.reload();
  const restored = await page
    .getByRole("separator", { name: "Resize channel panel" })
    .evaluate((element) => element.parentElement?.getBoundingClientRect().width ?? 0);
  expect(Math.abs(restored - resized)).toBeLessThan(2);
});

test("member modal and right panels use the Mac-style interaction model", async ({ page }) => {
  await page.setViewportSize({ width: 1720, height: 900 });
  await enableDemo(page);
  await page.goto("/");

  await expect(page.getByRole("dialog", { name: "Members · 3" })).toHaveCount(0);
  await page.getByRole("button", { name: "Members: 3" }).click();
  const members = page.getByRole("dialog", { name: "Members · 3" });
  await expect(members).toBeVisible();
  await expect(page.getByRole("separator", { name: /member panel/i })).toHaveCount(0);
  await members.getByRole("button", { name: "Add member" }).click();
  await members.getByLabel("Member public key").fill("c".repeat(64));
  await members.getByRole("button", { name: "Add member" }).last().click();
  await expect(page.getByRole("dialog", { name: "Members · 4" })).toBeVisible();
  const updatedMembers = page.getByRole("dialog", { name: "Members · 4" });
  await updatedMembers.getByRole("button", { name: /^Remove / }).click();
  const removeConfirmation = page.getByRole("dialog", { name: "Remove member" });
  await expect(removeConfirmation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(removeConfirmation).toHaveCount(0);
  await expect(updatedMembers).toBeVisible();
  await updatedMembers.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Channel details" }).click();
  const details = page.getByRole("complementary", { name: "Channel details" });
  const detailsSeparator = page.getByRole("separator", { name: "Resize channel details" });
  await expect(details).toBeVisible();
  await expect(detailsSeparator).toBeVisible();
  const detailsDefault = await detailsSeparator.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0,
  );
  expect(detailsDefault).toBeGreaterThanOrEqual(318);
  expect(detailsDefault).toBeLessThanOrEqual(322);
  const detailsHandle = await detailsSeparator.boundingBox();
  expect(detailsHandle).not.toBeNull();
  await page.mouse.move((detailsHandle?.x ?? 0) + 4, (detailsHandle?.y ?? 0) + 100);
  await page.mouse.down();
  await page.mouse.move((detailsHandle?.x ?? 0) - 120, (detailsHandle?.y ?? 0) + 100);
  await page.mouse.up();
  const detailsResized = await detailsSeparator.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0,
  );
  expect(detailsResized).toBeGreaterThan(detailsDefault + 100);

  const messageRow = page.locator("article").filter({
    hasText: "Relay is healthy. Postgres, Redis, MinIO, and Git are available.",
  });
  await messageRow.hover();
  await messageRow.getByRole("button", { name: "Reply in thread" }).click();

  const threadSeparator = page.getByRole("separator", { name: "Resize thread panel" });
  await expect(threadSeparator).toBeVisible();
  await expect(details).toHaveCount(0);
  await expect(detailsSeparator).toHaveCount(0);
  const threadDefault = await threadSeparator.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0,
  );
  expect(threadDefault).toBeGreaterThanOrEqual(360);
  expect(threadDefault).toBeLessThanOrEqual(400);
  const threadHandle = await threadSeparator.boundingBox();
  expect(threadHandle).not.toBeNull();
  await page.mouse.move((threadHandle?.x ?? 0) + 4, (threadHandle?.y ?? 0) + 100);
  await page.mouse.down();
  await page.mouse.move((threadHandle?.x ?? 0) - 100, (threadHandle?.y ?? 0) + 100);
  await page.mouse.up();
  const threadResized = await threadSeparator.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0,
  );
  expect(threadResized).toBeGreaterThan(threadDefault + 80);
  await page.screenshot({
    path: "test-results/visual/buzz-web-thread-resized.png",
    animations: "disabled",
  });

  await page.getByRole("button", { name: "Close thread" }).click();
  await expect(threadSeparator).toHaveCount(0);
  await page.getByRole("button", { name: "Channel details" }).click();
  const restoredDetails = await detailsSeparator.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0,
  );
  expect(Math.abs(restoredDetails - detailsResized)).toBeLessThan(2);

  await page.reload();
  await expect(detailsSeparator).toHaveCount(0);
  await page.getByRole("button", { name: "Channel details" }).click();
  const persistedDetails = await detailsSeparator.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0,
  );
  expect(Math.abs(persistedDetails - detailsResized)).toBeLessThan(2);

  const restoredMessageRow = page.locator("article").filter({
    hasText: "Relay is healthy. Postgres, Redis, MinIO, and Git are available.",
  });
  await restoredMessageRow.hover();
  await restoredMessageRow.getByRole("button", { name: "Reply in thread" }).click();
  await expect(details).toHaveCount(0);
  const persistedThread = await threadSeparator.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0,
  );
  expect(Math.abs(persistedThread - threadResized)).toBeLessThan(2);
});

test("message reactions toggle once and use the Mac-style capsule shape", async ({ page }) => {
  await enableDemo(page);
  await page.goto("/");

  const messageRow = page.locator("article").filter({
    hasText: "Document the Web client deployment as well.",
  });
  await messageRow.hover();
  await messageRow.getByRole("button", { name: "Reaction 👀" }).click();

  const reaction = messageRow.getByRole("button", { name: "👀, 1 reactions" });
  await expect(reaction).toBeVisible();
  await reaction.click();
  await expect(reaction).toHaveCount(0);

  await messageRow.hover();
  await messageRow.getByRole("button", { name: "Reaction 👀" }).click();
  await expect(reaction).toBeVisible();
  const shape = await reaction.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      radius: Number.parseFloat(style.borderTopLeftRadius),
    };
  });
  expect(shape.radius).toBeGreaterThanOrEqual(shape.height / 2);
  await page.screenshot({
    path: "test-results/visual/buzz-web-reaction-capsule.png",
    animations: "disabled",
  });
});

test("message images keep their reserved layout while loading", async ({ page }) => {
  const imageUrl = "https://cdn.example.com/media/layout-test.png";
  const imageBody = await readFile(new URL("../../public/app-icon.png", import.meta.url));
  let releaseImage = () => {};
  let markRequested = () => {};
  let imageRequests = 0;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });

  await enableDemo(page);
  await page.route("**/media/layout-test.png", async (route) => {
    imageRequests += 1;
    markRequested();
    await released;
    await route.fulfill({ body: imageBody, contentType: "image/png", status: 200 });
  });
  await page.goto("/");

  const composer = page.getByLabel("Send a message to #general");
  await composer.fill(`![poster](${imageUrl})`);
  await composer.press("Enter");
  await requested;

  const frame = page.locator('[data-protected-image-frame="true"]').last();
  await expect(frame).toBeVisible();
  const before = await frame.boundingBox();
  expect(before).not.toBeNull();
  expect(before?.width).toBe(384);
  expect(before?.height).toBe(256);

  releaseImage();
  const image = frame.getByRole("img", { name: "poster" });
  await expect(image).toBeVisible();
  await image.evaluate(async (element) => {
    await (element as HTMLImageElement).decode();
  });
  const loadedImage = await image.elementHandle();
  const loadedRow = await frame.locator("xpath=ancestor::article").elementHandle();
  expect(loadedImage).not.toBeNull();
  expect(loadedRow).not.toBeNull();
  const after = await frame.boundingBox();
  expect(after).not.toBeNull();

  expect(Math.abs((after?.width ?? 0) - (before?.width ?? 0))).toBeLessThan(1);
  expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThan(1);

  await composer.fill("Keep the loaded image mounted");
  await composer.press("Enter");
  await expect(page.getByText("Keep the loaded image mounted", { exact: true })).toBeVisible();
  expect(await loadedRow?.evaluate((element) => element.isConnected)).toBe(true);
  expect(imageRequests).toBe(1);
  expect(await loadedImage?.evaluate((element) => element.isConnected)).toBe(true);
  await expectNoViewportOverflow(page);
});

test("thread replies can target a specific message", async ({ page }) => {
  await enableDemo(page);
  await page.goto("/");

  const rootRow = page.locator("article").filter({
    hasText: "Relay is healthy. Postgres, Redis, MinIO, and Git are available.",
  });
  const rootId = await rootRow.getAttribute("data-message-id");
  if (!rootId) throw new Error("Thread root is missing its message id");
  await rootRow.hover();
  await rootRow.getByRole("button", { name: "Reply in thread" }).click();

  const thread = page.getByRole("complementary", { name: "Thread" });
  const composer = thread.getByLabel("Reply to thread");
  await composer.fill("First thread reply");
  await composer.press("Enter");

  const firstReply = thread.locator("article").filter({ hasText: "First thread reply" });
  await expect(firstReply).toBeVisible();
  const firstReplyId = await firstReply.getAttribute("data-message-id");
  if (!firstReplyId) throw new Error("Thread reply is missing its message id");
  await expect(firstReply).toHaveAttribute("data-parent-id", rootId);
  await expect(firstReply).toHaveAttribute("data-root-id", rootId);

  await firstReply.hover();
  await firstReply.getByRole("button", { name: "Reply to message" }).click();
  await expect(thread.getByTestId("reply-target")).toContainText("Replying to Alex");
  await page.screenshot({
    path: "test-results/visual/buzz-web-thread-reply-target.png",
    animations: "disabled",
  });
  await thread.getByRole("button", { name: "Cancel reply" }).click();
  await expect(thread.getByTestId("reply-target")).toHaveCount(0);

  await firstReply.hover();
  await firstReply.getByRole("button", { name: "Reply to message" }).click();
  await composer.fill("Nested thread reply");
  await composer.press("Enter");

  const nestedReply = thread.locator("article").filter({ hasText: "Nested thread reply" });
  await expect(nestedReply).toBeVisible();
  await expect(nestedReply).toHaveAttribute("data-parent-id", firstReplyId);
  await expect(nestedReply).toHaveAttribute("data-root-id", rootId);
  await expect(thread.getByTestId("reply-target")).toHaveCount(0);

  for (let index = 0; index < 10; index += 1) {
    const body = `Additional thread response ${index}`;
    await composer.fill(body);
    await composer.press("Enter");
    await expect(thread.locator("article").filter({ hasText: body })).toBeAttached();
  }
  await expect(thread.getByTestId("thread-bottom")).toBeInViewport();
});

test("thread summaries show unique participant avatars", async ({ page }) => {
  await enableDemo(page);
  await page.goto("/");

  const rootRow = page.locator("article").filter({
    hasText: "Document the Web client deployment as well.",
  });
  await rootRow.getByRole("button", { name: "1 replies" }).click();

  const thread = page.getByRole("complementary", { name: "Thread" });
  const composer = thread.getByLabel("Reply to thread");
  await composer.fill("Alex joins the existing Codex thread");
  await composer.press("Enter");

  const summary = rootRow.getByRole("button", { name: "2 replies" });
  await expect(summary).toBeVisible();
  const participants = summary.getByTestId("thread-participants");
  await expect(participants.locator('[title="Codex(remote)"]')).toHaveCount(1);
  await expect(participants.locator('[title="Alex"]')).toHaveCount(1);
  await expect(participants.locator(":scope > *")).toHaveCount(2);
  await summary.locator("xpath=ancestor::article").screenshot({
    path: "test-results/visual/buzz-web-thread-participants.png",
    animations: "disabled",
  });
  await expectNoViewportOverflow(page);
});

test("mention autocomplete works in channel and thread composers", async ({ page }) => {
  await enableDemo(page);
  await page.goto("/");

  const channelComposer = page.getByLabel("Send a message to #general");
  await channelComposer.fill("@Co");
  const channelSuggestions = page.getByRole("listbox", { name: "Mention suggestions" });
  await expect(channelSuggestions.getByRole("option", { name: /Codex\(remote\)/ })).toBeVisible();
  await channelComposer.press("Enter");
  await expect(channelComposer).toHaveValue("@Codex(remote) ");

  const rootRow = page.locator("article").filter({
    hasText: "Relay is healthy. Postgres, Redis, MinIO, and Git are available.",
  });
  await rootRow.hover();
  await rootRow.getByRole("button", { name: "Reply in thread" }).click();
  const thread = page.getByRole("complementary", { name: "Thread" });
  const threadComposer = thread.getByLabel("Reply to thread");
  await threadComposer.fill("@Gr");
  const threadSuggestions = thread.getByRole("listbox", { name: "Mention suggestions" });
  await expect(threadSuggestions.getByRole("option", { name: /Grok\(remote\)/ })).toBeVisible();
  await page.screenshot({
    path: "test-results/visual/buzz-web-mention-autocomplete.png",
    animations: "disabled",
  });
  await threadComposer.press("Tab");
  await expect(threadComposer).toHaveValue("@Grok(remote) ");
  await expectNoViewportOverflow(page);
});

test("mentions and single line breaks render consistently in channels and threads", async ({
  page,
}) => {
  await enableDemo(page);
  await page.goto("/");

  const seededMention = page
    .locator("article")
    .filter({ hasText: "Codex(remote) Check the Relay deployment." })
    .locator('[data-mention-agent="true"]');
  await expect(seededMention).toHaveText("Codex(remote)");
  await expect(seededMention.locator("svg")).toHaveCount(1);

  const channelComposer = page.getByLabel("Send a message to #general");
  await channelComposer.fill("@Codex(remote) 第一行\n第二行\n@Unknown");
  await page.getByRole("button", { name: "Send message" }).click();

  const channelMessage = page.locator("article").filter({ hasText: "第二行" }).last();
  const channelMention = channelMessage.locator('[data-mention-agent="true"]');
  await expect(channelMention).toHaveCount(1);
  await expect(channelMention).toHaveText("Codex(remote)");
  await expect(channelMention.locator("svg")).toHaveCount(1);
  await expect(channelMessage.locator(".buzz-message-markdown br")).toHaveCount(2);
  await expect(channelMessage).toContainText("@Unknown");
  const mentionStyle = await channelMention.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
    };
  });
  expect(mentionStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  await expect
    .poll(() =>
      channelMention.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
      ),
    )
    .toBeGreaterThanOrEqual(4);

  await channelMessage.hover();
  await channelMessage.getByRole("button", { name: "Reply in thread" }).click();
  const thread = page.getByRole("complementary", { name: "Thread" });
  await expect(thread.locator("article").filter({ hasText: "第二行" }).locator("br")).toHaveCount(
    2,
  );

  const threadComposer = thread.getByLabel("Reply to thread");
  await threadComposer.fill("@Grok(remote) 线程第一行\n线程第二行\n@Unknown");
  await thread.getByRole("button", { name: "Send message" }).click();

  const threadReply = thread.locator("article").filter({ hasText: "线程第二行" });
  const agentMention = threadReply.locator('[data-mention-agent="true"]');
  await expect(agentMention).toHaveCount(1);
  await expect(agentMention).toHaveText("Grok(remote)");
  await expect(agentMention.locator("svg")).toHaveCount(1);
  await expect(threadReply.locator(".buzz-message-markdown br")).toHaveCount(2);
  await expect(threadReply.locator('[data-mention=""]')).toHaveCount(1);
  await expect(threadReply).toContainText("@Unknown");
  await page.screenshot({
    path: "test-results/visual/buzz-web-mentions-and-line-breaks.png",
    animations: "disabled",
  });
});

test("workspace tools replace chat while preserving channel navigation", async ({ page }) => {
  await enableDemo(page);
  await page.goto("/");

  const composer = page.getByLabel("Send a message to #general");
  await page.getByRole("button", { name: "Projects" }).first().click();
  const reposPanel = page.getByTestId("workspace-tool-repos");
  await expect(page).toHaveURL(/\/$/);
  await expect(reposPanel).toBeVisible();
  await expect(reposPanel.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(reposPanel.getByRole("button", { name: "Publish a project" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "general", exact: true })).toHaveCount(0);
  await expect(composer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "general", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Codex(remote)", exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/visual/buzz-web-repos.png",
    animations: "disabled",
  });

  await reposPanel.getByRole("button", { name: /buzz-desktop/ }).click();
  const breadcrumb = reposPanel.getByRole("navigation", { name: "Repository breadcrumb" });
  await expect(breadcrumb).toContainText("Repositories");
  await expect(breadcrumb).toContainText("buzz-desktop");
  await expect(reposPanel.getByRole("tab", { name: "Code" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(reposPanel.getByRole("link", { name: "README.md" })).toBeVisible();
  await reposPanel.getByRole("tab", { name: "Commits" }).click();
  await expect(reposPanel.getByText("Polish repository browsing styles")).toBeVisible();
  await page.screenshot({
    path: "test-results/visual/buzz-web-repo-detail.png",
    animations: "disabled",
  });
  await breadcrumb.getByRole("button", { name: "Repositories" }).click();

  await page.getByRole("button", { name: "general", exact: true }).click();
  await expect(reposPanel).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "general" })).toBeVisible();
  await expect(composer).toBeVisible();

  await page.getByRole("button", { name: "Projects" }).first().click();
  await expect(reposPanel).toBeVisible();

  await page.getByRole("button", { name: "Agents" }).first().click();
  await expect(reposPanel).toHaveCount(0);
  await expect(page.getByTestId("workspace-tool-agents")).toBeVisible();
  await expect(page.getByRole("heading", { name: "general", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "general", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Agents" }).first().click();
  await expect(page.getByTestId("workspace-tool-agents")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "general" })).toBeVisible();
  await expect(composer).toBeVisible();
});

test("standalone repository details use breadcrumbs and content tabs", async ({ page }) => {
  await enableDemo(page);
  await page.goto("/repos/buzz-desktop?preview=repositories");

  const breadcrumb = page.getByRole("navigation", { name: "Repository breadcrumb" });
  await expect(breadcrumb.getByRole("link", { name: "Repositories" })).toHaveAttribute(
    "href",
    /\/repos\?preview=repositories$/,
  );
  await expect(breadcrumb).toContainText("buzz-desktop");
  await expect(page.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("link", { name: "README.md" })).toBeVisible();
  await page.getByRole("tab", { name: "Commits" }).click();
  await expect(page.getByText("Polish repository browsing styles")).toBeVisible();
  await expectNoViewportOverflow(page);
});

test("community admins can add a member or generate an invite link", async ({ page }) => {
  await enableDemo(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Invite people" }).click();
  const memberDialog = page.getByRole("dialog", { name: "Invite people" });
  await memberDialog.getByLabel("Member public key").fill("c".repeat(64));
  await memberDialog.getByRole("button", { name: "Add member" }).last().click();
  await expect(memberDialog).toBeHidden();
  await expect(page.getByText("Relay member added")).toBeVisible();

  await page.getByRole("button", { name: "Invite people" }).click();
  const inviteDialog = page.getByRole("dialog", { name: "Invite people" });
  await inviteDialog.getByRole("button", { name: "Invite link" }).click();
  await inviteDialog.getByLabel("Expires after").selectOption("604800");
  await inviteDialog.getByLabel("Limit number of uses").selectOption("3");
  await inviteDialog.getByRole("button", { name: "Generate link" }).click();
  await expect(inviteDialog.getByLabel("Generated invite link")).toHaveValue(
    /\/invite\/demo-code$/,
  );
  await page.screenshot({
    path: "test-results/visual/buzz-web-invite.png",
    animations: "disabled",
  });
});

test("remote agents open in a resizable profile panel and keep their controls", async ({
  page,
}) => {
  await enableDemo(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Agents" }).first().click();
  const agentsPanel = page.getByTestId("workspace-tool-agents");
  await expect(agentsPanel.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(agentsPanel.getByText("Grok(remote)", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "general", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "general", exact: true })).toBeVisible();
  await expect(agentsPanel.getByText("Codex(remote)", { exact: true })).toHaveCount(1);
  await expect(agentsPanel.getByRole("button", { name: "Add agent" })).toHaveCount(0);
  await expect(agentsPanel.getByRole("button", { name: "Stop running agents" })).toHaveCount(0);

  await agentsPanel.getByRole("button", { name: "Manage Codex(remote)" }).first().click();
  const profile = agentsPanel.getByRole("complementary", { name: "Manage Codex(remote)" });
  await expect(profile).toBeVisible();
  await expect(profile.getByRole("separator", { name: "Resize agent profile" })).toBeVisible();
  await expect(agentsPanel.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(profile.getByText("Agent default", { exact: true })).toBeVisible();

  const remove = profile.getByRole("button", { name: "Remove from #general" });
  await remove.click();
  await expect(profile.getByRole("button", { name: "Add to #general" })).toBeVisible();
  await profile.getByRole("button", { name: "Add to #general" }).click();
  await expect(profile.getByRole("button", { name: "Remove from #general" })).toBeVisible();
  await page.screenshot({
    path: "test-results/visual/buzz-web-agents.png",
    animations: "disabled",
  });

  await profile.getByRole("button", { name: "Message", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Codex(remote)" })).toBeVisible();
});

test("Inbox list width is resizable and persists", async ({ page }) => {
  await page.setViewportSize({ width: 1720, height: 900 });
  await enableDemo(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Inbox" }).first().click();

  const separator = page.getByRole("separator", { name: "Resize Inbox list" });
  const before = await separator.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0,
  );
  expect(before).toBeGreaterThanOrEqual(310);
  expect(before).toBeLessThanOrEqual(320);
  const handle = await separator.boundingBox();
  expect(handle).not.toBeNull();
  await page.mouse.move((handle?.x ?? 0) + 2, (handle?.y ?? 0) + 120);
  await page.mouse.down();
  await page.mouse.move((handle?.x ?? 0) + 90, (handle?.y ?? 0) + 120);
  await page.mouse.up();

  const resized = await separator.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0,
  );
  expect(resized).toBeGreaterThan(before + 70);
  await page.reload();
  await page.getByRole("button", { name: "Inbox" }).first().click();
  const restored = await separator.evaluate(
    (element) => element.parentElement?.getBoundingClientRect().width ?? 0,
  );
  expect(Math.abs(restored - resized)).toBeLessThan(2);
});

test("an offline agent play button starts its service without opening a DM", async ({ page }) => {
  await enableDemo(page);
  await page.route("https://buzz.example.com/app/api/agent-control/start", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ status: "accepted", action: "started" }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Agents" }).first().click();

  const requestPromise = page.waitForRequest(
    "https://buzz.example.com/app/api/agent-control/start",
  );
  await page.getByRole("button", { name: "Start Grok(remote)" }).click();
  const request = await requestPromise;
  expect(request.method()).toBe("POST");
  expect(request.postDataJSON()).toEqual({ pubkey: "b".repeat(64) });
  expect(request.headers().authorization).toMatch(/^Nostr /);
  await expect(page.getByTestId("workspace-tool-agents")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Grok(remote)" })).toHaveCount(0);
});

test("Inbox filters unread activity and opens the source thread", async ({ page }) => {
  await enableDemo(page);
  await page.goto("/");

  const inboxButton = page.getByRole("button", { name: "Inbox", exact: true }).first();
  await expect(inboxButton).toContainText("2");
  await inboxButton.click();
  const inboxPanel = page.getByTestId("workspace-tool-inbox");
  await expect(inboxPanel.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(inboxPanel.getByText("2 unread")).toBeVisible();
  await expect(page.getByRole("heading", { name: "general", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "general", exact: true })).toBeVisible();
  const generalUnread = page.getByTestId(
    `channel-unread-${"11111111-2222-4333-8444-555555555555"}`,
  );
  await expect(generalUnread).toBeVisible();
  await page.screenshot({
    path: "test-results/visual/buzz-web-inbox.png",
    animations: "disabled",
  });

  await inboxPanel.getByRole("combobox", { name: "Filter Inbox" }).selectOption("mention");
  await inboxPanel.getByRole("button", { name: /Can you review the deployment checklist/ }).click();
  await expect(inboxPanel.getByText("2 unread")).toBeVisible();
  await inboxPanel.getByRole("button", { name: "Open conversation" }).click();
  await expect(page.getByRole("heading", { name: "general", exact: true })).toBeVisible();
  const locatedMention = page.locator(`[data-message-id="${"1".repeat(64)}"]`);
  await expect(locatedMention).toHaveAttribute("data-highlighted", "true");
  await expect(locatedMention).toBeInViewport();
  await expect(generalUnread).toBeVisible();

  await page.getByRole("button", { name: "Inbox" }).first().click();
  await inboxPanel.getByRole("combobox", { name: "Filter Inbox" }).selectOption("thread");
  const reply = inboxPanel.getByRole("button", {
    name: /Verification is complete and the result is attached/,
  });
  await reply.click();
  await expect(inboxPanel.getByText("1 unread")).toBeVisible();
  await inboxPanel.getByRole("button", { name: "Open conversation" }).click();
  await expect(page.getByRole("complementary", { name: "Thread" })).toBeVisible();
  const locatedReply = page.locator(`[data-message-id="${"3".repeat(64)}"]`);
  await expect(locatedReply).toHaveAttribute("data-highlighted", "true");
  await expect(locatedReply).toBeInViewport();
  await expect(generalUnread).toHaveCount(0);

  await page.getByRole("button", { name: "Inbox" }).first().click();
  await page.keyboard.press("Shift+Escape");
  await expect(page.getByText("0 unread")).toBeVisible();
  await expect(generalUnread).toHaveCount(0);
});

test("Chinese browsers receive the Chinese interface", async ({ browser }) => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  await enableDemo(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "搜索" }).first()).toBeVisible();
  await expect(page.getByText("创建了此频道", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.screenshot({
    path: "test-results/visual/buzz-web-desktop-zh.png",
    animations: "disabled",
  });
  await page.keyboard.press("Control+f");
  const channelSearch = page.getByRole("dialog", { name: "在 #general 中搜索" });
  await expect(channelSearch.getByPlaceholder("搜索当前频道")).toBeFocused();
  await channelSearch.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("button", { name: "发起私聊" }).click();
  const newDm = page.getByTestId("workspace-tool-new-dm");
  await expect(newDm.getByRole("heading", { name: "发起私聊" })).toBeVisible();
  await newDm.getByLabel("搜索成员或 Agent").fill("不存在");
  await expect(newDm.getByText("没有匹配的成员")).toBeVisible();
  await newDm.getByRole("button", { name: "关闭新私聊" }).click();

  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "camera.heic",
      mimeType: "image/heic",
      buffer: Buffer.from([0, 0, 0, 20]),
    });
  await expect(page.getByText("暂不支持上传此媒体格式。")).toBeVisible();

  await page.goto("/invite/demo-code");
  await expect(page.getByRole("heading", { name: "你受邀加入" })).toBeVisible();
  await expect(page.getByRole("link", { name: "立即下载" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await context.close();
});

test("agent activity is localized in Chinese", async ({ browser }) => {
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await enableDemo(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Codex(remote)", exact: true }).click();
  await page.getByLabel("发送消息到 Codex(remote)").fill("运行合成验证。");
  await page.getByRole("button", { name: "发送消息" }).click();

  const indicator = page.getByTestId("agent-activity-indicator");
  await expect(indicator).toContainText("使用工具");
  await indicator.getByRole("button", { name: "查看活动" }).click();
  await expect(page.getByRole("complementary", { name: "Agent 活动" })).toContainText(
    "npm test -- --runInBand",
  );
  await page.screenshot({
    path: "test-results/visual/agent-activity-desktop-zh.png",
    animations: "disabled",
  });
  await context.close();
});

test("wide dark Chinese workspace remains readable", async ({ browser }) => {
  const context = await browser.newContext({
    colorScheme: "dark",
    locale: "zh-CN",
    viewport: { width: 1720, height: 900 },
  });
  await context.addInitScript(() => localStorage.setItem("buzz-web-theme", "dark"));
  const page = await context.newPage();
  await enableDemo(page);
  await page.goto("/");

  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("heading", { name: "general" })).toBeVisible();
  await expect(page.getByRole("button", { name: "搜索" }).first()).toBeVisible();
  await expectNoViewportOverflow(page);
  await page.screenshot({
    path: "test-results/visual/buzz-web-wide-dark-zh.png",
    animations: "disabled",
  });
  await context.close();
});

test("invite requires age and legal consent before opening Buzz", async ({ page }) => {
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        policy: {
          terms_markdown: "# Terms",
          privacy_markdown: "# Privacy",
          age_attestation_required: true,
          version: "policy-v1",
        },
      }),
    });
  });
  await page.route("https://api.github.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify([
        { draft: false, prerelease: false, assets: [] },
        {
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "Buzz_0.4.9_aarch64.dmg",
              browser_download_url:
                "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_aarch64.dmg",
            },
            {
              name: "Buzz_0.4.9_x64.dmg",
              browser_download_url:
                "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_x64.dmg",
            },
            {
              name: "Buzz_0.4.9_amd64.AppImage",
              browser_download_url:
                "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_amd64.AppImage",
            },
            {
              name: "Buzz_0.4.9_x64-setup_alpha-unsigned.exe",
              browser_download_url:
                "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_x64-setup_alpha-unsigned.exe",
            },
          ],
        },
      ]),
    });
  });
  await page.goto("/invite/demo-code");

  await expect(page.getByRole("link", { name: "Download it now" })).toHaveAttribute(
    "href",
    "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_x64-setup_alpha-unsigned.exe",
  );

  const ageConfirmation = page.getByLabel("I am 18 years of age or older.");
  const agreementConfirmation = page.getByLabel(
    "I agree to the Buzz Terms of Service and Privacy Policy.",
  );
  const acceptInvite = page.getByRole("button", {
    name: "Accept invite in Buzz",
  });

  await expect(ageConfirmation).toBeVisible();
  await expect(agreementConfirmation).toBeVisible();
  await expect(acceptInvite).toBeDisabled();

  const termsLink = page.getByRole("button", { name: "Terms of Service" });
  const privacyLink = page.getByRole("button", { name: "Privacy Policy" });
  await expect(termsLink).toHaveCSS("text-decoration-line", "none");
  await expect(privacyLink).toHaveCSS("text-decoration-line", "none");
  await termsLink.hover();
  await expect(termsLink).toHaveCSS("text-decoration-line", "underline");
  await page.mouse.move(0, 0);
  await privacyLink.hover();
  await expect(privacyLink).toHaveCSS("text-decoration-line", "underline");

  await page.locator("label").filter({ hasText: "I am 18 years of age or older." }).click();
  await expect(ageConfirmation).toBeChecked();
  await expect(acceptInvite).toBeDisabled();
  await page
    .locator("label")
    .filter({
      hasText: "I agree to the Buzz Terms of Service and Privacy Policy.",
    })
    .click({ position: { x: 8, y: 8 } });
  await expect(agreementConfirmation).toBeChecked();
  await expect(acceptInvite).toBeEnabled();

  const consentBox = await page.getByTestId("invite-join-policy-notice").boundingBox();
  const acceptButtonBox = await acceptInvite.boundingBox();
  expect(consentBox?.y).toBeLessThan(acceptButtonBox?.y ?? 0);
  expect(consentBox?.width).toBe(acceptButtonBox?.width);
});

test("invite can enroll a NIP-07 identity for browser access", async ({ page }) => {
  await enableDemo(page);
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  await page.exposeFunction("signNostrTestEvent", (event: EventTemplate) =>
    finalizeEvent(event, secretKey),
  );
  await page.addInitScript((extensionPubkey) => {
    (
      window as Window & {
        signNostrTestEvent(event: Record<string, unknown>): Promise<Record<string, unknown>>;
        nostr?: {
          getPublicKey(): Promise<string>;
          signEvent(event: Record<string, unknown>): Promise<Record<string, unknown>>;
        };
      }
    ).nostr = {
      async getPublicKey() {
        return extensionPubkey;
      },
      async signEvent(event) {
        return (
          window as Window & {
            signNostrTestEvent(event: Record<string, unknown>): Promise<Record<string, unknown>>;
          }
        ).signNostrTestEvent(event);
      },
    };
  }, pubkey);
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: null }),
    });
  });

  let claimObserved = false;
  await page.route("**/api/invites/claim", async (route) => {
    claimObserved = true;
    const request = route.request();
    expect(request.url()).toBe("https://relay.example.com/api/invites/claim");
    const body = request.postData() ?? "";
    expect(JSON.parse(body)).toEqual({
      code: "browser-code",
    });

    const authorization = request.headers().authorization;
    expect(authorization).toMatch(/^Nostr /);
    const event = JSON.parse(
      Buffer.from(authorization.slice("Nostr ".length), "base64").toString("utf8"),
    ) as {
      pubkey: string;
      tags: string[][];
    };
    expect(event.pubkey).toBe(pubkey);
    expect(event.tags).toContainEqual(["u", request.url()]);
    expect(event.tags).toContainEqual(["method", "POST"]);
    expect(event.tags).toContainEqual(["payload", createHash("sha256").update(body).digest("hex")]);

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "joined",
        community_id: "community-id",
        host: "127.0.0.1",
        role: "member",
      }),
    });
  });

  await page.goto("/invite/browser-code");
  await page.getByRole("button", { name: "Join in browser" }).click();
  await expect(page).toHaveURL("/");
  expect(claimObserved).toBe(true);
});

test("invite asks Safari users to choose their Mac download", async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/26.5 Safari/605.1.15",
  });
  await context.addInitScript(() => {
    Object.defineProperties(navigator, {
      platform: { configurable: true, value: "MacIntel" },
      maxTouchPoints: { configurable: true, value: 0 },
      userAgentData: { configurable: true, value: undefined },
    });
  });
  const page = await context.newPage();
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ policy: null }),
    });
  });
  await page.route("https://api.github.com/**", async (route) => {
    await route.fulfill({ status: 500 });
  });

  await page.goto("/invite/demo-code");
  const download = page.getByRole("link", { name: "Download it now" });
  await expect(download).toHaveAttribute("aria-haspopup", "dialog");
  await download.click();

  const chooser = page.getByRole("dialog", {
    name: "Which Mac do you have?",
  });
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole("link", { name: /Newer Mac/ })).toContainText(
    "2021 or later, or a late-2020 Mac with an Apple M1 chip",
  );
  await expect(chooser.getByRole("link", { name: /Older Mac/ })).toContainText(
    "2019 or earlier, or a 2020 Mac with an Intel processor",
  );
  await expect(chooser.getByText("About This Mac")).toBeVisible();

  const openedPagePromise = context.waitForEvent("page");
  await chooser.getByRole("link", { name: /Newer Mac/ }).click();
  const openedPage = await openedPagePromise;
  await expect(chooser).toBeHidden();
  await expect(openedPage).toHaveURL("https://github.com/block/buzz/releases");
  await expect(page).toHaveURL(/\/invite\/demo-code$/);
  await openedPage.close();

  await download.click();
  await expect(chooser).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chooser).toBeHidden();
  await expect(download).toBeFocused();
  await context.close();
});

test("invite download falls back for mobile and non-desktop devices", async ({ browser }) => {
  const unsupportedDevices = [
    {
      name: "iPhone Safari",
      platform: "iPhone",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
    },
    {
      name: "iPadOS desktop mode",
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
    },
    {
      name: "Android phone",
      platform: "Linux armv8l",
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 Mobile",
      maxTouchPoints: 5,
    },
    {
      name: "ChromeOS",
      platform: "Linux x86_64",
      userAgent: "Mozilla/5.0 (X11; CrOS x86_64 16093.68.0) AppleWebKit/537.36",
      maxTouchPoints: 0,
    },
  ];

  for (const device of unsupportedDevices) {
    const context = await browser.newContext({ userAgent: device.userAgent });
    await context.addInitScript(({ platform, maxTouchPoints }) => {
      Object.defineProperties(navigator, {
        platform: { configurable: true, value: platform },
        maxTouchPoints: { configurable: true, value: maxTouchPoints },
        userAgentData: {
          configurable: true,
          value: { platform, mobile: maxTouchPoints > 0 },
        },
      });
    }, device);
    const page = await context.newPage();
    await page.route("**/api/join-policy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ policy: null }),
      });
    });
    await page.route("https://api.github.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify([
          {
            draft: false,
            prerelease: false,
            assets: [
              {
                name: "Buzz_0.4.9_x64.dmg",
                browser_download_url:
                  "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_x64.dmg",
              },
              {
                name: "Buzz_0.4.9_amd64.AppImage",
                browser_download_url:
                  "https://github.com/block/buzz/releases/download/v0.4.9/Buzz_0.4.9_amd64.AppImage",
              },
            ],
          },
        ]),
      });
    });

    await page.goto("/invite/demo-code");
    await expect(page.getByRole("link", { name: "Download it now" }), device.name).toHaveAttribute(
      "href",
      "https://github.com/block/buzz/releases",
    );
    await context.close();
  }
});
