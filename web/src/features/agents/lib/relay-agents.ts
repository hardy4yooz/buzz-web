import { profileDisplayName } from "@/features/chat/lib/chat-model";
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

  return [...pubkeys]
    .map((pubkey): RelayAgent => {
      const event = latest.get(pubkey);
      let content: Record<string, unknown> = {};
      try {
        content = event ? (JSON.parse(event.content) as Record<string, unknown>) : {};
      } catch {
        content = {};
      }
      const profile = profiles[pubkey];
      const nameValue = content.display_name ?? content.name;
      const profileChannelIds = stringArray(content.channel_ids);
      const membershipChannelIds = channels
        .filter((channel) =>
          channel.members.some(
            (member) => member.pubkey.toLowerCase() === pubkey && member.role === "bot",
          ),
        )
        .map((channel) => channel.id);
      return {
        pubkey,
        name:
          (typeof nameValue === "string" && nameValue.trim()) ||
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
