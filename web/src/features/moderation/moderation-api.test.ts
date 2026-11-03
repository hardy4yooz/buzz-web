import { generateSecretKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canViewModeration,
  fetchModerationAudit,
  fetchModerationReports,
  fetchModerationRestricted,
  type ModerationReport,
  moderationQueryKey,
} from "@/features/moderation/moderation-api";
import { activateLocalSigner, clearActiveSigner } from "@/shared/lib/nostr-signer";

const RELAY = "wss://relay.example.com";
const ORIGIN = "https://relay.example.com";
const VIEWER = "d".repeat(64);

const REPORT: ModerationReport = {
  id: "0b0f3f4e-6a64-4c1e-9d3f-5b1f2c8aa111",
  report_event_id: "1".repeat(64),
  reporter_pubkey: "2".repeat(64),
  target_kind: "event",
  target: "3".repeat(64),
  channel_id: null,
  report_type: "spam",
  note: "Repeated links in #general",
  status: "open",
  resolved_by: null,
  resolved_at: null,
  action_id: null,
  created_at: "2026-11-01T10:00:00Z",
};

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

describe("canViewModeration", () => {
  it("admits only community owner and admin roles", () => {
    expect(canViewModeration("owner")).toBe(true);
    expect(canViewModeration("admin")).toBe(true);
    expect(canViewModeration("member")).toBe(false);
    expect(canViewModeration("guest")).toBe(false);
    expect(canViewModeration("bot")).toBe(false);
    // A channel admin has no community role, so the gate receives null.
    expect(canViewModeration(null)).toBe(false);
  });
});

describe("moderationQueryKey", () => {
  it("scopes every read to the relay and the active viewer", () => {
    expect(moderationQueryKey(RELAY, VIEWER, "reports")).toEqual([
      "moderation",
      RELAY,
      VIEWER,
      "reports",
    ]);
    expect(moderationQueryKey("wss://other.example.com", VIEWER, "reports")).not.toEqual(
      moderationQueryKey(RELAY, VIEWER, "reports"),
    );
    expect(moderationQueryKey(RELAY, "e".repeat(64), "reports")).not.toEqual(
      moderationQueryKey(RELAY, VIEWER, "reports"),
    );
  });
});

describe("fetchModerationReports", () => {
  it("signs a NIP-98 GET for the exact public-origin URL and parses known fields", async () => {
    activateLocalSigner(generateSecretKey());
    const fetchMock = stubFetch(() => jsonResponse([REPORT]));

    const result = await fetchModerationReports(RELAY);

    expect(result).toEqual({ state: "ok", rows: [REPORT] });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${ORIGIN}/moderation/reports?limit=100`);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    const signed = signedHeader(init);
    expect(signed.tags).toContainEqual(["u", `${ORIGIN}/moderation/reports?limit=100`]);
    expect(signed.tags).toContainEqual(["method", "GET"]);
    expect(signed.tags).toContainEqual(["nonce", expect.any(String)]);
    expect(signed.tags.some((tag) => tag[0] === "payload")).toBe(false);
  });

  it("keeps a status filter in the signed URL and never sends an empty status", async () => {
    activateLocalSigner(generateSecretKey());
    const fetchMock = stubFetch(() => jsonResponse([]));

    await fetchModerationReports(RELAY, { status: "open", limit: 500 });
    await fetchModerationReports(RELAY, { status: "  " });

    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls[0]).toBe(`${ORIGIN}/moderation/reports?status=open&limit=500`);
    // `status=` would filter on the empty string server-side and hide every row.
    expect(urls[1]).toBe(`${ORIGIN}/moderation/reports?limit=100`);
  });

  it("reports a 403 as a not-authorized outcome", async () => {
    activateLocalSigner(generateSecretKey());
    stubFetch(() => jsonResponse({ error: "restricted: moderator access required" }, 403));

    await expect(fetchModerationReports(RELAY)).resolves.toEqual({ state: "forbidden" });
  });

  it("reports the relay's 503 statement timeout as retryable", async () => {
    activateLocalSigner(generateSecretKey());
    stubFetch(() => jsonResponse({ error: "query timed out" }, 503));

    await expect(fetchModerationReports(RELAY)).resolves.toEqual({ state: "timeout" });
  });

  it("treats other server failures as a generic error", async () => {
    activateLocalSigner(generateSecretKey());
    stubFetch(() => jsonResponse({ error: "internal server error" }, 500));

    await expect(fetchModerationReports(RELAY)).resolves.toEqual({ state: "error" });
  });

  it("treats a network failure and an aborted request as a generic error", async () => {
    activateLocalSigner(generateSecretKey());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    );

    await expect(fetchModerationReports(RELAY)).resolves.toEqual({ state: "error" });
  });

  it("fails the read instead of showing an empty queue when the payload is not an array", async () => {
    activateLocalSigner(generateSecretKey());
    stubFetch(() => jsonResponse({ rows: [] }));

    await expect(fetchModerationReports(RELAY)).resolves.toEqual({ state: "error" });
  });

  it("fails the read when a row has an unexpected shape", async () => {
    activateLocalSigner(generateSecretKey());
    stubFetch(() => jsonResponse([{ ...REPORT, status: 7 }]));

    await expect(fetchModerationReports(RELAY)).resolves.toEqual({ state: "error" });
  });

  it("does not surface fields the relay did not send", async () => {
    activateLocalSigner(generateSecretKey());
    stubFetch(() => jsonResponse([{ ...REPORT, unexpected: "value" }]));

    const result = await fetchModerationReports(RELAY);
    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected an ok read");
    expect(Object.keys(result.rows[0] ?? {})).toEqual(Object.keys(REPORT));
  });
});

describe("fetchModerationAudit", () => {
  it("reads the audit log and keeps private reasons as plain text fields", async () => {
    activateLocalSigner(generateSecretKey());
    const row = {
      id: "b".repeat(36),
      actor_pubkey: "4".repeat(64),
      action: "ban",
      target_pubkey: "5".repeat(64),
      target_event_id: null,
      channel_id: null,
      reason_code: "spam",
      public_reason: "Repeated spam",
      private_reason: "Reported by three members",
      matched_principal: "self",
      created_at: "2026-11-02T09:30:00Z",
    };
    const fetchMock = stubFetch(() => jsonResponse([row]));

    const result = await fetchModerationAudit(RELAY, { limit: 50 });

    expect(result).toEqual({ state: "ok", rows: [row] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${ORIGIN}/moderation/audit?limit=50`);
  });
});

describe("fetchModerationRestricted", () => {
  it("reads current restrictions", async () => {
    activateLocalSigner(generateSecretKey());
    const row = {
      pubkey: "6".repeat(64),
      banned: true,
      ban_expires_at: null,
      ban_reason: "Harassment",
      muted_until: "2026-12-01T00:00:00Z",
      mute_reason: "Cooling-off period",
      actor_pubkey: "7".repeat(64),
      updated_at: "2026-11-02T09:30:00Z",
    };
    const fetchMock = stubFetch(() => jsonResponse([row]));

    const result = await fetchModerationRestricted(RELAY);

    expect(result).toEqual({ state: "ok", rows: [row] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${ORIGIN}/moderation/restricted`);
  });
});
