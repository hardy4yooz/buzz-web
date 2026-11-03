import {
  ArrowLeft,
  ArrowUp,
  CheckCheck,
  ExternalLink,
  Inbox,
  LoaderCircle,
  Mail,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { fallbackProfile } from "@/features/chat/lib/chat-model";
import type { BuzzChannel, UserProfile } from "@/features/chat/lib/chat-types";
import { Avatar } from "@/features/chat/ui/Avatar";
import { MessageContent } from "@/features/chat/ui/MessageContent";
import type { InboxCategory, InboxItem } from "@/features/inbox/lib/inbox-model";
import { inboxPreview } from "@/features/inbox/lib/inbox-model";
import { InboxListResizeHandle, useInboxListWidth } from "@/features/inbox/ui/InboxPanelSizing";
import { getLocale, t } from "@/shared/i18n";

type InboxFilter = "all" | InboxCategory;

function categoryLabel(category: InboxCategory): string {
  if (category === "dm") return t("inbox.directMessage");
  if (category === "thread") return t("inbox.threadReply");
  if (category === "needs_action") return t("inbox.needsAction");
  return t("inbox.mention");
}

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

function eventTime(createdAt: number): string {
  return new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(createdAt * 1_000);
}

export function InboxView({
  items,
  channels,
  profiles,
  relayUrl,
  connected,
  loading,
  error,
  approvalPending,
  onClose,
  onRefresh,
  onMarkRead,
  onMarkUnread,
  onMarkAllRead,
  onOpenConversation,
  onRespondToApproval,
}: {
  items: readonly InboxItem[];
  channels: readonly BuzzChannel[];
  profiles: Readonly<Record<string, UserProfile>>;
  relayUrl: string;
  connected: boolean;
  loading: boolean;
  error: string | null;
  approvalPending: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onMarkRead: (id: string) => void;
  onMarkUnread: (id: string) => void;
  onMarkAllRead: () => void;
  onOpenConversation: (item: InboxItem) => void;
  onRespondToApproval: (item: InboxItem, approved: boolean) => Promise<void>;
}) {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const {
    maximum: maximumListWidth,
    panelWidth: listWidth,
    setPanelWidth: setListWidth,
  } = useInboxListWidth();
  const visibleItems = useMemo(
    () =>
      items.filter(
        (item) => (filter === "all" || item.category === filter) && (!unreadOnly || item.unread),
      ),
    [filter, items, unreadOnly],
  );
  const selected = selectedId
    ? (items.find((item) => item.id === selectedId) ?? visibleItems[0] ?? null)
    : (visibleItems[0] ?? null);
  const unreadCount = items.filter((item) => item.unread).length;
  const selectedProfile = selected
    ? (profiles[selected.event.pubkey.toLowerCase()] ?? fallbackProfile(selected.event.pubkey))
    : null;
  const selectedChannel = selected?.channelId
    ? channels.find((channel) => channel.id === selected.channelId)
    : null;
  const relatedItems = selected
    ? items
        .filter(
          (item) =>
            item.channelId === selected.channelId &&
            (selected.threadRootId ? item.threadRootId === selected.threadRootId : true),
        )
        .sort((left, right) => left.event.created_at - right.event.created_at)
    : [];
  const detailTitle = selectedChannel
    ? selectedChannel.type === "dm"
      ? t("inbox.directConversation")
      : t("inbox.threadIn", { channel: selectedChannel.name })
    : t("inbox.details");

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <section
        aria-label={t("inbox.list")}
        className={`relative min-h-0 w-full shrink-0 flex-col border-r lg:flex lg:w-[var(--inbox-list-width)] ${selectedId ? "hidden" : "flex"}`}
        style={{ "--inbox-list-width": `${listWidth}px` } as React.CSSProperties}
      >
        <InboxListResizeHandle
          label={t("inbox.resize")}
          maximum={maximumListWidth}
          panelWidth={listWidth}
          onResize={setListWidth}
        />
        <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <Inbox className="h-[18px] w-[18px] shrink-0 text-muted-foreground lg:hidden" />
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold lg:sr-only">
            {t("inbox.title")}
          </h2>
          <select
            aria-label={t("inbox.filter")}
            className="hidden h-8 min-w-28 rounded-md bg-transparent px-1 text-sm font-semibold outline-none lg:block"
            value={filter}
            onChange={(event) => setFilter(event.target.value as InboxFilter)}
          >
            <option value="all">{t("inbox.all")}</option>
            <option value="mention">{t("inbox.mentions")}</option>
            <option value="dm">{t("inbox.directMessages")}</option>
            <option value="thread">{t("inbox.threadReplies")}</option>
            <option value="needs_action">{t("inbox.needsAction")}</option>
          </select>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {t("inbox.unreadCount", { count: unreadCount })}
          </span>
          <button
            aria-label={t("inbox.markAllRead")}
            className="buzz-icon-button"
            disabled={!unreadCount}
            title={t("inbox.markAllRead")}
            type="button"
            onClick={onMarkAllRead}
          >
            <CheckCheck className="h-4 w-4" />
          </button>
          <button
            aria-label={t("common.refresh")}
            className="buzz-icon-button"
            disabled={loading}
            title={t("common.refresh")}
            type="button"
            onClick={onRefresh}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <MoreHorizontal className="hidden h-4 w-4 text-muted-foreground xl:block" />
        </header>

        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 lg:hidden">
          <select
            aria-label={t("inbox.filter")}
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
            value={filter}
            onChange={(event) => setFilter(event.target.value as InboxFilter)}
          >
            <option value="all">{t("inbox.all")}</option>
            <option value="mention">{t("inbox.mentions")}</option>
            <option value="dm">{t("inbox.directMessages")}</option>
            <option value="thread">{t("inbox.threadReplies")}</option>
            <option value="needs_action">{t("inbox.needsAction")}</option>
          </select>
          <button
            aria-label={t("inbox.close")}
            className="buzz-icon-button"
            type="button"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="flex h-9 shrink-0 items-center gap-2 border-b px-4 text-xs text-muted-foreground">
          <input
            checked={unreadOnly}
            className="h-3.5 w-3.5 shrink-0 accent-primary"
            type="checkbox"
            onChange={(event) => setUnreadOnly(event.target.checked)}
          />
          {t("inbox.unreadOnly")}
        </label>

        {error ? (
          <div className="border-b bg-destructive/8 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        <div className="buzz-scrollbar min-h-0 flex-1 overflow-y-auto">
          {visibleItems.map((item) => {
            const profile =
              profiles[item.event.pubkey.toLowerCase()] ?? fallbackProfile(item.event.pubkey);
            const channel = item.channelId
              ? channels.find((candidate) => candidate.id === item.channelId)
              : null;
            const isSelected = selected?.id === item.id;
            return (
              <button
                key={item.id}
                aria-pressed={isSelected}
                className={`group flex min-h-[88px] w-full gap-3 border-b px-3 py-3 text-left transition-colors ${
                  isSelected ? "bg-foreground/[0.055]" : "hover:bg-foreground/[0.035]"
                }`}
                type="button"
                onClick={() => {
                  setSelectedId(item.id);
                  onMarkRead(item.id);
                }}
              >
                <Avatar profile={profile} relayUrl={relayUrl} size={34} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                      {profile.name}
                    </span>
                    {item.unread ? (
                      <span
                        aria-label={t("inbox.unread")}
                        className="h-2 w-2 shrink-0 rounded-full bg-primary"
                        role="img"
                      />
                    ) : null}
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {relativeTime(item.event.created_at)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>{categoryLabel(item.category)}</span>
                    {channel ? (
                      <>
                        <span>·</span>
                        <span className="truncate">#{channel.name}</span>
                      </>
                    ) : null}
                  </div>
                  <p className="mt-2 line-clamp-2 text-[13px] leading-5 text-foreground/90">
                    {inboxPreview(item.event) || t("inbox.noDetails")}
                  </p>
                </div>
              </button>
            );
          })}
          {!loading && !visibleItems.length ? (
            <div className="px-5 py-14 text-center">
              <Mail className="mx-auto h-8 w-8 text-muted-foreground/50" />
              <p className="mt-3 text-sm text-muted-foreground">
                {connected ? t("inbox.empty") : t("error.relayUnavailable")}
              </p>
            </div>
          ) : null}
          {loading && !visibleItems.length ? (
            <div className="flex items-center justify-center px-5 py-14 text-sm text-muted-foreground">
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
              {t("inbox.loading")}
            </div>
          ) : null}
        </div>
      </section>

      <section
        aria-label={detailTitle}
        className={`min-h-0 min-w-0 flex-1 flex-col ${selectedId ? "flex" : "hidden lg:flex"}`}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
          <button
            aria-label={t("inbox.backToList")}
            className="buzz-icon-button lg:!hidden"
            title={t("inbox.backToList")}
            type="button"
            onClick={() => setSelectedId(null)}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{detailTitle}</h3>
          {selected ? (
            <>
              <button
                aria-label={selected.unread ? t("inbox.markRead") : t("inbox.markUnread")}
                className="buzz-icon-button"
                title={selected.unread ? t("inbox.markRead") : t("inbox.markUnread")}
                type="button"
                onClick={() =>
                  selected.unread ? onMarkRead(selected.id) : onMarkUnread(selected.id)
                }
              >
                {selected.unread ? (
                  <CheckCheck className="h-4 w-4" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
              </button>
              <button
                aria-label={t("inbox.openInChat")}
                className="buzz-icon-button"
                disabled={!selected.channelId}
                title={t("inbox.openInChat")}
                type="button"
                onClick={() => onOpenConversation(selected)}
              >
                <ExternalLink className="h-4 w-4" />
              </button>
            </>
          ) : null}
          <button
            aria-label={t("inbox.close")}
            className="buzz-icon-button"
            title={t("inbox.close")}
            type="button"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {selected && selectedProfile ? (
          <>
            <div className="buzz-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
              <div className="mx-auto max-w-[900px]">
                {relatedItems.map((item, index) => {
                  const profile =
                    profiles[item.event.pubkey.toLowerCase()] ?? fallbackProfile(item.event.pubkey);
                  return (
                    <article key={item.id} className={index ? "mt-5 border-t pt-5" : undefined}>
                      <div className="flex items-start gap-3">
                        <Avatar profile={profile} relayUrl={relayUrl} size={40} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <strong className="text-sm font-semibold">{profile.name}</strong>
                            <time className="text-[11px] text-muted-foreground">
                              {eventTime(item.event.created_at)}
                            </time>
                          </div>
                          <div className="mt-2">
                            <MessageContent
                              content={item.event.content || t("inbox.noDetails")}
                              mediaTags={item.event.tags}
                              relayUrl={relayUrl}
                            />
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>

            <footer className="shrink-0 px-4 pb-4 sm:px-6">
              <div className="mx-auto max-w-[900px]">
                {selected.category === "needs_action" ? (
                  <div className="mb-3 flex justify-end gap-2">
                    <button
                      className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-foreground/5 disabled:opacity-50"
                      disabled={approvalPending !== null}
                      type="button"
                      onClick={() => void onRespondToApproval(selected, false)}
                    >
                      {t("inbox.deny")}
                    </button>
                    <button
                      className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      disabled={approvalPending !== null}
                      type="button"
                      onClick={() => void onRespondToApproval(selected, true)}
                    >
                      {approvalPending === selected.id ? (
                        <LoaderCircle className="mr-2 inline h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      {t("inbox.approve")}
                    </button>
                  </div>
                ) : null}
                <button
                  aria-label={t("inbox.openConversation")}
                  className="flex min-h-[72px] w-full items-center gap-3 rounded-xl border bg-background/35 px-4 text-left text-sm text-muted-foreground shadow-sm hover:bg-background/55 disabled:opacity-50"
                  disabled={!selected.channelId}
                  type="button"
                  onClick={() => onOpenConversation(selected)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t("inbox.replyIn", {
                      target:
                        selectedChannel?.type === "dm"
                          ? selectedProfile.name
                          : `#${selectedChannel?.name ?? t("common.channel")}`,
                    })}
                  </span>
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/15 text-foreground">
                    <ArrowUp className="h-4 w-4" />
                  </span>
                </button>
              </div>
            </footer>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-muted-foreground">
            <Mail className="h-9 w-9 opacity-45" />
            <p className="mt-3 text-sm">
              {connected ? t("inbox.empty") : t("error.relayUnavailable")}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
