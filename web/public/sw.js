const CACHE = "buzz-web-static-v1";
const PENDING_CACHE = "buzz-notify-pending-v1";
const TAG_PREFIX = "buzz:v1:";
const CATEGORIES = ["mention", "dm", "thread", "needs_action"];

const HEX_16 = /^[0-9a-f]{16}$/;
const HEX_64 = /^[0-9a-f]{64}$/i;
const CHANNEL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Serializes check-and-show so staggered tabs cannot both display the same event. */
let notifyQueue = Promise.resolve();

function enqueue(task) {
  const run = notifyQueue.then(task, task);
  notifyQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function parseTarget(value) {
  if (!value || typeof value !== "object") return null;
  const { v, scopeId, eventId, channelId, threadRootId, category, createdAt } = value;
  if (v !== 1 || typeof scopeId !== "string" || !HEX_16.test(scopeId)) return null;
  if (typeof eventId !== "string" || !HEX_64.test(eventId)) return null;
  if (typeof channelId !== "string" || !CHANNEL_ID.test(channelId)) return null;
  if (threadRootId !== null && (typeof threadRootId !== "string" || !HEX_64.test(threadRootId))) {
    return null;
  }
  if (!CATEGORIES.includes(category)) return null;
  if (!Number.isInteger(createdAt) || createdAt <= 0) return null;
  return { v: 1, scopeId, eventId, channelId, threadRootId, category, createdAt };
}

/**
 * Fixed fields plus already localized generic copy, capped by the page contract. No sender,
 * channel name, message text, relay host, or count can reach the notification store.
 */
function parseMessage(value) {
  const data = parseTarget(value);
  if (!data) return null;
  const { tag, title, body } = value;
  if (typeof tag !== "string" || tag !== `${TAG_PREFIX}${data.scopeId}:ch:${data.channelId}`) {
    return null;
  }
  if (typeof title !== "string" || !title.trim() || title.length > 120) return null;
  if (typeof body !== "string" || !body.trim() || body.length > 200) return null;
  return { tag, title, body, data };
}

/**
 * Dedupe lives here so every tab shares one answer per channel tag. The notification store is the
 * record: `duplicate` means this exact event is already shown; `stale` means a not-newer event
 * occupies the channel. This converges staggered tabs, but it is not exactly-once: a dismissed or
 * evicted notification is forgotten, and two worker instances overlapping an update are not
 * serialized by this chain (mitigated by skipWaiting).
 */
async function showIfFresh({ tag, title, body, data }) {
  const existing = await self.registration.getNotifications();
  const sameTag = existing.filter((notification) => notification.tag === tag);
  const known = sameTag
    .map((notification) => notification.data)
    .filter((value) => value && typeof value === "object");
  if (known.some((value) => value.eventId === data.eventId && value.scopeId === data.scopeId)) {
    return "duplicate";
  }
  const newest = sameTag.reduce(
    (latest, notification) =>
      Math.max(
        latest,
        notification.data && Number.isInteger(notification.data.createdAt)
          ? notification.data.createdAt
          : 0,
      ),
    0,
  );
  if (newest >= data.createdAt) return "stale";
  await self.registration.showNotification(title, {
    tag,
    body,
    data,
    renotify: false,
    silent: false,
  });
  return "shown";
}

async function storePending(target) {
  const cache = await caches.open(PENDING_CACHE);
  const key = `${target.scopeId}__buzz-notify-pending__/${target.scopeId}`;
  await cache.put(
    key,
    new Response(JSON.stringify({ v: 1, storedAt: Date.now(), target }), {
      headers: { "content-type": "application/json" },
    }),
  );
}

function reply(event, payload) {
  const port = event.ports?.[0];
  if (port) port.postMessage(payload);
  else if (event.source && "postMessage" in event.source) event.source.postMessage(payload);
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE && key !== PENDING_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "buzz:ping:v1") {
    reply(event, { type: "buzz:pong:v1" });
    return;
  }
  if (data.type !== "buzz:notify:v1") return;
  const message = parseMessage(data);
  if (!message) {
    reply(event, { type: "buzz:notify-result:v1", result: "invalid" });
    return;
  }
  event.waitUntil(
    enqueue(() => showIfFresh(message)).then(
      (result) => reply(event, { type: "buzz:notify-result:v1", result }),
      () => reply(event, { type: "buzz:notify-result:v1", result: "show-failed" }),
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = parseTarget(event.notification.data);
  event.waitUntil(
    (async () => {
      if (target) await storePending(target);
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (!clients.length) {
        await self.clients.openWindow(self.registration.scope);
        return;
      }
      // The wake-up carries no scope: each window reads the shared entry under its own scope key,
      // so a tab holding another identity finds nothing and stays put.
      for (const client of clients) client.postMessage({ type: "buzz:notification-click" });
      const chosen = clients.find((client) => client.focused) ?? clients[0];
      await chosen.focus();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !url.pathname.includes("/assets/")
  ) {
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }),
  );
});
