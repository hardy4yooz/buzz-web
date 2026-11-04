import { describe, expect, it, vi } from "vitest";
import {
  buildMessageTags,
  buildTimeline,
  channelFromEvents,
  contentWithAttachments,
  describeSystemMessage,
  fallbackProfile,
  isValidProfilePicture,
  mergeProfileMetadata,
  mergeProfiles,
  messageRecipientPubkeys,
  parseCommunityRole,
  parseSystemMessagePayload,
  profileDisplayName,
  profilesFromEvents,
  resolveMentionPubkeys,
  systemMessagePubkeys,
} from "@/features/chat/lib/chat-model";
import type { NostrEvent } from "@/shared/api/nostr-types";

const SELF = "11".repeat(32);
const AGENT = "22".repeat(32);
const RELAY = "33".repeat(32);
const CHANNEL = "11111111-2222-4333-8444-555555555555";

function event(
  id: string,
  kind: number,
  pubkey: string,
  content: string,
  tags: string[][],
  createdAt = 1,
): NostrEvent {
  return {
    id: id.repeat(64).slice(0, 64),
    kind,
    pubkey,
    content,
    tags,
    created_at: createdAt,
    sig: "aa".repeat(64),
  };
}

describe("profile picture validation", () => {
  it("accepts empty and HTTP(S) URLs, rejects malformed and other protocols", () => {
    expect(isValidProfilePicture("")).toBe(true);
    expect(isValidProfilePicture(" https://example.com/avatar.png ")).toBe(true);
    expect(isValidProfilePicture("http://example.com/avatar.png")).toBe(true);
    expect(isValidProfilePicture("not-a-url")).toBe(false);
    expect(isValidProfilePicture("ftp://example.com/avatar.png")).toBe(false);
  });
});

describe("Buzz channel model", () => {
  it("parses NIP-29 channel metadata and member roles", () => {
    const metadata = event("a", 39000, RELAY, "", [
      ["d", CHANNEL],
      ["name", "general"],
      ["about", "Team chat"],
      ["public"],
      ["closed"],
      ["t", "stream"],
    ]);
    const members = event("b", 39002, RELAY, "", [
      ["d", CHANNEL],
      ["p", SELF, "", "owner"],
      ["p", AGENT, "", "bot"],
    ]);

    expect(channelFromEvents(metadata, members)).toMatchObject({
      id: CHANNEL,
      name: "general",
      type: "stream",
      visibility: "open",
      members: [
        { pubkey: SELF, role: "owner" },
        { pubkey: AGENT, role: "bot" },
      ],
    });
  });

  it("reads the current relay role from the NIP-43 snapshot", () => {
    const membership = event("c", 13534, RELAY, "", [["-"], ["member", SELF, "admin"]]);
    expect(parseCommunityRole(membership, SELF)).toBe("admin");
  });
});

describe("Buzz timeline model", () => {
  it("merges replies, edits, reactions, and deletions", () => {
    const root = event(
      "d",
      9,
      SELF,
      "before @Codex(remote)",
      [
        ["h", CHANNEL],
        ["p", AGENT],
      ],
      10,
    );
    const reply = event(
      "e",
      9,
      AGENT,
      "reply",
      [
        ["h", CHANNEL],
        ["e", root.id, "", "reply"],
      ],
      11,
    );
    const edit = event(
      "f",
      40003,
      SELF,
      "after @Teammate",
      [
        ["e", root.id],
        ["mention", AGENT],
        ["p", RELAY],
      ],
      12,
    );
    const reaction = event("1", 7, AGENT, "✅", [["e", root.id]], 13);
    const deleted = event("2", 9, SELF, "remove me", [["h", CHANNEL]], 14);
    const deletion = event("3", 5, SELF, "", [["e", deleted.id]], 15);

    const timeline = buildTimeline([root, reply, deleted], [edit, reaction, deletion], SELF, {});
    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toMatchObject({
      content: "after @Teammate",
      mentionPubkeys: [AGENT, RELAY],
      rootId: null,
      reactions: [{ emoji: "✅", count: 1, reactedByMe: false }],
    });
    expect(timeline[1]).toMatchObject({ rootId: root.id, parentId: root.id });
    expect(timeline[2]).toMatchObject({
      content: "",
      mentionPubkeys: [],
      deleted: true,
      edited: false,
      reactions: [],
    });
  });

  it("deduplicates reactions by user and applies reaction tombstones", () => {
    const root = event("8", 9, SELF, "message", [["h", CHANNEL]], 10);
    const myFirst = event("9", 7, SELF, "👀", [["e", root.id]], 11);
    const myDuplicate = event("a", 7, SELF, "👀", [["e", root.id]], 12);
    const agentReaction = event("b", 7, AGENT, "👀", [["e", root.id]], 13);

    expect(
      buildTimeline([root], [myFirst, myDuplicate, agentReaction], SELF, {})[0].reactions,
    ).toEqual([
      {
        emoji: "👀",
        count: 2,
        reactedByMe: true,
        currentUserEventIds: [myFirst.id, myDuplicate.id],
      },
    ]);

    const removeFirst = event("c", 5, SELF, "", [["e", myFirst.id]], 14);
    const removeDuplicate = event("d", 5, SELF, "", [["e", myDuplicate.id]], 15);
    expect(
      buildTimeline(
        [root],
        [myFirst, myDuplicate, agentReaction, removeFirst, removeDuplicate],
        SELF,
        {},
      )[0].reactions,
    ).toEqual([
      {
        emoji: "👀",
        count: 1,
        reactedByMe: false,
        currentUserEventIds: [],
      },
    ]);
  });

  it("renders relay system events as Desktop-style timeline descriptions", () => {
    const profiles = {
      [SELF]: fallbackProfile(SELF, "Owner"),
      [AGENT]: fallbackProfile(AGENT, "Codex(remote)", true),
    };
    const created = event(
      "4",
      40099,
      RELAY,
      JSON.stringify({ type: "channel_created", actor: SELF }),
      [["h", CHANNEL]],
      20,
    );
    const joined = event(
      "5",
      40099,
      RELAY,
      JSON.stringify({ type: "member_joined", actor: SELF, target: AGENT }),
      [["h", CHANNEL]],
      21,
    );

    expect(parseSystemMessagePayload(created)).toMatchObject({
      type: "channel_created",
      actor: SELF,
    });
    expect(describeSystemMessage(created, SELF, profiles)).toEqual({
      identityPubkey: SELF,
      title: "You",
      action: "created this channel",
    });
    expect(describeSystemMessage(joined, SELF, profiles)).toEqual({
      identityPubkey: AGENT,
      title: "Codex(remote)",
      action: "added by You",
    });
    expect(systemMessagePubkeys(joined)).toEqual([SELF, AGENT]);
  });

  it("does not interpret ordinary JSON or unknown system payloads as system rows", () => {
    const ordinary = event("6", 9, SELF, JSON.stringify({ type: "channel_created", actor: SELF }), [
      ["h", CHANNEL],
    ]);
    const unknown = event(
      "7",
      40099,
      RELAY,
      JSON.stringify({ type: "future_system_event", actor: SELF }),
      [["h", CHANNEL]],
    );

    expect(parseSystemMessagePayload(ordinary)).toBeNull();
    expect(parseSystemMessagePayload(unknown)).toBeNull();
  });
});

describe("Buzz profile metadata", () => {
  it("preserves fields that the Web profile editor does not expose", () => {
    expect(
      JSON.parse(
        mergeProfileMetadata(
          JSON.stringify({ nip05: "owner@relay.example", website: "https://example.com" }),
          { name: "Alex", about: "Builder", picture: "https://example.com/avatar.png" },
        ),
      ),
    ).toEqual({
      nip05: "owner@relay.example",
      website: "https://example.com",
      display_name: "Alex",
      name: "Alex",
      about: "Builder",
      picture: "https://example.com/avatar.png",
    });
  });

  it("ignores malformed existing profile content", () => {
    expect(
      JSON.parse(mergeProfileMetadata("not-json", { name: "Alex", about: "", picture: "" })),
    ).toEqual({ display_name: "Alex", name: "Alex", about: "", picture: "" });
  });
});

describe("Buzz profile hydration", () => {
  const agents = new Set([AGENT]);

  it("uses the first non-blank name field instead of letting an empty one mask it", () => {
    const profiles = profilesFromEvents(
      [
        event(
          "a",
          0,
          AGENT,
          JSON.stringify({ display_name: "  ", displayName: null, name: "Codex(remote)" }),
          [],
          5,
        ),
      ],
      agents,
    );

    expect(profiles[AGENT]).toMatchObject({
      pubkey: AGENT,
      name: "Codex(remote)",
      isAgent: true,
    });
  });

  it("keeps the latest metadata and tolerates null, array, and malformed content", () => {
    const profiles = profilesFromEvents(
      [
        event("b", 0, SELF, JSON.stringify({ name: "Old name" }), [], 10),
        event("c", 0, SELF, JSON.stringify({ name: "New name" }), [], 11),
        event("d", 0, RELAY, "null", [], 20),
        event("e", 0, "44".repeat(32), "[]", [], 21),
        event("f", 0, "55".repeat(32), "not-json", [], 22),
        event("9", 0, "66".repeat(32), JSON.stringify({ name: "" }), [], 23),
      ],
      new Set(),
    );

    expect(profiles[SELF].name).toBe("New name");
    for (const pubkey of [RELAY, "44".repeat(32), "55".repeat(32), "66".repeat(32)]) {
      expect(profiles[pubkey]).toMatchObject({ name: "", about: "", picture: null });
    }
  });

  it("preserves known names and applies real names from newer metadata", () => {
    const current = {
      [SELF]: { ...fallbackProfile(SELF), name: "Alice", about: "old about" },
      [AGENT]: fallbackProfile(AGENT, "Codex(remote)", true),
    };
    const incoming = profilesFromEvents(
      [
        event("1", 0, SELF, JSON.stringify({ display_name: "", name: "" }), [], 30),
        event("2", 0, AGENT, JSON.stringify({ name: "Codex v2" }), [], 31),
        event("3", 0, RELAY, JSON.stringify({ display_name: "Bob" }), [], 32),
      ],
      agents,
    );
    const merged = mergeProfiles(current, incoming);

    expect(merged[SELF].name).toBe("Alice");
    expect(merged[AGENT]).toMatchObject({ name: "Codex v2", isAgent: true });
    expect(merged[RELAY]).toMatchObject({ name: "Bob", isAgent: false });
  });

  it("labels nameless authors locally instead of presenting a fabricated public name", () => {
    vi.stubGlobal("navigator", { languages: ["en"] });
    try {
      const merged = mergeProfiles(
        {},
        profilesFromEvents([event("4", 0, SELF, "null", [], 1)], new Set()),
      );

      expect(merged[SELF].name).toBe(fallbackProfile(SELF).name);
      expect(merged[SELF].name.startsWith("Member ")).toBe(true);
      expect(profileDisplayName({ ...fallbackProfile(SELF), name: "Alice" }, SELF)).toBe("Alice");
      expect(profileDisplayName(undefined, AGENT, true)).toBe(
        fallbackProfile(AGENT, undefined, true).name,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("localizes the local nameless placeholder", () => {
    vi.stubGlobal("navigator", { languages: ["zh-CN"] });
    try {
      expect(fallbackProfile(SELF).name.startsWith("成员 ")).toBe(true);
      expect(profileDisplayName(undefined, AGENT, true).startsWith("Agent ")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Buzz outgoing messages", () => {
  it("adds agent mentions, thread markers, and imeta tags", () => {
    const profiles = {
      [SELF]: fallbackProfile(SELF, "Owner"),
      [AGENT]: fallbackProfile(AGENT, "Codex(remote)", true),
    };
    const members = [
      { pubkey: SELF, role: "owner" as const },
      { pubkey: AGENT, role: "bot" as const },
    ];
    const mentions = resolveMentionPubkeys("@Codex(remote) fix it", members, profiles);
    const tags = buildMessageTags(
      CHANNEL,
      mentions,
      [
        {
          url: "https://relay.example/media/hash.png",
          sha256: "ab".repeat(32),
          size: 10,
          type: "image/png",
          uploaded: 0,
          filename: "shot.png",
        },
      ],
      { id: "44".repeat(32), rootId: "55".repeat(32) },
    );

    expect(tags).toContainEqual(["h", CHANNEL]);
    expect(tags).toContainEqual(["p", AGENT]);
    expect(tags).toContainEqual(["e", "55".repeat(32), "", "root"]);
    expect(tags).toContainEqual(["e", "44".repeat(32), "", "reply"]);
    const imeta = tags.find((tag) => tag[0] === "imeta");
    expect(imeta).toContain("m image/png");
    expect(imeta).toContain("filename shot.png");
    expect(imeta).not.toContain("name shot.png");
  });

  it("appends uploaded files as markdown without duplicating empty body", () => {
    expect(
      contentWithAttachments("", [
        {
          url: "https://relay.example/media/hash.pdf",
          sha256: "ab".repeat(32),
          size: 10,
          type: "application/pdf",
          uploaded: 0,
          filename: "runbook.pdf",
        },
      ]),
    ).toBe("[runbook.pdf](https://relay.example/media/hash.pdf)");
  });

  it("keeps agents addressed in DMs and throughout an agent thread", () => {
    const profiles = {
      [SELF]: fallbackProfile(SELF, "Owner"),
      [AGENT]: fallbackProfile(AGENT, "Codex(remote)", true),
      [RELAY]: fallbackProfile(RELAY, "Teammate"),
    };
    const stream = {
      id: CHANNEL,
      name: "general",
      description: "",
      topic: null,
      type: "stream" as const,
      visibility: "open" as const,
      archived: false,
      isMember: true,
      members: [
        { pubkey: SELF, role: "owner" as const },
        { pubkey: AGENT, role: "bot" as const },
        { pubkey: RELAY, role: "member" as const },
      ],
      participantPubkeys: [SELF, AGENT, RELAY],
    };
    const dm = { ...stream, type: "dm" as const, visibility: "private" as const };
    const rootEvent = event("d", 9, SELF, "@Codex(remote) investigate", [
      ["h", CHANNEL],
      ["p", AGENT],
    ]);
    const root = buildTimeline([rootEvent], [], SELF, {})[0];

    expect(messageRecipientPubkeys("Continue", dm, profiles, SELF)).toEqual([AGENT, RELAY]);
    expect(
      messageRecipientPubkeys(
        "Continue in the thread",
        stream,
        profiles,
        SELF,
        { authorPubkey: RELAY, rootId: rootEvent.id },
        [root],
      ),
    ).toEqual([AGENT]);
    expect(
      messageRecipientPubkeys("Reply directly", stream, profiles, SELF, {
        authorPubkey: AGENT,
        rootId: rootEvent.id,
      }),
    ).toEqual([AGENT]);
  });
});
