/**
 * React Query hooks for browsing git repos via isomorphic-git.
 *
 * All hooks depend on `useGitClone` which ensures the repo is shallow-cloned
 * into IndexedDB before any reads happen.
 */

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { resolveRef } from "isomorphic-git";
import { getActiveSignerPubkey } from "@/shared/lib/nostr-signer";
import {
  ensureClone,
  findReadme,
  getCommitLog,
  readBlobView,
  readTreeEntries,
  resolveHtmlAssets,
} from "./git-client";

type CloneData = Awaited<ReturnType<typeof ensureClone>>;

/**
 * The public shape every derived browse hook exposes.
 *
 * A clone-query rejection (initial denial or a denied background refetch)
 * must mask every derived result, including bytes React Query still retains
 * from an earlier success. Only the clone query's error remains visible.
 */
export interface GitBrowseResult<T> {
  data: T | undefined;
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
}

function browseResult<T>(
  query: UseQueryResult<T>,
  cloneQuery: UseQueryResult<CloneData>,
): GitBrowseResult<T> {
  if (cloneQuery.isError) {
    return { data: undefined, error: cloneQuery.error, isLoading: false, isFetching: false };
  }
  return {
    data: query.data,
    error: query.error,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
  };
}

/**
 * Ensure the repo is cloned (or fetched) into IndexedDB.
 * Other hooks depend on this to get `fs` and `dir`.
 */
export function useGitClone(relayUrl: string, owner: string, repoName: string, ref: string) {
  const viewer = getActiveSignerPubkey();

  return useQuery({
    queryKey: ["git-clone", relayUrl, viewer ?? "", owner, repoName, ref],
    queryFn: () => ensureClone(relayUrl, viewer ?? "", owner, repoName, ref),
    staleTime: 5 * 60_000,
    enabled: !!viewer && !!owner && !!repoName && !!ref,
    retry: false,
  });
}

/** Read tree entries at a path (or root). Directories first, then files, alphabetical. */
export function useGitTree(
  relayUrl: string,
  owner: string,
  repoName: string,
  ref: string,
  path?: string,
) {
  const viewer = getActiveSignerPubkey();
  const cloneQuery = useGitClone(relayUrl, owner, repoName, ref);

  const query = useQuery({
    queryKey: ["git-tree", relayUrl, viewer ?? "", owner, repoName, ref, path ?? ""],
    queryFn: async () => {
      if (!cloneQuery.data) throw new Error("unreachable: enabled guards data");
      const { fs, dir } = cloneQuery.data;
      const oid = await resolveRef({ fs, dir, ref });
      const entries = await readTreeEntries(fs, dir, oid, path || undefined);

      // Sort: directories first, then files, alphabetical within each group
      return entries.sort((a, b) => {
        if (a.type === "tree" && b.type !== "tree") return -1;
        if (a.type !== "tree" && b.type === "tree") return 1;
        return a.name.localeCompare(b.name);
      });
    },
    enabled: !!cloneQuery.data,
    staleTime: 5 * 60_000,
  });
  return browseResult(query, cloneQuery);
}

/** Get recent commits for the given ref. */
export function useGitLog(relayUrl: string, owner: string, repoName: string, ref: string) {
  const viewer = getActiveSignerPubkey();
  const cloneQuery = useGitClone(relayUrl, owner, repoName, ref);

  const query = useQuery({
    queryKey: ["git-log", relayUrl, viewer ?? "", owner, repoName, ref],
    queryFn: async () => {
      if (!cloneQuery.data) throw new Error("unreachable: enabled guards data");
      const { fs, dir } = cloneQuery.data;
      return getCommitLog(fs, dir, ref);
    },
    enabled: !!cloneQuery.data,
    staleTime: 5 * 60_000,
  });
  return browseResult(query, cloneQuery);
}

/** Find and read the README from the repo root. */
export function useGitReadme(relayUrl: string, owner: string, repoName: string, ref: string) {
  const viewer = getActiveSignerPubkey();
  const cloneQuery = useGitClone(relayUrl, owner, repoName, ref);

  const query = useQuery({
    queryKey: ["git-readme", relayUrl, viewer ?? "", owner, repoName, ref],
    queryFn: async () => {
      if (!cloneQuery.data) throw new Error("unreachable: enabled guards data");
      const { fs, dir } = cloneQuery.data;
      return findReadme(fs, dir, ref);
    },
    enabled: !!cloneQuery.data,
    staleTime: 5 * 60_000,
  });
  return browseResult(query, cloneQuery);
}

/** Read a single file's content as a classified `BlobView`. */
export function useGitBlob(
  relayUrl: string,
  owner: string,
  repoName: string,
  ref: string,
  filepath: string,
) {
  const viewer = getActiveSignerPubkey();
  const cloneQuery = useGitClone(relayUrl, owner, repoName, ref);

  const query = useQuery({
    queryKey: ["git-blob", relayUrl, viewer ?? "", owner, repoName, ref, filepath],
    queryFn: async () => {
      if (!cloneQuery.data) throw new Error("unreachable: enabled guards data");
      const { fs, dir } = cloneQuery.data;
      const oid = await resolveRef({ fs, dir, ref });
      return readBlobView(fs, dir, oid, filepath);
    },
    enabled: !!cloneQuery.data && !!filepath,
    staleTime: 5 * 60_000,
  });
  return browseResult(query, cloneQuery);
}

/**
 * Resolve an HTML file into a self-contained doc (relative assets inlined),
 * ready to drop into a sandboxed iframe. Lazy: `enabled` is caller-gated so
 * we only do the inlining work when the user clicks "Run". The decoded HTML
 * is passed in (the blob view already has it) to avoid a second read.
 */
export function useGitHtmlDoc(
  relayUrl: string,
  owner: string,
  repoName: string,
  ref: string,
  filepath: string,
  html: string,
  enabled: boolean,
) {
  const viewer = getActiveSignerPubkey();
  const cloneQuery = useGitClone(relayUrl, owner, repoName, ref);

  const query = useQuery({
    queryKey: ["git-html-doc", relayUrl, viewer ?? "", owner, repoName, ref, filepath],
    queryFn: async () => {
      if (!cloneQuery.data) throw new Error("unreachable: enabled guards data");
      const { fs, dir } = cloneQuery.data;
      const oid = await resolveRef({ fs, dir, ref });
      return resolveHtmlAssets(fs, dir, oid, filepath, html);
    },
    enabled: enabled && !!cloneQuery.data && !!filepath,
    staleTime: 5 * 60_000,
  });
  return browseResult(query, cloneQuery);
}
