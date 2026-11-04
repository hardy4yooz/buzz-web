import { LoaderCircle, Search, UserRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { UserProfile } from "@/features/chat/lib/chat-types";
import { Avatar } from "@/features/chat/ui/Avatar";
import { getLocale, t } from "@/shared/i18n";

export function NewDmView({
  profiles,
  currentPubkey,
  relayUrl,
  connected,
  onClose,
  onOpen,
}: {
  profiles: Record<string, UserProfile>;
  currentPubkey: string;
  relayUrl: string;
  connected: boolean;
  onClose: () => void;
  onOpen: (pubkey: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return Object.values(profiles)
      .filter((profile) => profile.pubkey !== currentPubkey)
      .filter(
        (profile) =>
          !term ||
          profile.name.toLocaleLowerCase().includes(term) ||
          profile.about.toLocaleLowerCase().includes(term),
      )
      .sort(
        (left, right) =>
          Number(right.isAgent) - Number(left.isAgent) ||
          left.name.localeCompare(right.name, getLocale()),
      );
  }, [currentPubkey, profiles, query]);

  const open = async (profile: UserProfile) => {
    setOpening(profile.pubkey);
    setError(null);
    try {
      await onOpen(profile.pubkey);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : t("error.dmOpen"));
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("dialog.newDm")}</h2>
        <button
          aria-label={t("dm.close")}
          className="buzz-icon-button h-7 w-7 flex-none"
          title={t("dm.close")}
          type="button"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="border-b p-3">
        <label className="flex h-10 items-center gap-2 rounded-md border bg-background px-3">
          <span className="shrink-0 text-sm font-medium">{t("dm.to")}</span>
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            aria-label={t("dialog.searchMembers")}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            placeholder={t("dialog.searchMembers")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </div>
      <div className="buzz-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl p-3 sm:p-5">
          <p className="mb-2 px-2 text-[11px] font-medium text-muted-foreground">
            {t("dm.choose")}
          </p>
          {options.map((profile) => (
            <button
              key={profile.pubkey}
              className="flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-foreground/5 disabled:opacity-50"
              disabled={opening !== null}
              type="button"
              onClick={() => void open(profile)}
            >
              <Avatar profile={profile} relayUrl={relayUrl} size={32} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{profile.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {profile.isAgent ? t("member.remoteAgent") : profile.about}
                </div>
              </div>
              {opening === profile.pubkey ? (
                <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : null}
            </button>
          ))}
          {!options.length ? (
            <div className="flex flex-col items-center py-16 text-center text-muted-foreground">
              <UserRound className="h-7 w-7 opacity-55" />
              <p className="mt-3 text-sm">
                {connected ? t("dm.empty") : t("error.relayUnavailable")}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
