import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_OBSERVER_FRAME_KIND,
  type AgentActivityItem,
  type AgentActivityStatus,
  AgentActivityStore,
  parseObserverFrame,
  unwrapObserverBatch,
  validateObserverEvent,
} from "@/features/chat/lib/agent-activity";
import type { NostrEvent, NostrFilter, RelayConnectionState } from "@/shared/api/nostr-types";
import type { BuzzRelayClient } from "@/shared/api/relay-client";
import {
  canDecryptNip44FromPeer,
  decryptNip44FromPeer,
  getActiveSignerPubkey,
} from "@/shared/lib/nostr-signer";

const MAX_OBSERVER_CIPHERTEXT_CHARS = 96_000;
const MAX_OBSERVER_PLAINTEXT_CHARS = 64_000;

export function observerActivityFilter(ownerPubkey: string): NostrFilter {
  return { kinds: [AGENT_OBSERVER_FRAME_KIND], "#p": [ownerPubkey], limit: 0 };
}

function ingestDemoActivity(
  store: AgentActivityStore,
  channelId: string,
  agentPubkeys: readonly string[],
): void {
  const receivedAt = Date.now();
  for (const [index, agentPubkey] of agentPubkeys.entries()) {
    const frame = parseObserverFrame({
      seq: receivedAt + index,
      timestamp: new Date(receivedAt + index).toISOString(),
      kind: "acp_read",
      channelId,
      sessionId: `demo-session-${channelId}`,
      turnId: `demo-turn-${receivedAt}`,
      payload: {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            status: "completed",
            title: "shell",
            rawInput: { command: "npm test -- --runInBand" },
          },
        },
      },
    });
    if (frame) store.ingest(agentPubkey, frame, receivedAt + index);
  }
}

export function useLiveAgentActivity({
  client,
  demo,
  knownAgentPubkeys,
  ownerPubkey,
}: {
  client: BuzzRelayClient | null;
  demo: boolean;
  knownAgentPubkeys: readonly string[];
  ownerPubkey: string;
}): {
  available: boolean;
  connection: RelayConnectionState;
  healthy: boolean;
  markSubmitted: (channelId: string, agentPubkeys: readonly string[]) => void;
  statusesFor: (channelId: string, agentPubkeys: readonly string[]) => AgentActivityStatus[];
  itemsFor: (channelId: string, agentPubkeys: readonly string[]) => AgentActivityItem[];
} {
  const storeIdentity = `${client?.relayUrl ?? "demo"}|${ownerPubkey.toLowerCase()}`;
  const storeRef = useRef<{ identity: string; store: AgentActivityStore } | null>(null);
  if (storeRef.current?.identity !== storeIdentity) {
    storeRef.current = { identity: storeIdentity, store: new AgentActivityStore() };
  }
  const store = storeRef.current.store;
  const [connection, setConnection] = useState<RelayConnectionState>(demo ? "connected" : "idle");
  const [version, setVersion] = useState(0);
  const knownAgentKey = [...new Set(knownAgentPubkeys.map((value) => value.toLowerCase()))]
    .sort()
    .join(",");
  const knownAgents = useMemo(
    () => new Set(knownAgentKey ? knownAgentKey.split(",") : []),
    [knownAgentKey],
  );
  const available =
    demo ||
    (canDecryptNip44FromPeer() &&
      getActiveSignerPubkey()?.toLowerCase() === ownerPubkey.toLowerCase());
  const processing = useRef(Promise.resolve());

  useEffect(() => {
    if (demo) {
      setConnection("connected");
      return;
    }
    if (!client || !available) {
      setConnection("idle");
      return;
    }
    return client.onStateChange((state) => {
      if (state === "connected") {
        setConnection((current) => (current === "connected" ? current : "connecting"));
      } else {
        setConnection(state);
      }
    });
  }, [available, client, demo]);

  useEffect(() => {
    if (!client || demo || !available || knownAgents.size === 0) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    const handleEvent = (event: NostrEvent) => {
      processing.current = processing.current
        .then(async () => {
          if (cancelled) return;
          const agentPubkey = validateObserverEvent(event, ownerPubkey, knownAgents);
          if (!agentPubkey) return;
          if (event.content.length > MAX_OBSERVER_CIPHERTEXT_CHARS) return;
          try {
            const plaintext = await decryptNip44FromPeer(agentPubkey, event.content);
            if (cancelled) return;
            if (plaintext.length > MAX_OBSERVER_PLAINTEXT_CHARS) return;
            const parsed = parseObserverFrame(JSON.parse(plaintext));
            if (!parsed) return;
            for (const frame of unwrapObserverBatch(parsed)) {
              if (store.ingest(agentPubkey, frame)) setVersion((current) => current + 1);
            }
            setConnection("connected");
          } catch {
            // Observer payloads are private and untrusted. Invalid/decrypt-failed frames are ignored.
          }
        })
        .catch(() => undefined);
    };
    setConnection("connecting");
    void client
      .subscribe(observerActivityFilter(ownerPubkey), handleEvent, {
        onClosed: () => {
          if (!cancelled) setConnection("disconnected");
        },
        onEose: () => {
          if (!cancelled) setConnection("connected");
        },
        onRetry: () => {
          if (!cancelled) setConnection("reconnecting");
        },
      })
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unsubscribe = cleanup;
      })
      .catch(() => {
        if (!cancelled) setConnection("disconnected");
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [available, client, demo, knownAgents, ownerPubkey, store]);

  useEffect(() => {
    const timer = window.setInterval(() => setVersion((current) => current + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const markSubmitted = useCallback(
    (channelId: string, agentPubkeys: readonly string[]) => {
      store.markSubmitted(channelId, agentPubkeys);
      if (demo) ingestDemoActivity(store, channelId, agentPubkeys);
      setVersion((current) => current + 1);
    },
    [demo, store],
  );

  const statusesFor = useCallback(
    (channelId: string, agentPubkeys: readonly string[]) => {
      void version;
      return store.getStatuses(channelId, agentPubkeys, connection, available);
    },
    [available, connection, store, version],
  );

  const itemsFor = useCallback(
    (channelId: string, agentPubkeys: readonly string[]) => {
      void version;
      return store.getItems(channelId, agentPubkeys);
    },
    [store, version],
  );

  return useMemo(
    () => ({
      available,
      connection,
      healthy: available && connection === "connected",
      itemsFor,
      markSubmitted,
      statusesFor,
    }),
    [available, connection, itemsFor, markSubmitted, statusesFor],
  );
}
