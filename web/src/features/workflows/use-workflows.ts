import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  fetchWorkflowRuns,
  parseWorkflowDefinitions,
  type RunCursor,
  WORKFLOW_DEFINITION_FILTER,
  workflowDefinitionsQueryKey,
  workflowRunsQueryKey,
} from "@/features/workflows/workflow-api";
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
