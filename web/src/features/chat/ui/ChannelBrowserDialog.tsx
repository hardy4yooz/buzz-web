import {
  ArchiveRestore,
  ArrowLeft,
  Compass,
  Hash,
  LoaderCircle,
  Lock,
  Plus,
  Search,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { BuzzChannel } from "@/features/chat/lib/chat-types";
import {
  CreateChannelForm,
  type CreateChannelInput,
  DialogFrame,
} from "@/features/chat/ui/AppDialogs";
import { getLocale, t } from "@/shared/i18n";

type BrowserTab = "all" | "joined" | "archived";

export function ChannelBrowserDialog({
  channels,
  currentPubkey,
  allowForum,
  canCreate,
  connected,
  initialView = "browse",
  onClose,
  onCreate,
  onJoin,
  onSelect,
  onSetArchived,
}: {
  channels: BuzzChannel[];
  currentPubkey: string;
  allowForum: boolean;
  canCreate: boolean;
  connected: boolean;
  initialView?: "browse" | "create";
  onClose: () => void;
  onCreate: (input: CreateChannelInput) => Promise<unknown>;
  onJoin: (channelId: string) => Promise<void>;
  onSelect: (channelId: string) => void;
  onSetArchived: (channelId: string, archived: boolean) => Promise<void>;
}) {
  const [view, setView] = useState<"browse" | "create">(initialView);
  const [tab, setTab] = useState<BrowserTab>("all");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return channels
      .filter((channel) => channel.type !== "dm")
      .filter((channel) => {
        if (tab === "joined") return channel.isMember && !channel.archived;
        if (tab === "archived") return channel.isMember && channel.archived;
        return !channel.archived;
      })
      .filter(
        (channel) =>
          !normalizedQuery ||
          channel.name.toLocaleLowerCase().includes(normalizedQuery) ||
          channel.description.toLocaleLowerCase().includes(normalizedQuery),
      )
      .sort((left, right) => left.name.localeCompare(right.name, getLocale()));
  }, [channels, query, tab]);

  const run = async (channelId: string, action: () => Promise<void>) => {
    setPending(channelId);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t("error.channelUpdate"));
    } finally {
      setPending(null);
    }
  };

  return (
    <DialogFrame
      title={view === "create" ? t("dialog.createChannel") : t("channel.browserTitle")}
      width="max-w-2xl"
      onClose={onClose}
    >
      {view === "create" ? (
        <>
          <div className="border-b px-3 py-2">
            <button
              className="inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs font-medium hover:bg-foreground/6"
              type="button"
              onClick={() => setView("browse")}
            >
              <ArrowLeft className="h-4 w-4" />
              {t("channel.backToBrowser")}
            </button>
          </div>
          <CreateChannelForm
            allowForum={allowForum}
            onCancel={() => setView("browse")}
            onCreate={async (input) => {
              await onCreate(input);
              onClose();
            }}
          />
        </>
      ) : (
        <>
          <div className="border-b p-3">
            <div className="flex gap-2">
              <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3">
                <Search className="h-4 w-4 text-muted-foreground" />
                <input
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  placeholder={t("channel.search")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              {canCreate ? (
                <button
                  className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md bg-foreground px-3 text-xs font-medium text-background"
                  type="button"
                  onClick={() => setView("create")}
                >
                  <Plus className="h-4 w-4" />
                  {t("common.create")}
                </button>
              ) : null}
            </div>
            <div className="mt-3 inline-flex rounded-md border bg-background p-1">
              {(["all", "joined", "archived"] as const).map((value) => (
                <button
                  key={value}
                  aria-pressed={tab === value}
                  className="h-8 rounded px-3 text-xs aria-pressed:bg-foreground aria-pressed:text-background"
                  type="button"
                  onClick={() => setTab(value)}
                >
                  {value === "all"
                    ? t("channel.all")
                    : value === "joined"
                      ? t("channel.joined")
                      : t("channel.archived")}
                </button>
              ))}
            </div>
          </div>
          <div className="buzz-scrollbar max-h-[60dvh] overflow-y-auto p-2">
            {visible.map((channel) => {
              const role = channel.members.find(
                (member) => member.pubkey.toLowerCase() === currentPubkey.toLowerCase(),
              )?.role;
              const canUnarchive = role === "owner" || role === "admin";
              return (
                <div
                  key={channel.id}
                  className="flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-foreground/5"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-foreground/6 text-muted-foreground">
                    {channel.visibility === "private" ? (
                      <Lock className="h-4 w-4" />
                    ) : (
                      <Hash className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{channel.name}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3 w-3" /> {channel.members.length}
                      </span>
                      {channel.description ? (
                        <span className="truncate">{channel.description}</span>
                      ) : null}
                    </div>
                  </div>
                  {pending === channel.id ? (
                    <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : channel.archived ? (
                    canUnarchive ? (
                      <button
                        className="buzz-icon-button"
                        title={t("channel.unarchive")}
                        type="button"
                        onClick={() => void run(channel.id, () => onSetArchived(channel.id, false))}
                      >
                        <ArchiveRestore className="h-4 w-4" />
                      </button>
                    ) : null
                  ) : channel.isMember ? (
                    <button
                      className="h-8 rounded-md px-3 text-xs font-medium hover:bg-foreground/7"
                      type="button"
                      onClick={() => {
                        onSelect(channel.id);
                        onClose();
                      }}
                    >
                      {t("channel.open")}
                    </button>
                  ) : (
                    <button
                      className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground"
                      type="button"
                      onClick={() =>
                        void run(channel.id, async () => {
                          await onJoin(channel.id);
                          onClose();
                        })
                      }
                    >
                      {t("channel.join")}
                    </button>
                  )}
                </div>
              );
            })}
            {!visible.length ? (
              <div className="flex flex-col items-center px-6 py-14 text-center text-muted-foreground">
                <Compass className="h-6 w-6" />
                <p className="mt-3 text-sm">
                  {connected ? t("channel.empty") : t("error.relayUnavailable")}
                </p>
              </div>
            ) : null}
            {error ? <p className="px-3 py-2 text-xs text-destructive">{error}</p> : null}
          </div>
        </>
      )}
    </DialogFrame>
  );
}

export function ArchiveChannelDialog({
  channel,
  onClose,
  onArchive,
}: {
  channel: BuzzChannel;
  onClose: () => void;
  onArchive: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <DialogFrame title={t("channel.archive")} onClose={onClose}>
      <div className="space-y-4 p-4">
        <p className="text-sm leading-6 text-muted-foreground">
          {t("channel.archiveConfirm", { channel: channel.name })}
        </p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t pt-4">
          <button
            className="h-9 rounded-md px-3 text-sm hover:bg-foreground/5"
            type="button"
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            className="inline-flex h-9 items-center rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground disabled:opacity-40"
            disabled={pending}
            type="button"
            onClick={() => {
              setPending(true);
              setError(null);
              void onArchive()
                .then(onClose)
                .catch((archiveError) =>
                  setError(
                    archiveError instanceof Error
                      ? archiveError.message
                      : t("error.channelArchive"),
                  ),
                )
                .finally(() => setPending(false));
            }}
          >
            {pending ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("channel.archive")}
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}
