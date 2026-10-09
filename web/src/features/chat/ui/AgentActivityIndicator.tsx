import {
  Activity,
  Brain,
  CircleAlert,
  LoaderCircle,
  MessageCircle,
  Radio,
  Wrench,
} from "lucide-react";
import type { ActivityState, AgentActivityStatus } from "@/features/chat/lib/agent-activity";
import type { UserProfile } from "@/features/chat/lib/chat-types";
import { t } from "@/shared/i18n";

const stateIcon: Record<ActivityState, typeof Radio> = {
  working: LoaderCircle,
  thinking: Brain,
  tool: Wrench,
  responding: MessageCircle,
  quiet: Radio,
  reconnecting: LoaderCircle,
  disconnected: CircleAlert,
  unavailable: CircleAlert,
};

function stateLabel(state: ActivityState): string {
  return t(`activity.${state}` as Parameters<typeof t>[0]);
}

export function AgentActivityIndicator({
  statuses,
  profiles,
  itemCount,
  onOpen,
}: {
  statuses: AgentActivityStatus[];
  profiles: Record<string, UserProfile>;
  itemCount: number;
  onOpen: () => void;
}) {
  const visible = statuses.length > 0 || itemCount > 0;
  const label = statuses
    .map((status) => {
      const state = `${profiles[status.agentPubkey]?.name ?? t("common.agent")}: ${stateLabel(status.state)}`;
      return status.summary ? `${state} — ${status.summary}` : state;
    })
    .join(" · ");
  const accessibleLabel = statuses.some((status) => status.state === "unavailable")
    ? t("activity.unavailableDescription")
    : label || t("activity.recent");
  const Icon = statuses[0] ? stateIcon[statuses[0].state] : CircleAlert;
  return (
    <div
      className="flex h-8 shrink-0 items-center px-5 text-[11px] text-muted-foreground"
      aria-live="polite"
    >
      {visible ? (
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5"
          data-testid="agent-activity-indicator"
        >
          <Icon
            className={`h-3.5 w-3.5 shrink-0 ${statuses[0]?.state === "working" || statuses[0]?.state === "thinking" || statuses[0]?.state === "tool" || statuses[0]?.state === "reconnecting" ? "animate-pulse" : ""}`}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate font-mono">{accessibleLabel}</span>
          {itemCount > 0 ? (
            <button
              className="ml-1 inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-sans font-medium text-foreground/75 hover:bg-foreground/6 hover:text-foreground"
              type="button"
              onClick={onOpen}
            >
              <Activity className="h-3 w-3" aria-hidden="true" />
              {t("activity.view")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
