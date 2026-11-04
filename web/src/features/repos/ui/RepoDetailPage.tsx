import { Link, useParams } from "@tanstack/react-router";
import {
  BookMarked,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  MessageSquare,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AuthenticatedRoute } from "@/features/chat/ui/AuthenticatedRoute";
import { t } from "@/shared/i18n";
import { relativeTime } from "@/shared/lib/relative-time";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  getMockRepo,
  mockRepoCommits,
  mockRepoPreviewEnabled,
  mockRepoReadme,
  mockRepoTree,
} from "../mock-repos";
import { useGitLog, useGitReadme, useGitTree } from "../use-git-browse";
import { useRepoRefs } from "../use-repo-refs";
import { useRepo } from "../use-repos";
import { ConnectButton } from "./ConnectButton";
import { PubkeyAvatar } from "./PubkeyAvatar";
import { RepoContentTabs } from "./RepoContentTabs";
import { RepoRefsSection } from "./RepoRefsSection";

function CopyableUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success(t("common.copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("error.clipboard"));
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2">
      <code className="min-w-0 flex-1 truncate text-sm text-foreground">{url}</code>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={t("repos.copyClone")}
      >
        {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex w-full flex-1 gap-8 bg-background px-4 py-8">
      <div className="min-w-0 flex-1">
        <div className="h-5 w-24 animate-pulse rounded bg-black/10 dark:bg-white/10" />
        <div className="mt-6 h-8 w-64 animate-pulse rounded bg-black/10 dark:bg-white/10" />
        <div className="mt-3 h-5 w-96 animate-pulse rounded bg-black/10 dark:bg-white/10" />
        <div className="mt-8 space-y-3">
          <div className="h-4 w-32 animate-pulse rounded bg-black/10 dark:bg-white/10" />
          <div className="h-10 w-full animate-pulse rounded bg-black/10 dark:bg-white/10" />
        </div>
      </div>
      <aside className="hidden w-72 shrink-0 lg:block" />
    </div>
  );
}

function RepositoryBreadcrumb({
  name,
  mockPreview = false,
}: {
  name: string;
  mockPreview?: boolean;
}) {
  return (
    <nav aria-label={t("repos.breadcrumb")} className="flex min-w-0 items-center gap-1.5 text-sm">
      <Link
        className="shrink-0 text-muted-foreground hover:text-foreground"
        search={mockPreview ? { preview: "repositories" } : undefined}
        to="/repos"
      >
        {t("repos.title")}
      </Link>
      <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span aria-current="page" className="truncate font-medium">
        {name}
      </span>
    </nav>
  );
}

export function RepoDetailPage({ relayUrl }: { relayUrl: string }) {
  const { repoId } = useParams({ from: "/repos/$repoId" });
  const preview =
    mockRepoPreviewEnabled &&
    new URLSearchParams(window.location.search).get("preview") === "repositories";
  const mockRepo = preview ? getMockRepo(repoId) : undefined;
  const showMockRepo = Boolean(mockRepo);
  const {
    data: repo,
    isLoading,
    error,
  } = useRepo(repoId, {
    relayUrl,
    preview: showMockRepo,
  });
  const { data: refs, isLoading: refsLoading } = useRepoRefs(repoId, {
    relayUrl,
    preview: showMockRepo,
  });

  const defaultRef = refs?.head?.ref ?? "main";
  const owner = repo?.owner ?? "";
  const repoName = repo?.id ?? "";
  const browseOwner = showMockRepo ? "" : owner;

  const {
    data: fetchedTreeEntries,
    isLoading: isTreeLoading,
    error: treeError,
  } = useGitTree(relayUrl, browseOwner, repoName, defaultRef);
  const {
    data: fetchedCommits,
    isLoading: areCommitsLoading,
    error: commitsError,
  } = useGitLog(relayUrl, browseOwner, repoName, defaultRef);
  const { data: fetchedReadme, isLoading: isReadmeLoading } = useGitReadme(
    relayUrl,
    browseOwner,
    repoName,
    defaultRef,
  );
  const treeEntries = showMockRepo ? mockRepoTree : fetchedTreeEntries;
  const commits = showMockRepo ? mockRepoCommits : fetchedCommits;
  const readme = showMockRepo ? mockRepoReadme : fetchedReadme;
  const treeLoading = showMockRepo ? false : isTreeLoading;
  const commitsLoading = showMockRepo ? false : areCommitsLoading;
  const readmeLoading = showMockRepo ? false : isReadmeLoading;

  // Surface clone/browse errors — these are otherwise silent
  const browseError = treeError || commitsError;
  useEffect(() => {
    if (browseError) {
      console.error("[git-browse]", browseError);
    }
  }, [browseError]);

  useEffect(() => {
    if (error) {
      toast.error(t("error.repoLoad"), {
        description: error.message,
      });
    }
  }, [error]);

  if (isLoading) return <DetailSkeleton />;

  if (!repo) {
    return (
      <div className="flex w-full flex-1 gap-8 bg-background px-4 py-8 text-foreground">
        <div className="min-w-0 flex-1">
          <RepositoryBreadcrumb name={repoId} />
          <div className="mt-12 text-center">
            <BookMarked className="mx-auto h-10 w-10 text-black/50 dark:text-white/50" />
            <h1 className="mt-4 text-xl font-semibold text-black dark:text-white">
              {t("repos.notFound")}
            </h1>
            <p className="mt-1 text-sm text-black/60 dark:text-white/60">
              {t("repos.notFoundDescription")}
            </p>
          </div>
        </div>
        <aside className="hidden w-72 shrink-0 lg:block" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-1 gap-8 bg-background px-4 py-8 text-foreground sm:px-6">
      {/* Main content */}
      <div className="min-w-0 flex-1">
        <RepositoryBreadcrumb mockPreview={preview} name={repo.name} />

        {/* Mobile-only connect button */}
        <div className="mt-4 lg:hidden">
          <ConnectButton className="w-full" relayUrl={relayUrl} />
        </div>

        {/* Header */}
        <div className="mt-6">
          <div className="flex items-center gap-3">
            <BookMarked className="h-6 w-6 shrink-0 text-muted-foreground" />
            <h1 className="text-2xl font-semibold text-foreground">{repo.name}</h1>
            <Badge variant="outline" className="text-muted-foreground">
              {t("repos.public")}
            </Badge>
          </div>
          {repo.description && (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{repo.description}</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {t("repos.updated", { time: relativeTime(repo.createdAt) })}
          </p>
        </div>

        {/* Refs & HEAD */}
        <RepoRefsSection refs={refs} isLoading={refsLoading} />

        {/* Clone/browse error banner */}
        {browseError && (
          <div
            aria-atomic="true"
            className="mt-6 rounded-md border border-destructive/50 bg-background px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            {t("error.repoContentsLoad")}:{" "}
            {browseError instanceof Error ? browseError.message : String(browseError)}
          </div>
        )}

        {/* Tabs */}
        <RepoContentTabs
          repoId={repoId}
          treeEntries={treeEntries}
          treeLoading={treeLoading}
          commits={commits}
          commitsLoading={commitsLoading}
          readme={readme}
          readmeLoading={readmeLoading}
          preview={showMockRepo}
        />

        {/* Clone URLs */}
        {repo.cloneUrls.length > 0 && (
          <div className="mt-8">
            <h2 className="mb-3 text-sm font-semibold text-foreground">{t("repos.clone")}</h2>
            <div className="space-y-2">
              {repo.cloneUrls.map((url) => (
                <CopyableUrl key={url} url={url} />
              ))}
            </div>
          </div>
        )}

        {/* External link — validate scheme to prevent javascript: XSS */}
        {(() => {
          if (!repo.webUrl) return null;
          let safe: string | null = null;
          try {
            safe = /^https?:/.test(new URL(repo.webUrl).protocol) ? repo.webUrl : null;
          } catch {
            safe = null;
          }
          if (!safe) return null;
          return (
            <div className="mt-6">
              <Button
                variant="outline"
                className="border-black/10 bg-white text-black hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
                asChild
              >
                <a href={safe} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t("repos.viewWeb")}
                </a>
              </Button>
            </div>
          );
        })()}

        {/* Channel link */}
        {repo.channelId && (
          <div className="mt-8">
            <Button
              variant="outline"
              className="border-black/10 bg-white text-black hover:bg-black/5 dark:border-white/10 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
              asChild
            >
              <a href={`/channels/${repo.channelId}`}>
                <MessageSquare className="h-4 w-4" />
                {t("repos.viewChannel")}
              </a>
            </Button>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <aside className="hidden w-72 shrink-0 border-l pl-8 lg:block">
        <div className="space-y-6">
          {/* Open in Buzz */}
          <ConnectButton className="w-full" relayUrl={relayUrl} />

          {/* People */}
          <div>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-black dark:text-white">
              <Users className="h-4 w-4" />
              {t("repos.people")}
            </h3>
            <div className="flex flex-wrap gap-2">
              <PubkeyAvatar pubkey={repo.owner} />
              {repo.contributors
                .filter((c) => c !== repo.owner)
                .map((c) => (
                  <PubkeyAvatar key={c} pubkey={c} />
                ))}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

export function AuthenticatedRepoDetailPage() {
  return (
    <AuthenticatedRoute>
      {(config) => <RepoDetailPage relayUrl={config.relayUrl} />}
    </AuthenticatedRoute>
  );
}
