import {
  BellOff,
  Bot,
  Compass,
  Ellipsis,
  GitBranch,
  Hash,
  Inbox,
  Lock,
  MessageCircle,
  MessagesSquare,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Star,
  UserRoundCog,
  UserRoundPlus,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import buzzAppIcon from "@/assets/app-icon@3x.png";
import { channelDisplayName } from "@/features/chat/lib/chat-model";
import type { BuzzChannel, UserProfile } from "@/features/chat/lib/chat-types";
import { connectionStateLabel } from "@/features/chat/lib/connection-state";
import { Avatar } from "@/features/chat/ui/Avatar";
import { LeftPanelResizeHandle } from "@/features/chat/ui/LeftPanelSizing";
import type { WorkspaceTool } from "@/features/chat/ui/WorkspaceToolPanel";
import type { RelayConnectionState } from "@/shared/api/nostr-types";
import type { RelayFeatureState } from "@/shared/features/relay-features";
import { t } from "@/shared/i18n";

function ConnectionDot({ state }: { state: RelayConnectionState }) {
  const color =
    state === "connected"
      ? "bg-emerald-500"
      : state === "connecting" || state === "reconnecting"
        ? "bg-amber-500"
        : "bg-rose-500";
  return (
    <span
      className={`h-2 w-2 rounded-full ${color}`}
      aria-label={connectionStateLabel(state)}
      role="img"
    />
  );
}

function navRow(active: boolean, unread = false): string {
  return `flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors ${
    active
      ? "bg-foreground/10 font-semibold text-foreground"
      : unread
        ? "font-semibold text-foreground hover:bg-foreground/5"
        : "text-foreground/85 hover:bg-foreground/5"
  }`;
}

function ChannelUnreadDot({ channelId }: { channelId: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-full bg-primary"
      data-testid={`channel-unread-${channelId}`}
    />
  );
}

export function AppNavigation({
  communityName,
  relayUrl,
  channels,
  selectedChannelId,
  profiles,
  presence,
  currentPubkey,
  connectionState,
  mobileOpen,
  canCreateChannel,
  canManageMembers,
  canModerate,
  activeTool,
  inboxUnreadCount,
  showWorkflows,
  channelUnreadCounts,
  starredChannelIds,
  mutedChannelIds,
  features,
  maximumWidth,
  panelWidth,
  onCloseMobile,
  onSelectChannel,
  onBrowseChannels,
  onNewDm,
  onSearch,
  onSettings,
  onInvite,
  onSwitchIdentity,
  onShowMessages,
  onToggleTool,
  onResize,
}: {
  communityName: string;
  relayUrl: string;
  channels: BuzzChannel[];
  selectedChannelId: string | null;
  profiles: Record<string, UserProfile>;
  presence: Record<string, "online" | "away" | "offline">;
  currentPubkey: string;
  connectionState: RelayConnectionState;
  mobileOpen: boolean;
  canCreateChannel: boolean;
  canManageMembers: boolean;
  canModerate: boolean;
  activeTool: WorkspaceTool | null;
  inboxUnreadCount: number;
  showWorkflows: boolean;
  channelUnreadCounts: Readonly<Record<string, number>>;
  features: RelayFeatureState;
  maximumWidth: number;
  panelWidth: number;
  onCloseMobile: () => void;
  onSelectChannel: (id: string) => void;
  onBrowseChannels: () => void;
  onNewDm: () => void;
  onSearch: () => void;
  onSettings: () => void;
  onInvite: () => void;
  onSwitchIdentity: () => void;
  onShowMessages: () => void;
  onToggleTool: (tool: WorkspaceTool) => void;
  onResize: (width: number) => void;
  starredChannelIds: ReadonlySet<string>;
  mutedChannelIds: ReadonlySet<string>;
}) {
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const profile = profiles[currentPubkey] ?? {
    pubkey: currentPubkey,
    name: t("system.you"),
    about: "",
    picture: null,
    isAgent: false,
  };
  const sortChannels = (items: BuzzChannel[]) =>
    [...items].sort(
      (left, right) =>
        Number(starredChannelIds.has(right.id)) - Number(starredChannelIds.has(left.id)) ||
        left.name.localeCompare(right.name),
    );
  const streamChannels = sortChannels(channels.filter((channel) => channel.type === "stream"));
  const forumChannels = sortChannels(channels.filter((channel) => channel.type === "forum"));
  const directMessages = sortChannels(channels.filter((channel) => channel.type === "dm"));
  const select = (id: string) => {
    onSelectChannel(id);
    onCloseMobile();
  };

  useEffect(() => {
    if (mobileOpen) mobileCloseRef.current?.focus();
  }, [mobileOpen]);

  useEffect(() => {
    if (!profileMenuOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) setProfileMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [profileMenuOpen]);

  const runProfileAction = (action: () => void) => {
    setProfileMenuOpen(false);
    action();
  };

  return (
    <>
      <nav className="hidden w-11 shrink-0 flex-col items-center border-r border-black/5 py-2 md:flex dark:border-white/5">
        <img alt="Buzz" className="h-8 w-8 rounded-lg" src={buzzAppIcon} />
        <button
          aria-label={canManageMembers ? t("invite.title") : t("nav.newDm")}
          className="mt-2 flex h-8 w-8 items-center justify-center rounded-full bg-background/60 text-foreground/70 transition-colors hover:bg-background/90"
          title={canManageMembers ? t("invite.title") : t("nav.newDm")}
          type="button"
          onClick={canManageMembers ? onInvite : onNewDm}
        >
          <Plus className="h-[18px] w-[18px]" />
        </button>
        <div className="mt-auto pb-1">
          <ConnectionDot state={connectionState} />
        </div>
      </nav>

      {mobileOpen ? (
        <button
          aria-label={t("nav.closeChannels")}
          className="fixed inset-0 z-40 bg-black/35 md:hidden"
          type="button"
          onClick={onCloseMobile}
        />
      ) : null}

      <aside
        className={`relative z-50 flex shrink-0 flex-col overflow-hidden border-r border-black/5 bg-transparent transition-transform dark:border-white/5 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:!w-[282px] max-md:bg-[linear-gradient(to_bottom,var(--buzz-gradient-top),var(--buzz-gradient-bottom))] max-md:shadow-2xl ${mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full"}`}
        style={{ width: panelWidth }}
      >
        <LeftPanelResizeHandle
          label={t("nav.resize")}
          maximum={maximumWidth}
          panelWidth={panelWidth}
          onResize={onResize}
        />

        <header className="flex h-11 shrink-0 items-center gap-1.5 px-2">
          <button
            aria-label={t("common.search")}
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-background/35 px-2.5 text-left text-xs text-muted-foreground hover:bg-background/55"
            type="button"
            onClick={onSearch}
          >
            <Search className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t("nav.searchEverything")}</span>
            <kbd className="shrink-0 text-[10px] opacity-65">⌘K</kbd>
          </button>
          <button
            ref={mobileCloseRef}
            aria-label={t("common.close")}
            className="buzz-icon-button md:!hidden"
            type="button"
            onClick={onCloseMobile}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="buzz-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-5">
          <nav aria-label={t("nav.workspace")} className="space-y-0.5">
            <button
              aria-label={t("inbox.title")}
              aria-pressed={activeTool === "inbox"}
              className={`${navRow(activeTool === "inbox")} relative`}
              type="button"
              onClick={() => onToggleTool("inbox")}
            >
              <Inbox className="h-[17px] w-[17px] shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("inbox.title")}</span>
              {inboxUnreadCount ? (
                <span
                  className="flex min-h-5 min-w-5 items-center justify-center rounded-full bg-foreground/10 px-1.5 text-[10px] font-semibold"
                  data-testid="inbox-unread-count"
                >
                  {inboxUnreadCount > 99 ? "99+" : inboxUnreadCount}
                </span>
              ) : null}
            </button>
            {features.projects ? (
              <button
                aria-label={t("nav.projects")}
                aria-pressed={activeTool === "repos"}
                className={navRow(activeTool === "repos")}
                type="button"
                onClick={() => onToggleTool("repos")}
              >
                <GitBranch className="h-[17px] w-[17px] shrink-0" />
                <span>{t("nav.projects")}</span>
              </button>
            ) : null}
            {showWorkflows ? (
              <button
                aria-label={t("nav.workflows")}
                aria-pressed={activeTool === "workflows"}
                className={navRow(activeTool === "workflows")}
                type="button"
                onClick={() => onToggleTool("workflows")}
              >
                <Workflow className="h-[17px] w-[17px] shrink-0" />
                <span>{t("nav.workflows")}</span>
              </button>
            ) : null}
            {canModerate ? (
              <button
                aria-label={t("nav.moderation")}
                aria-pressed={activeTool === "moderation"}
                className={navRow(activeTool === "moderation")}
                type="button"
                onClick={() => onToggleTool("moderation")}
              >
                <ShieldCheck className="h-[17px] w-[17px] shrink-0" />
                <span>{t("nav.moderation")}</span>
              </button>
            ) : null}
            <button
              aria-label={t("agents.title")}
              aria-pressed={activeTool === "agents"}
              className={navRow(activeTool === "agents")}
              type="button"
              onClick={() => onToggleTool("agents")}
            >
              <Bot className="h-[17px] w-[17px] shrink-0" />
              <span>{t("agents.title")}</span>
            </button>
          </nav>

          <section className="mt-5">
            <div className="mb-1 flex h-7 items-center justify-between px-3">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("nav.channels")}
              </span>
              <span className="flex items-center gap-0.5">
                <button
                  aria-label={t("channel.browserTitle")}
                  className="buzz-icon-button h-6 w-6 flex-none"
                  title={t("channel.browserTitle")}
                  type="button"
                  onClick={onBrowseChannels}
                >
                  <Compass className="h-3.5 w-3.5" />
                </button>
                {canCreateChannel ? null : (
                  <span className="sr-only">{t("nav.onlyAdminCreate")}</span>
                )}
              </span>
            </div>
            {streamChannels.map((channel) => {
              const selected = activeTool === null && selectedChannelId === channel.id;
              const unreadCount = channelUnreadCounts[channel.id] ?? 0;
              return (
                <button
                  key={channel.id}
                  aria-pressed={selected}
                  className={navRow(selected, unreadCount > 0)}
                  title={
                    unreadCount > 0
                      ? t("nav.unreadIn", { count: unreadCount, name: channel.name })
                      : undefined
                  }
                  type="button"
                  onClick={() => select(channel.id)}
                >
                  {channel.visibility === "private" ? (
                    <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                  {starredChannelIds.has(channel.id) ? (
                    <Star className="h-3 w-3 shrink-0 fill-current text-primary" />
                  ) : null}
                  {mutedChannelIds.has(channel.id) ? (
                    <BellOff className="h-3 w-3 shrink-0 text-muted-foreground" />
                  ) : null}
                  {unreadCount > 0 ? <ChannelUnreadDot channelId={channel.id} /> : null}
                </button>
              );
            })}
          </section>

          {features.forum ? (
            <section className="mt-6">
              <div className="mb-1 flex h-7 items-center px-3 text-[11px] font-medium text-muted-foreground">
                {t("nav.forums")}
              </div>
              {forumChannels.map((channel) => {
                const selected = activeTool === null && selectedChannelId === channel.id;
                const unreadCount = channelUnreadCounts[channel.id] ?? 0;
                return (
                  <button
                    key={channel.id}
                    aria-pressed={selected}
                    className={navRow(selected, unreadCount > 0)}
                    title={
                      unreadCount > 0
                        ? t("nav.unreadIn", { count: unreadCount, name: channel.name })
                        : undefined
                    }
                    type="button"
                    onClick={() => select(channel.id)}
                  >
                    <MessagesSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                    {starredChannelIds.has(channel.id) ? (
                      <Star className="h-3 w-3 shrink-0 fill-current text-primary" />
                    ) : null}
                    {mutedChannelIds.has(channel.id) ? (
                      <BellOff className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : null}
                    {unreadCount > 0 ? <ChannelUnreadDot channelId={channel.id} /> : null}
                  </button>
                );
              })}
            </section>
          ) : null}

          <section className="mt-6">
            <div className="mb-1 flex h-7 items-center justify-between px-2.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("nav.directMessages")}
              </span>
              <button
                aria-label={t("nav.newDm")}
                className="buzz-icon-button h-6 w-6 flex-none"
                title={t("nav.newDm")}
                type="button"
                onClick={onNewDm}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {directMessages.map((channel) => {
              const name = channelDisplayName(channel, profiles, currentPubkey);
              const other = channel.participantPubkeys.find((value) => value !== currentPubkey);
              const dmProfile = other ? profiles[other] : null;
              const selected = activeTool === null && selectedChannelId === channel.id;
              const unreadCount = channelUnreadCounts[channel.id] ?? 0;
              return (
                <button
                  key={channel.id}
                  aria-label={name}
                  aria-pressed={selected}
                  className={navRow(selected, unreadCount > 0)}
                  title={
                    unreadCount > 0 ? t("nav.unreadIn", { count: unreadCount, name }) : undefined
                  }
                  type="button"
                  onClick={() => select(channel.id)}
                >
                  {dmProfile ? (
                    <Avatar
                      profile={dmProfile}
                      relayUrl={relayUrl}
                      size={23}
                      showStatus
                      status={other ? presence[other] : undefined}
                    />
                  ) : (
                    <MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  {starredChannelIds.has(channel.id) ? (
                    <Star className="h-3 w-3 shrink-0 fill-current text-primary" />
                  ) : null}
                  {mutedChannelIds.has(channel.id) ? (
                    <BellOff className="h-3 w-3 shrink-0 text-muted-foreground" />
                  ) : null}
                  {unreadCount > 0 ? <ChannelUnreadDot channelId={channel.id} /> : null}
                </button>
              );
            })}
          </section>
        </div>

        <footer className="relative shrink-0 px-2 pb-2" ref={profileMenuRef}>
          {profileMenuOpen ? (
            <div
              aria-label={t("nav.profileMenu")}
              className="absolute bottom-full left-2 right-2 z-50 mb-1 rounded-lg border border-border/70 bg-popover p-1.5 text-popover-foreground shadow-xl"
              role="menu"
            >
              {canManageMembers ? (
                <button
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-foreground/6"
                  role="menuitem"
                  type="button"
                  onClick={() => runProfileAction(onInvite)}
                >
                  <UserRoundPlus className="h-4 w-4 text-muted-foreground" />
                  {t("invite.title")}
                </button>
              ) : null}
              <button
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-foreground/6"
                role="menuitem"
                type="button"
                onClick={() => runProfileAction(onSettings)}
              >
                <Settings className="h-4 w-4 text-muted-foreground" />
                {t("common.settings")}
              </button>
              <div className="my-1 h-px bg-border" />
              <button
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-foreground/6"
                role="menuitem"
                type="button"
                onClick={() => runProfileAction(onSwitchIdentity)}
              >
                <UserRoundCog className="h-4 w-4 text-muted-foreground" />
                {t("identity.switch")}
              </button>
            </div>
          ) : null}
          <button
            aria-expanded={profileMenuOpen}
            aria-haspopup="menu"
            aria-label={t("nav.profileMenu")}
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-foreground/5"
            type="button"
            onClick={() => setProfileMenuOpen((open) => !open)}
          >
            <Avatar profile={profile} relayUrl={relayUrl} size={27} showStatus status="online" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold">{profile.name}</div>
              <div className="mt-0.5 flex items-center gap-1.5 truncate text-[9px] text-muted-foreground">
                <ConnectionDot state={connectionState} />
                <span className="truncate">{communityName}</span>
              </div>
            </div>
            <Ellipsis className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        </footer>
      </aside>

      <nav className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-center justify-around border-t bg-background/95 px-[max(1rem,env(safe-area-inset-left))] pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <button
          aria-label={t("inbox.title")}
          aria-pressed={activeTool === "inbox"}
          className="buzz-icon-button relative"
          type="button"
          onClick={() => onToggleTool("inbox")}
        >
          <Inbox className="h-5 w-5" />
          {inboxUnreadCount ? (
            <span className="absolute right-0 top-0 h-2 w-2 rounded-full bg-primary" />
          ) : null}
        </button>
        <button
          aria-label={t("common.messages")}
          aria-pressed={activeTool === null}
          className="buzz-icon-button"
          type="button"
          onClick={onShowMessages}
        >
          <MessagesSquare className="h-5 w-5" />
        </button>
        {features.projects ? (
          <button
            aria-label={t("nav.projects")}
            aria-pressed={activeTool === "repos"}
            className="buzz-icon-button"
            type="button"
            onClick={() => onToggleTool("repos")}
          >
            <GitBranch className="h-5 w-5" />
          </button>
        ) : null}
        <button
          aria-label={t("agents.title")}
          aria-pressed={activeTool === "agents"}
          className="buzz-icon-button"
          type="button"
          onClick={() => onToggleTool("agents")}
        >
          <Bot className="h-5 w-5" />
        </button>
        <button
          aria-label={t("common.settings")}
          className="buzz-icon-button"
          type="button"
          onClick={onSettings}
        >
          <Settings className="h-5 w-5" />
        </button>
      </nav>
    </>
  );
}
