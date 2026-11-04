import { CircleDot, GitPullRequest, LoaderCircle, RefreshCw } from "lucide-react";
import {
  REPO_ACTIVITY_LIMIT,
  type RepoActivity,
  type RepoActivityStatus,
} from "@/features/repos/use-repo-activity";
import { type MessageKey, t } from "@/shared/i18n";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relativeTime } from "@/shared/lib/relative-time";

const STATUS_LABELS: Record<RepoActivityStatus, MessageKey> = {
  open: "repos.activityOpen",
  merged: "repos.activityMerged",
  applied: "repos.activityApplied",
  closed: "repos.activityClosed",
  draft: "repos.activityDraft",
};

export function RepoActivitySection({
  kind,
  activity,
  isLoading,
  error,
  onRetry,
  onOpenRepo,
}: {
  kind: "issues" | "pull-requests";
  activity: RepoActivity | undefined;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  onOpenRepo: (repoId: string) => void;
}) {
  const items = kind === "issues" ? activity?.issues : activity?.pullRequests;

  return (
    <div className="mt-5">
      <div className="rounded-lg border bg-background/25 px-4 py-3 text-xs leading-5 text-muted-foreground">
        <p>{t("repos.activityDisclaimer")}</p>
        <p className="mt-1.5">{t("repos.activityStatusPolicy")}</p>
      </div>

      {error ? (
        <div
          aria-atomic="true"
          className="mt-4 flex flex-wrap items-center gap-2.5 rounded-md border border-destructive/50 bg-background px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          <span className="min-w-0 flex-1 break-words">
            {t("repos.activityLoadFailed")}: {error.message}
          </span>
          <button
            className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border px-2.5 font-medium hover:bg-foreground/5 sm:h-8"
            type="button"
            onClick={onRetry}
          >
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            {t("repos.activityRetry")}
          </button>
        </div>
      ) : null}

      {isLoading && !activity ? (
        <div
          aria-live="polite"
          className="flex items-center justify-center px-4 py-14 text-sm text-muted-foreground"
        >
          <LoaderCircle aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
          {t("repos.activityLoading")}
        </div>
      ) : activity ? (
        <>
          {activity.truncated ? (
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              {t("repos.activityWindow", { count: REPO_ACTIVITY_LIMIT })}
            </p>
          ) : null}
          {items?.length ? (
            <ul className="mt-4 divide-y rounded-lg border bg-background/20">
              {items.map((item) => (
                <li key={item.id} className="flex min-w-0 gap-3 px-4 py-3">
                  <span className="mt-0.5 h-fit shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    <span>{t(STATUS_LABELS[item.status])}</span>
                    {item.statusAuthor ? (
                      <span className="sr-only">
                        {t("repos.activityStatusBy", {
                          actor: truncatePubkey(item.statusAuthor),
                        })}
                      </span>
                    ) : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium leading-5">{item.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="min-w-0 truncate font-mono" title={item.author}>
                        {truncatePubkey(item.author)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <time dateTime={new Date(item.createdAt * 1_000).toISOString()}>
                        {relativeTime(item.createdAt)}
                      </time>
                      <span aria-hidden="true">·</span>
                      <button
                        aria-label={t("repos.activityOpenRepo", { repository: item.repoName })}
                        className="min-w-0 truncate underline-offset-2 hover:text-foreground hover:underline"
                        type="button"
                        onClick={() => onOpenRepo(item.repoId)}
                      >
                        {item.repoName}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : activity.complete ? (
            <div className="mt-4 flex min-h-[220px] flex-col items-center justify-center rounded-lg border text-center text-muted-foreground">
              {kind === "issues" ? (
                <CircleDot aria-hidden="true" className="h-9 w-9 opacity-45" />
              ) : (
                <GitPullRequest aria-hidden="true" className="h-9 w-9 opacity-45" />
              )}
              <p className="mt-3 text-sm">
                {kind === "issues" ? t("repos.noIssues") : t("repos.noPullRequests")}
              </p>
            </div>
          ) : (
            <div className="mt-4 flex min-h-[220px] flex-col items-center justify-center rounded-lg border px-4 text-center text-muted-foreground">
              <span aria-hidden="true" className="text-3xl">
                —
              </span>
              <p className="mt-3 text-sm">{t("repos.activityIncomplete")}</p>
            </div>
          )}
        </>
      ) : error ? null : (
        <div className="mt-4 flex min-h-[220px] flex-col items-center justify-center rounded-lg border px-4 text-center text-sm text-muted-foreground">
          {t("repos.activityUnavailable")}
        </div>
      )}
    </div>
  );
}
