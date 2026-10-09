import { TerminalSquare, X } from "lucide-react";
import type {
  ActivityState,
  AgentActivityItem,
  AgentActivityStatus,
} from "@/features/chat/lib/agent-activity";
import type { UserProfile } from "@/features/chat/lib/chat-types";
import { getLocale, t } from "@/shared/i18n";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { RightPanelResizeHandle } from "@/shared/ui/right-panel-sizing";

function stateLabel(state: ActivityState): string {
  return t(`activity.${state}` as Parameters<typeof t>[0]);
}

function frameTime(timestamp: string): string {
  return new Intl.DateTimeFormat(getLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

export function AgentActivityPanel({
  items,
  statuses,
  profiles,
  maximumWidth,
  minimumWidth,
  panelWidth,
  onClose,
  onResize,
}: {
  items: AgentActivityItem[];
  statuses: AgentActivityStatus[];
  profiles: Record<string, UserProfile>;
  maximumWidth: number;
  minimumWidth: number;
  panelWidth: number;
  onClose: () => void;
  onResize: (width: number) => void;
}) {
  const newestFirst = [...items].reverse();
  const visibleItems = newestFirst.filter(
    (item) =>
      !["raw_json_rpc", "session_config_captured", "turn_liveness"].includes(
        item.frame.kind.toLowerCase(),
      ),
  );

  return (
    <aside
      aria-label={t("activity.panelTitle")}
      className="relative flex min-h-0 shrink-0 flex-col border-l bg-background max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:shadow-xl max-sm:!w-full"
      style={{ width: panelWidth }}
    >
      <RightPanelResizeHandle
        label={t("activity.resize")}
        maximum={maximumWidth}
        minimum={minimumWidth}
        panelWidth={panelWidth}
        onResize={onResize}
      />
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold">{t("activity.panelTitle")}</h2>
          <p className="text-[10px] text-muted-foreground">
            {statuses.length
              ? statuses.map((status) => stateLabel(status.state)).join(" · ")
              : t("activity.recent")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            aria-label={t("activity.close")}
            className="buzz-icon-button h-7 w-7 flex-none"
            title={t("activity.close")}
            type="button"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="buzz-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
        {visibleItems.length ? (
          <ol className="space-y-2">
            {visibleItems.map((item) => {
              const profile = profiles[item.agentPubkey];
              return (
                <li className="rounded-md border bg-foreground/[0.025] p-2.5" key={item.id}>
                  <div className="flex min-w-0 items-start gap-2">
                    <TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="min-w-0 truncate text-xs font-semibold">
                          {profile?.name ?? truncatePubkey(item.agentPubkey)} ·{" "}
                          {item.presentation.title}
                        </p>
                        <time className="shrink-0 text-[9px] text-muted-foreground">
                          {frameTime(item.frame.timestamp)}
                        </time>
                      </div>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {stateLabel(item.presentation.state)} · {item.frame.kind}
                      </p>
                    </div>
                  </div>

                  {item.presentation.detail ? (
                    <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-foreground/5 p-2 font-mono text-[10px] leading-4 text-foreground/85">
                      {item.presentation.detail}
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="flex h-full min-h-40 items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {items.length ? t("activity.compactEmpty") : t("activity.empty")}
          </div>
        )}
      </div>
      <p className="shrink-0 border-t px-3 py-2 text-[9px] text-muted-foreground">
        {t("activity.inMemory")}
      </p>
    </aside>
  );
}
