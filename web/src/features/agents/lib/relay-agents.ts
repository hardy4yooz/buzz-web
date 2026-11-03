import { metadataDisplayName, profileDisplayName } from "@/features/chat/lib/chat-model";
import type { BuzzChannel, UserProfile } from "@/features/chat/lib/chat-types";
import type { NostrEvent } from "@/shared/api/nostr-types";
import type { ConfiguredAgent } from "@/shared/config/runtime-config";

export type AgentRespondTo = "owner-only" | "allowlist" | "anyone";

export type RelayAgent = {
  pubkey: string;
  name: string;
  agentType: string;
  about: string;
  channelIds: string[];
  capabilities: string[];
  status: "online" | "away" | "offline";
  respondTo: AgentRespondTo | null;
  respondToAllowlist: string[];
  startable: boolean;
};

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

function validStatus(value: unknown): RelayAgent["status"] {
  return value === "online" || value === "away" ? value : "offline";
}

function validRespondTo(value: unknown): AgentRespondTo | null {
  return value === "owner-only" || value === "allowlist" || value === "anyone" ? value : null;
}

function latestAgentEvents(events: readonly NostrEvent[]): Map<string, NostrEvent> {
  const latest = new Map<string, NostrEvent>();
  for (const event of events) {
    const pubkey = event.pubkey.toLowerCase();
    if ((latest.get(pubkey)?.created_at ?? 0) <= event.created_at) latest.set(pubkey, event);
  }
  return latest;
}

export function relayAgentsFromEvents({
  events,
  configuredAgents,
  channels,
  profiles,
  presence,
}: {
  events: readonly NostrEvent[];
  configuredAgents: readonly ConfiguredAgent[];
  channels: readonly BuzzChannel[];
  profiles: Readonly<Record<string, UserProfile>>;
  presence: Readonly<Record<string, RelayAgent["status"]>>;
}): RelayAgent[] {
  const latest = latestAgentEvents(events);
  const configured = new Map(configuredAgents.map((agent) => [agent.pubkey.toLowerCase(), agent]));
  const botPubkeys = channels.flatMap((channel) =>
    channel.members
      .filter((member) => member.role === "bot")
      .map((member) => member.pubkey.toLowerCase()),
  );
  const pubkeys = new Set([...latest.keys(), ...configured.keys(), ...botPubkeys]);
  const channelsByPubkey = new Map<string, string[]>();
  for (const channel of channels) {
    for (const member of channel.members) {
      const pubkey = member.pubkey.toLowerCase();
      const ids = channelsByPubkey.get(pubkey) ?? [];
      ids.push(channel.id);
      channelsByPubkey.set(pubkey, ids);
    }
  }

  return [...pubkeys]
    .map((pubkey): RelayAgent => {
      const event = latest.get(pubkey);
      let content: Record<string, unknown> = {};
      try {
        const parsed: unknown = event ? JSON.parse(event.content) : {};
        content =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
      } catch {
        content = {};
      }
      const profile = profiles[pubkey];
      const profileChannelIds = stringArray(content.channel_ids);
      const membershipChannelIds = channelsByPubkey.get(pubkey) ?? [];
      return {
        pubkey,
        name:
          metadataDisplayName(content) ||
          configured.get(pubkey)?.name ||
          profileDisplayName(profile, pubkey, true),
        agentType:
          typeof content.agent_type === "string" && content.agent_type.trim()
            ? content.agent_type.trim()
            : "agent",
        about: profile?.about ?? "",
        channelIds: [...new Set([...profileChannelIds, ...membershipChannelIds])],
        capabilities: stringArray(content.capabilities),
        status: presence[pubkey] ?? validStatus(content.status),
        respondTo: validRespondTo(content.respond_to),
        respondToAllowlist: stringArray(content.respond_to_allowlist).map((value) =>
          value.toLowerCase(),
        ),
        startable: configured.get(pubkey)?.startable === true,
      };
    })
    .sort(
      (left, right) =>
        Number(right.status === "online") - Number(left.status === "online") ||
        left.name.localeCompare(right.name),
    );
}
