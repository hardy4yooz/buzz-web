import { useQuery } from "@tanstack/react-query";
import { type NostrEvent, queryEvents } from "@/shared/lib/nostr-client";
import { getActiveSignerPubkey } from "@/shared/lib/nostr-signer";
import { dedup } from "./use-repos";

export interface RepoRefs {
  branches: string[];
  tags: string[];
  head: { ref: string; sha: string } | null;
}

function parseRefs(events: NostrEvent[]): RepoRefs {
  const latest = dedup(events);
  const branches: string[] = [];
  const tags: string[] = [];
  let head: RepoRefs["head"] = null;

  for (const event of latest) {
    for (const tag of event.tags) {
      const [name, value] = tag;
      if (!name || !value) continue;

      if (name === "HEAD" && value.startsWith("ref: refs/heads/")) {
        // HEAD points to a branch ref — find its SHA from a matching branch tag
        const branchName = value.replace("ref: refs/heads/", "");
        head = { ref: branchName, sha: "" };
      } else if (name.startsWith("refs/heads/")) {
        branches.push(name.replace("refs/heads/", ""));
      } else if (name.startsWith("refs/tags/")) {
        tags.push(name.replace("refs/tags/", ""));
      }
    }
  }

  // Resolve HEAD SHA from the matching branch
  if (head) {
    for (const event of latest) {
      for (const tag of event.tags) {
        if (tag[0] === `refs/heads/${head.ref}` && tag[1]) {
          head = { ref: head.ref, sha: tag[1] };
          break;
        }
      }
      if (head.sha) break;
    }
  }

  return { branches, tags, head };
}

async function fetchRepoRefs(relayUrl: string, repoId: string): Promise<RepoRefs> {
  // TODO: Filter by `authors: [relayPubkey]` once the relay's own pubkey is
  // exposed to the client. Without this, a user with ReposWrite permission
  // could publish fake kind:30618 events with spoofed refs.
  const events = await queryEvents(relayUrl, {
    kinds: [30618],
    "#d": [repoId],
  });
  return parseRefs(events);
}

export function useRepoRefs(
  repoId: string,
  { relayUrl, preview = false }: { relayUrl: string; preview?: boolean },
) {
  const mockRefs: RepoRefs = {
    branches: ["main"],
    tags: ["v0.1.0"],
    head: { ref: "main", sha: "a".repeat(40) },
  };
  const viewer = getActiveSignerPubkey();

  return useQuery({
    queryKey: preview
      ? ["repo-refs", "mock", repoId]
      : ["repo-refs", relayUrl, viewer ?? "", repoId],
    queryFn: preview ? async () => mockRefs : () => fetchRepoRefs(relayUrl, repoId),
    initialData: preview ? mockRefs : undefined,
    enabled: preview || !!viewer,
    staleTime: 60_000,
  });
}
