import { AlertTriangle, Hash, LoaderCircle, Lock, Menu, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import buzzAppIcon from "@/assets/app-icon@3x.png";
import { AgentsView } from "@/features/agents/ui/AgentsView";
import { useRelayAgents } from "@/features/agents/use-relay-agents";
import { channelDisplayName, threadReference } from "@/features/chat/lib/chat-model";
import type { BuzzChannel, TimelineMessage } from "@/features/chat/lib/chat-types";
import { conversationDraftKey } from "@/features/chat/lib/conversation-drafts";
import { useBuzzSession } from "@/features/chat/lib/use-buzz-session";
import { useLiveAgentActivity } from "@/features/chat/lib/use-live-agent-activity";
import { useRelayUserState } from "@/features/chat/lib/use-relay-user-state";
import {
  isEditableShortcutTarget,
  resolveWorkspaceShortcut,
} from "@/features/chat/lib/workspace-shortcuts";
import { AgentActivityIndicator } from "@/features/chat/ui/AgentActivityIndicator";
import { AgentActivityPanel } from "@/features/chat/ui/AgentActivityPanel";
import { SearchDialog } from "@/features/chat/ui/AppDialogs";
import { AppNavigation } from "@/features/chat/ui/AppNavigation";
import {
  ArchiveChannelDialog,
  ChannelBrowserDialog,
} from "@/features/chat/ui/ChannelBrowserDialog";
import { ChannelDetailsPanel } from "@/features/chat/ui/ChannelDetailsPanel";
import { ChannelHeaderActions } from "@/features/chat/ui/ChannelHeaderActions";
import { IdentityGate } from "@/features/chat/ui/IdentityGate";
import { useLeftPanelWidth } from "@/features/chat/ui/LeftPanelSizing";
import { MemberDialog } from "@/features/chat/ui/MemberPanel";
import { MessageComposer } from "@/features/chat/ui/MessageComposer";
import { DeleteMessageDialog, EditMessageDialog } from "@/features/chat/ui/MessageDialogs";
import { MessageList } from "@/features/chat/ui/MessageList";
import { NewDmView } from "@/features/chat/ui/NewDmView";
import { SettingsView } from "@/features/chat/ui/SettingsDialog";
import { ThreadPanel } from "@/features/chat/ui/ThreadPanel";
import { type WorkspaceTool, WorkspaceToolPanel } from "@/features/chat/ui/WorkspaceToolPanel";
import { addCommunityMember, mintCommunityInvite } from "@/features/community/invite-api";
import { CommunityInviteDialog } from "@/features/community/ui/CommunityInviteDialog";
import type { InboxItem } from "@/features/inbox/lib/inbox-model";
import { InboxView } from "@/features/inbox/ui/InboxView";
import { useInbox } from "@/features/inbox/use-inbox";
import { ReposPanel } from "@/features/repos/ui/ReposPanel";
import { clearMediaObjectUrls } from "@/shared/api/media-client";
import { BuzzRelayClient } from "@/shared/api/relay-client";
import { loadRuntimeConfig, type RuntimeConfig } from "@/shared/config/runtime-config";
import { resolveRelayFeatures } from "@/shared/features/relay-features";
import { t } from "@/shared/i18n";
import { useRightPanelWidth } from "@/shared/ui/right-panel-sizing";

type DialogName = "browse" | "search" | "invite" | null;

function Workspace({
  config,
  pubkey,
  demo,
  signOut,
}: {
  config: RuntimeConfig;
  pubkey: string;
  demo: boolean;
  signOut: () => void;
}) {
  const client = useMemo(
    () => (demo ? null : new BuzzRelayClient(config.relayUrl)),
    [config.relayUrl, demo],
  );
  const session = useBuzzSession({ client, config, pubkey, demo });
  const { state, selectedChannel } = session;
  const userState = useRelayUserState({
    client,
    demo,
    relayUrl: config.relayUrl,
    pubkey,
  });
  const [activeTool, setActiveTool] = useState<WorkspaceTool | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [searchChannelId, setSearchChannelId] = useState<string | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [threadReplyTargetId, setThreadReplyTargetId] = useState<string | null>(null);
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [channelDetailsOpen, setChannelDetailsOpen] = useState(false);
  const [activityPanelOpen, setActivityPanelOpen] = useState(false);
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  const [channelBrowserInitialView, setChannelBrowserInitialView] = useState<"browse" | "create">(
    "browse",
  );
  const [insertMention, setInsertMention] = useState<string | null>(null);
  const [relayHasProjects, setRelayHasProjects] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<BuzzChannel | null>(null);
  const [editTarget, setEditTarget] = useState<TimelineMessage | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TimelineMessage | null>(null);
  const [unreadBoundaries, setUnreadBoundaries] = useState<Record<string, number>>({});
  const {
    maximum: maximumNavigationWidth,
    panelWidth: navigationWidth,
    setPanelWidth: setNavigationWidth,
  } = useLeftPanelWidth();
  const {
    maximum: maximumActivityWidth,
    minimum: minimumActivityWidth,
    panelWidth: activityPanelWidth,
    setPanelWidth: setActivityPanelWidth,
  } = useRightPanelWidth("activity");
  const {
    maximum: maximumChannelDetailsWidth,
    minimum: minimumChannelDetailsWidth,
    panelWidth: channelDetailsWidth,
    setPanelWidth: setChannelDetailsWidth,
  } = useRightPanelWidth("channel");
  const {
    maximum: maximumThreadWidth,
    minimum: minimumThreadWidth,
    panelWidth: threadPanelWidth,
    setPanelWidth: setThreadPanelWidth,
  } = useRightPanelWidth("thread");
  const relayAgents = useRelayAgents({
    client,
    demo,
    agentControlUrl: config.agentControlUrl,
    configuredAgents: config.agents,
    channels: state.channels,
    profiles: state.profiles,
    presence: state.presence,
    ensureProfiles: session.ensureProfiles,
    refreshChannels: session.refreshChannels,
  });
  const inbox = useInbox({
    client,
    demo,
    relayUrl: config.relayUrl,
    currentPubkey: pubkey,
    configuredAgents: config.agents,
    channels: state.channels,
    ensureProfiles: session.ensureProfiles,
    readContexts: userState.contexts,
    markContextRead: userState.markContextRead,
  });
  const threadRoot = state.messages.find((message) => message.event.id === threadRootId) ?? null;
  const threadReplyTarget =
    state.messages.find((message) => message.event.id === threadReplyTargetId) ?? null;
  const canCreateChannel = state.communityRole === "owner" || state.communityRole === "admin";
  const selectedRole = selectedChannel?.members.find(
    (member) => member.pubkey.toLowerCase() === pubkey.toLowerCase(),
  )?.role;
  const canManageChannel = canCreateChannel || selectedRole === "owner" || selectedRole === "admin";
  const connected = state.connectionState === "connected";
  const features = resolveRelayFeatures(config.features, {
    projects: relayHasProjects,
    forum: state.channels.some((channel) => channel.type === "forum"),
  });
  const channelAgentPubkeys = useMemo(
    () =>
      selectedChannel?.members
        .filter(
          (member) =>
            member.role === "bot" || state.profiles[member.pubkey.toLowerCase()]?.isAgent === true,
        )
        .map((member) => member.pubkey.toLowerCase()) ?? [],
    [selectedChannel?.members, state.profiles],
  );
  const knownAgentPubkeys = useMemo(
    () => [
      ...new Set(
        state.channels.flatMap((channel) =>
          channel.members
            .filter(
              (member) =>
                member.role === "bot" ||
                state.profiles[member.pubkey.toLowerCase()]?.isAgent === true,
            )
            .map((member) => member.pubkey.toLowerCase()),
        ),
      ),
    ],
    [state.channels, state.profiles],
  );
  const liveAgentActivity = useLiveAgentActivity({
    client,
    demo,
    knownAgentPubkeys,
    ownerPubkey: pubkey,
  });
  const activityStatuses = selectedChannel
    ? liveAgentActivity.statusesFor(selectedChannel.id, channelAgentPubkeys)
    : [];
  const activityItems = selectedChannel
    ? liveAgentActivity.itemsFor(selectedChannel.id, channelAgentPubkeys)
    : [];
  const sendMessage = useCallback(
    async (content: string, attachments: Parameters<typeof session.sendMessage>[1]) => {
      if (!selectedChannel) return;
      await session.sendMessage(content, attachments);
      liveAgentActivity.markSubmitted(selectedChannel.id, channelAgentPubkeys);
    },
    [channelAgentPubkeys, liveAgentActivity, selectedChannel, session],
  );

  useEffect(() => {
    if (!client || demo || config.features.projects || !connected) return;
    let cancelled = false;
    void client
      .query({ kinds: [30617], limit: 1 })
      .then((events) => {
        if (!cancelled) setRelayHasProjects(events.length > 0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, config.features.projects, connected, demo]);

  useEffect(() => {
    if (userState.syncError) toast.error(userState.syncError);
  }, [userState.syncError]);

  useEffect(() => {
    const channelId = state.selectedChannelId;
    if (!channelId || activeTool || !userState.hydrated) return;
    setUnreadBoundaries((current) =>
      current[channelId] === undefined
        ? { ...current, [channelId]: userState.contexts[channelId] ?? 0 }
        : current,
    );
    const latest = state.messages
      .filter((message) => !message.rootId)
      .reduce((timestamp, message) => Math.max(timestamp, message.event.created_at), 0);
    if (latest > 0) inbox.markChannelRead(channelId, latest);
  }, [
    activeTool,
    inbox.markChannelRead,
    state.messages,
    state.selectedChannelId,
    userState.contexts,
    userState.hydrated,
  ]);

  useEffect(() => {
    if (!threadRootId || activeTool || !userState.hydrated) return;
    const latest = state.messages
      .filter((message) => message.rootId === threadRootId)
      .reduce((timestamp, message) => Math.max(timestamp, message.event.created_at), 0);
    if (latest > 0) inbox.markThreadRead(threadRootId, latest);
  }, [activeTool, inbox.markThreadRead, state.messages, threadRootId, userState.hydrated]);

  const handleSignOut = () => {
    client?.disconnect();
    clearMediaObjectUrls();
    signOut();
  };
  const selectChannel = (channelId: string) => {
    setUnreadBoundaries((current) => ({
      ...current,
      [channelId]: userState.contexts[channelId] ?? 0,
    }));
    setActiveTool(null);
    setThreadRootId(null);
    setThreadReplyTargetId(null);
    setChannelDetailsOpen(false);
    setActivityPanelOpen(false);
    setMemberDialogOpen(false);
    setFocusedMessageId(null);
    session.selectChannel(channelId);
  };
  const toggleTool = (tool: WorkspaceTool) => {
    setActiveTool((current) => (current === tool ? null : tool));
    setThreadRootId(null);
    setThreadReplyTargetId(null);
    setChannelDetailsOpen(false);
    setActivityPanelOpen(false);
    setMemberDialogOpen(false);
    setMobileNavigationOpen(false);
    setFocusedMessageId(null);
  };
  const showMessages = () => {
    setActiveTool(null);
    setChannelDetailsOpen(false);
    setActivityPanelOpen(false);
    setMobileNavigationOpen(false);
    setFocusedMessageId(null);
  };
  const revealMessage = (channelId: string, eventId: string, threadId: string | null) => {
    setActiveTool(null);
    setMobileNavigationOpen(false);
    setChannelDetailsOpen(false);
    setActivityPanelOpen(false);
    setMemberDialogOpen(false);
    setThreadRootId(threadId);
    setThreadReplyTargetId(null);
    setFocusedMessageId(eventId);
    session.revealMessage({ channelId, eventId, threadRootId: threadId });
  };
  const openInboxConversation = (item: InboxItem) => {
    if (!item.channelId) return;
    revealMessage(item.channelId, item.event.id, item.threadRootId);
  };
  const openAgentDm = async (targetPubkey: string) => {
    try {
      await session.openDm(targetPubkey);
      setActiveTool(null);
      setThreadRootId(null);
      setThreadReplyTargetId(null);
      setChannelDetailsOpen(false);
      setActivityPanelOpen(false);
      setMemberDialogOpen(false);
      setFocusedMessageId(null);
    } catch (openError) {
      toast.error(openError instanceof Error ? openError.message : t("error.dmOpen"));
    }
  };
  const openThread = (message: TimelineMessage, reply: boolean) => {
    setActiveTool(null);
    setChannelDetailsOpen(false);
    setActivityPanelOpen(false);
    setThreadRootId(message.event.id);
    setThreadReplyTargetId(reply ? message.event.id : null);
    setFocusedMessageId(null);
  };
  const toggleChannelDetails = () => {
    setActiveTool(null);
    setThreadRootId(null);
    setThreadReplyTargetId(null);
    setActivityPanelOpen(false);
    setChannelDetailsOpen((open) => !open);
  };
  const openActivityPanel = () => {
    setActiveTool(null);
    setThreadRootId(null);
    setThreadReplyTargetId(null);
    setChannelDetailsOpen(false);
    setActivityPanelOpen(true);
  };
  const openChannelBrowser = useCallback((initialView: "browse" | "create" = "browse") => {
    setChannelBrowserInitialView(initialView);
    setDialog("browse");
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcut = resolveWorkspaceShortcut(event, isEditableShortcutTarget(event.target));
      if (!shortcut) return;
      if (
        dialog ||
        memberDialogOpen ||
        archiveTarget ||
        editTarget ||
        deleteTarget ||
        mobileNavigationOpen
      ) {
        return;
      }

      let handled = true;
      if (shortcut === "search") {
        setSearchChannelId(null);
        setDialog("search");
      } else if (shortcut === "search-channel") {
        if (!selectedChannel || activeTool) handled = false;
        else {
          setSearchChannelId(selectedChannel.id);
          setDialog("search");
        }
      } else if (shortcut === "settings") {
        setActiveTool("settings");
        setThreadRootId(null);
        setThreadReplyTargetId(null);
        setChannelDetailsOpen(false);
        setActivityPanelOpen(false);
        setMemberDialogOpen(false);
        setMobileNavigationOpen(false);
        setFocusedMessageId(null);
      } else if (shortcut === "browse-channels") {
        openChannelBrowser();
      } else if (shortcut === "create-channel") {
        if (!canCreateChannel) handled = false;
        else openChannelBrowser("create");
      } else if (shortcut === "new-dm") {
        setActiveTool("new-dm");
        setThreadRootId(null);
        setThreadReplyTargetId(null);
        setChannelDetailsOpen(false);
        setActivityPanelOpen(false);
        setMemberDialogOpen(false);
        setMobileNavigationOpen(false);
        setFocusedMessageId(null);
      } else if (shortcut === "mark-all-read") {
        inbox.markAllRead();
      } else if (shortcut === "mark-current-read") {
        if (!selectedChannel || activeTool) handled = false;
        else {
          const latestChannelMessage = state.messages
            .filter((message) => !message.rootId)
            .reduce((timestamp, message) => Math.max(timestamp, message.event.created_at), 0);
          if (latestChannelMessage > 0) {
            inbox.markChannelRead(selectedChannel.id, latestChannelMessage);
          }
          if (threadRootId) {
            const latestThreadMessage = state.messages
              .filter((message) => message.rootId === threadRootId)
              .reduce((timestamp, message) => Math.max(timestamp, message.event.created_at), 0);
            if (latestThreadMessage > 0) {
              inbox.markThreadRead(threadRootId, latestThreadMessage);
            }
          }
        }
      }

      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    activeTool,
    archiveTarget,
    canCreateChannel,
    deleteTarget,
    dialog,
    editTarget,
    inbox.markAllRead,
    inbox.markChannelRead,
    inbox.markThreadRead,
    memberDialogOpen,
    mobileNavigationOpen,
    openChannelBrowser,
    selectedChannel,
    state.messages,
    threadRootId,
  ]);

  const displayName = selectedChannel
    ? channelDisplayName(selectedChannel, state.profiles, pubkey)
    : "Buzz";
  const searchChannel = state.channels.find((channel) => channel.id === searchChannelId) ?? null;
  const typingNames = state.typingPubkeys
    .filter(
      (typingPubkey) =>
        !liveAgentActivity.healthy || !channelAgentPubkeys.includes(typingPubkey.toLowerCase()),
    )
    .map((typingPubkey) => state.profiles[typingPubkey]?.name)
    .filter((name): name is string => Boolean(name));

  return (
    <div className="buzz-app-surface flex h-dvh min-h-0 w-full overflow-hidden pb-14 md:p-1.5 md:pb-1.5">
      <AppNavigation
        activeTool={activeTool}
        canCreateChannel={canCreateChannel}
        canManageMembers={canCreateChannel}
        channels={state.channels}
        communityName={config.communityName}
        connectionState={state.connectionState}
        currentPubkey={pubkey}
        channelUnreadCounts={inbox.channelUnreadCounts}
        inboxUnreadCount={inbox.unreadCount}
        features={features}
        mobileOpen={mobileNavigationOpen}
        maximumWidth={maximumNavigationWidth}
        panelWidth={navigationWidth}
        profiles={state.profiles}
        presence={state.presence}
        relayUrl={config.relayUrl}
        selectedChannelId={state.selectedChannelId}
        onCloseMobile={() => setMobileNavigationOpen(false)}
        onBrowseChannels={() => openChannelBrowser()}
        onInvite={() => setDialog("invite")}
        onSwitchIdentity={handleSignOut}
        onNewDm={() => toggleTool("new-dm")}
        onShowMessages={showMessages}
        onToggleTool={toggleTool}
        onSearch={() => {
          setSearchChannelId(null);
          setDialog("search");
        }}
        onSelectChannel={selectChannel}
        onSettings={() => toggleTool("settings")}
        onResize={setNavigationWidth}
        starredChannelIds={userState.starredChannelIds}
        mutedChannelIds={userState.mutedChannelIds}
      />

      <section className="buzz-content-surface relative flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border">
        {!activeTool ? (
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex h-11 shrink-0 items-center gap-2 border-b px-2.5 sm:px-3">
              <button
                aria-label={t("workspace.openChannels")}
                className="buzz-icon-button md:!hidden"
                title={t("common.channel")}
                type="button"
                onClick={() => setMobileNavigationOpen(true)}
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {selectedChannel?.type === "dm" ? (
                  <Users className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
                ) : (
                  <Hash className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
                )}
                <h1 className="truncate text-[15px] font-semibold">{displayName}</h1>
                {selectedChannel?.visibility === "private" ? (
                  <Lock
                    className="h-3 w-3 shrink-0 text-muted-foreground"
                    aria-label={t("common.private")}
                  />
                ) : null}
              </div>
              {selectedChannel ? (
                <ChannelHeaderActions
                  detailsVisible={channelDetailsOpen}
                  memberCount={selectedChannel.members.length}
                  onSearch={() => {
                    setSearchChannelId(selectedChannel.id);
                    setDialog("search");
                  }}
                  onShowDetails={toggleChannelDetails}
                  onShowMembers={() => setMemberDialogOpen(true)}
                />
              ) : null}
            </header>

            {state.error ? (
              <div className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/8 px-4 py-2 text-xs text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{state.error}</span>
                {state.error.toLowerCase().includes("member") || state.error.includes("成员") ? (
                  <button
                    className="shrink-0 font-medium underline"
                    type="button"
                    onClick={handleSignOut}
                  >
                    {t("workspace.changeIdentity")}
                  </button>
                ) : null}
              </div>
            ) : null}

            {selectedChannel ? (
              <>
                <MessageList
                  canModerate={canManageChannel}
                  currentPubkey={pubkey}
                  focusedMessageId={focusedMessageId}
                  loading={state.loadingMessages}
                  messages={state.messages}
                  presence={state.presence}
                  profiles={state.profiles}
                  relayUrl={config.relayUrl}
                  unreadAfter={unreadBoundaries[selectedChannel.id] ?? null}
                  onDelete={setDeleteTarget}
                  onEdit={setEditTarget}
                  onOpenThread={(message) => openThread(message, false)}
                  onReact={session.addReaction}
                  onReply={(message) => openThread(message, true)}
                />
                <AgentActivityIndicator
                  itemCount={activityItems.length}
                  profiles={state.profiles}
                  statuses={activityStatuses}
                  onOpen={openActivityPanel}
                />
                {typingNames.length ? (
                  <div className="h-6 shrink-0 px-5 text-[11px] text-muted-foreground">
                    {t("workspace.typing", { names: typingNames.slice(0, 3).join(", ") })}
                  </div>
                ) : null}
                <MessageComposer
                  key={selectedChannel.id}
                  disabled={!connected}
                  draftKey={conversationDraftKey(config.relayUrl, pubkey, selectedChannel.id)}
                  insertMention={insertMention}
                  members={selectedChannel.members}
                  placeholder={t("workspace.sendTo", {
                    target: selectedChannel.type === "dm" ? displayName : `#${displayName}`,
                  })}
                  profiles={state.profiles}
                  relayUrl={config.relayUrl}
                  onMentionInserted={() => setInsertMention(null)}
                  onSend={sendMessage}
                  onTyping={() => session.notifyTyping()}
                />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                {state.loadingChannels ? (
                  <>
                    <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                    {t("workspace.loadingChannels")}
                  </>
                ) : (
                  t("workspace.noChannels")
                )}
              </div>
            )}
          </main>
        ) : null}

        {activeTool ? (
          <WorkspaceToolPanel tool={activeTool}>
            {activeTool === "agents" ? (
              <AgentsView
                agents={relayAgents.agents}
                channels={state.channels}
                error={relayAgents.error}
                loading={relayAgents.loading}
                pendingAction={relayAgents.pendingAction}
                startingPubkey={relayAgents.startingPubkey}
                profiles={state.profiles}
                relayUrl={config.relayUrl}
                onClose={() => setActiveTool(null)}
                onOpenDm={openAgentDm}
                onRefresh={() => void relayAgents.refresh()}
                onSetChannel={relayAgents.setAgentChannel}
                onStartAgent={relayAgents.startAgent}
              />
            ) : activeTool === "inbox" ? (
              <InboxView
                approvalPending={inbox.approvalPending}
                channels={state.channels}
                error={inbox.error}
                items={inbox.items}
                loading={inbox.loading}
                profiles={state.profiles}
                relayUrl={config.relayUrl}
                onClose={() => setActiveTool(null)}
                onMarkAllRead={inbox.markAllRead}
                onMarkRead={inbox.markRead}
                onMarkUnread={inbox.markUnread}
                onOpenConversation={openInboxConversation}
                onRefresh={() => void inbox.refresh()}
                onRespondToApproval={(item, approved) =>
                  inbox.respondToApproval(item.event, approved)
                }
              />
            ) : activeTool === "new-dm" ? (
              <NewDmView
                currentPubkey={pubkey}
                profiles={state.profiles}
                relayUrl={config.relayUrl}
                onClose={() => setActiveTool(null)}
                onOpen={openAgentDm}
              />
            ) : activeTool === "repos" ? (
              <ReposPanel
                demo={demo}
                profiles={state.profiles}
                relayUrl={config.relayUrl}
                onClose={() => setActiveTool(null)}
                onOpenChannel={selectChannel}
              />
            ) : activeTool === "settings" ? (
              <SettingsView
                canInvite={canCreateChannel}
                connectionState={state.connectionState}
                profile={
                  state.profiles[pubkey] ?? {
                    pubkey,
                    name: pubkey.slice(0, 12),
                    about: "",
                    picture: null,
                    isAgent: false,
                  }
                }
                pubkey={pubkey}
                relayUrl={config.relayUrl}
                onClose={() => setActiveTool(null)}
                onOpenInvites={() => setDialog("invite")}
                onSwitchIdentity={handleSignOut}
                onUpdateProfile={session.updateProfile}
              />
            ) : null}
          </WorkspaceToolPanel>
        ) : selectedChannel && activityPanelOpen ? (
          <AgentActivityPanel
            items={activityItems}
            maximumWidth={maximumActivityWidth}
            minimumWidth={minimumActivityWidth}
            panelWidth={activityPanelWidth}
            profiles={state.profiles}
            statuses={activityStatuses}
            onClose={() => setActivityPanelOpen(false)}
            onResize={setActivityPanelWidth}
          />
        ) : threadRoot ? (
          <ThreadPanel
            key={`${threadRoot.event.id}:${threadReplyTargetId ?? "thread"}`}
            canModerate={canManageChannel}
            currentPubkey={pubkey}
            disabled={!connected}
            draftKey={conversationDraftKey(
              config.relayUrl,
              pubkey,
              selectedChannel?.id ?? "",
              threadRoot.event.id,
            )}
            maximumWidth={maximumThreadWidth}
            messages={state.messages}
            members={selectedChannel?.members ?? []}
            initialReplyTarget={threadReplyTarget}
            focusedMessageId={focusedMessageId}
            minimumWidth={minimumThreadWidth}
            panelWidth={threadPanelWidth}
            presence={state.presence}
            profiles={state.profiles}
            relayUrl={config.relayUrl}
            root={threadRoot}
            onClose={() => {
              setThreadRootId(null);
              setThreadReplyTargetId(null);
              setFocusedMessageId(null);
            }}
            onDelete={setDeleteTarget}
            onEdit={setEditTarget}
            onReact={session.addReaction}
            onResize={setThreadPanelWidth}
            onSend={(content, attachments, replyTarget) =>
              session.sendMessage(content, attachments, {
                id: replyTarget.event.id,
                rootId: threadRoot.event.id,
                authorPubkey: replyTarget.event.pubkey,
              })
            }
            onTyping={(replyTarget) =>
              session.notifyTyping({
                id: replyTarget.event.id,
                rootId: threadRoot.event.id,
                authorPubkey: replyTarget.event.pubkey,
              })
            }
          />
        ) : selectedChannel && channelDetailsOpen ? (
          <ChannelDetailsPanel
            canArchive={canManageChannel && selectedChannel.type !== "dm"}
            channel={selectedChannel}
            loading={state.loadingChannels}
            maximumWidth={maximumChannelDetailsWidth}
            minimumWidth={minimumChannelDetailsWidth}
            muted={userState.mutedChannelIds.has(selectedChannel.id)}
            panelWidth={channelDetailsWidth}
            starred={userState.starredChannelIds.has(selectedChannel.id)}
            onArchive={() => setArchiveTarget(selectedChannel)}
            onClose={() => setChannelDetailsOpen(false)}
            onRefresh={() => void session.refreshChannels()}
            onResize={setChannelDetailsWidth}
            onToggleMuted={() =>
              userState.setChannelMuted(
                selectedChannel.id,
                !userState.mutedChannelIds.has(selectedChannel.id),
              )
            }
            onToggleStarred={() =>
              userState.setChannelStarred(
                selectedChannel.id,
                !userState.starredChannelIds.has(selectedChannel.id),
              )
            }
          />
        ) : null}
      </section>

      {dialog === "browse" ? (
        <ChannelBrowserDialog
          key={channelBrowserInitialView}
          allowForum={features.forum}
          canCreate={canCreateChannel}
          channels={session.discoveredChannels}
          currentPubkey={pubkey}
          initialView={channelBrowserInitialView}
          onClose={() => setDialog(null)}
          onCreate={session.createChannel}
          onJoin={session.joinChannel}
          onSelect={selectChannel}
          onSetArchived={session.setChannelArchived}
        />
      ) : null}
      {dialog === "search" ? (
        <SearchDialog
          channels={state.channels}
          profiles={state.profiles}
          onClose={() => setDialog(null)}
          onSearch={session.search}
          onSelect={(hit) => {
            const reference = threadReference(hit.event);
            revealMessage(hit.channelId, hit.event.id, reference.rootId);
          }}
          onSelectChannel={selectChannel}
          onBrowseChannels={() => openChannelBrowser()}
          onCreateChannel={canCreateChannel ? () => openChannelBrowser("create") : undefined}
          onNewDm={() => toggleTool("new-dm")}
          scopeChannel={searchChannel}
        />
      ) : null}
      {dialog === "invite" ? (
        <CommunityInviteDialog
          onClose={() => setDialog(null)}
          onAddMember={async (targetPubkey, role) => {
            if (demo) return;
            if (!client) throw new Error(t("error.relayClient"));
            await addCommunityMember(client, targetPubkey, role);
            await session.ensureProfiles([targetPubkey]);
          }}
          onMintInvite={async (options) => {
            if (demo) {
              return {
                code: "demo-code",
                expiresAt: Math.floor(Date.now() / 1_000) + options.ttlSecs,
                url: new URL(
                  `${import.meta.env.BASE_URL}invite/demo-code`,
                  window.location.origin,
                ).toString(),
                maxUses: options.maxUses,
                usesRemaining: options.maxUses,
              };
            }
            return mintCommunityInvite(config.relayUrl, options);
          }}
        />
      ) : null}
      {selectedChannel && memberDialogOpen ? (
        <MemberDialog
          canManage={canManageChannel}
          channel={selectedChannel}
          currentPubkey={pubkey}
          presence={state.presence}
          profiles={state.profiles}
          relayUrl={config.relayUrl}
          onClose={() => setMemberDialogOpen(false)}
          onMention={setInsertMention}
          onOpenDm={async (target) => {
            await session.openDm(target);
            setMemberDialogOpen(false);
          }}
          onRemoveMember={(targetPubkey) =>
            session.removeChannelMember(selectedChannel.id, targetPubkey)
          }
          onSetMember={(targetPubkey, role) =>
            session.setChannelMember(selectedChannel.id, targetPubkey, role)
          }
        />
      ) : null}
      {archiveTarget ? (
        <ArchiveChannelDialog
          channel={archiveTarget}
          onArchive={() => session.setChannelArchived(archiveTarget.id, true)}
          onClose={() => setArchiveTarget(null)}
        />
      ) : null}
      {editTarget ? (
        <EditMessageDialog
          message={editTarget}
          onClose={() => setEditTarget(null)}
          onSave={(content) => session.editMessage(editTarget, content)}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteMessageDialog
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => session.deleteMessage(deleteTarget)}
        />
      ) : null}
    </div>
  );
}

export function BuzzWebApp() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void loadRuntimeConfig()
      .then(setConfig)
      .catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : t("error.configLoad")),
      );
  }, []);

  if (!config) {
    return (
      <div className="buzz-app-surface flex min-h-dvh items-center justify-center">
        <div className="text-center">
          <img alt="Buzz" className="mx-auto h-12 w-12 rounded-xl" src={buzzAppIcon} />
          {error ? (
            <p className="mt-4 text-sm text-destructive">{error}</p>
          ) : (
            <LoaderCircle className="mx-auto mt-4 h-5 w-5 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>
    );
  }
  return (
    <IdentityGate config={config}>
      {({ pubkey, signOut, demo }) => (
        <Workspace
          key={`${config.relayUrl}:${pubkey}`}
          config={config}
          demo={demo}
          pubkey={pubkey}
          signOut={signOut}
        />
      )}
    </IdentityGate>
  );
}
