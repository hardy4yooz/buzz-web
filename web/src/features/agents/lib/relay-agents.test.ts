import { describe, expect, it } from "vitest";
import { relayAgentsFromEvents } from "@/features/agents/lib/relay-agents";
import type { BuzzChannel, UserProfile } from "@/features/chat/lib/chat-types";
import type { NostrEvent } from "@/shared/api/nostr-types";

const AGENT = "a".repeat(64);
const CONFIGURED = "b".repeat(64);

function event(createdAt: number, content: Record<string, unknown>): NostrEvent {
  return {
    id: String(createdAt).padStart(64, "0"),
    pubkey: AGENT,
    kind: 10100,
    content: JSON.stringify(content),
    created_at: createdAt,
    tags: [],
    sig: "0".repeat(128),
  };
}

function channel(): BuzzChannel {
  return {
    id: "channel-id",
    name: "general",
    description: "",
    topic: null,
    type: "stream",
    visibility: "open",
    archived: false,
    isMember: true,
    members: [{ pubkey: AGENT, role: "bot" }],
    participantPubkeys: [AGENT],
  };
}

describe("relayAgentsFromEvents", () => {
  it("uses the latest agent profile and actual bot membership", () => {
    const profiles: Record<string, UserProfile> = {
      [AGENT]: {
        pubkey: AGENT,
        name: "Profile name",
        about: "Remote coding assistant",
        picture: null,
        isAgent: true,
      },
    };
    const agents = relayAgentsFromEvents({
      events: [
        event(1, { name: "Old name", channel_ids: ["stale"] }),
        event(2, {
          display_name: "Codex(remote)",
          capabilities: ["chat", "tools"],
          respond_to: "owner-only",
          channel_ids: ["declared"],
          status: "offline",
        }),
      ],
      configuredAgents: [],
      channels: [channel()],
      profiles,
      presence: { [AGENT]: "online" },
    });

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      pubkey: AGENT,
      name: "Codex(remote)",
      about: "Remote coding assistant",
      capabilities: ["chat", "tools"],
      respondTo: "owner-only",
      status: "online",
    });
    expect(agents[0]?.channelIds).toEqual(["declared", "channel-id"]);
  });

  it("keeps configured agents visible before they publish kind 10100", () => {
    const agents = relayAgentsFromEvents({
      events: [],
      configuredAgents: [{ pubkey: CONFIGURED, name: "Grok(remote)" }],
      channels: [],
      profiles: {},
      presence: {},
    });

    expect(agents).toEqual([
      expect.objectContaining({
        pubkey: CONFIGURED,
        name: "Grok(remote)",
        status: "offline",
      }),
    ]);
  });

  it("labels an unnamed agent with the local readable fallback", () => {
    const agents = relayAgentsFromEvents({
      events: [event(1, {})],
      configuredAgents: [],
      channels: [channel()],
      profiles: {},
      presence: {},
    });

    expect(agents[0]?.name.startsWith("Agent ")).toBe(true);
  });

  it("deduplicates configured agents and bot memberships regardless of pubkey casing", () => {
    const agents = relayAgentsFromEvents({
      events: [],
      configuredAgents: [{ pubkey: AGENT.toUpperCase(), name: "Codex(remote)" }],
      channels: [channel()],
      profiles: {},
      presence: {},
    });

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      pubkey: AGENT,
      name: "Codex(remote)",
      channelIds: ["channel-id"],
    });
  });
});
