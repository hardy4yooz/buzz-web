import type { UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import type { MemberRole } from "@/features/chat/lib/chat-types";
import {
  canViewModeration,
  type ModerationAction,
  type ModerationRead,
  type ModerationReport,
  type ModerationRestriction,
  type ModerationSection,
} from "@/features/moderation/moderation-api";
import {
  useModerationAudit,
  useModerationReports,
  useModerationRestricted,
} from "@/features/moderation/use-moderation";
import { getLocale, type MessageKey, t } from "@/shared/i18n";
import { truncatePubkey } from "@/shared/lib/pubkey";

const REPORT_TYPES: Record<string, MessageKey> = {
  spam: "moderation.reportType.spam",
  nudity: "moderation.reportType.nudity",
  malware: "moderation.reportType.malware",
  illegal: "moderation.reportType.illegal",
  impersonation: "moderation.reportType.impersonation",
  profanity: "moderation.reportType.profanity",
  other: "moderation.reportType.other",
};

const REPORT_STATUSES: Record<string, MessageKey> = {
  open: "moderation.reportStatus.open",
  processing: "moderation.reportStatus.processing",
  resolved: "moderation.reportStatus.resolved",
  dismissed: "moderation.reportStatus.dismissed",
  escalated: "moderation.reportStatus.escalated",
};

const ACTIONS: Record<string, MessageKey> = {
  delete_message: "moderation.action.deleteMessage",
  kick: "moderation.action.kick",
  ban: "moderation.action.ban",
  unban: "moderation.action.unban",
  timeout: "moderation.action.timeout",
  untimeout: "moderation.action.untimeout",
  dismiss_report: "moderation.action.dismissReport",
  escalate: "moderation.action.escalate",
  "resolve:delete": "moderation.action.resolveDelete",
  "resolve:kick": "moderation.action.resolveKick",
  "resolve:ban": "moderation.action.resolveBan",
  "resolve:timeout": "moderation.action.resolveTimeout",
};

const TARGET_KINDS: Record<ModerationReport["target_kind"], MessageKey> = {
  event: "moderation.targetKind.event",
  pubkey: "moderation.targetKind.pubkey",
  blob: "moderation.targetKind.blob",
};

/** Relay values are shown through a known label; unknown values stay verbatim as data. */
function knownLabel(map: Record<string, MessageKey>, value: string): string {
  const key = map[value];
  return key ? t(key) : value;
}

/** A timestamp the client cannot parse is omitted, never rendered raw. */
function formatTime(value: string | null): string | null {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return null;
  return new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(milliseconds);
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] font-medium">
      {children}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Timestamp({ value }: { value: string | null }) {
  const formatted = formatTime(value);
  if (!formatted) return null;
  return (
    <time
      className="ml-auto shrink-0 text-[11px] text-muted-foreground"
      dateTime={value ?? undefined}
    >
      {formatted}
    </time>
  );
}

function Notice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      aria-live="polite"
      className="mt-4 flex flex-wrap items-center gap-2.5 rounded-md bg-destructive/8 px-3 py-2 text-xs ring-1 ring-destructive/20"
      role="status"
    >
      {/* Red body text on this warm surface measures 4.16:1; the tint plus icon
          carries the alert without dropping below AA for small text. */}
      <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 break-words text-foreground">{message}</span>
      {onRetry ? (
        <button
          className="inline-flex h-11 min-w-11 shrink-0 items-center gap-1.5 rounded-md border px-2.5 font-medium text-foreground hover:bg-destructive/10 sm:h-8"
          type="button"
          onClick={onRetry}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("moderation.retry")}
        </button>
      ) : null}
    </div>
  );
}

function ModerationPanel<T>({
  query,
  emptyLabel,
  rowKey,
  renderRow,
}: {
  query: UseQueryResult<ModerationRead<T>>;
  emptyLabel: MessageKey;
  rowKey: (row: T) => string;
  renderRow: (row: T) => ReactNode;
}) {
  const read = query.data;

  if (query.isPending) {
    return (
      <p aria-live="polite" className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        {t("moderation.loading")}
      </p>
    );
  }
  if (!read || read.state === "error") {
    return <Notice message={t("moderation.error")} onRetry={() => void query.refetch()} />;
  }
  if (read.state === "forbidden") {
    return <Notice message={t("moderation.forbidden")} />;
  }
  if (read.state === "timeout") {
    return <Notice message={t("moderation.timeout")} onRetry={() => void query.refetch()} />;
  }
  if (read.rows.length === 0) {
    return (
      <p aria-live="polite" className="mt-4 text-xs text-muted-foreground">
        {t(emptyLabel)}
      </p>
    );
  }
  return (
    <ul className="mt-4 space-y-2">
      {read.rows.map((row) => (
        <li key={rowKey(row)}>{renderRow(row)}</li>
      ))}
    </ul>
  );
}

function ReportRow({ row }: { row: ModerationReport }) {
  return (
    <article className="rounded-lg border bg-background/25 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{knownLabel(REPORT_STATUSES, row.status)}</Badge>
        <span className="min-w-0 text-sm font-medium">
          {knownLabel(REPORT_TYPES, row.report_type)}
        </span>
        <Timestamp value={row.created_at} />
      </div>
      <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
        <Field label={t("moderation.target")}>
          {t(TARGET_KINDS[row.target_kind])} · {truncatePubkey(row.target)}
        </Field>
        <Field label={t("moderation.reporter")}>{truncatePubkey(row.reporter_pubkey)}</Field>
      </dl>
      {row.note ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {row.note}
        </p>
      ) : null}
    </article>
  );
}

function ActionRow({ row }: { row: ModerationAction }) {
  const target = row.target_pubkey ?? row.target_event_id;
  return (
    <article className="rounded-lg border bg-background/25 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-sm font-medium">{knownLabel(ACTIONS, row.action)}</span>
        <Timestamp value={row.created_at} />
      </div>
      <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
        <Field label={t("moderation.actor")}>{truncatePubkey(row.actor_pubkey)}</Field>
        {target ? <Field label={t("moderation.target")}>{truncatePubkey(target)}</Field> : null}
        {row.reason_code ? <Field label={t("moderation.reason")}>{row.reason_code}</Field> : null}
      </dl>
      {row.public_reason ? (
        <p className="mt-2 break-words text-xs">
          <span className="text-muted-foreground">{t("moderation.publicReason")}: </span>
          {row.public_reason}
        </p>
      ) : null}
      {row.private_reason ? (
        <p className="mt-1 break-words text-xs">
          <span className="text-muted-foreground">{t("moderation.privateReason")}: </span>
          {row.private_reason}
        </p>
      ) : null}
    </article>
  );
}

function RestrictionRow({ row }: { row: ModerationRestriction }) {
  const mutedUntil = formatTime(row.muted_until);
  return (
    <article className="rounded-lg border bg-background/25 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-mono text-xs">{truncatePubkey(row.pubkey)}</span>
        {row.banned ? <Badge>{t("moderation.banned")}</Badge> : null}
        {row.muted_until && mutedUntil ? <Badge>{t("moderation.timedOut")}</Badge> : null}
        <Timestamp value={row.updated_at} />
      </div>
      <dl className="mt-2 grid gap-1 text-xs">
        {row.ban_reason ? <Field label={t("moderation.banReason")}>{row.ban_reason}</Field> : null}
        {row.mute_reason ? (
          <Field label={t("moderation.muteReason")}>{row.mute_reason}</Field>
        ) : null}
        {mutedUntil ? (
          <Field label={t("moderation.expires")}>{mutedUntil}</Field>
        ) : row.ban_expires_at && formatTime(row.ban_expires_at) ? (
          <Field label={t("moderation.expires")}>{formatTime(row.ban_expires_at)}</Field>
        ) : null}
      </dl>
    </article>
  );
}

const TABS: ModerationSection[] = ["reports", "audit", "restricted"];

function tabLabel(view: ModerationSection): string {
  if (view === "audit") return t("moderation.tab.audit");
  if (view === "restricted") return t("moderation.tab.restricted");
  return t("moderation.tab.reports");
}

export function ModerationView({
  relayUrl,
  viewerPubkey,
  role,
  onClose,
}: {
  relayUrl: string;
  viewerPubkey: string;
  role: MemberRole | null;
  onClose: () => void;
}) {
  const [view, setView] = useState<ModerationSection>("reports");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const options = { relayUrl, viewerPubkey, role };
  const reports = useModerationReports(options);
  const audit = useModerationAudit(options);
  const restricted = useModerationRestricted(options);

  // Presentation gate only: the Relay still enforces ViewQueue on every read.
  if (!canViewModeration(role)) return null;

  const selectTab = (index: number) => {
    setView(TABS[index]);
    tabRefs.current[index]?.focus();
  };

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight") selectTab((index + 1) % TABS.length);
    else if (event.key === "ArrowLeft") selectTab((index - 1 + TABS.length) % TABS.length);
    else if (event.key === "Home") selectTab(0);
    else if (event.key === "End") selectTab(TABS.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div className="buzz-scrollbar min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1280px] px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1 pr-8 sm:pr-0">
            <h2 className="flex items-center gap-2 text-[22px] font-semibold leading-tight">
              <ShieldCheck className="h-5 w-5 shrink-0 text-muted-foreground" />
              {t("moderation.title")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("moderation.subtitle")}</p>
          </div>
          <button
            aria-label={t("moderation.close")}
            className="absolute right-5 top-6 inline-flex size-11 shrink-0 items-center justify-center rounded-[0.35rem] text-[var(--buzz-chrome-foreground)] transition-colors hover:bg-[var(--buzz-hover-surface)] hover:text-foreground sm:static sm:size-8"
            title={t("moderation.close")}
            type="button"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <p className="mt-3 text-[11px] text-muted-foreground">{t("moderation.privacyNote")}</p>

        <div aria-label={t("moderation.tabs")} className="mt-6 flex gap-6 border-b" role="tablist">
          {TABS.map((tab, index) => (
            <button
              key={tab}
              aria-controls="moderation-panel"
              aria-selected={view === tab}
              className={`h-11 shrink-0 border-b-2 px-0.5 text-sm font-medium ${
                view === tab
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              id={`moderation-tab-${tab}`}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              role="tab"
              tabIndex={view === tab ? 0 : -1}
              type="button"
              onClick={() => setView(tab)}
              onKeyDown={(event) => moveTab(event, index)}
            >
              {tabLabel(tab)}
            </button>
          ))}
        </div>

        <div
          aria-labelledby={`moderation-tab-${view}`}
          className="min-h-0"
          id="moderation-panel"
          role="tabpanel"
        >
          {view === "reports" ? (
            <ModerationPanel
              emptyLabel="moderation.emptyReports"
              query={reports}
              renderRow={(row) => <ReportRow row={row} />}
              rowKey={(row) => row.id}
            />
          ) : view === "audit" ? (
            <ModerationPanel
              emptyLabel="moderation.emptyAudit"
              query={audit}
              renderRow={(row) => <ActionRow row={row} />}
              rowKey={(row) => row.id}
            />
          ) : (
            <ModerationPanel
              emptyLabel="moderation.emptyRestricted"
              query={restricted}
              renderRow={(row) => <RestrictionRow row={row} />}
              rowKey={(row) => row.pubkey}
            />
          )}
        </div>
      </div>
    </div>
  );
}
