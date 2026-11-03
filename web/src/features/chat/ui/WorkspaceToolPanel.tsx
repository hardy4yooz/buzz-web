import type { ReactNode } from "react";
import { t } from "@/shared/i18n";

export type WorkspaceTool = "agents" | "inbox" | "moderation" | "new-dm" | "repos" | "settings";

export function WorkspaceToolPanel({
  tool,
  children,
}: {
  tool: WorkspaceTool;
  children: ReactNode;
}) {
  return (
    <main
      aria-label={t("workspace.toolPanel", { name: t(`workspace.tool.${tool}`) })}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background/65"
      data-testid={`workspace-tool-${tool}`}
    >
      {children}
    </main>
  );
}
