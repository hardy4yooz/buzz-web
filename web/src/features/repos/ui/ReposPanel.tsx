import { Link } from "@tanstack/react-router";
import {
  BookMarked,
  Check,
  ChevronRight,
  CircleDot,
  Copy,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  Radio,
  RefreshCw,
  Search,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fallbackProfile } from "@/features/chat/lib/chat-model";
import type { UserProfile } from "@/features/chat/lib/chat-types";
import { Avatar } from "@/features/chat/ui/Avatar";
import {
  mockRepoCommits,
  mockRepoReadme,
  mockRepos,
  mockRepoTree,
} from "@/features/repos/mock-repos";
import { useGitLog, useGitReadme, useGitTree } from "@/features/repos/use-git-browse";
import { useRepoRefs } from "@/features/repos/use-repo-refs";
import { type Repo, useRepos } from "@/features/repos/use-repos";
import { getLocale, t } from "@/shared/i18n";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { RepoContentTabs } from "./RepoContentTabs";
import { RepoRefsSection } from "./RepoRefsSection";

type SortOrder = "name" | "newest" | "oldest";
type ProjectTab = "overview" | "repositories" | "pull-requests" | "issues";

const HEATMAP_WEEKS = 18;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7;

function relativeTime(createdAt: number): string {
  const seconds = createdAt - Math.floor(Date.now() / 1_000);
  const formatter = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function safeWebUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function contributionData(repos: readonly Repo[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(today.getDate() - (HEATMAP_DAYS - 1));
  const counts = new Map<number, number>();
  for (const repo of repos) {
    const date = new Date(repo.createdAt * 1_000);
    date.setHours(0, 0, 0, 0);
    const index = Math.floor((date.getTime() - start.getTime()) / 86_400_000);
    if (index >= 0 && index < HEATMAP_DAYS) counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  const cells = Array.from({ length: HEATMAP_DAYS }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return { date: date.toISOString().slice(0, 10), count: counts.get(index) ?? 0 };
  });
  const monthLabels = Array.from({ length: 5 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + Math.round((index * (HEATMAP_DAYS - 1)) / 4));
    return {
      date: date.toISOString().slice(0, 10),
      label: new Intl.DateTimeFormat(getLocale(), { month: "short" }).format(date),
    };
  });
  return { cells, monthLabels };
}

function RepoDetail({
  repo,
  demo,
  relayUrl,
  onBack,
  onOpenChannel,
}: {
  repo: Repo;
  demo: boolean;
  relayUrl: string;
  onBack: () => void;
  onOpenChannel: (channelId: string) => void;
}) {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const webUrl = safeWebUrl(repo.webUrl);
  const { data: refs, isLoading: refsLoading } = useRepoRefs(repo.id, {
    relayUrl,
    preview: demo,
  });
  const defaultRef = refs?.head?.ref ?? "main";
  const browseOwner = demo ? "" : repo.owner;
  const treeQuery = useGitTree(relayUrl, browseOwner, repo.id, defaultRef);
  const commitsQuery = useGitLog(relayUrl, browseOwner, repo.id, defaultRef);
  const readmeQuery = useGitReadme(relayUrl, browseOwner, repo.id, defaultRef);
  const treeEntries = demo ? mockRepoTree : treeQuery.data;
  const commits = demo ? mockRepoCommits : commitsQuery.data;
  const readme = demo ? mockRepoReadme : readmeQuery.data;
  const browseError = treeQuery.error || commitsQuery.error;

  const copyCloneUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      window.setTimeout(() => setCopiedUrl((current) => (current === url ? null : current)), 2_000);
    } catch {
      setCopiedUrl(null);
    }
  };

  return (
    <div className="mt-8">
      <nav aria-label={t("repos.breadcrumb")} className="flex min-w-0 items-center gap-1.5 text-sm">
        <button
          className="shrink-0 text-muted-foreground hover:text-foreground"
          type="button"
          onClick={onBack}
        >
          {t("repos.title")}
        </button>
        <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span aria-current="page" className="truncate font-medium">
          {repo.name}
        </span>
      </nav>

      <div className="mt-5 grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <div className="border-b pb-6">
            <div className="flex items-start gap-3">
              <BookMarked className="mt-1 h-6 w-6 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-2xl font-semibold">{repo.name}</h3>
                {repo.description ? (
                  <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-muted-foreground">
                    {repo.description}
                  </p>
                ) : null}
              </div>
              <span className="rounded-full border px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
                {t("repos.public")}
              </span>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {t("repos.updated", { time: relativeTime(repo.createdAt) })}
            </p>
            <RepoRefsSection refs={refs} isLoading={refsLoading} />
          </div>

          {browseError ? (
            <div className="mt-5 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {t("error.repoContentsLoad")}: {browseError.message}
            </div>
          ) : null}

          <RepoContentTabs
            commits={commits}
            commitsLoading={demo ? false : commitsQuery.isLoading}
            preview={demo}
            readme={readme}
            readmeLoading={demo ? false : readmeQuery.isLoading}
            repoId={repo.id}
            treeEntries={treeEntries}
            treeLoading={demo ? false : treeQuery.isLoading}
          />

          {repo.cloneUrls.length ? (
            <section className="border-b py-6">
              <h4 className="mb-3 text-sm font-semibold">{t("repos.clone")}</h4>
              <div className="space-y-2">
                {repo.cloneUrls.map((url) => (
                  <div key={url} className="flex items-center gap-2 rounded-md border px-3 py-2.5">
                    <code className="min-w-0 flex-1 truncate text-xs" title={url}>
                      {url}
                    </code>
                    <button
                      aria-label={t("repos.copyClone")}
                      className="buzz-icon-button h-7 w-7 shrink-0"
                      title={t("repos.copyClone")}
                      type="button"
                      onClick={() => void copyCloneUrl(url)}
                    >
                      {copiedUrl === url ? (
                        <Check className="h-3.5 w-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <aside className="space-y-5">
          <div>
            <div className="text-xs font-medium text-muted-foreground">{t("repos.owner")}</div>
            <div className="mt-1 break-all font-mono text-xs" title={repo.owner}>
              {truncatePubkey(repo.owner)}
            </div>
          </div>
          <div>
            <div className="text-xs font-medium text-muted-foreground">
              {t("repos.contributors")}
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-muted-foreground" />
              {repo.contributors.length}
            </div>
          </div>
          <div className="flex flex-col gap-2 pt-2">
            {repo.channelId ? (
              <button
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-foreground/5"
                type="button"
                onClick={() => onOpenChannel(repo.channelId as string)}
              >
                <MessageSquare className="h-4 w-4" />
                {t("repos.openChannel")}
              </button>
            ) : null}
            <Link
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-foreground/5"
              params={{ repoId: repo.id }}
              rel="noopener noreferrer"
              search={demo ? { preview: "repositories" } : undefined}
              target="_blank"
              to="/repos/$repoId"
            >
              <ExternalLink className="h-4 w-4" />
              {t("repos.openFull")}
            </Link>
            {webUrl ? (
              <a
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-foreground/5"
                href={webUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-4 w-4" />
                {t("repos.openWeb")}
              </a>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="min-h-[112px] rounded-lg border bg-background/30 p-4">
      <div className="flex items-center justify-between gap-3 text-xs font-medium">
        <span>{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <div className="mt-4 text-4xl font-semibold leading-none">{value}</div>
    </div>
  );
}

export function ReposPanel({
  demo,
  profiles,
  relayUrl,
  onClose,
  onOpenChannel,
}: {
  demo: boolean;
  profiles: Readonly<Record<string, UserProfile>>;
  relayUrl: string;
  onClose: () => void;
  onOpenChannel: (channelId: string) => void;
}) {
  const query = useRepos({ relayUrl, enabled: !demo });
  const repos = demo ? mockRepos : (query.data ?? []);
  const [activeTab, setActiveTab] = useState<ProjectTab>("overview");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOrder>("newest");
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const selected = selectedRepoId
    ? (repos.find((repo) => repo.id === selectedRepoId) ?? null)
    : null;
  const filteredRepos = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const filtered = repos.filter(
      (repo) =>
        !term ||
        repo.name.toLocaleLowerCase().includes(term) ||
        repo.description.toLocaleLowerCase().includes(term),
    );
    return [...filtered].sort((left, right) => {
      if (sort === "oldest") return left.createdAt - right.createdAt;
      if (sort === "name") return left.name.localeCompare(right.name);
      return right.createdAt - left.createdAt;
    });
  }, [repos, search, sort]);
  const people = useMemo(
    () => [...new Set(repos.flatMap((repo) => [repo.owner, ...repo.contributors]))],
    [repos],
  );
  const contribution = useMemo(() => contributionData(repos), [repos]);

  useEffect(() => {
    if (selectedRepoId && !selected) setSelectedRepoId(null);
  }, [selected, selectedRepoId]);

  const openRepo = (repoId: string) => {
    setActiveTab("repositories");
    setSelectedRepoId(repoId);
  };

  return (
    <div className="buzz-scrollbar min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1280px] px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <header className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[22px] font-semibold leading-tight">{t("nav.projects")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("repos.subtitle")}</p>
          </div>
          <button
            aria-label={t("common.refresh")}
            className="buzz-icon-button"
            disabled={query.isFetching || demo}
            title={t("common.refresh")}
            type="button"
            onClick={() => void query.refetch()}
          >
            <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
          </button>
          <button
            aria-label={t("repos.close")}
            className="buzz-icon-button"
            title={t("repos.close")}
            type="button"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {query.error && !demo ? (
          <div className="mt-5 rounded-md bg-destructive/8 px-3 py-2 text-xs text-destructive">
            {query.error.message}
          </div>
        ) : null}

        {!selected ? (
          <div className="mt-7 flex items-end gap-4 border-b">
            <div className="flex min-w-0 flex-1 gap-6 overflow-x-auto" role="tablist">
              {(
                [
                  ["overview", t("repos.overview")],
                  ["repositories", t("repos.title")],
                  ["pull-requests", t("repos.pullRequests")],
                  ["issues", t("repos.issues")],
                ] as const
              ).map(([tab, label]) => (
                <button
                  key={tab}
                  aria-selected={activeTab === tab}
                  className={`h-11 shrink-0 border-b-2 px-0.5 text-sm font-medium ${
                    activeTab === tab
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                  role="tab"
                  type="button"
                  onClick={() => setActiveTab(tab)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {selected ? (
          <RepoDetail
            demo={demo}
            relayUrl={relayUrl}
            repo={selected}
            onBack={() => setSelectedRepoId(null)}
            onOpenChannel={onOpenChannel}
          />
        ) : activeTab === "overview" ? (
          <div className="mt-5">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                icon={<GitBranch className="h-4 w-4" />}
                label={t("repos.title")}
                value={repos.length}
              />
              <StatCard
                icon={<GitPullRequest className="h-4 w-4" />}
                label={t("repos.pullRequests")}
                value={0}
              />
              <StatCard icon={<Radio className="h-4 w-4" />} label={t("repos.local")} value={0} />
              <StatCard
                icon={<CircleDot className="h-4 w-4" />}
                label={t("repos.issues")}
                value={0}
              />
            </div>

            <div className="mt-6 grid gap-8 xl:grid-cols-[minmax(0,1fr)_280px]">
              <section>
                <h3 className="sr-only">{t("repos.recentActivity")}</h3>
                <div className="space-y-3">
                  {repos.map((repo) => {
                    const profile = profiles[repo.owner] ?? fallbackProfile(repo.owner);
                    return (
                      <button
                        key={`${repo.owner}:${repo.id}`}
                        className="flex min-h-[120px] w-full items-start gap-3 rounded-lg border bg-background/25 p-4 text-left hover:bg-foreground/[0.035]"
                        type="button"
                        onClick={() => openRepo(repo.id)}
                      >
                        <Avatar profile={profile} relayUrl={relayUrl} size={40} />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-muted-foreground">
                            {t("repos.createdRepository", {
                              actor: profile.name,
                              repository: repo.name,
                            })}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {relativeTime(repo.createdAt)}
                          </p>
                          <div className="mt-3 text-sm font-semibold">{repo.name}</div>
                          {repo.description ? (
                            <p className="mt-1 line-clamp-2 text-sm text-foreground/85">
                              {repo.description}
                            </p>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                  {query.isLoading && !demo ? (
                    <div className="flex items-center justify-center px-4 py-14 text-sm text-muted-foreground">
                      <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                      {t("repos.loading")}
                    </div>
                  ) : null}
                  {!query.isLoading && !repos.length ? (
                    <div className="rounded-lg border px-5 py-14 text-center">
                      <BookMarked className="mx-auto h-8 w-8 text-muted-foreground/50" />
                      <p className="mt-3 text-sm font-medium">{t("repos.empty")}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {t("repos.emptyDescription")}
                      </p>
                    </div>
                  ) : null}
                </div>
              </section>

              <aside className="space-y-8">
                <section>
                  <h3 className="text-sm font-semibold">{t("repos.people")}</h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {people.slice(0, 12).map((pubkey) => (
                      <Avatar
                        key={pubkey}
                        profile={profiles[pubkey] ?? fallbackProfile(pubkey)}
                        relayUrl={relayUrl}
                        size={30}
                      />
                    ))}
                    {!people.length ? (
                      <span className="text-xs text-muted-foreground">{t("repos.noPeople")}</span>
                    ) : null}
                  </div>
                </section>

                <section>
                  <h3 className="text-sm font-semibold">{t("repos.contributionActivity")}</h3>
                  <div className="mt-3 flex justify-between text-[10px] text-muted-foreground">
                    {contribution.monthLabels.map((month) => (
                      <span key={month.date}>{month.label}</span>
                    ))}
                  </div>
                  <div
                    aria-label={t("repos.contributionActivity")}
                    className="mt-2 grid grid-flow-col grid-rows-7 gap-1"
                    role="img"
                  >
                    {contribution.cells.map((cell) => (
                      <span
                        key={cell.date}
                        className={`aspect-square min-w-0 rounded-[3px] border border-foreground/[0.025] ${
                          cell.count > 1
                            ? "bg-emerald-500/55"
                            : cell.count === 1
                              ? "bg-emerald-500/30"
                              : "bg-foreground/[0.035]"
                        }`}
                        title={t("repos.contributionCount", { count: cell.count })}
                      />
                    ))}
                  </div>
                </section>
              </aside>
            </div>
          </div>
        ) : activeTab === "repositories" ? (
          <div className="mt-5">
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background/30 px-3">
                <Search className="h-4 w-4 text-muted-foreground" />
                <input
                  aria-label={t("repos.search")}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  placeholder={t("repos.search")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <select
                aria-label={t("repos.sort")}
                className="h-10 min-w-36 rounded-md border bg-background/30 px-3 text-xs"
                value={sort}
                onChange={(event) => setSort(event.target.value as SortOrder)}
              >
                <option value="newest">{t("repos.sortNewest")}</option>
                <option value="oldest">{t("repos.sortOldest")}</option>
                <option value="name">{t("repos.sortName")}</option>
              </select>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {filteredRepos.map((repo) => (
                <button
                  key={`${repo.owner}:${repo.id}`}
                  className="flex min-h-[124px] w-full items-start gap-3 rounded-lg border bg-background/20 px-4 py-4 text-left hover:bg-foreground/[0.035]"
                  type="button"
                  onClick={() => setSelectedRepoId(repo.id)}
                >
                  <BookMarked className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{repo.name}</div>
                    {repo.description ? (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {repo.description}
                      </p>
                    ) : null}
                    <div className="mt-2 flex gap-2 text-[10px] text-muted-foreground">
                      <span className="truncate font-mono">{truncatePubkey(repo.owner)}</span>
                      <span>·</span>
                      <span className="shrink-0">{relativeTime(repo.createdAt)}</span>
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
                    {t("repos.public")}
                  </span>
                </button>
              ))}
            </div>
            {!query.isLoading && repos.length > 0 && !filteredRepos.length ? (
              <div className="px-4 py-14 text-center text-sm text-muted-foreground">
                {t("repos.noMatches")}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex min-h-[360px] flex-col items-center justify-center text-center text-muted-foreground">
            {activeTab === "pull-requests" ? (
              <GitPullRequest className="h-9 w-9 opacity-45" />
            ) : (
              <CircleDot className="h-9 w-9 opacity-45" />
            )}
            <p className="mt-3 text-sm">
              {activeTab === "pull-requests" ? t("repos.noPullRequests") : t("repos.noIssues")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
