import {
  AlertTriangle,
  ChevronDown,
  Info,
  LoaderCircle,
  RefreshCw,
  Workflow,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { BuzzChannel } from "@/features/chat/lib/chat-types";
import { useWorkflowDefinitions, useWorkflowRuns } from "@/features/workflows/use-workflows";
import {
  runErrorKey,
  runStatusKey,
  selectRunsView,
  stepStatusKey,
  timestampMillis,
  type WorkflowRun,
} from "@/features/workflows/workflow-api";
import { getLocale, t } from "@/shared/i18n";
import { badgeVariants } from "@/shared/ui/badge";

const MAX_ERROR_MESSAGE = 400;

function formatTime(seconds: number | null): string | null {
  const milliseconds = timestampMillis(seconds);
  if (milliseconds === null) return null;
  return new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "short",
    timeStyle: "short",
  }).format(milliseconds);
}

function isoTime(seconds: number | null): string | undefined {
  const milliseconds = timestampMillis(seconds);
  return milliseconds === null ? undefined : new Date(milliseconds).toISOString();
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Notice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      aria-live="polite"
      className="mt-3 flex flex-wrap items-center gap-2.5 rounded-md bg-destructive/8 px-3 py-2 text-xs ring-1 ring-destructive/20"
      role="status"
    >
      <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 break-words text-foreground">{message}</span>
      {onRetry ? (
        <button
          className="inline-flex h-11 min-w-11 shrink-0 items-center gap-1.5 rounded-md border px-2.5 font-medium text-foreground hover:bg-destructive/10 sm:h-8"
          type="button"
          onClick={onRetry}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("workflows.retry")}
        </button>
      ) : null}
    </div>
  );
}

function RunRow({
  run,
  index,
  expanded,
  onToggle,
}: {
  run: WorkflowRun;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const panelId = `workflow-run-panel-${index}`;
  const started = formatTime(run.startedAt);
  const completed = formatTime(run.completedAt);
  const errorKey = runErrorKey(run.errorCode);
  const showCompleted =
    run.completedAt !== null || ["completed", "failed", "cancelled"].includes(run.status);
  return (
    <li>
      <article className="rounded-lg border bg-background/25">
        <button
          aria-controls={panelId}
          aria-expanded={expanded}
          className="flex min-h-11 w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left"
          type="button"
          onClick={onToggle}
        >
          <span className={badgeVariants({ variant: "outline" })}>
            {t(runStatusKey(run.status))}
          </span>
          {run.status === "running" && run.currentStep !== null ? (
            <span className="text-xs text-muted-foreground">
              {t("workflows.currentStep", { step: run.currentStep + 1 })}
            </span>
          ) : null}
          <span className="ml-auto flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
            {started ? <time dateTime={isoTime(run.startedAt)}>{started}</time> : null}
            <ChevronDown
              aria-hidden="true"
              className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </span>
          <span className="sr-only">{t("workflows.runDetails")}</span>
        </button>
        {expanded ? (
          <div className="border-t px-3 py-2 text-xs" id={panelId}>
            <dl className="grid gap-1 sm:grid-cols-2">
              <Field label={t("workflows.started")}>
                {run.status === "pending"
                  ? t("workflows.notStarted")
                  : (started ?? t("workflows.timeUnknown"))}
              </Field>
              {showCompleted ? (
                <Field label={t("workflows.ended")}>
                  {completed ?? t("workflows.timeUnknown")}
                </Field>
              ) : null}
            </dl>
            {errorKey || run.errorMessage ? (
              <div className="mt-2">
                <p className="font-medium">
                  {t("workflows.errorLabel")}: {t(errorKey ?? "workflows.error.generic")}
                </p>
                {run.errorMessage ? (
                  <p className="mt-0.5 break-words text-muted-foreground">
                    {run.errorMessage.slice(0, MAX_ERROR_MESSAGE)}
                  </p>
                ) : null}
              </div>
            ) : null}
            {run.steps.length > 0 ? (
              <div className="mt-2">
                <p className="text-muted-foreground">{t("workflows.steps")}</p>
                <ol className="mt-1 space-y-0.5">
                  {run.steps.map((step) => (
                    <li className="flex flex-wrap gap-x-2" key={`${step.stepId}:${step.status}`}>
                      <span className="break-words">{step.stepId}</span>
                      <span className="text-muted-foreground">{t(stepStatusKey(step.status))}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
        ) : null}
      </article>
    </li>
  );
}

export function WorkflowsView({
  relayUrl,
  viewerPubkey,
  channels,
  onClose,
}: {
  relayUrl: string;
  viewerPubkey: string;
  channels: BuzzChannel[];
  onClose: () => void;
}) {
  const definitionsQuery = useWorkflowDefinitions({ relayUrl, viewerPubkey });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const definitions = definitionsQuery.data ?? [];
  // The list is authoritative: a selected workflow that is no longer listed
  // falls back to the newest one instead of showing a stale run history.
  const selected = definitions.find((item) => item.id === selectedId) ?? definitions[0] ?? null;
  const runs = useWorkflowRuns({
    relayUrl,
    viewerPubkey,
    workflowId: selected?.id ?? "",
  });
  const view = selectRunsView(runs.data?.pages, runs.isPending);
  const channelNames = new Map(channels.map((channel) => [channel.id, channel.name]));
  const channelName = selected ? (channelNames.get(selected.channelId ?? "") ?? null) : null;

  return (
    <div className="buzz-scrollbar min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1280px] px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1 pr-8 sm:pr-0">
            <h2 className="flex items-center gap-2 text-[22px] font-semibold leading-tight">
              <Workflow className="h-5 w-5 shrink-0 text-muted-foreground" />
              {t("workflows.title")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("workflows.subtitle")}</p>
          </div>
          <button
            aria-label={t("workflows.close")}
            className="absolute right-5 top-6 inline-flex size-11 shrink-0 items-center justify-center rounded-[0.35rem] text-[var(--buzz-chrome-foreground)] transition-colors hover:bg-[var(--buzz-hover-surface)] hover:text-foreground sm:static sm:size-8"
            title={t("workflows.close")}
            type="button"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <p className="mt-3 text-[11px] text-muted-foreground">{t("workflows.privacyNote")}</p>

        <div className="mt-6 grid gap-5 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
          <section aria-labelledby="workflow-definitions-heading" className="min-w-0">
            <h3
              className="text-xs font-medium text-muted-foreground"
              id="workflow-definitions-heading"
            >
              {t("workflows.definitions")}
            </h3>
            {definitionsQuery.isPending ? (
              <p
                aria-live="polite"
                className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
              >
                <LoaderCircle className="h-4 w-4 animate-spin" />
                {t("workflows.loadingDefinitions")}
              </p>
            ) : definitionsQuery.isError ? (
              <Notice
                message={t("workflows.errorDefinitions")}
                onRetry={() => void definitionsQuery.refetch()}
              />
            ) : definitions.length === 0 ? (
              <p aria-live="polite" className="mt-3 text-xs text-muted-foreground">
                {t("workflows.emptyDefinitions")}
              </p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {definitions.map((definition) => {
                  const isSelected = selected?.id === definition.id;
                  const updated = formatTime(definition.updatedAt);
                  const definitionChannel = channelNames.get(definition.channelId ?? "") ?? null;
                  return (
                    <li key={definition.id}>
                      <button
                        aria-pressed={isSelected}
                        className={`min-h-11 w-full min-w-0 rounded-lg border px-3 py-2 text-left ${
                          isSelected
                            ? "border-foreground/30 bg-foreground/5"
                            : "hover:bg-foreground/5"
                        }`}
                        type="button"
                        onClick={() => setSelectedId(definition.id)}
                      >
                        <span className="block break-words text-sm font-medium">
                          {definition.name ?? t("workflows.untitled")}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                          {definitionChannel ? (
                            <span className="min-w-0 break-words">#{definitionChannel}</span>
                          ) : null}
                          {updated ? (
                            <span>{t("workflows.updatedAt", { time: updated })}</span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {selected ? (
            <section aria-labelledby="workflow-runs-heading" className="min-w-0">
              <h3 className="min-w-0 break-words text-sm font-semibold" id="workflow-runs-heading">
                {selected.name ?? t("workflows.untitled")}
              </h3>
              {channelName ? (
                <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
                  #{channelName}
                </p>
              ) : null}

              {view.kind === "loading" ? (
                <p
                  aria-live="polite"
                  className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  {t("workflows.loadingRuns")}
                </p>
              ) : view.kind === "forbidden" ? (
                <Notice message={t("workflows.forbiddenRuns")} />
              ) : view.kind === "unavailable" ? (
                <Notice message={t("workflows.unavailableRuns")} />
              ) : view.kind === "error" ? (
                <Notice message={t("workflows.errorRuns")} onRetry={() => void runs.refetch()} />
              ) : view.kind === "empty" ? (
                <p aria-live="polite" className="mt-3 text-xs text-muted-foreground">
                  {t("workflows.emptyRuns")}
                </p>
              ) : (
                <>
                  {view.dropped > 0 ? (
                    // Informational, not an error: the rows that could be read are
                    // shown above, so this must not wear the destructive surface.
                    <div
                      aria-live="polite"
                      className="mt-3 flex flex-wrap items-center gap-2.5 rounded-md bg-muted px-3 py-2 text-xs text-foreground ring-1 ring-border"
                      role="status"
                    >
                      <Info aria-hidden="true" className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1 break-words">
                        {t("workflows.someRunsUnreadable")}
                      </span>
                    </div>
                  ) : null}
                  <ul aria-live="polite" className="mt-3 space-y-2">
                    {view.runs.map((run, index) => (
                      <RunRow
                        expanded={expandedKey === run.key}
                        index={index}
                        key={run.key}
                        run={run}
                        onToggle={() =>
                          setExpandedKey((current) => (current === run.key ? null : run.key))
                        }
                      />
                    ))}
                  </ul>
                  {view.failedPage ? (
                    <Notice
                      message={t("workflows.olderFailed")}
                      onRetry={() => void runs.refetch()}
                    />
                  ) : view.next ? (
                    <button
                      className="mt-3 inline-flex h-11 min-w-11 items-center rounded-md border px-3 text-xs font-medium hover:bg-foreground/5 sm:h-8"
                      disabled={runs.isFetchingNextPage}
                      type="button"
                      onClick={() => void runs.fetchNextPage()}
                    >
                      {runs.isFetchingNextPage
                        ? t("workflows.loadingMore")
                        : t("workflows.loadMore")}
                    </button>
                  ) : null}
                </>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
