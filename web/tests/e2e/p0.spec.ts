import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
  advanceFixtureRepo,
  answerGitRequest,
  authPubkey,
  createFixtureRepo,
  FILE_MARKER_A,
  FILE_MARKER_B,
  HTML_MARKER_A,
  legacyGitDbName,
  README_MARKER_A,
  README_MARKER_B,
  removeFixtureRepo,
  viewerGitDbName,
} from "./git-fixture";

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

// ---------------------------------------------------------------------------
// Synthetic Git/cache isolation regression (real clone/fetch/tree/blob).
// The Relay transport and NIP-98-compatible Git responses are synthetic; all
// owned Git logic runs unmodified in the browser against a local fixture repo.
// ---------------------------------------------------------------------------

const CACHE_RELAY = "ws://127.0.0.1:4187";
const CACHE_OWNER = "c".repeat(64);
const CACHE_REPO_ID = "cache-isolation-fixture";
const CACHE_REPO_PATH = `/repos/${CACHE_REPO_ID}`;
const CACHE_BLOB_PATH = `${CACHE_REPO_PATH}/blob/src/marker.txt`;
const CACHE_PASS_A = "cache isolation passphrase A";
const CACHE_PASS_B = "cache isolation passphrase B";
const LEGACY_MARKER = "CACHE_ISOLATION_LEGACY_MARKER";
const CACHE_CONFIG = {
  communityName: "Cache Isolation",
  relayUrl: CACHE_RELAY,
  agentControlUrl: null,
  features: { projects: true, forum: false },
  demoMode: false,
  agents: [],
};

type CacheIsolationProbeState = {
  seen: { A: boolean; B: boolean };
  opens: string[];
  deletes: string[];
  frames: number;
  error?: string;
};

type GitRequestLog = {
  viewer: string | null;
  method: string;
  path: string;
  status: number | "aborted";
};

async function installCacheProbe(page: Page) {
  await page.addInitScript(
    ({ markerA, markerB }) => {
      const state: CacheIsolationProbeState = {
        seen: { A: false, B: false },
        opens: [],
        deletes: [],
        frames: 0,
      };
      Object.defineProperty(window, "__cacheIsolationProbe", { value: state });

      try {
        const factory = IDBFactory.prototype;
        const originalOpen = factory.open;
        factory.open = function (name: string, version?: number) {
          state.opens.push(String(name));
          return version === undefined
            ? originalOpen.call(this, name)
            : originalOpen.call(this, name, version);
        };
        const originalDelete = factory.deleteDatabase;
        factory.deleteDatabase = function (name: string) {
          state.deletes.push(String(name));
          return originalDelete.call(this, name);
        };

        const scan = () => {
          const text = document.body?.innerText ?? "";
          if (!state.seen.A && text.includes(markerA)) state.seen.A = true;
          if (!state.seen.B && text.includes(markerB)) state.seen.B = true;
        };
        new MutationObserver(scan).observe(document, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
        const tick = () => {
          state.frames += 1;
          scan();
          window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
      } catch (error) {
        state.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
      }
    },
    { markerA: README_MARKER_A, markerB: README_MARKER_B },
  );
}

async function cacheProbe(page: Page): Promise<CacheIsolationProbeState> {
  return page.evaluate(
    () =>
      (window as unknown as { __cacheIsolationProbe: CacheIsolationProbeState })
        .__cacheIsolationProbe,
  );
}

async function resetPaintProbe(page: Page) {
  await page.evaluate(() => {
    const state = (window as unknown as { __cacheIsolationProbe: CacheIsolationProbeState })
      .__cacheIsolationProbe;
    state.seen.A = false;
    state.seen.B = false;
  });
}

async function indexedDbNames(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases()).map((database) => database.name ?? "").filter(Boolean),
  );
}

async function dbHasMarker(
  page: Page,
  dbName: string,
  markers: string[],
): Promise<{ exists: boolean; matched: string[] }> {
  return page.evaluate(
    async ({ name, needles }) => {
      const exists = (await indexedDB.databases()).some((database) => database.name === name);
      if (!exists) return { exists: false, matched: [] as string[] };
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const matched = new Set<string>();
      const scan = (value: unknown): void => {
        if (typeof value === "string") {
          for (const needle of needles) if (value.includes(needle)) matched.add(needle);
          return;
        }
        if (value instanceof Uint8Array) {
          const text = new TextDecoder().decode(value);
          for (const needle of needles) if (text.includes(needle)) matched.add(needle);
          return;
        }
        if (value instanceof ArrayBuffer) {
          const text = new TextDecoder().decode(value);
          for (const needle of needles) if (text.includes(needle)) matched.add(needle);
          return;
        }
        if (Array.isArray(value)) {
          for (const item of value) scan(item);
          return;
        }
        if (value && typeof value === "object") {
          for (const item of Object.values(value)) scan(item);
        }
      };
      for (const store of Array.from(database.objectStoreNames)) {
        const records = await new Promise<unknown[]>((resolve, reject) => {
          const transaction = database.transaction(store, "readonly");
          const request = transaction.objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result as unknown[]);
          request.onerror = () => reject(request.error);
        });
        for (const record of records) scan(record);
      }
      database.close();
      return { exists: true, matched: [...matched] };
    },
    { name: dbName, needles: markers },
  );
}

async function seedLegacyDatabase(page: Page, dbName: string, marker: string) {
  await page.evaluate(
    async ({ name, value }) => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("data")) {
            request.result.createObjectStore("data");
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("data", "readwrite");
          transaction.objectStore("data").put({ legacy: value }, "legacy/seed");
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      });
    },
    { name: dbName, value: marker },
  );
}

function shortIdentity(pubkey: string): string {
  return `${pubkey.slice(0, 12)}...${pubkey.slice(-8)}`;
}

async function unlockSavedIdentity(page: Page, pubkey: string, passphrase: string) {
  const savedIdentity = page.locator("label").filter({ hasText: shortIdentity(pubkey) });
  await expect(savedIdentity).toBeVisible();
  await savedIdentity.click();
  await page.getByLabel("Vault passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByLabel("Vault passphrase")).toHaveCount(0);
}

async function openProjects(page: Page) {
  await page
    .getByRole("button", { name: "Projects", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByTestId("workspace-tool-repos")).toBeVisible();
}

function repoCard(page: Page) {
  return page.getByRole("button", { name: new RegExp(CACHE_REPO_ID) });
}

async function switchIdentityToCreate(page: Page) {
  const settings = await openSettings(page);
  await settings.getByRole("button", { name: "Identity" }).click();
  await settings.getByRole("button", { name: "Switch identity" }).click();
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeVisible();
}

test("repository caches stay isolated by viewer and keep the owner's offline cache", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const fixture = await createFixtureRepo();
  const refs = {
    id: "2".repeat(64),
    pubkey: CACHE_OWNER,
    created_at: 1_700_000_000,
    kind: 30618,
    tags: [
      ["d", CACHE_REPO_ID],
      ["HEAD", "ref: refs/heads/main"],
      ["refs/heads/main", fixture.head],
    ],
    content: "",
    sig: "0".repeat(128),
  };
  const events = [
    {
      id: "1".repeat(64),
      pubkey: CACHE_OWNER,
      created_at: 1_700_000_000,
      kind: 30617,
      tags: [
        ["d", CACHE_REPO_ID],
        ["name", CACHE_REPO_ID],
        ["description", "Synthetic cache isolation fixture"],
        ["clone", `http://127.0.0.1:4187/git/${CACHE_OWNER}/${CACHE_REPO_ID}.git`],
      ],
      content: "",
      sig: "0".repeat(128),
    },
    refs,
  ];
  const gitRequests: GitRequestLog[] = [];
  const allowed = new Set<string>();
  let gitMode: "allow" | "deny403" | "offline" = "allow";
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  const legacyDb = legacyGitDbName(CACHE_RELAY, CACHE_OWNER, CACHE_REPO_ID);

  await installCacheProbe(page);
  await page.routeWebSocket(CACHE_RELAY, (ws) => {
    ws.send(JSON.stringify(["AUTH", "cache-isolation-challenge"]));
    ws.onMessage((message) => {
      const data = JSON.parse(String(message));
      if (data[0] === "AUTH") {
        ws.send(JSON.stringify(["OK", data[1].id, true, ""]));
        return;
      }
      if (data[0] !== "REQ") return;
      const [, subscriptionId, filter] = data;
      for (const event of events) {
        if (!(filter.kinds ?? []).includes(event.kind)) continue;
        const identifier = event.tags.find((tag) => tag[0] === "d")?.[1];
        if (filter["#d"] && !filter["#d"].includes(identifier)) continue;
        ws.send(JSON.stringify(["EVENT", subscriptionId, event]));
      }
      ws.send(JSON.stringify(["EOSE", subscriptionId]));
    });
  });
  await page.route("**/query", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/git/**", async (route) => {
    const request = route.request();
    const headers = await request.allHeaders();
    const viewer = authPubkey(headers);
    const url = request.url();
    if (gitMode === "offline") {
      gitRequests.push({ viewer, method: request.method(), path: url, status: "aborted" });
      await route.abort("internetdisconnected");
      return;
    }
    if (gitMode === "deny403") {
      gitRequests.push({ viewer, method: request.method(), path: url, status: 403 });
      await route.fulfill({ status: 403, contentType: "text/plain", body: "Forbidden" });
      return;
    }
    if (!viewer || !allowed.has(viewer)) {
      gitRequests.push({ viewer, method: request.method(), path: url, status: 404 });
      await route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
      return;
    }
    const response = await answerGitRequest(
      fixture.repoDir,
      request.method(),
      url,
      headers,
      request.postDataBuffer() ?? Buffer.alloc(0),
    );
    gitRequests.push({
      viewer,
      method: request.method(),
      path: url,
      status: response.status,
    });
    await route.fulfill({
      status: response.status,
      headers: response.headers,
      body: response.body,
    });
  });
  page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await useConfig(page, CACHE_CONFIG);
  try {
    await page.goto("/");
    await seedLegacyDatabase(page, legacyDb, LEGACY_MARKER);
    await page.evaluate(() => {
      const state = (window as unknown as { __cacheIsolationProbe: CacheIsolationProbeState })
        .__cacheIsolationProbe;
      state.opens.length = 0;
    });

    await createIdentity(page, CACHE_PASS_A);
    const viewerA = await activePubkey(page);
    allowed.add(viewerA);
    const dbA = viewerGitDbName(CACHE_RELAY, viewerA, CACHE_OWNER, CACHE_REPO_ID);
    const dbB = viewerGitDbName(CACHE_RELAY, "0".repeat(64), CACHE_OWNER, CACHE_REPO_ID);

    // A: real clone, tree, README and refs in the workspace project panel.
    await resetPaintProbe(page);
    const aOpenStart = (await cacheProbe(page)).opens.length;
    await openProjects(page);
    await expect(repoCard(page)).toBeVisible();
    await repoCard(page).click();
    await expect(page.getByText(README_MARKER_A)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("src", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "README.md", level: 2 })).toBeVisible();
    await expect(page.getByText(/1 branch/)).toBeVisible();
    const aProbe = await cacheProbe(page);
    expect(aProbe.frames).toBeGreaterThan(0);
    expect(aProbe.seen.A).toBe(true);
    expect(aProbe.seen.B).toBe(false);
    expect(aProbe.opens.slice(aOpenStart)).not.toContain(legacyDb);
    expect(gitRequests.some((entry) => entry.viewer === viewerA && entry.status === 200)).toBe(
      true,
    );
    expect(await indexedDbNames(page)).toEqual(expect.arrayContaining([dbA, legacyDb]));
    const aContent = await dbHasMarker(page, dbA, [
      README_MARKER_A,
      FILE_MARKER_A,
      README_MARKER_B,
      FILE_MARKER_B,
    ]);
    expect(aContent.exists).toBe(true);
    expect(aContent.matched).toEqual(expect.arrayContaining([README_MARKER_A, FILE_MARKER_A]));
    expect(aContent.matched).not.toContain(README_MARKER_B);
    // LightningFS debounces its superblock write; let it flush before navigation.
    await page.waitForTimeout(1_000);

    // A: the deep-linked blob also comes from the real clone.
    const aBlobLogStart = gitRequests.length;
    await page.goto(CACHE_BLOB_PATH);
    await resetPaintProbe(page);
    const aBlobOpenStart = (await cacheProbe(page)).opens.length;
    await unlockSavedIdentity(page, viewerA, CACHE_PASS_A);
    await expect(page.getByText(FILE_MARKER_A)).toBeVisible({ timeout: 30_000 });
    expect(
      gitRequests
        .slice(aBlobLogStart)
        .some((entry) => entry.viewer === viewerA && entry.status === 200),
    ).toBe(true);
    expect((await cacheProbe(page)).opens.slice(aBlobOpenStart)).not.toContain(legacyDb);
    await page.waitForTimeout(1_000);

    // Back to the workspace and use the real Switch identity control.
    await page.goto("/");
    await unlockSavedIdentity(page, viewerA, CACHE_PASS_A);
    await expect(page.getByRole("button", { name: "Profile menu" })).toBeVisible();
    await resetPaintProbe(page);
    await switchIdentityToCreate(page);
    expect(await page.getByText(README_MARKER_A).count()).toBe(0);
    expect((await cacheProbe(page)).seen.A).toBe(false);
    await createIdentity(page, CACHE_PASS_B);
    const viewerB = await activePubkey(page);
    expect(viewerB).not.toBe(viewerA);
    const dbBName = viewerGitDbName(CACHE_RELAY, viewerB, CACHE_OWNER, CACHE_REPO_ID);
    expect(dbBName).not.toBe(dbB);

    // B is not allowed: a real 404, no A cache read, no A marker painted.
    await resetPaintProbe(page);
    const bOpenStart = (await cacheProbe(page)).opens.length;
    const bLogStart = gitRequests.length;
    await openProjects(page);
    await repoCard(page).click();
    await expect
      .poll(
        () =>
          gitRequests
            .slice(bLogStart)
            .some((entry) => entry.viewer === viewerB && entry.status === 404),
        { timeout: 30_000 },
      )
      .toBe(true);
    await page.waitForTimeout(2_000);
    const bAlert = page.getByRole("alert");
    await expect(bAlert).toBeVisible();
    await expect(bAlert).toContainText("Failed to load repository contents");
    await expect(bAlert).toContainText("Repository access is not available for this identity.");
    const bProbe = await cacheProbe(page);
    expect(bProbe.seen).toEqual({ A: false, B: false });
    expect(await page.getByText(README_MARKER_A).count()).toBe(0);
    expect(await page.getByText(FILE_MARKER_A).count()).toBe(0);
    expect(gitRequests.slice(bLogStart).filter((entry) => entry.viewer === viewerA)).toEqual([]);
    const bOpens = bProbe.opens.slice(bOpenStart);
    expect(bOpens).toContain(dbBName);
    expect(bOpens).not.toContain(dbA);
    expect(bOpens).not.toContain(legacyDb);
    expect(await indexedDbNames(page)).toEqual(expect.arrayContaining([dbA, legacyDb]));
    const bContent = await dbHasMarker(page, dbBName, [README_MARKER_A, FILE_MARKER_A]);
    expect(bContent.exists).toBe(true);
    expect(bContent.matched).toEqual([]);
    const aContentAfterB = await dbHasMarker(page, dbA, [README_MARKER_A, README_MARKER_B]);
    expect(aContentAfterB.matched).toContain(README_MARKER_A);
    expect(aContentAfterB.matched).not.toContain(README_MARKER_B);
    expect((await dbHasMarker(page, legacyDb, [LEGACY_MARKER])).matched).toEqual([LEGACY_MARKER]);

    // B: the blob deep link is denied too.
    const bBlobLogStart = gitRequests.length;
    await page.goto(CACHE_BLOB_PATH);
    await resetPaintProbe(page);
    const bBlobOpenStart = (await cacheProbe(page)).opens.length;
    await unlockSavedIdentity(page, viewerB, CACHE_PASS_B);
    await expect
      .poll(
        () =>
          gitRequests
            .slice(bBlobLogStart)
            .some((entry) => entry.viewer === viewerB && entry.status === 404),
        { timeout: 30_000 },
      )
      .toBe(true);
    await page.waitForTimeout(1_500);
    const bBlobAlert = page.getByRole("alert");
    await expect(bBlobAlert).toBeVisible();
    await expect(bBlobAlert).toContainText("Failed to load file");
    await expect(bBlobAlert).toContainText("Repository access is not available for this identity.");
    expect((await cacheProbe(page)).seen).toEqual({ A: false, B: false });
    expect(await page.getByText(README_MARKER_A).count()).toBe(0);
    expect(await page.getByText(FILE_MARKER_A).count()).toBe(0);
    const bBlobOpens = (await cacheProbe(page)).opens.slice(bBlobOpenStart);
    expect(bBlobOpens).not.toContain(dbA);
    expect(bBlobOpens).not.toContain(legacyDb);

    // Allow B and advance the served branch: B must clone its own new bytes,
    // never A's older cached README.
    const headB = await advanceFixtureRepo(fixture);
    refs.tags[2][1] = headB;
    allowed.add(viewerB);
    const allowLogStart = gitRequests.length;
    await page.goto(CACHE_REPO_PATH);
    await resetPaintProbe(page);
    const allowOpenStart = (await cacheProbe(page)).opens.length;
    await unlockSavedIdentity(page, viewerB, CACHE_PASS_B);
    await expect(page.getByText(README_MARKER_B)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("src", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "README.md", level: 2 })).toBeVisible();
    const allowProbe = await cacheProbe(page);
    expect(allowProbe.seen.B).toBe(true);
    expect(allowProbe.seen.A).toBe(false);
    expect(
      gitRequests
        .slice(allowLogStart)
        .some((entry) => entry.viewer === viewerB && entry.status === 200),
    ).toBe(true);
    const allowOpens = allowProbe.opens.slice(allowOpenStart);
    expect(allowOpens).toContain(dbBName);
    expect(allowOpens).not.toContain(dbA);
    expect(allowOpens).not.toContain(legacyDb);
    const bOwnContent = await dbHasMarker(page, dbBName, [README_MARKER_A, README_MARKER_B]);
    expect(bOwnContent.matched).toContain(README_MARKER_B);
    expect(bOwnContent.matched).not.toContain(README_MARKER_A);
    const aStillIsolated = await dbHasMarker(page, dbA, [README_MARKER_A, README_MARKER_B]);
    expect(aStillIsolated.matched).toContain(README_MARKER_A);
    expect(aStillIsolated.matched).not.toContain(README_MARKER_B);

    // Same viewer, existing clone, HTTP denial: no stale bytes on a fresh open.
    gitMode = "deny403";
    const denyLogStart = gitRequests.length;
    await page.goto("/");
    await resetPaintProbe(page);
    const denyOpenStart = (await cacheProbe(page)).opens.length;
    await unlockSavedIdentity(page, viewerA, CACHE_PASS_A);
    await expect(page.getByRole("button", { name: "Profile menu" })).toBeVisible();
    await openProjects(page);
    await repoCard(page).click();
    await expect
      .poll(
        () =>
          gitRequests
            .slice(denyLogStart)
            .some((entry) => entry.viewer === viewerA && entry.status === 403),
        { timeout: 30_000 },
      )
      .toBe(true);
    await page.waitForTimeout(2_000);
    const denyAlert = page.getByRole("alert");
    await expect(denyAlert).toBeVisible();
    await expect(denyAlert).toContainText("Failed to load repository contents");
    await expect(denyAlert).toContainText("Repository access is not available for this identity.");
    const denyProbe = await cacheProbe(page);
    expect(denyProbe.seen).toEqual({ A: false, B: false });
    expect(await page.getByText(README_MARKER_A).count()).toBe(0);
    const denyOpens = denyProbe.opens.slice(denyOpenStart);
    expect(denyOpens).not.toContain(legacyDb);
    expect((await dbHasMarker(page, dbA, [README_MARKER_A])).matched).toContain(README_MARKER_A);

    // A offline: own cache only, and it is the pre-advance README marker.
    gitMode = "offline";
    const offlineLogStart = gitRequests.length;
    await page.goto(CACHE_REPO_PATH);
    await resetPaintProbe(page);
    await unlockSavedIdentity(page, viewerA, CACHE_PASS_A);
    await page.waitForTimeout(3_000);
    await expect(page.getByText(README_MARKER_A)).toBeVisible({ timeout: 30_000 });
    const offlineProbe = await cacheProbe(page);
    expect(offlineProbe.seen.A).toBe(true);
    expect(offlineProbe.seen.B).toBe(false);
    expect(offlineProbe.opens).not.toContain(legacyDb);
    expect(
      gitRequests
        .slice(offlineLogStart)
        .some((entry) => entry.viewer === viewerA && entry.status === "aborted"),
    ).toBe(true);
    expect(
      (await dbHasMarker(page, dbA, [README_MARKER_A, README_MARKER_B])).matched,
    ).not.toContain(README_MARKER_B);

    expect(pageErrors).toEqual([]);
    expect(
      consoleLines.filter(
        (line) => line.includes(README_MARKER_A) || line.includes(README_MARKER_B),
      ),
    ).toEqual([]);
    expect((await cacheProbe(page)).deletes).toEqual([]);
    expect(await indexedDbNames(page)).toEqual(expect.arrayContaining([dbA, legacyDb]));
  } finally {
    await removeFixtureRepo(fixture);
  }
});

// ---------------------------------------------------------------------------
// Denial UI, stale-refetch, visual matrix, and preview parity for the same
// repository cache surface. All transport/identity helpers are synthetic.
// ---------------------------------------------------------------------------

async function measureAlertContrast(page: Page) {
  return page.evaluate(() => {
    const alert = document.querySelector('[role="alert"]');
    if (!alert) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const parse = (value: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000000";
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2], data[3]];
    };
    const style = getComputedStyle(alert);
    const foreground = parse(style.color);
    const ownBackground = parse(style.backgroundColor);
    let under: [number, number, number, number] = [255, 255, 255, 255];
    if (ownBackground[3] < 255) {
      let node: Element | null = alert.parentElement;
      while (node) {
        const candidate = parse(getComputedStyle(node).backgroundColor);
        if (candidate[3] > 0) {
          under = candidate;
          if (candidate[3] === 255) break;
        }
        node = node.parentElement;
      }
    }
    const alpha = ownBackground[3] / 255;
    const background = [
      ownBackground[0] * alpha + under[0] * (1 - alpha),
      ownBackground[1] * alpha + under[1] * (1 - alpha),
      ownBackground[2] * alpha + under[2] * (1 - alpha),
    ];
    const foregroundAlpha = foreground[3] / 255;
    const ink = [
      foreground[0] * foregroundAlpha + background[0] * (1 - foregroundAlpha),
      foreground[1] * foregroundAlpha + background[1] * (1 - foregroundAlpha),
      foreground[2] * foregroundAlpha + background[2] * (1 - foregroundAlpha),
    ];
    const channel = (value: number) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: number[]) =>
      0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
    const inkLuminance = luminance(ink);
    const backgroundLuminance = luminance(background);
    return {
      ratio:
        (Math.max(inkLuminance, backgroundLuminance) + 0.05) /
        (Math.min(inkLuminance, backgroundLuminance) + 0.05),
      color: style.color,
      backgroundColor: style.backgroundColor,
      backgroundUnder: under.slice(0, 3),
    };
  });
}

test("repository previews keep mock content and do not surface cache errors", async ({ page }) => {
  await useConfig(page, DEMO_CONFIG);
  await page.goto("/repos/buzz-desktop?preview=repositories");
  await expect(page.getByText("Buzz Desktop")).toBeVisible();
  await expect(page.getByText("src", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.goto("/repos/buzz-desktop/blob/package.json?preview=repositories");
  await expect(page.getByText(/"name": "buzz-desktop"/)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

async function spaNavigate(page: Page, path: string) {
  await page.evaluate((next) => {
    window.history.pushState({}, "", next);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await expect.poll(() => new URL(page.url()).pathname).toBe(path);
}

test("same-viewer refetch denial clears cached private content and surfaces the error", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const fixture = await createFixtureRepo();
  const requests: Array<{ viewer: string | null; status: number; path: string }> = [];
  const allowed = new Set<string>();
  const pageErrors: string[] = [];
  let gitMode: "allow" | "deny403" = "allow";
  const events = [
    {
      id: "1".repeat(64),
      pubkey: CACHE_OWNER,
      created_at: 1_700_000_000,
      kind: 30617,
      tags: [
        ["d", CACHE_REPO_ID],
        ["name", CACHE_REPO_ID],
        ["description", "Synthetic cache isolation fixture"],
      ],
      content: "",
      sig: "0".repeat(128),
    },
    {
      id: "2".repeat(64),
      pubkey: CACHE_OWNER,
      created_at: 1_700_000_000,
      kind: 30618,
      tags: [
        ["d", CACHE_REPO_ID],
        ["HEAD", "ref: refs/heads/main"],
        ["refs/heads/main", fixture.head],
      ],
      content: "",
      sig: "0".repeat(128),
    },
  ];

  try {
    await page.clock.install({ time: new Date() });
    await page.routeWebSocket(CACHE_RELAY, (ws) => {
      ws.send(JSON.stringify(["AUTH", "stale-refetch-challenge"]));
      ws.onMessage((message) => {
        const data = JSON.parse(String(message));
        if (data[0] === "AUTH") {
          ws.send(JSON.stringify(["OK", data[1].id, true, ""]));
          return;
        }
        if (data[0] !== "REQ") return;
        const [, subscriptionId, filter] = data;
        for (const event of events) {
          if (!(filter.kinds ?? []).includes(event.kind)) continue;
          const identifier = event.tags.find((tag) => tag[0] === "d")?.[1];
          if (filter["#d"] && !filter["#d"].includes(identifier)) continue;
          ws.send(JSON.stringify(["EVENT", subscriptionId, event]));
        }
        ws.send(JSON.stringify(["EOSE", subscriptionId]));
      });
    });
    await page.route("**/query", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
    await page.route("**/git/**", async (route) => {
      const request = route.request();
      const viewer = authPubkey(await request.allHeaders());
      const url = request.url();
      if (gitMode === "deny403") {
        requests.push({ viewer, status: 403, path: url });
        await route.fulfill({ status: 403, contentType: "text/plain", body: "Forbidden" });
        return;
      }
      if (!viewer || !allowed.has(viewer)) {
        requests.push({ viewer, status: 404, path: url });
        await route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
        return;
      }
      const response = await answerGitRequest(
        fixture.repoDir,
        request.method(),
        url,
        await request.allHeaders(),
        request.postDataBuffer() ?? Buffer.alloc(0),
      );
      requests.push({ viewer, status: response.status, path: url });
      await route.fulfill({
        status: response.status,
        headers: response.headers,
        body: response.body,
      });
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    // biome-ignore lint/correctness/useHookAtTopLevel: test helper, not a React hook
    await useConfig(page, CACHE_CONFIG);
    await page.goto("/");
    await createIdentity(page, CACHE_PASS_A);
    const viewerA = await activePubkey(page);
    allowed.add(viewerA);

    const armAndDenyAfterRemount = async (
      path: string,
      routeReady: () => Promise<void>,
      ready: () => Promise<void>,
    ) => {
      gitMode = "deny403";
      const denialStart = requests.length;
      const pageNow = await page.evaluate(() => Date.now());
      await page.clock.setSystemTime(pageNow + 6 * 60_000);
      await spaNavigate(page, "/");
      await expect(page.getByRole("button", { name: "Profile menu" })).toBeVisible();
      await spaNavigate(page, path);
      await routeReady();
      await expect
        .poll(
          () =>
            requests
              .slice(denialStart)
              .some((entry) => entry.viewer === viewerA && entry.status === 403),
          { timeout: 30_000 },
        )
        .toBe(true);
      await expect(page.getByRole("alert")).toContainText(
        "Repository access is not available for this identity.",
      );
      await ready();
    };

    await page.goto(CACHE_REPO_PATH);
    await unlockSavedIdentity(page, viewerA, CACHE_PASS_A);
    await expect(page.getByText(README_MARKER_A)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("src", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Commits" }).click();
    await expect(page.getByText("initial fixture commit")).toBeVisible();
    await page.getByRole("tab", { name: "Code" }).click();
    await expect(page.getByText(README_MARKER_A)).toBeVisible();

    await armAndDenyAfterRemount(
      CACHE_REPO_PATH,
      async () => {
        await expect(page.getByRole("heading", { level: 1, name: CACHE_REPO_ID })).toBeVisible();
      },
      async () => {
        await expect(page.getByRole("alert")).toContainText("Failed to load repository contents");
        await expect(page.getByText(README_MARKER_A)).toHaveCount(0);
        await expect(page.getByText("src", { exact: true })).toHaveCount(0);
        await page.getByRole("tab", { name: "Commits" }).click();
        await expect(page.getByText("initial fixture commit")).toHaveCount(0);
      },
    );

    const reloadAllowed = async (path: string, ready: () => Promise<void>) => {
      gitMode = "allow";
      await page.goto(path);
      await unlockSavedIdentity(page, viewerA, CACHE_PASS_A);
      await ready();
    };

    await reloadAllowed(CACHE_BLOB_PATH, async () => {
      await expect(page.getByText(FILE_MARKER_A)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
    });
    await armAndDenyAfterRemount(
      CACHE_BLOB_PATH,
      async () => {
        await expect(page.getByRole("link", { name: "Back to repository" })).toBeVisible();
      },
      async () => {
        await expect(page.getByRole("alert")).toContainText("Failed to load file");
        await expect(page.getByText(FILE_MARKER_A)).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
      },
    );

    await reloadAllowed(`${CACHE_REPO_PATH}/blob/preview.html`, async () => {
      await expect(page.getByText(HTML_MARKER_A)).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await expect(page.getByTitle("Repository page (sandboxed)")).toBeVisible();
    });
    await armAndDenyAfterRemount(
      `${CACHE_REPO_PATH}/blob/preview.html`,
      async () => {
        await expect(page.getByRole("link", { name: "Back to repository" })).toBeVisible();
      },
      async () => {
        await expect(page.getByRole("alert")).toContainText("Failed to load file");
        await expect(page.getByText(HTML_MARKER_A)).toHaveCount(0);
        await expect(page.getByTitle("Repository page (sandboxed)")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
      },
    );

    await reloadAllowed(`${CACHE_REPO_PATH}/blob/asset.bin`, async () => {
      await expect(page.getByRole("link", { name: "Download", exact: true })).toBeVisible({
        timeout: 30_000,
      });
    });
    await armAndDenyAfterRemount(
      `${CACHE_REPO_PATH}/blob/asset.bin`,
      async () => {
        await expect(page.getByRole("link", { name: "Back to repository" })).toBeVisible();
      },
      async () => {
        await expect(page.getByRole("alert")).toContainText("Failed to load file");
        await expect(page.getByRole("link", { name: "Download", exact: true })).toHaveCount(0);
      },
    );

    expect(pageErrors).toEqual([]);
  } finally {
    await removeFixtureRepo(fixture);
  }
});

test("denied repository and blob pages surface localized errors at both widths", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const cases = [
    {
      name: "en-desktop-light",
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
      theme: "light",
    },
    {
      name: "en-mobile-dark",
      locale: "en-US",
      viewport: { width: 390, height: 844 },
      theme: "dark",
    },
    {
      name: "zh-desktop-dark",
      locale: "zh-CN",
      viewport: { width: 1440, height: 900 },
      theme: "dark",
    },
    {
      name: "zh-mobile-light",
      locale: "zh-CN",
      viewport: { width: 390, height: 844 },
      theme: "light",
    },
  ];
  for (const item of cases) {
    const context = await browser.newContext({ locale: "en-US", viewport: item.viewport });
    const page = await context.newPage();
    await page.addInitScript(
      ({ theme }) => {
        localStorage.setItem("buzz-web-theme", theme);
        const forced = sessionStorage.getItem("buzz-visual-locale");
        if (forced) {
          Object.defineProperty(navigator, "language", { configurable: true, get: () => forced });
          Object.defineProperty(navigator, "languages", {
            configurable: true,
            get: () => [forced],
          });
        }
      },
      { theme: item.theme },
    );
    const requests: Array<{ viewer: string | null; status: number }> = [];
    const pageErrors: string[] = [];
    const events = [
      {
        id: "1".repeat(64),
        pubkey: CACHE_OWNER,
        created_at: 1_700_000_000,
        kind: 30617,
        tags: [
          ["d", CACHE_REPO_ID],
          ["name", CACHE_REPO_ID],
          ["description", "Synthetic cache isolation fixture"],
        ],
        content: "",
        sig: "0".repeat(128),
      },
      {
        id: "2".repeat(64),
        pubkey: CACHE_OWNER,
        created_at: 1_700_000_000,
        kind: 30618,
        tags: [
          ["d", CACHE_REPO_ID],
          ["HEAD", "ref: refs/heads/main"],
          ["refs/heads/main", "a".repeat(40)],
        ],
        content: "",
        sig: "0".repeat(128),
      },
    ];
    await page.routeWebSocket(CACHE_RELAY, (ws) => {
      ws.send(JSON.stringify(["AUTH", "visual-denial-challenge"]));
      ws.onMessage((message) => {
        const data = JSON.parse(String(message));
        if (data[0] === "AUTH") {
          ws.send(JSON.stringify(["OK", data[1].id, true, ""]));
          return;
        }
        if (data[0] !== "REQ") return;
        const [, subscriptionId, filter] = data;
        for (const event of events) {
          if (!(filter.kinds ?? []).includes(event.kind)) continue;
          const identifier = event.tags.find((tag) => tag[0] === "d")?.[1];
          if (filter["#d"] && !filter["#d"].includes(identifier)) continue;
          ws.send(JSON.stringify(["EVENT", subscriptionId, event]));
        }
        ws.send(JSON.stringify(["EOSE", subscriptionId]));
      });
    });
    await page.route("**/query", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
    await page.route("**/git/**", async (route) => {
      requests.push({ viewer: authPubkey(await route.request().allHeaders()), status: 404 });
      await route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    // biome-ignore lint/correctness/useHookAtTopLevel: test helper, not a React hook
    await useConfig(page, CACHE_CONFIG);
    await page.goto("/");
    await createIdentity(page, "visual denial passphrase");
    if (item.locale === "zh-CN") {
      await page.evaluate(() => sessionStorage.setItem("buzz-visual-locale", "zh-CN"));
    }

    const inspect = async (
      path: string,
      marker: string,
      expectedPrefix: string,
      expectedCause: string,
      surface: "repo" | "blob",
    ) => {
      const requestStart = requests.length;
      await page.goto(path);
      await page.locator('label:has(input[name="saved-identity"])').first().click();
      await page.locator('input[type="password"]').fill("visual denial passphrase");
      await page.locator('form button[type="submit"]').click();
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
      await expect
        .poll(() => requests.slice(requestStart).length > 0, { timeout: 30_000 })
        .toBe(true);
      const alert = page.getByRole("alert");
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(expectedPrefix);
      await expect(alert).toContainText(expectedCause);
      await expect(alert).toHaveAttribute("aria-atomic", "true");
      await expect(page.getByText(marker)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Download", exact: true })).toHaveCount(0);
      await expect(page.getByTitle("Repository page (sandboxed)")).toHaveCount(0);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      const tabIndex = await alert.getAttribute("tabindex");
      expect(tabIndex).toBeNull();
      const contrast = await measureAlertContrast(page);
      expect(contrast).not.toBeNull();
      expect(contrast?.ratio ?? 0).toBeGreaterThanOrEqual(4.5);
      const shot = testInfo.outputPath(`${item.name}-${surface}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      await page.evaluate(() => (document.body as HTMLElement).focus());
      const stops: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        await page.keyboard.press("Tab");
        stops.push(
          await page.evaluate(() => {
            const active = document.activeElement as HTMLElement | null;
            return active
              ? `${active.tagName}:${(active.textContent ?? "").trim().slice(0, 24)}`
              : "";
          }),
        );
      }
      expect(new Set(stops).size).toBeGreaterThan(1);
      expect(
        await page.evaluate(() => {
          const active = document.activeElement;
          const alert = document.querySelector('[role="alert"]');
          return Boolean(active && alert && (active === alert || alert.contains(active)));
        }),
      ).toBe(false);
      return { shot, overflow, tabIndex, contrast, stops };
    };

    const english = item.locale === "en-US";
    const repo = await inspect(
      CACHE_REPO_PATH,
      README_MARKER_A,
      english ? "Failed to load repository contents" : "仓库内容加载失败",
      english ? "Repository access is not available for this identity." : "此身份无法访问该仓库。",
      "repo",
    );
    const blob = await inspect(
      CACHE_BLOB_PATH,
      FILE_MARKER_A,
      english ? "Failed to load file" : "文件加载失败",
      english ? "Repository access is not available for this identity." : "此身份无法访问该仓库。",
      "blob",
    );
    expect(pageErrors).toEqual([]);
    console.log(
      "DENIAL_VISUAL_EVIDENCE",
      JSON.stringify({
        case: item.name,
        viewport: item.viewport,
        theme: item.theme,
        repo,
        blob,
        pageErrors,
      }),
    );
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Repository activity (NIP-34 issues/PRs) is a read-only, bounded Relay query.
// The Relay is synthetic; the client join, status trust, and tab rendering run
// unmodified.
// ---------------------------------------------------------------------------

const ACTIVITY_OWNER = "c".repeat(64);
const ACTIVITY_OTHER_OWNER = "d".repeat(64);
const ACTIVITY_ISSUE_AUTHOR = "e".repeat(64);
const ACTIVITY_PR_AUTHOR = "f".repeat(64);
const ACTIVITY_STRANGER = "9".repeat(64);
const ACTIVITY_REPO_ID = "activity-fixture";
const ACTIVITY_CONFIG = {
  communityName: "Repo Activity",
  relayUrl: CACHE_RELAY,
  agentControlUrl: null,
  features: { projects: true, forum: false },
  demoMode: false,
  agents: [],
};

function repoActivityEvents(now: number) {
  return [
    {
      id: "1".repeat(64),
      pubkey: ACTIVITY_OWNER,
      created_at: now - 86_400,
      kind: 30617,
      tags: [
        ["d", ACTIVITY_REPO_ID],
        ["name", ACTIVITY_REPO_ID],
        ["description", "Synthetic activity fixture"],
      ],
      content: "",
      sig: "0".repeat(128),
    },
    {
      id: "3".repeat(64),
      pubkey: ACTIVITY_ISSUE_AUTHOR,
      created_at: now - 7_200,
      kind: 1621,
      tags: [
        ["a", `30617:${ACTIVITY_OWNER}:${ACTIVITY_REPO_ID}`],
        ["p", ACTIVITY_OWNER],
        ["subject", "Published issue title"],
      ],
      content: "Published issue body",
      sig: "0".repeat(128),
    },
    {
      id: "4".repeat(64),
      pubkey: ACTIVITY_PR_AUTHOR,
      created_at: now - 3_600,
      kind: 1618,
      tags: [
        ["a", `30617:${ACTIVITY_OWNER}:${ACTIVITY_REPO_ID}`],
        ["p", ACTIVITY_OWNER],
        ["subject", "Published pull request title"],
      ],
      content: "Published pull request body",
      sig: "0".repeat(128),
    },
    {
      id: "5".repeat(64),
      pubkey: ACTIVITY_OWNER,
      created_at: now - 1_800,
      kind: 1631,
      tags: [["e", "4".repeat(64)]],
      content: "",
      sig: "0".repeat(128),
    },
    {
      // Same `d`, different owner, and no matching announcement: must not join.
      id: "6".repeat(64),
      pubkey: ACTIVITY_OTHER_OWNER,
      created_at: now - 900,
      kind: 1621,
      tags: [
        ["a", `30617:${ACTIVITY_OTHER_OWNER}:${ACTIVITY_REPO_ID}`],
        ["p", ACTIVITY_OTHER_OWNER],
        ["subject", "Unrelated issue title"],
      ],
      content: "Unrelated issue body",
      sig: "0".repeat(128),
    },
    {
      id: "7".repeat(64),
      pubkey: ACTIVITY_OTHER_OWNER,
      created_at: now - 600,
      kind: 1618,
      tags: [
        ["a", `30617:${ACTIVITY_OTHER_OWNER}:${ACTIVITY_REPO_ID}`],
        ["p", ACTIVITY_OTHER_OWNER],
        ["subject", "Unrelated pull request title"],
      ],
      content: "Unrelated pull request body",
      sig: "0".repeat(128),
    },
    {
      id: "8".repeat(64),
      pubkey: ACTIVITY_STRANGER,
      created_at: now - 300,
      kind: 1632,
      tags: [["e", "3".repeat(64)]],
      content: "",
      sig: "0".repeat(128),
    },
  ];
}

async function mockRepoActivityRelay(page: Page, events: readonly { kind: number }[]) {
  await page.routeWebSocket(CACHE_RELAY, (ws) => {
    ws.send(JSON.stringify(["AUTH", "repo-activity-challenge"]));
    ws.onMessage((message) => {
      const data = JSON.parse(String(message));
      if (data[0] === "AUTH") {
        ws.send(JSON.stringify(["OK", data[1].id, true, ""]));
        return;
      }
      if (data[0] !== "REQ") return;
      const [, subscriptionId, filter] = data;
      for (const event of events) {
        if (!(filter.kinds ?? []).includes(event.kind)) continue;
        ws.send(JSON.stringify(["EVENT", subscriptionId, event]));
      }
      ws.send(JSON.stringify(["EOSE", subscriptionId]));
    });
  });
  await page.route("**/query", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
}

test("repository activity shows published issues and PRs without leaking other repositories", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const events = repoActivityEvents(Math.floor(Date.now() / 1_000));

  await mockRepoActivityRelay(page, events);

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await useConfig(page, ACTIVITY_CONFIG);
  await page.goto("/");
  await createIdentity(page, "repo activity passphrase");
  await openProjects(page);

  const panel = page.getByTestId("workspace-tool-repos");
  await expect(panel.getByRole("group", { name: "Pull Requests" })).toContainText("1");
  await expect(panel.getByRole("group", { name: "Issues" })).toContainText("1");

  const issuesTab = panel.getByRole("tab", { name: "Issues" });
  await issuesTab.click();
  await expect(issuesTab).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByText("Published issue title")).toBeVisible();
  await expect(panel.getByText("Unrelated issue title")).toHaveCount(0);
  await expect(panel.getByText("Open", { exact: true })).toBeVisible();
  await expect(panel.getByText(/Recent Relay activity only/)).toBeVisible();
  await page.screenshot({
    path: "/tmp/opencode/repo-activity/en-1440x900-issues.png",
    animations: "disabled",
  });

  const prTab = panel.getByRole("tab", { name: "Pull Requests" });
  await prTab.click();
  await expect(prTab).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByText("Published pull request title")).toBeVisible();
  await expect(panel.getByText("Unrelated pull request title")).toHaveCount(0);
  await expect(panel.getByText("Merged", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "/tmp/opencode/repo-activity/en-1440x900-pull-requests.png",
    animations: "disabled",
  });

  await issuesTab.click();
  await page.setViewportSize({ width: 390, height: 844 });
  const closeChannels = page.getByRole("button", { name: "Close channel list" });
  if (await closeChannels.isVisible().catch(() => false)) {
    await closeChannels.click();
    await expect(closeChannels).toHaveCount(0);
    await expect
      .poll(async () => (await page.locator("aside").first().boundingBox())?.x ?? 0)
      .toBeLessThanOrEqual(-280);
  }
  await expect(panel.getByText("Published issue title")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "/tmp/opencode/repo-activity/en-390x844-issues.png",
    animations: "disabled",
  });
  await prTab.click();
  await expect(panel.getByText("Published pull request title")).toBeVisible();
  await page.screenshot({
    path: "/tmp/opencode/repo-activity/en-390x844-pull-requests.png",
    animations: "disabled",
  });

  expect(pageErrors).toEqual([]);
});

test("repository activity uses Simplified Chinese in a Chinese browser", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockRepoActivityRelay(page, repoActivityEvents(Math.floor(Date.now() / 1_000)));

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await useConfig(page, ACTIVITY_CONFIG);
  await page.goto("/");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("新保险库口令").fill("repo activity zh passphrase");
  await page.getByLabel("确认口令").fill("repo activity zh passphrase");
  await page.getByLabel("我明白，如果加密保险库和备份均丢失，Buzz 无法恢复此身份。").check();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await expect(page.getByRole("button", { name: "个人菜单" })).toBeVisible();

  await page.getByRole("button", { name: "项目", exact: true }).filter({ visible: true }).click();
  const panel = page.getByTestId("workspace-tool-repos");
  await expect(panel.getByRole("group", { name: "Issues" })).toContainText("1");
  await expect(panel.getByRole("group", { name: "Pull Requests" })).toContainText("1");

  await panel.getByRole("tab", { name: "Issues" }).click();
  await expect(panel.getByText("Published issue title")).toBeVisible();
  await expect(panel.getByText("开放", { exact: true })).toBeVisible();
  await expect(panel.getByText(/这里只显示 Relay 上的近期活动/)).toBeVisible();
  await expect(panel.getByText(/仅当状态由 Issue 或 Pull Request 作者/)).toBeVisible();
  await page.screenshot({
    path: "/tmp/opencode/repo-activity/zh-CN-1440x900-issues.png",
    animations: "disabled",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const closeChannels = page.getByRole("button", { name: "关闭频道列表" });
  if (await closeChannels.isVisible().catch(() => false)) {
    await closeChannels.click();
    await expect(closeChannels).toHaveCount(0);
  }
  await expect(panel.getByText("Published issue title")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "/tmp/opencode/repo-activity/zh-CN-390x844-issues.png",
    animations: "disabled",
  });

  expect(pageErrors).toEqual([]);
  await context.close();
});
