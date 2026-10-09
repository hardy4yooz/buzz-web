import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  AgentActivityStore,
  classifyObserverFrame,
  describeObserverFrame,
  parseObserverFrame,
  unwrapObserverBatch,
  validateObserverEvent,
} from "@/features/chat/lib/agent-activity";
import { observerActivityFilter } from "@/features/chat/lib/use-live-agent-activity";
import type { NostrEvent } from "@/shared/api/nostr-types";

const OWNER = "1".repeat(64);
const AGENT_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const OTHER_AGENT_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const AGENT = getPublicKey(AGENT_SECRET);
const OTHER_AGENT = getPublicKey(OTHER_AGENT_SECRET);
const CHANNEL = "channel-one";

function requiredFrame(overrides: Record<string, unknown> = {}) {
  const value = frame(overrides);
  if (!value) throw new Error("fixture frame must be valid");
  return value;
}

function event(
  overrides: Partial<NostrEvent> = {},
  secretKey: Uint8Array = AGENT_SECRET,
): NostrEvent {
  const pubkey = getPublicKey(secretKey);
  const signed = finalizeEvent(
    {
      kind: overrides.kind ?? 24200,
      created_at: overrides.created_at ?? 1,
      tags: overrides.tags ?? [
        ["p", OWNER],
        ["agent", pubkey],
        ["frame", "telemetry"],
      ],
      content: overrides.content ?? "ciphertext",
    },
    secretKey,
  );
  const event = {
    ...signed,
    ...(overrides.id ? { id: overrides.id } : {}),
    ...(overrides.pubkey ? { pubkey: overrides.pubkey } : {}),
    ...(overrides.sig ? { sig: overrides.sig } : {}),
  };
  return JSON.parse(JSON.stringify(event)) as NostrEvent;
}

function frame(overrides: Record<string, unknown> = {}) {
  return parseObserverFrame({
    seq: 1,
    timestamp: "2026-08-09T12:00:00.000Z",
    kind: "turn_started",
    channelId: CHANNEL,
    sessionId: "session-fixture",
    turnId: "turn-fixture",
    payload: null,
    ...overrides,
  });
}

describe("live agent activity protocol", () => {
  it("builds the exact persistent owner-scoped Relay filter", () => {
    expect(observerActivityFilter(OWNER)).toEqual({
      kinds: [24200],
      "#p": [OWNER],
      limit: 0,
    });
  });

  it("requires owner, agent, frame tags and a matching signed agent", () => {
    expect(validateObserverEvent(event(), OWNER)).toBe(AGENT);
    expect(validateObserverEvent(event({ pubkey: OTHER_AGENT }), OWNER)).toBeNull();
    expect(validateObserverEvent(event({ sig: "b".repeat(128) }), OWNER)).toBeNull();
    expect(
      validateObserverEvent(event({}, OTHER_AGENT_SECRET), OWNER, new Set([AGENT])),
    ).toBeNull();
    expect(
      validateObserverEvent(
        event({
          tags: [
            ["p", "9".repeat(64)],
            ["agent", AGENT],
            ["frame", "telemetry"],
          ],
        }),
        OWNER,
      ),
    ).toBeNull();
    expect(
      validateObserverEvent(
        event({
          tags: [
            ["p", OWNER],
            ["agent", AGENT],
            ["frame", "other"],
          ],
        }),
        OWNER,
      ),
    ).toBeNull();
  });

  it("unwraps valid batches and preserves malformed envelopes as one safe frame", () => {
    const batch = frame({
      kind: "batch",
      payload: {
        events: [
          {
            seq: 2,
            timestamp: "2026-08-09T12:00:01Z",
            kind: "turn_liveness",
            channelId: CHANNEL,
            payload: null,
          },
          {
            seq: 3,
            timestamp: "2026-08-09T12:00:02Z",
            kind: "turn_completed",
            channelId: CHANNEL,
            payload: null,
          },
        ],
      },
    });
    expect(batch).not.toBeNull();
    expect(unwrapObserverBatch(batch ?? requiredFrame())).toHaveLength(2);
    const malformed = frame({ kind: "batch", payload: { nope: true } });
    expect(unwrapObserverBatch(malformed ?? requiredFrame())).toHaveLength(1);
    const oversized = frame({
      kind: "batch",
      payload: {
        events: Array.from({ length: 80 }, (_, index) => ({
          seq: index,
          timestamp: "2026-08-09T12:00:01Z",
          kind: "turn_liveness",
          channelId: CHANNEL,
          payload: null,
        })),
      },
    });
    expect(unwrapObserverBatch(oversized ?? requiredFrame())).toHaveLength(64);
    expect(frame({ channelId: "x".repeat(513) })).toBeNull();
  });

  it("deduplicates frames and scopes statuses to the active channel", () => {
    const store = new AgentActivityStore();
    const first = frame({ seq: 1, channelId: CHANNEL });
    const otherChannel = frame({ seq: 2, channelId: "channel-two" });
    expect(store.ingest(AGENT, first ?? requiredFrame(), 1_000)).toBe(true);
    expect(store.ingest(AGENT, first ?? requiredFrame(), 1_001)).toBe(false);
    expect(store.ingest(AGENT, otherChannel ?? requiredFrame(), 1_002)).toBe(true);
    expect(store.getStatuses(CHANNEL, [AGENT], "connected", true, 1_003)[0]?.state).toBe("working");
    expect(store.getStatuses("channel-three", [AGENT], "connected", true, 1_003)).toEqual([]);
  });

  it("does not let a late older frame replace the newest channel status", () => {
    const store = new AgentActivityStore();
    store.ingest(
      AGENT,
      requiredFrame({
        seq: 2,
        timestamp: "2026-08-09T12:00:02.000Z",
        payload: {
          params: {
            update: {
              sessionUpdate: "tool_call",
              title: "shell",
              rawInput: { command: "npm run newest" },
            },
          },
        },
      }),
      1_000,
    );
    store.ingest(
      AGENT,
      requiredFrame({
        seq: 1,
        timestamp: "2026-08-09T12:00:01.000Z",
        payload: {
          params: {
            update: {
              sessionUpdate: "tool_call",
              title: "shell",
              rawInput: { command: "npm run older" },
            },
          },
        },
      }),
      1_100,
    );
    expect(store.getStatuses(CHANNEL, [AGENT], "connected", true, 1_200)[0]?.summary).toBe(
      "npm run newest",
    );
  });

  it("transitions fresh activity to quiet without calling silence a stall", () => {
    const store = new AgentActivityStore();
    store.ingest(AGENT, requiredFrame({ kind: "turn_liveness" }), 10_000);
    expect(store.getStatuses(CHANNEL, [AGENT], "connected", true, 10_500)[0]).toMatchObject({
      state: "working",
      detail: "fresh",
    });
    expect(store.getStatuses(CHANNEL, [AGENT], "connected", true, 30_000)[0]).toMatchObject({
      state: "quiet",
      detail: "silent",
    });
    expect(store.getStatuses(CHANNEL, [AGENT], "reconnecting", true, 30_000)[0]?.state).toBe(
      "reconnecting",
    );
    expect(store.getStatuses(CHANNEL, [AGENT], "connecting", true, 30_000)[0]?.state).toBe(
      "reconnecting",
    );
    expect(store.getStatuses(CHANNEL, [AGENT], "disconnected", true, 30_000)[0]?.state).toBe(
      "disconnected",
    );
  });

  it("reports signer unavailability only for a pending agent turn", () => {
    const store = new AgentActivityStore();
    expect(store.getStatuses(CHANNEL, [AGENT], "connected", false, 1_000)).toEqual([]);
    store.markSubmitted(CHANNEL, [AGENT], 1_000);
    expect(store.getStatuses(CHANNEL, [AGENT], "connected", false, 1_100)[0]).toMatchObject({
      state: "unavailable",
      detail: "signer",
    });
  });

  it("classifies only lifecycle categories from encrypted frame structure", () => {
    expect(
      classifyObserverFrame(
        requiredFrame({
          kind: "acp_read",
          payload: {
            params: { update: { sessionUpdate: "agent_thought_chunk", content: "private" } },
          },
        }),
      ),
    ).toBe("thinking");
    expect(
      classifyObserverFrame(
        requiredFrame({
          kind: "acp_read",
          payload: { params: { update: { sessionUpdate: "tool_call", arguments: "private" } } },
        }),
      ),
    ).toBe("tool");
    expect(
      classifyObserverFrame(
        requiredFrame({
          kind: "acp_read",
          payload: {
            params: { update: { sessionUpdate: "agent_message_chunk", content: "private" } },
          },
        }),
      ),
    ).toBe("responding");
  });

  it("surfaces a redacted shell command without raw output", () => {
    const shellFrame = requiredFrame({
      kind: "acp_read",
      payload: {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            status: "completed",
            title: "shell",
            rawInput: {
              command:
                "TOKEN=ghp_fixturetoken123456789 cat /Users/fixture/private && echo nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
            },
            rawOutput: "unrelated private output",
          },
        },
      },
    });

    expect(describeObserverFrame(shellFrame)).toMatchObject({
      state: "tool",
      title: "shell",
      detail: "TOKEN=<redacted> cat <path> && echo <redacted>",
    });
    expect(JSON.stringify(describeObserverFrame(shellFrame))).not.toContain("private output");
  });

  it("does not render empty lifecycle payloads as bracket noise", () => {
    const emptyFrame = requiredFrame({ kind: "turn_liveness", payload: {} });
    expect(describeObserverFrame(emptyFrame).detail).toBeNull();

    const store = new AgentActivityStore();
    store.ingest(AGENT, emptyFrame, 1_000);
    expect(store.getStatuses(CHANNEL, [AGENT], "connected", true, 1_100)[0]?.summary).toBeNull();
  });

  it("keeps structured protocol objects out of the human activity presentation", () => {
    const metadataFrame = requiredFrame({
      kind: "acp_read",
      payload: {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "available_commands_update",
            commands: [{ name: "fixture-command", input: { nested: true } }],
          },
        },
      },
    });
    expect(describeObserverFrame(metadataFrame).detail).toBeNull();

    const structuredToolFrame = requiredFrame({
      kind: "acp_read",
      payload: {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            title: "search",
            rawInput: { recursive: true, limit: 25, options: { nested: true } },
            rawOutput: { matches: [{ path: "fixture-only" }] },
          },
        },
      },
    });
    expect(describeObserverFrame(structuredToolFrame)).toMatchObject({
      detail: null,
    });
  });

  it("routes unscoped frames only through a trusted turn or session channel correlation", () => {
    const store = new AgentActivityStore();
    store.ingest(AGENT, requiredFrame({ seq: 1, channelId: CHANNEL }), 1_000);
    expect(
      store.ingest(
        AGENT,
        requiredFrame({
          seq: 2,
          channelId: null,
          payload: {
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "tool_call",
                title: "shell",
                rawInput: { command: "npm test" },
              },
            },
          },
        }),
        1_100,
      ),
    ).toBe(true);
    expect(
      store.ingest(
        AGENT,
        requiredFrame({
          seq: 3,
          channelId: null,
          turnId: "unrelated-turn",
          sessionId: "unrelated-session",
        }),
        1_200,
      ),
    ).toBe(false);

    const channelItems = store.getItems(CHANNEL, [AGENT]);
    expect(channelItems).toHaveLength(2);
    expect(channelItems[1]?.presentation.detail).toBe("npm test");
    expect(store.getStatuses(CHANNEL, [AGENT], "connected", true, 1_300)[0]?.summary).toBe(
      "npm test",
    );
    expect(store.getItems("other-private-channel", [AGENT])).toEqual([]);
    expect(store.getItems(CHANNEL, [OTHER_AGENT])).toEqual([]);
  });

  it("drops unscoped frames when a session correlation spans channels", () => {
    const store = new AgentActivityStore();
    store.ingest(
      AGENT,
      requiredFrame({ seq: 1, channelId: CHANNEL, turnId: "turn-one", sessionId: "shared" }),
      1_000,
    );
    store.ingest(
      AGENT,
      requiredFrame({ seq: 2, channelId: "channel-two", turnId: "turn-two", sessionId: "shared" }),
      1_100,
    );
    expect(
      store.ingest(
        AGENT,
        requiredFrame({ seq: 3, channelId: null, turnId: null, sessionId: "shared" }),
        1_200,
      ),
    ).toBe(false);
  });

  it("does not present a previous turn as current after a new submission", () => {
    const store = new AgentActivityStore();
    store.ingest(
      AGENT,
      requiredFrame({
        seq: 1,
        payload: {
          params: {
            update: {
              sessionUpdate: "tool_call",
              title: "shell",
              rawInput: { command: "npm run previous" },
            },
          },
        },
      }),
      1_000,
    );
    store.markSubmitted(CHANNEL, [AGENT], 2_000);
    expect(store.getStatuses(CHANNEL, [AGENT], "connected", true, 2_100)[0]).toMatchObject({
      state: "working",
      detail: "waiting",
      summary: null,
    });
  });
});
