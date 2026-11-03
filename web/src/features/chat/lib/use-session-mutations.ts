import { useCallback, useRef } from "react";
import {
  buildMessageTags,
  fallbackProfile,
  isValidProfilePicture,
  mergeProfileMetadata,
  messageRecipientPubkeys,
  resolveMentionPubkeys,
} from "@/features/chat/lib/chat-model";
import type {
  AttachmentDescriptor,
  BuzzChannel,
  ChannelType,
  MemberRole,
  TimelineMessage,
  UserProfile,
} from "@/features/chat/lib/chat-types";
import { demoEvent, eventChannelId, mergeEvents } from "@/features/chat/lib/session-events";
import type { NostrEvent } from "@/shared/api/nostr-types";
import type { BuzzRelayClient } from "@/shared/api/relay-client";
import { t } from "@/shared/i18n";
import { signNostrEvent } from "@/shared/lib/nostr-signer";

export type CreateChannelInput = {
  name: string;
  description: string;
  type: Exclude<ChannelType, "dm">;
  visibility: "open" | "private";
};

export type ReplyTarget = { id: string; rootId: string; authorPubkey: string } | null;

type StateSetter<T> = React.Dispatch<React.SetStateAction<T>>;

export function useSessionMutations({
  client,
  demo,
  pubkey,
  channels,
  discoveredChannels,
  communityRole,
  selectedChannel,
  messages,
  profiles,
  setChannels,
  setDiscoveredChannels,
  setSelectedChannelId,
  setContentEvents,
  setAuxiliaryEvents,
  setDelivery,
  setProfiles,
  loadChannels,
  loadProfiles,
}: {
  client: BuzzRelayClient | null;
  demo: boolean;
  pubkey: string;
  channels: BuzzChannel[];
  discoveredChannels: BuzzChannel[];
  communityRole: MemberRole | null;
  selectedChannel: BuzzChannel | null;
  messages: TimelineMessage[];
  profiles: Record<string, UserProfile>;
  setChannels: StateSetter<BuzzChannel[]>;
  setDiscoveredChannels: StateSetter<BuzzChannel[]>;
  setSelectedChannelId: StateSetter<string | null>;
  setContentEvents: StateSetter<NostrEvent[]>;
  setAuxiliaryEvents: StateSetter<NostrEvent[]>;
  setDelivery: StateSetter<Record<string, "sending" | "failed">>;
  setProfiles: StateSetter<Record<string, UserProfile>>;
  loadChannels: () => Promise<void>;
  loadProfiles: (pubkeys: string[]) => Promise<void>;
}) {
  const reactionPending = useRef(new Set<string>());

  const sendMessage = useCallback(
    async (
      content: string,
      attachments: AttachmentDescriptor[],
      replyTarget: ReplyTarget = null,
    ) => {
      if (!selectedChannel || (!content.trim() && !attachments.length)) return;
      const recipients = messageRecipientPubkeys(
        content,
        selectedChannel,
        profiles,
        pubkey,
        replyTarget,
        messages,
      );
      const tags = buildMessageTags(selectedChannel.id, recipients, attachments, replyTarget);
      if (demo) {
        const event = demoEvent(
          crypto.randomUUID().replace(/-/g, ""),
          pubkey,
          selectedChannel.id,
          content,
          Math.floor(Date.now() / 1_000),
          tags.slice(1),
        );
        setContentEvents((current) => mergeEvents(current, [event]));
        return;
      }
      if (!client) throw new Error(t("error.relayClient"));
      const event = await signNostrEvent({ kind: 9, content, tags }, { requireActive: true });
      setContentEvents((current) => mergeEvents(current, [event]));
      setDelivery((current) => ({ ...current, [event.id]: "sending" }));
      try {
        await client.publishSigned(event);
        setDelivery((current) => {
          const next = { ...current };
          delete next[event.id];
          return next;
        });
      } catch (publishError) {
        setDelivery((current) => ({ ...current, [event.id]: "failed" }));
        throw publishError;
      }
    },
    [client, demo, messages, profiles, pubkey, selectedChannel, setContentEvents, setDelivery],
  );

  const addReaction = useCallback(
    async (message: TimelineMessage, emoji: string) => {
      const pendingKey = `${message.event.id}:${emoji}`;
      if (reactionPending.current.has(pendingKey)) return;
      reactionPending.current.add(pendingKey);
      try {
        const existing = message.reactions.find((reaction) => reaction.emoji === emoji);
        const reactionEventIds = existing?.currentUserEventIds ?? [];

        if (reactionEventIds.length) {
          for (const reactionEventId of reactionEventIds) {
            if (demo) {
              const deletion = demoEvent(
                crypto.randomUUID().replace(/-/g, ""),
                pubkey,
                eventChannelId(message.event),
                "",
                Math.floor(Date.now() / 1_000),
                [["e", reactionEventId]],
              );
              deletion.kind = 5;
              setAuxiliaryEvents((current) => mergeEvents(current, [deletion]));
              continue;
            }
            if (!client) throw new Error(t("error.relayClient"));
            const deletion = await signNostrEvent(
              { kind: 5, content: "", tags: [["e", reactionEventId]] },
              { requireActive: true },
            );
            setAuxiliaryEvents((current) => mergeEvents(current, [deletion]));
            try {
              await client.publishSigned(deletion);
            } catch (publishError) {
              setAuxiliaryEvents((current) => current.filter((event) => event.id !== deletion.id));
              throw publishError;
            }
          }
          return;
        }

        if (demo) {
          const event = demoEvent(
            crypto.randomUUID().replace(/-/g, ""),
            pubkey,
            eventChannelId(message.event),
            emoji,
            Math.floor(Date.now() / 1_000),
            [["e", message.event.id]],
          );
          event.kind = 7;
          setAuxiliaryEvents((current) => mergeEvents(current, [event]));
          return;
        }
        if (!client) throw new Error(t("error.relayClient"));
        const event = await signNostrEvent(
          { kind: 7, content: emoji, tags: [["e", message.event.id]] },
          { requireActive: true },
        );
        setAuxiliaryEvents((current) => mergeEvents(current, [event]));
        try {
          await client.publishSigned(event);
        } catch (publishError) {
          setAuxiliaryEvents((current) => current.filter((item) => item.id !== event.id));
          throw publishError;
        }
      } finally {
        reactionPending.current.delete(pendingKey);
      }
    },
    [client, demo, pubkey, setAuxiliaryEvents],
  );

  const editMessage = useCallback(
    async (message: TimelineMessage, content: string) => {
      const channelId = eventChannelId(message.event);
      if (!channelId || !content.trim()) return;
      const previousMentions = new Set(
        selectedChannel
          ? resolveMentionPubkeys(message.content, selectedChannel.members, profiles)
          : [],
      );
      const mentions = selectedChannel
        ? resolveMentionPubkeys(content, selectedChannel.members, profiles).filter(
            (mention) => !previousMentions.has(mention),
          )
        : [];
      const preservedTags = message.event.tags.filter(
        (tag) => tag[0] === "imeta" || tag[0] === "emoji",
      );
      const tags = [
        ["h", channelId],
        ["e", message.event.id],
        ...preservedTags,
        ...mentions.map((mention) => ["p", mention]),
      ];
      if (demo) {
        const event = demoEvent(
          crypto.randomUUID().replace(/-/g, ""),
          pubkey,
          channelId,
          content,
          Math.floor(Date.now() / 1_000),
          tags.slice(1),
        );
        event.kind = 40003;
        setAuxiliaryEvents((current) => mergeEvents(current, [event]));
        return;
      }
      if (!client) throw new Error(t("error.relayClient"));
      const event = await signNostrEvent({ kind: 40003, content, tags }, { requireActive: true });
      await client.publishSigned(event);
      setAuxiliaryEvents((current) => mergeEvents(current, [event]));
    },
    [client, demo, profiles, pubkey, selectedChannel, setAuxiliaryEvents],
  );

  const deleteMessage = useCallback(
    async (message: TimelineMessage) => {
      const channelId = eventChannelId(message.event);
      if (!channelId) return;
      const ownMessage = message.event.pubkey.toLowerCase() === pubkey.toLowerCase();
      const currentRole = selectedChannel?.members.find(
        (member) => member.pubkey.toLowerCase() === pubkey.toLowerCase(),
      )?.role;
      const canModerate =
        communityRole === "owner" ||
        communityRole === "admin" ||
        currentRole === "owner" ||
        currentRole === "admin";
      if (!ownMessage && !canModerate) throw new Error(t("error.messageDeletePermission"));
      const kind = ownMessage ? 5 : 9005;
      const tags = [
        ["h", channelId],
        ["e", message.event.id],
      ];
      if (demo) {
        const event = demoEvent(
          crypto.randomUUID().replace(/-/g, ""),
          pubkey,
          channelId,
          "",
          Math.floor(Date.now() / 1_000),
          tags.slice(1),
        );
        event.kind = kind;
        setAuxiliaryEvents((current) => mergeEvents(current, [event]));
        return;
      }
      if (!client) throw new Error(t("error.relayClient"));
      const event = await signNostrEvent({ kind, content: "", tags }, { requireActive: true });
      await client.publishSigned(event);
      setAuxiliaryEvents((current) => mergeEvents(current, [event]));
    },
    [client, communityRole, demo, pubkey, selectedChannel, setAuxiliaryEvents],
  );

  const createChannel = useCallback(
    async (input: CreateChannelInput): Promise<string> => {
      const id = crypto.randomUUID();
      if (demo) {
        const channel: BuzzChannel = {
          id,
          name: input.name.trim(),
          description: input.description.trim(),
          topic: null,
          type: input.type,
          visibility: input.visibility,
          archived: false,
          isMember: true,
          members: [{ pubkey, role: "owner" }],
          participantPubkeys: [pubkey],
        };
        setChannels((current) => [...current, channel]);
        setDiscoveredChannels((current) => [...current, channel]);
        setSelectedChannelId(id);
        return id;
      }
      if (!client) throw new Error(t("error.relayClient"));
      const tags: string[][] = [
        ["h", id],
        ["name", input.name.trim()],
        ["visibility", input.visibility],
        ["channel_type", input.type],
      ];
      if (input.description.trim()) tags.push(["about", input.description.trim()]);
      await client.publish({ kind: 9007, content: "", tags });
      await loadChannels();
      setSelectedChannelId(id);
      return id;
    },
    [client, demo, loadChannels, pubkey, setChannels, setDiscoveredChannels, setSelectedChannelId],
  );

  const joinChannel = useCallback(
    async (channelId: string) => {
      if (demo) {
        const channel = discoveredChannels.find((candidate) => candidate.id === channelId);
        if (!channel) return;
        const joined = {
          ...channel,
          isMember: true,
          members: [
            ...channel.members.filter((member) => member.pubkey !== pubkey),
            { pubkey, role: "member" as const },
          ],
          participantPubkeys: [...new Set([...channel.participantPubkeys, pubkey])],
        };
        setDiscoveredChannels((current) =>
          current.map((candidate) => (candidate.id === channelId ? joined : candidate)),
        );
        setChannels((current) =>
          current.some((candidate) => candidate.id === channelId)
            ? current.map((candidate) => (candidate.id === channelId ? joined : candidate))
            : [...current, joined],
        );
        setSelectedChannelId(channelId);
        return;
      }
      if (!client) throw new Error(t("error.relayClient"));
      await client.publish({ kind: 9021, content: "", tags: [["h", channelId]] });
      await loadChannels();
      setSelectedChannelId(channelId);
    },
    [
      client,
      demo,
      discoveredChannels,
      loadChannels,
      pubkey,
      setChannels,
      setDiscoveredChannels,
      setSelectedChannelId,
    ],
  );

  const setChannelArchived = useCallback(
    async (channelId: string, archived: boolean) => {
      if (demo) {
        const source =
          discoveredChannels.find((channel) => channel.id === channelId) ??
          channels.find((channel) => channel.id === channelId);
        setDiscoveredChannels((current) =>
          current.map((channel) => (channel.id === channelId ? { ...channel, archived } : channel)),
        );
        setChannels((current) =>
          archived
            ? current.filter((channel) => channel.id !== channelId)
            : current.some((channel) => channel.id === channelId)
              ? current.map((channel) =>
                  channel.id === channelId ? { ...channel, archived: false } : channel,
                )
              : source
                ? [...current, { ...source, archived: false }]
                : current,
        );
        if (archived) {
          setSelectedChannelId((current) =>
            current === channelId
              ? (channels.find((channel) => channel.id !== channelId)?.id ?? null)
              : current,
          );
        }
        return;
      }
      if (!client) throw new Error(t("error.relayClient"));
      await client.publish({
        kind: 9002,
        content: "",
        tags: [
          ["h", channelId],
          ["archived", archived ? "true" : "false"],
        ],
      });
      await loadChannels();
    },
    [
      channels,
      client,
      demo,
      discoveredChannels,
      loadChannels,
      setChannels,
      setDiscoveredChannels,
      setSelectedChannelId,
    ],
  );

  const setChannelMember = useCallback(
    async (channelId: string, memberPubkey: string, role: "admin" | "member" | "guest") => {
      if (!demo) {
        if (!client) throw new Error(t("error.relayClient"));
        await client.publish({
          kind: 9000,
          content: "",
          tags: [
            ["h", channelId],
            ["p", memberPubkey.toLowerCase()],
            ["role", role],
          ],
        });
        await loadChannels();
        return;
      }
      const normalizedMember = memberPubkey.toLowerCase();
      const update = (channel: BuzzChannel) => {
        if (channel.id !== channelId) return channel;
        const withoutTarget = channel.members.filter(
          (member) => member.pubkey.toLowerCase() !== normalizedMember,
        );
        return {
          ...channel,
          members: [...withoutTarget, { pubkey: normalizedMember, role }],
          participantPubkeys: [...new Set([...channel.participantPubkeys, normalizedMember])],
        };
      };
      setChannels((current) => current.map(update));
      setDiscoveredChannels((current) => current.map(update));
      await loadProfiles([normalizedMember]);
    },
    [client, demo, loadChannels, loadProfiles, setChannels, setDiscoveredChannels],
  );

  const removeChannelMember = useCallback(
    async (channelId: string, memberPubkey: string) => {
      const normalizedMember = memberPubkey.toLowerCase();
      if (!demo) {
        if (!client) throw new Error(t("error.relayClient"));
        await client.publish({
          kind: 9001,
          content: "",
          tags: [
            ["h", channelId],
            ["p", normalizedMember],
          ],
        });
        await loadChannels();
        return;
      }
      const update = (channel: BuzzChannel) =>
        channel.id === channelId
          ? {
              ...channel,
              members: channel.members.filter(
                (member) => member.pubkey.toLowerCase() !== normalizedMember,
              ),
              participantPubkeys: channel.participantPubkeys.filter(
                (candidate) => candidate.toLowerCase() !== normalizedMember,
              ),
            }
          : channel;
      setChannels((current) => current.map(update));
      setDiscoveredChannels((current) => current.map(update));
    },
    [client, demo, loadChannels, setChannels, setDiscoveredChannels],
  );

  const openDm = useCallback(
    async (targetPubkey: string): Promise<string> => {
      const normalizedTarget = targetPubkey.toLowerCase();
      if (demo) {
        const existing = channels.find(
          (channel) =>
            channel.type === "dm" &&
            channel.participantPubkeys.some(
              (participant) => participant.toLowerCase() === normalizedTarget,
            ),
        );
        if (existing) setSelectedChannelId(existing.id);
        return existing?.id ?? "";
      }
      if (!client) throw new Error(t("error.relayClient"));
      const requestedId = crypto.randomUUID();
      const result = await client.publish({
        kind: 41010,
        content: "",
        tags: [
          ["p", normalizedTarget],
          ["d", requestedId],
        ],
      });
      let channelId: string = requestedId;
      const responseJson = result.message.startsWith("response:")
        ? result.message.slice("response:".length)
        : "";
      try {
        const response = JSON.parse(responseJson) as { channel_id?: string };
        channelId = response.channel_id || channelId;
      } catch {
        // Older relay versions may not return structured response metadata.
      }
      await loadChannels();
      setSelectedChannelId(channelId);
      return channelId;
    },
    [channels, client, demo, loadChannels, setSelectedChannelId],
  );

  const updateProfile = useCallback(
    async (input: { name: string; about: string; picture: string }) => {
      const name = input.name.trim();
      if (!name) throw new Error(t("error.profileName"));
      const picture = input.picture.trim();
      if (!isValidProfilePicture(picture)) {
        throw new Error(t("error.profilePicture"));
      }
      const about = input.about.trim();
      let currentContent: string | undefined;
      if (!demo) {
        if (!client) throw new Error(t("error.relayClient"));
        const currentProfiles = await client.query({ kinds: [0], authors: [pubkey], limit: 10 });
        currentContent = currentProfiles
          .filter((event) => event.pubkey.toLowerCase() === pubkey.toLowerCase())
          .sort((left, right) =>
            left.created_at === right.created_at
              ? left.id.localeCompare(right.id)
              : right.created_at - left.created_at,
          )[0]?.content;
      }
      const content = mergeProfileMetadata(currentContent, { name, about, picture });
      if (!demo) {
        if (!client) throw new Error(t("error.relayClient"));
        await client.publish({ kind: 0, content, tags: [] });
      }
      setProfiles((current) => ({
        ...current,
        [pubkey.toLowerCase()]: {
          ...(current[pubkey.toLowerCase()] ?? fallbackProfile(pubkey)),
          name,
          about,
          picture: picture || null,
        },
      }));
    },
    [client, demo, pubkey, setProfiles],
  );

  return {
    sendMessage,
    addReaction,
    editMessage,
    deleteMessage,
    createChannel,
    joinChannel,
    setChannelArchived,
    setChannelMember,
    removeChannelMember,
    openDm,
    updateProfile,
  };
}
