import type {
  AttachmentDescriptor,
  BuzzChannel,
  ChannelMember,
  ChannelType,
  MemberRole,
  TimelineMessage,
  UserProfile,
} from "@/features/chat/lib/chat-types";
import type { NostrEvent } from "@/shared/api/nostr-types";
import { t } from "@/shared/i18n";
import { truncatePubkey } from "@/shared/lib/pubkey";

export const TIMELINE_KINDS = [9, 40002, 40008, 40099, 43001, 43002, 43003, 43004, 43005, 43006];
export const AUXILIARY_KINDS = [5, 7, 9005, 40003];

const SYSTEM_MESSAGE_TYPES = [
  "member_joined",
  "member_left",
  "member_removed",
  "topic_changed",
  "purpose_changed",
  "channel_created",
  "channel_archived",
  "channel_unarchived",
  "message_deleted",
] as const;

export type SystemMessagePayload = {
  type: (typeof SYSTEM_MESSAGE_TYPES)[number];
  actor?: string;
  target?: string;
  topic?: string;
  purpose?: string;
  publicReason?: string;
};

export type SystemMessagePresentation = {
  identityPubkey: string | null;
  title: string;
  action: string;
};

function normalizedPubkey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : undefined;
}

function isSystemMessageType(value: unknown): value is SystemMessagePayload["type"] {
  return typeof value === "string" && (SYSTEM_MESSAGE_TYPES as readonly string[]).includes(value);
}

/** Parse only relay-signed timeline system events; ordinary JSON messages stay ordinary messages. */
export function parseSystemMessagePayload(event: NostrEvent): SystemMessagePayload | null {
  if (event.kind !== 40099) return null;
  try {
    const value = JSON.parse(event.content) as Record<string, unknown>;
    if (!value || typeof value !== "object" || !isSystemMessageType(value.type)) return null;
    return {
      type: value.type,
      actor: normalizedPubkey(value.actor),
      target: normalizedPubkey(value.target),
      topic: typeof value.topic === "string" ? value.topic : undefined,
      purpose: typeof value.purpose === "string" ? value.purpose : undefined,
      publicReason:
        typeof value.public_reason === "string" && value.public_reason.trim()
          ? value.public_reason.trim()
          : undefined,
    };
  } catch {
    return null;
  }
}

export function systemMessagePubkeys(event: NostrEvent): string[] {
  const payload = parseSystemMessagePayload(event);
  return payload
    ? [
        ...new Set(
          [payload.actor, payload.target].filter((value): value is string => Boolean(value)),
        ),
      ]
    : [];
}

function systemIdentityLabel(
  pubkey: string | undefined,
  currentPubkey: string,
  profiles: Record<string, UserProfile>,
): string {
  if (!pubkey) return t("system.system");
  if (pubkey === currentPubkey.toLowerCase()) return t("system.you");
  return profiles[pubkey]?.name || truncatePubkey(pubkey);
}

/** Match Desktop's human-readable treatment of kind:40099 system rows. */
export function describeSystemMessage(
  event: NostrEvent,
  currentPubkey: string,
  profiles: Record<string, UserProfile>,
): SystemMessagePresentation | null {
  const payload = parseSystemMessagePayload(event);
  if (!payload) return null;
  const actorLabel = systemIdentityLabel(payload.actor, currentPubkey, profiles);
  const targetLabel = systemIdentityLabel(payload.target, currentPubkey, profiles);

  switch (payload.type) {
    case "member_joined":
      if (!payload.actor || !payload.target) return null;
      return payload.actor === payload.target
        ? { identityPubkey: payload.target, title: targetLabel, action: t("system.joined") }
        : {
            identityPubkey: payload.target,
            title: targetLabel,
            action: t("system.addedBy", { actor: actorLabel }),
          };
    case "member_left":
      if (!payload.actor) return null;
      return { identityPubkey: payload.actor, title: actorLabel, action: t("system.left") };
    case "member_removed":
      if (!payload.actor || !payload.target) return null;
      return {
        identityPubkey: payload.actor,
        title: actorLabel,
        action: t("system.removed", { target: targetLabel }),
      };
    case "topic_changed":
      if (!payload.actor) return null;
      return {
        identityPubkey: payload.actor,
        title: actorLabel,
        action: t("system.topicChanged", { topic: payload.topic ?? "" }),
      };
    case "purpose_changed":
      if (!payload.actor) return null;
      return {
        identityPubkey: payload.actor,
        title: actorLabel,
        action: t("system.purposeChanged", { purpose: payload.purpose ?? "" }),
      };
    case "channel_created":
      if (!payload.actor) return null;
      return {
        identityPubkey: payload.actor,
        title: actorLabel,
        action: t("system.channelCreated"),
      };
    case "channel_archived":
      if (!payload.actor) return null;
      return { identityPubkey: payload.actor, title: actorLabel, action: t("system.archived") };
    case "channel_unarchived":
      if (!payload.actor) return null;
      return { identityPubkey: payload.actor, title: actorLabel, action: t("system.unarchived") };
    case "message_deleted":
      if (payload.publicReason) {
        return {
          identityPubkey: payload.actor ?? null,
          title: t("system.communityAdmin"),
          action: payload.publicReason,
        };
      }
      if (!payload.actor) return null;
      return {
        identityPubkey: payload.actor,
        title: actorLabel,
        action: t("system.deletedMessage"),
      };
  }
}

export function tagValue(event: NostrEvent, name: string): string | null {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

export function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((tag) => tag[0] === name && tag[1]).map((tag) => tag[1]);
}

function hasSingleTag(event: NostrEvent, name: string): boolean {
  return event.tags.some((tag) => tag.length === 1 && tag[0] === name);
}

function normalizeRole(value: string | undefined): MemberRole {
  return value === "owner" || value === "admin" || value === "guest" || value === "bot"
    ? value
    : "member";
}

export function membersFromEvent(event: NostrEvent | undefined): ChannelMember[] {
  if (!event) return [];
  return event.tags
    .filter((tag) => tag[0] === "p" && /^[0-9a-f]{64}$/i.test(tag[1] ?? ""))
    .map((tag) => ({
      pubkey: tag[1].toLowerCase(),
      role: normalizeRole(tag[3] || (tag[2] && tag[2] !== "" ? tag[2] : undefined)),
    }));
}

export function channelFromEvents(
  metadata: NostrEvent,
  membership: NostrEvent | undefined,
  currentPubkey?: string,
): BuzzChannel | null {
  const id = tagValue(metadata, "d");
  if (!id) return null;
  const typeTag = tagValue(metadata, "t");
  const type: ChannelType = typeTag === "dm" || typeTag === "forum" ? typeTag : "stream";
  const members = membersFromEvent(membership);
  const participants = [
    ...new Set([...tagValues(metadata, "p"), ...members.map((member) => member.pubkey)]),
  ];
  const normalizedCurrent = currentPubkey?.toLowerCase();
  return {
    id,
    name: tagValue(metadata, "name") || (type === "dm" ? "Direct message" : "channel"),
    description: tagValue(metadata, "about") || "",
    topic: tagValue(metadata, "topic"),
    type,
    visibility: hasSingleTag(metadata, "private") ? "private" : "open",
    archived: tagValue(metadata, "archived") === "true",
    isMember: normalizedCurrent
      ? members.some((member) => member.pubkey === normalizedCurrent) ||
        (type === "dm" && participants.includes(normalizedCurrent))
      : Boolean(membership),
    members,
    participantPubkeys: participants,
  };
}

export function parseCommunityRole(
  event: NostrEvent | undefined,
  pubkey: string,
): MemberRole | null {
  const tag = event?.tags.find(
    (candidate) =>
      candidate[0] === "member" && candidate[1]?.toLowerCase() === pubkey.toLowerCase(),
  );
  return tag ? normalizeRole(tag[2]) : null;
}

export function fallbackProfile(pubkey: string, name?: string, isAgent = false): UserProfile {
  return {
    pubkey: pubkey.toLowerCase(),
    name: name || truncatePubkey(pubkey),
    about: "",
    picture: null,
    isAgent,
  };
}

export function profilesFromEvents(
  events: NostrEvent[],
  agentPubkeys: ReadonlySet<string>,
): Record<string, UserProfile> {
  const latest = new Map<string, NostrEvent>();
  for (const event of events) {
    const pubkey = event.pubkey.toLowerCase();
    if ((latest.get(pubkey)?.created_at ?? 0) <= event.created_at) latest.set(pubkey, event);
  }
  const profiles: Record<string, UserProfile> = {};
  for (const [pubkey, event] of latest) {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(event.content) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    const profile = fallbackProfile(pubkey, undefined, agentPubkeys.has(pubkey));
    const displayName = metadata.display_name ?? metadata.displayName ?? metadata.name;
    profiles[pubkey] = {
      ...profile,
      name:
        typeof displayName === "string" && displayName.trim() ? displayName.trim() : profile.name,
      about: typeof metadata.about === "string" ? metadata.about : "",
      picture: typeof metadata.picture === "string" && metadata.picture ? metadata.picture : null,
    };
  }
  return profiles;
}

export function isValidProfilePicture(picture: string): boolean {
  const value = picture.trim();
  if (!value) return true;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function mergeProfileMetadata(
  currentContent: string | undefined,
  input: { name: string; about: string; picture: string },
): string {
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(currentContent ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
  return JSON.stringify({
    ...current,
    display_name: input.name,
    name: input.name,
    about: input.about,
    picture: input.picture,
  });
}

export function channelDisplayName(
  channel: BuzzChannel,
  profiles: Record<string, UserProfile>,
  currentPubkey: string,
): string {
  if (channel.type !== "dm") return channel.name;
  const names = channel.participantPubkeys
    .filter((pubkey) => pubkey.toLowerCase() !== currentPubkey.toLowerCase())
    .map((pubkey) => profiles[pubkey.toLowerCase()]?.name)
    .filter((name): name is string => Boolean(name));
  return names.length ? names.join(", ") : channel.name;
}

export function threadReference(event: NostrEvent): {
  rootId: string | null;
  parentId: string | null;
} {
  const root = event.tags.find((tag) => tag[0] === "e" && tag[3] === "root")?.[1] ?? null;
  const reply = event.tags.find((tag) => tag[0] === "e" && tag[3] === "reply")?.[1] ?? null;
  return { rootId: root ?? reply, parentId: reply };
}

function referencedEventId(event: NostrEvent): string | null {
  return event.tags.find((tag) => tag[0] === "e")?.[1] ?? null;
}

function referencedEventIds(event: NostrEvent): string[] {
  return event.tags.filter((tag) => tag[0] === "e" && Boolean(tag[1])).map((tag) => tag[1]);
}

function eventMentionPubkeys(event: NostrEvent): string[] {
  return event.tags
    .filter((tag) => tag[0] === "p" || tag[0] === "mention")
    .map((tag) => normalizedPubkey(tag[1]))
    .filter((pubkey): pubkey is string => Boolean(pubkey));
}

export function buildTimeline(
  contentEvents: NostrEvent[],
  auxiliaryEvents: NostrEvent[],
  currentPubkey: string,
  delivery: Readonly<Record<string, "sending" | "failed">>,
): TimelineMessage[] {
  const deleted = new Set(
    auxiliaryEvents
      .filter((event) => event.kind === 5 || event.kind === 9005)
      .flatMap(referencedEventIds),
  );
  const edits = new Map<string, NostrEvent>();
  const editMentionPubkeys = new Map<string, Set<string>>();
  const reactions = new Map<string, NostrEvent[]>();
  const orderedAuxiliaryEvents = [...auxiliaryEvents].sort((left, right) =>
    left.created_at === right.created_at
      ? left.id.localeCompare(right.id)
      : left.created_at - right.created_at,
  );
  for (const event of orderedAuxiliaryEvents) {
    if (deleted.has(event.id)) continue;
    const target = referencedEventId(event);
    if (!target) continue;
    if (
      event.kind === 40003 &&
      !deleted.has(target) &&
      (edits.get(target)?.created_at ?? 0) <= event.created_at
    ) {
      edits.set(target, event);
    }
    if (event.kind === 40003 && !deleted.has(target)) {
      const mentions = editMentionPubkeys.get(target) ?? new Set<string>();
      for (const pubkey of eventMentionPubkeys(event)) mentions.add(pubkey);
      editMentionPubkeys.set(target, mentions);
    }
    if (event.kind === 7) reactions.set(target, [...(reactions.get(target) ?? []), event]);
  }

  return contentEvents
    .filter((event) => TIMELINE_KINDS.includes(event.kind))
    .map((event) => {
      const isDeleted = deleted.has(event.id);
      const grouped = new Map<string, Map<string, string[]>>();
      for (const reaction of reactions.get(event.id) ?? []) {
        const actors = grouped.get(reaction.content) ?? new Map<string, string[]>();
        const actor = reaction.pubkey.toLowerCase();
        actors.set(actor, [...(actors.get(actor) ?? []), reaction.id]);
        grouped.set(reaction.content, actors);
      }
      const refs = threadReference(event);
      const mentionPubkeys = new Set(eventMentionPubkeys(event));
      for (const pubkey of editMentionPubkeys.get(event.id) ?? []) mentionPubkeys.add(pubkey);
      return {
        event,
        content: isDeleted ? "" : (edits.get(event.id)?.content ?? event.content),
        mentionPubkeys: isDeleted ? [] : [...mentionPubkeys],
        ...refs,
        reactions: isDeleted
          ? []
          : [...grouped.entries()].map(([emoji, actors]) => ({
              emoji,
              count: actors.size,
              reactedByMe: actors.has(currentPubkey),
              currentUserEventIds: actors.get(currentPubkey) ?? [],
            })),
        edited: !isDeleted && edits.has(event.id),
        deleted: isDeleted,
        delivery: delivery[event.id] ?? "sent",
      } satisfies TimelineMessage;
    })
    .sort((left, right) =>
      left.event.created_at === right.event.created_at
        ? left.event.id.localeCompare(right.event.id)
        : left.event.created_at - right.event.created_at,
    );
}

export function resolveMentionPubkeys(
  content: string,
  members: ChannelMember[],
  profiles: Record<string, UserProfile>,
): string[] {
  const lower = content.toLocaleLowerCase();
  return members
    .filter((member) => {
      const name = profiles[member.pubkey]?.name.trim().toLocaleLowerCase();
      return name ? lower.includes(`@${name}`) : false;
    })
    .map((member) => member.pubkey);
}

export function messageRecipientPubkeys(
  content: string,
  channel: BuzzChannel,
  profiles: Record<string, UserProfile>,
  senderPubkey: string,
  replyTo?: { authorPubkey: string; rootId: string } | null,
  messages: readonly TimelineMessage[] = [],
): string[] {
  const candidates = resolveMentionPubkeys(content, channel.members, profiles);
  const channelAgents = new Set(
    channel.members
      .filter((member) => member.role === "bot")
      .map((member) => member.pubkey.toLowerCase()),
  );
  const isAgent = (pubkey: string) =>
    profiles[pubkey.toLowerCase()]?.isAgent === true || channelAgents.has(pubkey.toLowerCase());

  if (channel.type === "dm") {
    candidates.push(
      ...channel.members.map((member) => member.pubkey),
      ...channel.participantPubkeys,
    );
  }

  if (replyTo) {
    const replyAuthor = replyTo.authorPubkey.toLowerCase();
    if (isAgent(replyAuthor)) candidates.push(replyAuthor);

    const root = messages.find((message) => message.event.id === replyTo.rootId);
    if (root?.event.pubkey.toLowerCase() === senderPubkey.toLowerCase()) {
      for (const pubkey of tagValues(root.event, "p")) {
        const normalized = pubkey.toLowerCase();
        if (isAgent(normalized)) candidates.push(normalized);
      }
    }
  }

  const sender = senderPubkey.toLowerCase();
  return [...new Set(candidates.map((pubkey) => pubkey.toLowerCase()))].filter(
    (pubkey) => /^[0-9a-f]{64}$/.test(pubkey) && pubkey !== sender,
  );
}

export function buildMessageTags(
  channelId: string,
  mentions: string[],
  attachments: AttachmentDescriptor[],
  replyTo?: { id: string; rootId: string } | null,
): string[][] {
  const tags: string[][] = [["h", channelId]];
  if (replyTo) {
    if (replyTo.rootId !== replyTo.id) tags.push(["e", replyTo.rootId, "", "root"]);
    tags.push(["e", replyTo.id, "", "reply"]);
  }
  for (const pubkey of [...new Set(mentions)]) tags.push(["p", pubkey]);
  for (const descriptor of attachments) {
    const tag = [
      "imeta",
      `url ${descriptor.url}`,
      `m ${descriptor.type}`,
      `x ${descriptor.sha256}`,
      `size ${descriptor.size}`,
    ];
    if (descriptor.dim) tag.push(`dim ${descriptor.dim}`);
    if (descriptor.blurhash) tag.push(`blurhash ${descriptor.blurhash}`);
    if (descriptor.thumb) tag.push(`thumb ${descriptor.thumb}`);
    if (descriptor.duration !== undefined) tag.push(`duration ${descriptor.duration}`);
    if (descriptor.filename) tag.push(`filename ${descriptor.filename}`);
    tags.push(tag);
  }
  return tags;
}

export function contentWithAttachments(
  content: string,
  attachments: AttachmentDescriptor[],
): string {
  const lines = attachments.map((attachment) => {
    const label = (attachment.filename || "attachment").replace(/\[|\]/g, "");
    return attachment.type.startsWith("image/")
      ? `![${label}](${attachment.url})`
      : `[${label}](${attachment.url})`;
  });
  return [content.trim(), ...lines].filter(Boolean).join("\n\n");
}
