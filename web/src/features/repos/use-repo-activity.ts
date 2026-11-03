import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { type NostrEvent, queryEvents } from "@/shared/lib/nostr-client";
import { getActiveSignerPubkey } from "@/shared/lib/nostr-signer";
import type { Repo } from "./use-repos";

/**
 * The Relay does not index `#a`, so the query is a bounded newest window and
 * events are joined to loaded repository announcements in the browser.
 */
export const REPO_ACTIVITY_LIMIT = 200;

const STATUS_KINDS = new Set([1630, 1631, 1632, 1633]);

export type RepoActivityKind = "issue" | "pull-request";
export type RepoActivityStatus = "open" | "merged" | "applied" | "closed" | "draft";

export interface RepoActivityItem {
  id: string;
  kind: RepoActivityKind;
  title: string;
  author: string;
  createdAt: number;
  status: RepoActivityStatus;
  /** Pubkey that published the accepted status event, null when no status was published. */
  statusAuthor: string | null;
  repoId: string;
  repoName: string;
}

export interface RepoActivity {
  issues: RepoActivityItem[];
  pullRequests: RepoActivityItem[];
  /** True when the Relay returned the full query window, so older activity may exist. */
  truncated: boolean;
  /**
   * False when the window was full or a root named a repository with no loaded
   * announcement, so an empty list does not prove that no activity exists.
   */
  complete: boolean;
}

/** Zero is only provable from a complete join; otherwise the count is unknown. */
export function activityCount(
  items: readonly RepoActivityItem[],
  complete: boolean,
): number | null {
  return items.length > 0 || complete ? items.length : null;
}

/** Without loaded announcements there is nothing to join, so the query stays off. */
export function activityQueryEnabled(
  enabled: boolean,
  viewer: string | null,
  repoCount: number,
): boolean {
  return enabled && !!viewer && repoCount > 0;
}

function tagValues(event: NostrEvent, name: string): string[] {
  if (!Array.isArray(event.tags)) return [];
  const values: string[] = [];
  for (const tag of event.tags) {
    if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === "string") values.push(tag[1]);
  }
  return values;
}

function getTag(event: NostrEvent, name: string): string | undefined {
  return tagValues(event, name)[0];
}

function repoKey(owner: string, id: string): string {
  return `${owner}\u0000${id}`;
}

/** Parse an `a` tag (`30617:<owner>:<d>`) without splitting a `d` value that contains colons. */
function parseAddress(value: string | undefined): { owner: string; id: string } | null {
  if (!value) return null;
  const [kind, owner, ...rest] = value.split(":");
  const id = rest.join(":");
  if (kind !== "30617" || !owner || !id) return null;
  return { owner, id };
}

function isUsableEvent(event: NostrEvent): boolean {
  return (
    typeof event.id === "string" &&
    event.id.length > 0 &&
    typeof event.pubkey === "string" &&
    event.pubkey.length > 0 &&
    Number.isFinite(event.created_at)
  );
}

function titleFor(event: NostrEvent): string {
  const subject = getTag(event, "subject")?.trim();
  if (subject) return subject;
  const content =
    typeof event.content === "string" ? event.content.replace(/\s+/g, " ").trim() : "";
  if (content) return content.length > 80 ? `${content.slice(0, 80)}…` : content;
  return `${event.id.slice(0, 12)}…`;
}

function statusFor(kind: number, rootKind: RepoActivityKind): RepoActivityStatus {
  if (kind === 1631) return rootKind === "issue" ? "applied" : "merged";
  if (kind === 1632) return "closed";
  if (kind === 1633) return "draft";
  return "open";
}

/**
 * Join issue/PR roots to loaded repository announcements, then apply only
 * status events published by the root author or the repository owner.
 * Anyone with write access can publish these kinds, so the status is a
 * client-side trust policy, not Relay-enforced moderation.
 */
export function buildRepoActivity(
  events: readonly NostrEvent[],
  repos: readonly Repo[],
): RepoActivity {
  const reposByAddress = new Map<string, Repo>();
  for (const repo of repos) reposByAddress.set(repoKey(repo.owner, repo.id), repo);

  const roots: Array<{ event: NostrEvent; repo: Repo; kind: RepoActivityKind }> = [];
  const rootsById = new Map<string, (typeof roots)[number]>();
  let unjoinedRoots = 0;
  for (const event of events) {
    if (event.kind !== 1618 && event.kind !== 1621) continue;
    if (!isUsableEvent(event)) continue;
    const address = parseAddress(getTag(event, "a"));
    if (!address) continue;
    const repo = reposByAddress.get(repoKey(address.owner, address.id));
    if (!repo) {
      unjoinedRoots += 1;
      continue;
    }
    const root = {
      event,
      repo,
      kind: event.kind === 1621 ? ("issue" as const) : ("pull-request" as const),
    };
    roots.push(root);
    rootsById.set(event.id, root);
  }

  const latestStatus = new Map<
    string,
    { kind: number; author: string; createdAt: number; id: string }
  >();
  for (const event of events) {
    if (!STATUS_KINDS.has(event.kind) || !isUsableEvent(event)) continue;
    const rootId = getTag(event, "e");
    if (!rootId) continue;
    const root = rootsById.get(rootId);
    if (!root) continue;
    if (event.pubkey !== root.event.pubkey && event.pubkey !== root.repo.owner) continue;
    const previous = latestStatus.get(rootId);
    const isNewer =
      !previous ||
      event.created_at > previous.createdAt ||
      (event.created_at === previous.createdAt && event.id < previous.id);
    if (isNewer) {
      latestStatus.set(rootId, {
        kind: event.kind,
        author: event.pubkey,
        createdAt: event.created_at,
        id: event.id,
      });
    }
  }

  const issues: RepoActivityItem[] = [];
  const pullRequests: RepoActivityItem[] = [];
  for (const root of roots) {
    const status = latestStatus.get(root.event.id);
    const item: RepoActivityItem = {
      id: root.event.id,
      kind: root.kind,
      title: titleFor(root.event),
      author: root.event.pubkey,
      createdAt: root.event.created_at,
      status: status ? statusFor(status.kind, root.kind) : "open",
      statusAuthor: status?.author ?? null,
      repoId: root.repo.id,
      repoName: root.repo.name,
    };
    if (root.kind === "issue") issues.push(item);
    else pullRequests.push(item);
  }

  const newestFirst = (left: RepoActivityItem, right: RepoActivityItem) =>
    right.createdAt - left.createdAt || left.id.localeCompare(right.id);
  issues.sort(newestFirst);
  pullRequests.sort(newestFirst);

  return {
    issues,
    pullRequests,
    truncated: events.length >= REPO_ACTIVITY_LIMIT,
    complete: events.length < REPO_ACTIVITY_LIMIT && unjoinedRoots === 0,
  };
}

async function fetchRepoActivity(relayUrl: string): Promise<NostrEvent[]> {
  return queryEvents(relayUrl, {
    kinds: [1618, 1621, 1630, 1631, 1632, 1633],
    limit: REPO_ACTIVITY_LIMIT,
  });
}

export function useRepoActivity({
  relayUrl,
  repos,
  enabled = true,
}: {
  relayUrl: string;
  repos: readonly Repo[];
  enabled?: boolean;
}) {
  const viewer = getActiveSignerPubkey();
  const select = useCallback((events: NostrEvent[]) => buildRepoActivity(events, repos), [repos]);

  return useQuery({
    queryKey: ["repo-activity", relayUrl, viewer ?? ""],
    queryFn: () => fetchRepoActivity(relayUrl),
    select,
    enabled: activityQueryEnabled(enabled, viewer, repos.length),
    staleTime: 60_000,
  });
}
