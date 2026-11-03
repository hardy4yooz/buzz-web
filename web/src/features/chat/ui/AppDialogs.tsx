import { Compass, Hash, LoaderCircle, MessageCircle, Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BuzzChannel, SearchHit, UserProfile } from "@/features/chat/lib/chat-types";
import { t } from "@/shared/i18n";
import { truncatePubkey } from "@/shared/lib/pubkey";

export function DialogFrame({
  title,
  children,
  onClose,
  closeOnEscape = true,
  width = "max-w-lg",
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  closeOnEscape?: boolean;
  width?: string;
}) {
  useEffect(() => {
    if (!closeOnEscape) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeOnEscape, onClose]);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      role="presentation"
    >
      <section
        aria-label={title}
        aria-modal="true"
        className={`max-h-[85dvh] w-full ${width} overflow-hidden rounded-lg border bg-popover shadow-2xl`}
        role="dialog"
      >
        <header className="flex h-13 items-center justify-between border-b px-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            aria-label={t("common.close")}
            className="buzz-icon-button"
            title={t("common.close")}
            type="button"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export type CreateChannelInput = {
  name: string;
  description: string;
  type: "stream" | "forum";
  visibility: "open" | "private";
};

export function CreateChannelForm({
  allowForum,
  onCancel,
  onCreate,
}: {
  allowForum: boolean;
  onCancel: () => void;
  onCreate: (input: CreateChannelInput) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"stream" | "forum">("stream");
  const [visibility, setVisibility] = useState<"open" | "private">("open");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        setSubmitting(true);
        setError(null);
        void onCreate({ name, description, type, visibility })
          .catch((createError) =>
            setError(createError instanceof Error ? createError.message : t("error.channelCreate")),
          )
          .finally(() => setSubmitting(false));
      }}
    >
      <label className="block text-xs font-medium">
        {t("dialog.channelName")}
        <input
          className="mt-1.5 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
          maxLength={80}
          placeholder={t("dialog.channelExample")}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="block text-xs font-medium">
        {t("dialog.channelSummary")}
        <textarea
          className="mt-1.5 min-h-20 w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
          maxLength={500}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-xs font-medium">
          {t("dialog.channelType")}
          <select
            className="mt-1.5 h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={type}
            onChange={(event) => setType(event.target.value as "stream" | "forum")}
          >
            <option value="stream">{t("dialog.channelTypeStream")}</option>
            {allowForum ? <option value="forum">{t("dialog.channelTypeForum")}</option> : null}
          </select>
        </label>
        <label className="block text-xs font-medium">
          {t("dialog.channelVisibility")}
          <select
            className="mt-1.5 h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as "open" | "private")}
          >
            <option value="open">{t("dialog.visibilityOpen")}</option>
            <option value="private">{t("dialog.visibilityPrivate")}</option>
          </select>
        </label>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2 border-t pt-4">
        <button
          className="h-9 rounded-md px-3 text-sm hover:bg-foreground/5"
          type="button"
          onClick={onCancel}
        >
          {t("common.cancel")}
        </button>
        <button
          className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-40"
          disabled={!name.trim() || submitting}
          type="submit"
        >
          {submitting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
          {t("common.create")}
        </button>
      </div>
    </form>
  );
}

export function SearchDialog({
  channels,
  profiles,
  connected,
  onClose,
  onSearch,
  onSelect,
  onSelectChannel,
  onBrowseChannels,
  onCreateChannel,
  onNewDm,
  scopeChannel = null,
}: {
  channels: BuzzChannel[];
  profiles: Record<string, UserProfile>;
  connected: boolean;
  onClose: () => void;
  onSearch: (term: string, channelId?: string) => Promise<SearchHit[]>;
  onSelect: (hit: SearchHit) => void;
  onSelectChannel: (channelId: string) => void;
  onBrowseChannels: () => void;
  onCreateChannel?: () => void;
  onNewDm?: () => void;
  scopeChannel?: BuzzChannel | null;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    let active = true;
    setError(null);
    setLoading(false);
    if (!connected) {
      setResults([]);
      return () => {
        active = false;
      };
    }
    if (term.trim().length < 2) {
      setResults([]);
      return () => {
        active = false;
      };
    }
    const query = term.trim();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void onSearch(query, scopeChannel?.id)
        .then((nextResults) => {
          if (active) setResults(nextResults);
        })
        .catch(() => {
          if (active) {
            setResults([]);
            setError(t("error.messageSearch"));
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [connected, onSearch, scopeChannel?.id, term]);
  const title = scopeChannel
    ? t("dialog.searchChannel", { channel: scopeChannel.name })
    : t("dialog.searchMessages");
  return (
    <DialogFrame title={title} width="max-w-2xl" onClose={onClose}>
      <div className="flex h-12 items-center gap-2 border-b px-4">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input
          ref={inputRef}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          placeholder={
            scopeChannel ? t("dialog.searchChannelPlaceholder") : t("dialog.searchRelay")
          }
          value={term}
          onChange={(event) => setTerm(event.target.value)}
        />
        {loading ? <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
      </div>
      <div className="buzz-scrollbar max-h-[60dvh] overflow-y-auto p-2">
        {term.trim().length < 2 && !scopeChannel ? (
          <div>
            <div className="flex items-center gap-2 px-2 pb-2">
              <button
                className="inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-xs font-medium hover:bg-foreground/6"
                type="button"
                onClick={() => {
                  onClose();
                  onBrowseChannels();
                }}
              >
                <Compass className="h-4 w-4 text-muted-foreground" />
                {t("channel.browserTitle")}
              </button>
              {onCreateChannel ? (
                <button
                  className="inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-xs font-medium hover:bg-foreground/6"
                  type="button"
                  onClick={() => {
                    onClose();
                    onCreateChannel();
                  }}
                >
                  <Plus className="h-4 w-4 text-muted-foreground" />
                  {t("dialog.createChannel")}
                </button>
              ) : null}
              {onNewDm ? (
                <button
                  className="inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-xs font-medium hover:bg-foreground/6"
                  type="button"
                  onClick={() => {
                    onClose();
                    onNewDm();
                  }}
                >
                  <MessageCircle className="h-4 w-4 text-muted-foreground" />
                  {t("workspace.tool.new-dm")}
                </button>
              ) : null}
            </div>
            <div className="border-t pt-1">
              {channels
                .filter((channel) => channel.isMember && !channel.archived)
                .slice(0, 10)
                .map((channel) => (
                  <button
                    key={channel.id}
                    className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-foreground/5"
                    type="button"
                    onClick={() => {
                      onSelectChannel(channel.id);
                      onClose();
                    }}
                  >
                    <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                    {channel.description ? (
                      <span className="max-w-[45%] truncate text-xs text-muted-foreground">
                        {channel.description}
                      </span>
                    ) : null}
                  </button>
                ))}
            </div>
          </div>
        ) : null}
        {results.map((hit) => {
          const channel = channels.find((item) => item.id === hit.channelId);
          const profile = profiles[hit.event.pubkey.toLowerCase()];
          return (
            <button
              key={hit.event.id}
              className="w-full rounded-md px-3 py-2.5 text-left hover:bg-foreground/5"
              type="button"
              onClick={() => {
                onSelect(hit);
                onClose();
              }}
            >
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Hash className="h-3 w-3" /> {channel?.name ?? t("common.channel")} ·{" "}
                {profile?.name ?? truncatePubkey(hit.event.pubkey)}
              </div>
              <p className="mt-1 line-clamp-2 text-sm leading-5">{hit.event.content}</p>
            </button>
          );
        })}
        {!connected && term.trim().length >= 2 ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground" role="status">
            {t("error.relayUnavailable")}
          </p>
        ) : null}
        {error ? (
          <p className="px-3 py-10 text-center text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {connected && term.trim().length >= 2 && !loading && !error && !results.length ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">
            {t("dialog.noMessages")}
          </p>
        ) : null}
      </div>
    </DialogFrame>
  );
}
