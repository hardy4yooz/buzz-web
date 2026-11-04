import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  fetchWorkflowRuns,
  parseWorkflowDefinitions,
  type RunCursor,
  WORKFLOW_DEFINITION_FILTER,
  WORKFLOW_DEFINITION_KIND,
  type WorkflowGate,
  workflowDefinitionsQueryKey,
  workflowGateAfterProbe,
  workflowRunsQueryKey,
} from "@/features/workflows/workflow-api";
import type { BuzzRelayClient } from "@/shared/api/relay-client";
import { queryEvents } from "@/shared/lib/nostr-client";

/**
 * Workflow reads are short-lived on purpose: `gcTime: 0` drops definitions and
 * run rows as soon as the tool closes, and every key carries the Relay plus the
 * active viewer so identities and Relays never share rows.
 */
export function useWorkflowDefinitions({
  relayUrl,
  viewerPubkey,
}: {
  relayUrl: string;
  viewerPubkey: string;
}) {
  return useQuery({
    queryKey: workflowDefinitionsQueryKey(relayUrl, viewerPubkey),
    queryFn: async () =>
      parseWorkflowDefinitions(await queryEvents(relayUrl, WORKFLOW_DEFINITION_FILTER)),
    enabled: Boolean(viewerPubkey),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

/**
 * A workflow definition the viewer can read is the only evidence that the Relay
 * hosts workflows; without one the tool would have nothing to show. The gate
 * re-probes on every (re)connect so a failed or stale probe cannot hide a
 * shipped feature for the rest of the session.
 */
export function useWorkflowGate({
  client,
  connected,
  demo,
}: {
  client: BuzzRelayClient | null;
  connected: boolean;
  demo: boolean;
}): WorkflowGate {
  const [gate, setGate] = useState<WorkflowGate>("checking");

  useEffect(() => {
    if (!client || demo) return;
    let cancelled = false;
    const probe = () => {
      void client
        .query({ kinds: [WORKFLOW_DEFINITION_KIND], limit: 1 })
        .then((events) => {
          if (!cancelled) setGate(workflowGateAfterProbe(events.length));
        })
        .catch(() => {
          if (!cancelled) setGate(workflowGateAfterProbe(null));
        });
    };
    const unsubscribe = client.onStateChange((connectionState) => {
      if (connectionState === "connected") probe();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, demo]);

  // A definition published mid-session is the only new evidence a connected
  // session can get, and waiting for a reconnect is not something a user does.
  // Watch the definition stream while the gate is unresolved and reveal the row
  // on the first definition. One subscription, torn down as soon as it answers:
  // no timers, no re-probe loop, and nothing to do once the gate is present.
  useEffect(() => {
    if (!client || demo || !connected) return;
    if (gate !== "absent" && gate !== "error") return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void client
      .subscribe({ kinds: [WORKFLOW_DEFINITION_KIND], limit: 1 }, () => {
        setGate("present");
      })
      .then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else stop = unsubscribe;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [client, connected, demo, gate]);

  return gate;
}

export function useWorkflowRuns({
  relayUrl,
  viewerPubkey,
  workflowId,
}: {
  relayUrl: string;
  viewerPubkey: string;
  workflowId: string;
}) {
  return useInfiniteQuery({
    queryKey: workflowRunsQueryKey(relayUrl, viewerPubkey, workflowId),
    queryFn: ({ pageParam }) => fetchWorkflowRuns(relayUrl, workflowId, { cursor: pageParam }),
    initialPageParam: null as RunCursor | null,
    getNextPageParam: (last) => (last.state === "ok" ? last.next : null) ?? undefined,
    enabled: Boolean(viewerPubkey) && Boolean(workflowId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}
