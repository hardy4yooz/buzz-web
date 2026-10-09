import { PanelResizeHandle, usePersistedPanelWidth } from "@/shared/ui/resizable-panel";

type RightPanelKind = "activity" | "agent" | "channel" | "thread";

const PANEL_SPECS: Record<
  RightPanelKind,
  { defaultWidth: number; minimumWidth: number; storageKey: string }
> = {
  activity: {
    defaultWidth: 420,
    minimumWidth: 320,
    storageKey: "buzz-web-activity-panel-width-v1",
  },
  agent: {
    defaultWidth: 360,
    minimumWidth: 320,
    storageKey: "buzz-web-agent-panel-width-v1",
  },
  channel: {
    defaultWidth: 320,
    minimumWidth: 280,
    storageKey: "buzz-web-channel-panel-width-v1",
  },
  thread: {
    defaultWidth: 380,
    minimumWidth: 300,
    storageKey: "buzz-web-thread-panel-width-v2",
  },
};

export function useRightPanelWidth(kind: RightPanelKind) {
  const spec = PANEL_SPECS[kind];
  return usePersistedPanelWidth({
    ...spec,
    maximumWidth: 720,
    reservedWidth: 720,
  });
}

export function RightPanelResizeHandle({
  label,
  maximum,
  minimum,
  panelWidth,
  onResize,
}: {
  label: string;
  maximum: number;
  minimum: number;
  panelWidth: number;
  onResize: (width: number) => void;
}) {
  return (
    <PanelResizeHandle
      className="left-0 z-40 -translate-x-1/2 transition-colors hover:bg-primary/20 focus:bg-primary/30 max-sm:hidden"
      edge="left"
      label={label}
      maximum={maximum}
      minimum={minimum}
      panelWidth={panelWidth}
      onResize={onResize}
    />
  );
}
