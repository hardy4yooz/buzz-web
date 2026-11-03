import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { MemberRole } from "@/features/chat/lib/chat-types";
import {
  canViewModeration,
  fetchModerationAudit,
  fetchModerationReports,
  fetchModerationRestricted,
  type ModerationAction,
  type ModerationRead,
  type ModerationReport,
  type ModerationRestriction,
  type ModerationSection,
  moderationQueryKey,
} from "@/features/moderation/moderation-api";

/**
 * Moderation reads are short-lived on purpose: `gcTime: 0` drops the rows as
 * soon as the tool closes, so audit reasons never outlive the view, and the
 * key carries the Relay plus the active viewer so identities never share rows.
 */
function useModerationRead<T>({
  relayUrl,
  viewerPubkey,
  role,
  view,
  queryFn,
}: {
  relayUrl: string;
  viewerPubkey: string;
  role: MemberRole | null;
  view: ModerationSection;
  queryFn: () => Promise<ModerationRead<T>>;
}): UseQueryResult<ModerationRead<T>> {
  return useQuery({
    queryKey: moderationQueryKey(relayUrl, viewerPubkey, view),
    queryFn,
    enabled: canViewModeration(role),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useModerationReports(options: {
  relayUrl: string;
  viewerPubkey: string;
  role: MemberRole | null;
}): UseQueryResult<ModerationRead<ModerationReport>> {
  return useModerationRead({
    ...options,
    view: "reports",
    queryFn: () => fetchModerationReports(options.relayUrl),
  });
}

export function useModerationAudit(options: {
  relayUrl: string;
  viewerPubkey: string;
  role: MemberRole | null;
}): UseQueryResult<ModerationRead<ModerationAction>> {
  return useModerationRead({
    ...options,
    view: "audit",
    queryFn: () => fetchModerationAudit(options.relayUrl),
  });
}

export function useModerationRestricted(options: {
  relayUrl: string;
  viewerPubkey: string;
  role: MemberRole | null;
}): UseQueryResult<ModerationRead<ModerationRestriction>> {
  return useModerationRead({
    ...options,
    view: "restricted",
    queryFn: () => fetchModerationRestricted(options.relayUrl),
  });
}
