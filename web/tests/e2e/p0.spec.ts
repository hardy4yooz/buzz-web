import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

const GENERAL = "11111111-2222-4333-8444-555555555555";
const DEMO_CONFIG = {
  communityName: "Buzz Community",
  relayUrl: "wss://relay.example.com",
  agentControlUrl: "https://buzz.example.com/app/api/agent-control",
  features: { projects: true, forum: true },
  demoMode: true,
  agents: [
    { pubkey: "a".repeat(64), name: "Codex(remote)", startable: true },
    { pubkey: "b".repeat(64), name: "Grok(remote)", startable: true },
  ],
};

async function useConfig(page: Page, config: Record<string, unknown>) {
  await page.route("**/config.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(config),
    });
  });
}

async function openChannelDetails(page: Page) {
  await page.getByRole("button", { name: "Channel details" }).click();
  const details = page.getByRole("complementary", { name: "Channel details" });
  await expect(details).toBeVisible();
  return details;
}

async function openSettings(page: Page) {
  const settings = page.getByTestId("workspace-tool-settings");
  if (!(await settings.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Profile menu" }).click();
    await page
      .getByRole("menu", { name: "Profile menu" })
      .getByRole("menuitem", { name: "Settings" })
      .click();
  }
  await expect(settings).toBeVisible();
  return settings;
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

async function activePubkey(page: Page): Promise<string> {
  const settings = await openSettings(page);
  await settings.getByRole("button", { name: "Identity" }).click();
  const value =
    (
      await settings
        .locator("dt")
        .filter({ hasText: "Public key" })
        .locator("xpath=following-sibling::dd[1]")
        .textContent()
    )?.trim() ?? "";
  expect(value).toMatch(/^[0-9a-f]{64}$/);
  return value;
}

test("channel discovery, shared preferences, archive, and member management work together", async ({
  page,
}) => {
  await useConfig(page, DEMO_CONFIG);
  await page.goto("/");

  await page.getByRole("button", { name: "Browse channels" }).click();
  const browser = page.getByRole("dialog", { name: "Browse channels" });
  await expect(browser.getByText("product", { exact: true })).toBeVisible();
  await browser.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: "product" })).toBeVisible();

  await page.getByRole("button", { name: "general", exact: true }).click();
  let details = await openChannelDetails(page);
  await details.getByRole("button", { name: "Add to favorites" }).click();
  await details.getByRole("button", { name: "Mute channel" }).click();
  await expect
    .poll(() =>
      page.evaluate((channelId) => {
        const key = Object.keys(localStorage).find((candidate) =>
          candidate.startsWith("buzz:web:relay-user-state:v1:"),
        );
        if (!key) return false;
        const value = JSON.parse(localStorage.getItem(key) ?? "{}") as {
          stars?: Record<string, { enabled?: boolean }>;
          mutes?: Record<string, { enabled?: boolean }>;
        };
        return value.stars?.[channelId]?.enabled && value.mutes?.[channelId]?.enabled;
      }, GENERAL),
    )
    .toBe(true);

  await page.reload();
  details = await openChannelDetails(page);
  await expect(details.getByRole("button", { name: "Remove from favorites" })).toBeVisible();
  await expect(details.getByRole("button", { name: "Unmute channel" })).toBeVisible();
  await details.getByRole("button", { name: "Close channel details" }).click();

  await page.getByRole("button", { name: "Members: 3" }).click();
  const members = page.getByRole("dialog", { name: "Members · 3" });
  await members.getByRole("button", { name: "Add member" }).click();
  await members.getByLabel("Member public key").fill("c".repeat(64));
  await members.getByLabel("Role").selectOption("guest");
  await members.getByRole("button", { name: "Add member" }).last().click();
  const memberName = "Member cccccccc…cccc";
  const roleSelect = page.getByRole("combobox", { name: `Change ${memberName}'s role` });
  await expect(roleSelect).toHaveValue("guest");
  await roleSelect.selectOption("admin");
  await expect(roleSelect).toHaveValue("admin");
  const memberRow = page.locator("div.group").filter({ hasText: memberName });
  await memberRow.hover();
  await memberRow.getByRole("button", { name: `Remove ${memberName}` }).click();
  const removeDialog = page.getByRole("dialog", { name: "Remove member" });
  await removeDialog.getByRole("button", { name: "Remove member" }).click();
  await expect(page.getByText(memberName, { exact: true })).toHaveCount(0);
  await members.getByRole("button", { name: "Close" }).click();

  details = await openChannelDetails(page);
  await details.getByRole("button", { name: "Archive channel" }).click();
  const archiveDialog = page.getByRole("dialog", { name: "Archive channel" });
  await archiveDialog.getByRole("button", { name: "Archive channel" }).click();
  await expect(page.getByRole("button", { name: "general", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Browse channels" }).click();
  const archivedBrowser = page.getByRole("dialog", { name: "Browse channels" });
  await archivedBrowser.getByRole("button", { name: "Archived" }).click();
  await archivedBrowser.getByRole("button", { name: "Restore channel" }).click();
  await archivedBrowser.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "general", exact: true })).toBeVisible();
});

test("message lifecycle, drafts, thread drafts, and profile editing survive navigation", async ({
  page,
}) => {
  await useConfig(page, DEMO_CONFIG);
  await page.goto("/");

  const channelComposer = page.getByLabel("Send a message to #general");
  await channelComposer.fill("general draft");
  await page.getByRole("button", { name: "Codex(remote)", exact: true }).click();
  await page.getByLabel("Send a message to Codex(remote)").fill("direct draft");
  await page.getByRole("button", { name: "general", exact: true }).click();
  await expect(channelComposer).toHaveValue("general draft");
  await page.reload();
  await expect(channelComposer).toHaveValue("general draft");
  await channelComposer.press("Enter");
  await expect(channelComposer).toHaveValue("");
  await page.reload();
  await expect(channelComposer).toHaveValue("");

  const threadRoot = page.locator("article").filter({
    hasText: "Relay is healthy. Postgres, Redis, MinIO, and Git are available.",
  });
  await threadRoot.hover();
  await threadRoot.getByRole("button", { name: "Reply in thread" }).click();
  const thread = page.getByRole("complementary", { name: "Thread" });
  await thread.getByLabel("Reply to thread").fill("thread draft");
  await thread.getByRole("button", { name: "Close thread" }).click();
  await threadRoot.hover();
  await threadRoot.getByRole("button", { name: "Reply in thread" }).click();
  await expect(thread.getByLabel("Reply to thread")).toHaveValue("thread draft");
  await thread.getByRole("button", { name: "Close thread" }).click();

  const ownMessage = page.locator("article").filter({
    hasText: "Document the Web client deployment as well.",
  });
  const ownMessageId = await ownMessage.getAttribute("data-message-id");
  expect(ownMessageId).toBeTruthy();
  await ownMessage.hover();
  await ownMessage.getByRole("button", { name: "More message actions" }).click();
  await ownMessage
    .getByRole("menu", { name: "More message actions" })
    .getByRole("menuitem", { name: "Edit message" })
    .click();
  const editDialog = page.getByRole("dialog", { name: "Edit message" });
  await editDialog.getByLabel("Message").fill("Document the tested P0 deployment.");
  await editDialog.getByRole("button", { name: "Save" }).click();
  const editedRow = page.locator(`article[data-message-id="${ownMessageId}"]`);
  await expect(editedRow).toContainText("Document the tested P0 deployment.");
  await expect(editedRow).toContainText("edited");
  await editedRow.hover();
  await editedRow.getByRole("button", { name: "More message actions" }).click();
  await editedRow
    .getByRole("menu", { name: "More message actions" })
    .getByRole("menuitem", { name: "Delete message" })
    .click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete message" });
  await deleteDialog.getByRole("button", { name: "Delete message" }).click();
  await expect(editedRow).toHaveAttribute("data-deleted", "true");
  await expect(editedRow).toContainText("This message was deleted");
  await expect(editedRow.getByRole("button", { name: "More message actions" })).toHaveCount(0);

  const settings = await openSettings(page);
  await expect(settings.getByRole("heading", { name: "Profile" })).toBeVisible();
  await settings.getByRole("button", { name: "Appearance" }).click();
  await expect(settings.getByRole("button", { name: "System" })).toBeVisible();
  await settings.getByRole("button", { name: "Invites" }).click();
  await expect(settings.getByRole("button", { name: "Invite people" })).toBeVisible();
  await settings.getByRole("button", { name: "Identity" }).click();
  await expect(settings.getByText("Connected", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Profile", exact: true }).click();
  await settings.getByRole("button", { name: "Edit profile" }).click();
  const profileEditor = page.getByRole("dialog", { name: "Edit profile" });
  await profileEditor.getByLabel("Picture URL").fill("javascript:alert(1)");
  await expect(profileEditor.getByRole("button", { name: "Save profile" })).toBeDisabled();
  await expect(profileEditor.getByText("The picture URL must use HTTP or HTTPS.")).toBeVisible();
  await profileEditor.getByLabel("Display name").fill("Alex Web");
  await profileEditor.getByLabel("About").fill("P0 verification profile");
  await profileEditor.getByLabel("Picture URL").fill("https://buzz.example.com/alex.png");
  await profileEditor.getByRole("button", { name: "Save profile" }).click();
  await expect(profileEditor).toHaveCount(0);
  await settings.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("button", { name: "Profile menu" })).toContainText("Alex Web");
});

test("local identities can be created, switched, backed up, deleted, and restored", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await useConfig(page, {
    ...DEMO_CONFIG,
    relayUrl: "ws://127.0.0.1:9",
    agentControlUrl: null,
    features: { projects: false, forum: false },
    demoMode: false,
    agents: [],
  });
  await page.goto("/");

  const firstVaultPassphrase = "first vault passphrase";
  await createIdentity(page, firstVaultPassphrase);
  const firstPubkey = await activePubkey(page);
  let settings = page.getByTestId("workspace-tool-settings");
  await settings.getByRole("button", { name: "Create encrypted backup" }).click();
  await settings.getByLabel("Backup passphrase").fill("backup passphrase 123");
  await settings.getByLabel("Confirm passphrase").fill("backup passphrase 123");
  const downloadPromise = page.waitForEvent("download");
  await settings.getByRole("button", { name: "Download backup" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Identity backup did not produce a local download");
  const backup = (await readFile(downloadPath, "utf8")).trim();
  expect(backup).toMatch(/^ncryptsec1/);
  await settings.getByRole("button", { name: "Switch identity" }).click();

  await createIdentity(page, "second vault passphrase");
  const secondPubkey = await activePubkey(page);
  expect(secondPubkey).not.toBe(firstPubkey);
  settings = page.getByTestId("workspace-tool-settings");
  await settings.getByRole("button", { name: "Switch identity" }).click();

  const firstLabel = `${firstPubkey.slice(0, 12)}...${firstPubkey.slice(-8)}`;
  await page.locator("label").filter({ hasText: firstLabel }).click();
  await page.getByLabel("Vault passphrase").fill(firstVaultPassphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  expect(await activePubkey(page)).toBe(firstPubkey);
  settings = page.getByTestId("workspace-tool-settings");
  await settings.getByRole("button", { name: "Switch identity" }).click();

  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .locator("label")
    .filter({ hasText: firstLabel })
    .getByRole("button", { name: "Forget identity" })
    .click();
  await expect(page.locator("label").filter({ hasText: firstLabel })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByLabel("ncryptsec backup").fill(backup);
  await page.getByLabel("Backup passphrase").fill("backup passphrase 123");
  await page.getByLabel("New vault passphrase").fill("restored vault passphrase");
  await page.getByLabel("Confirm passphrase").fill("restored vault passphrase");
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  expect(await activePubkey(page)).toBe(firstPubkey);

  const localStorageDump = await page.evaluate(() => JSON.stringify(localStorage));
  expect(localStorageDump).not.toContain("nsec1");
  expect(localStorageDump).not.toContain("ncryptsec1");
});

test("NIP-07 login waits for an extension injected after page load", async ({ page }) => {
  await useConfig(page, {
    ...DEMO_CONFIG,
    relayUrl: "ws://127.0.0.1:9",
    agentControlUrl: null,
    features: { projects: false, forum: false },
    demoMode: false,
    agents: [],
  });
  await page.goto("/");

  const extensionLogin = page.getByRole("button", { name: "Use NIP-07 extension" });
  await expect(extensionLogin).toBeEnabled();
  await page.evaluate((extensionPubkey) => {
    window.setTimeout(() => {
      window.nostr = {
        async getPublicKey() {
          return extensionPubkey;
        },
        async signEvent() {
          throw new Error("Signing is not expected during this login test");
        },
      };
    }, 300);
  }, "d".repeat(64));
  await extensionLogin.click();
  await expect(page.getByRole("button", { name: "Profile menu" })).toBeVisible();
});

test("P0 controls use Simplified Chinese in a Chinese browser", async ({ browser }) => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  await useConfig(page, DEMO_CONFIG);
  await page.goto("/");

  await page.getByRole("button", { name: "浏览频道" }).click();
  const browserDialog = page.getByRole("dialog", { name: "浏览频道" });
  await expect(browserDialog.getByRole("button", { name: "加入", exact: true })).toBeVisible();
  await browserDialog.getByRole("button", { name: "关闭" }).click();

  const ownMessage = page.locator("article").filter({
    hasText: "Document the Web client deployment as well.",
  });
  await ownMessage.hover();
  await ownMessage.getByRole("button", { name: "更多消息操作" }).click();
  await expect(
    ownMessage
      .getByRole("menu", { name: "更多消息操作" })
      .getByRole("menuitem", { name: "编辑消息" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "个人菜单" }).click();
  await page
    .getByRole("menu", { name: "个人菜单" })
    .getByRole("menuitem", { name: "设置" })
    .click();
  const settings = page.getByTestId("workspace-tool-settings");
  await expect(settings.getByRole("button", { name: "外观" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "邀请" })).toBeVisible();
  await settings.getByRole("button", { name: "身份" }).click();
  await expect(settings.getByText("已连接", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Profile", exact: true }).click();
  await settings.getByRole("button", { name: "编辑 Profile" }).click();
  const profileEditor = page.getByRole("dialog", { name: "编辑 Profile" });
  await expect(profileEditor.getByLabel("显示名称")).toBeVisible();
  await expect(profileEditor.getByLabel("简介")).toBeVisible();
  await context.close();
});
