import {
  ArrowLeft,
  Bell,
  Download,
  KeyRound,
  LoaderCircle,
  Monitor,
  Moon,
  Pencil,
  RotateCw,
  Sun,
  UserRound,
  UserRoundPlus,
} from "lucide-react";
import { useState } from "react";
import type { UserProfile } from "@/features/chat/lib/chat-types";
import { connectionStateLabel } from "@/features/chat/lib/connection-state";
import { DialogFrame } from "@/features/chat/ui/AppDialogs";
import { Avatar } from "@/features/chat/ui/Avatar";
import type { NotificationController } from "@/features/notifications/use-foreground-notifications";
import type { RelayConnectionState } from "@/shared/api/nostr-types";
import { t } from "@/shared/i18n";
import { downloadIdentityBackup } from "@/shared/lib/identity-backup";
import { createActiveIdentityBackup, getActiveSignerMode } from "@/shared/lib/nostr-signer";
import { useTheme } from "@/shared/theme/ThemeProvider";

export type SettingsSection = "appearance" | "identity" | "invites" | "notifications" | "profile";

function ProfileEditor({
  profile,
  onClose,
  onUpdate,
}: {
  profile: UserProfile;
  onClose: () => void;
  onUpdate: (input: { name: string; about: string; picture: string }) => Promise<void>;
}) {
  const [name, setName] = useState(profile.name);
  const [about, setAbout] = useState(profile.about);
  const [picture, setPicture] = useState(profile.picture ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <DialogFrame title={t("settings.editProfile")} onClose={onClose}>
      <form
        className="space-y-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError(null);
          void onUpdate({ name, about, picture })
            .then(onClose)
            .catch((profileError) =>
              setError(
                profileError instanceof Error ? profileError.message : t("error.profileUpdate"),
              ),
            )
            .finally(() => setSaving(false));
        }}
      >
        <label className="block text-xs font-medium">
          {t("profile.name")}
          <input
            className="mt-1.5 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="block text-xs font-medium">
          {t("profile.about")}
          <textarea
            className="mt-1.5 min-h-20 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none"
            maxLength={500}
            value={about}
            onChange={(event) => setAbout(event.target.value)}
          />
        </label>
        <label className="block text-xs font-medium">
          {t("profile.picture")}
          <input
            className="mt-1.5 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none"
            placeholder={t("profile.picturePlaceholder")}
            type="url"
            value={picture}
            onChange={(event) => setPicture(event.target.value)}
          />
        </label>
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
            className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-40"
            disabled={!name.trim() || saving}
            type="submit"
          >
            {saving ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("profile.save")}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const options = [
    { value: "system", label: t("dialog.systemTheme"), icon: Monitor },
    { value: "light", label: t("dialog.light"), icon: Sun },
    { value: "dark", label: t("dialog.dark"), icon: Moon },
  ] as const;
  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">{t("dialog.appearance")}</h2>
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {options.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            aria-pressed={theme === value}
            className="flex h-24 flex-col items-center justify-center gap-2 rounded-lg border bg-background/35 text-sm aria-pressed:border-foreground/45 aria-pressed:bg-foreground/7"
            type="button"
            onClick={() => setTheme(value)}
          >
            <Icon className="h-5 w-5 text-muted-foreground" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function IdentitySection({
  relayUrl,
  pubkey,
  connectionState,
  onSwitchIdentity,
}: {
  relayUrl: string;
  pubkey: string;
  connectionState: RelayConnectionState;
  onSwitchIdentity: () => void;
}) {
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [backupConfirmation, setBackupConfirmation] = useState("");
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localIdentity = getActiveSignerMode() === "local";

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">{t("settings.identity")}</h2>
      <section className="mt-6 border-y py-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <KeyRound className="h-4 w-4" /> {t("dialog.relaySession")}
        </div>
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-3 text-xs">
          <dt className="text-muted-foreground">{t("field.status")}</dt>
          <dd>{connectionStateLabel(connectionState)}</dd>
          <dt className="text-muted-foreground">{t("field.address")}</dt>
          <dd className="break-all font-mono">{relayUrl}</dd>
          <dt className="text-muted-foreground">{t("field.publicKey")}</dt>
          <dd className="break-all font-mono">{pubkey}</dd>
        </dl>
      </section>

      <section className="mt-6">
        <h3 className="text-sm font-semibold">{t("identity.backup")}</h3>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {localIdentity ? t("identity.backupWarning") : t("identity.extensionBackup")}
        </p>
        {localIdentity && backupOpen ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium">
              {t("identity.backupPassphrase")}
              <input
                autoComplete="new-password"
                className="mt-1.5 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none"
                minLength={12}
                type="password"
                value={backupPassword}
                onChange={(event) => setBackupPassword(event.target.value)}
              />
            </label>
            <label className="block text-xs font-medium">
              {t("identity.confirmPassphrase")}
              <input
                autoComplete="new-password"
                className="mt-1.5 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none"
                minLength={12}
                type="password"
                value={backupConfirmation}
                onChange={(event) => setBackupConfirmation(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        {localIdentity ? (
          <button
            className="mt-4 inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-foreground/5 disabled:opacity-40"
            disabled={
              creatingBackup ||
              (backupOpen && (backupPassword.length < 12 || backupPassword !== backupConfirmation))
            }
            type="button"
            onClick={() => {
              if (!backupOpen) {
                setBackupOpen(true);
                return;
              }
              setCreatingBackup(true);
              setError(null);
              window.setTimeout(() => {
                try {
                  const backup = createActiveIdentityBackup(backupPassword);
                  downloadIdentityBackup(backup, pubkey);
                  setBackupPassword("");
                  setBackupConfirmation("");
                  setBackupOpen(false);
                } catch (backupError) {
                  setError(
                    backupError instanceof Error ? backupError.message : t("error.backupCreate"),
                  );
                } finally {
                  setCreatingBackup(false);
                }
              }, 0);
            }}
          >
            {creatingBackup ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {backupOpen ? t("identity.downloadBackup") : t("identity.createBackup")}
          </button>
        ) : null}
        {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
      </section>

      <div className="mt-8 border-t pt-5">
        <button
          className="h-9 rounded-md border px-3 text-sm hover:bg-foreground/5"
          type="button"
          onClick={onSwitchIdentity}
        >
          {t("identity.switch")}
        </button>
      </div>
    </div>
  );
}

function NotificationsSection({ notifications }: { notifications: NotificationController }) {
  const { state, enable, disable, retry } = notifications;
  const hint =
    state === "unsupported"
      ? t("notify.unsupported")
      : state === "blocked"
        ? t("notify.blocked")
        : state === "checking"
          ? t("notify.checking")
          : state === "unavailable"
            ? t("notify.unavailable")
            : state === "ready"
              ? t("notify.on")
              : t("notify.off");
  const actionClass =
    "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-foreground/5 disabled:opacity-40";
  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">{t("notify.title")}</h2>
      <section
        className="mt-6 border-y py-5"
        data-notify-state={state}
        data-testid="settings-notifications"
      >
        <p className="text-sm font-medium">{t("notify.description")}</p>
        <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {state === "ready" ? (
            <button className={actionClass} type="button" onClick={disable}>
              {t("notify.turnOff")}
            </button>
          ) : null}
          {state === "off" || state === "granted_off" ? (
            <button className={actionClass} type="button" onClick={enable}>
              {state === "off" ? t("notify.enable") : t("notify.turnOn")}
            </button>
          ) : null}
          {state === "unavailable" ? (
            <button className={actionClass} type="button" onClick={retry}>
              <RotateCw className="h-3.5 w-3.5" />
              {t("notify.retry")}
            </button>
          ) : null}
          {state === "blocked" ? (
            <button className={actionClass} disabled type="button">
              {t("notify.enable")}
            </button>
          ) : null}
          {state === "checking" ? (
            <button className={actionClass} disabled type="button">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              {t("notify.checking")}
            </button>
          ) : null}
        </div>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">{t("notify.privacy")}</p>
      </section>
    </div>
  );
}

export function SettingsView({
  relayUrl,
  pubkey,
  profile,
  connectionState,
  canInvite,
  notifications,
  onClose,
  onOpenInvites,
  onSwitchIdentity,
  onUpdateProfile,
}: {
  relayUrl: string;
  pubkey: string;
  profile: UserProfile;
  connectionState: RelayConnectionState;
  canInvite: boolean;
  notifications: NotificationController;
  onClose: () => void;
  onOpenInvites: () => void;
  onSwitchIdentity: () => void;
  onUpdateProfile: (input: { name: string; about: string; picture: string }) => Promise<void>;
}) {
  const [section, setSection] = useState<SettingsSection>("profile");
  const [editingProfile, setEditingProfile] = useState(false);
  const sections = [
    { id: "profile", label: t("profile.title"), icon: UserRound },
    { id: "notifications", label: t("notify.title"), icon: Bell },
    { id: "appearance", label: t("dialog.appearance"), icon: Monitor },
    { id: "invites", label: t("settings.invites"), icon: UserRoundPlus },
    { id: "identity", label: t("settings.identity"), icon: KeyRound },
  ] as const;

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="shrink-0 border-b bg-foreground/[0.025] md:w-52 md:border-b-0 md:border-r">
        <div className="flex h-11 items-center border-b px-2.5">
          <button
            className="inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs font-medium hover:bg-foreground/6"
            type="button"
            onClick={onClose}
          >
            <ArrowLeft className="h-4 w-4" />
            {t("settings.back")}
          </button>
        </div>
        <nav
          aria-label={t("common.settings")}
          className="buzz-scrollbar flex gap-1 overflow-x-auto p-2 md:block md:space-y-1 md:overflow-visible"
        >
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-current={section === id ? "page" : undefined}
              className="flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-left text-xs text-foreground/80 hover:bg-foreground/5 aria-[current=page]:bg-foreground/9 aria-[current=page]:font-semibold aria-[current=page]:text-foreground md:w-full"
              type="button"
              onClick={() => setSection(id)}
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="buzz-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        {section === "profile" ? (
          <div className="max-w-2xl">
            <h2 className="text-xl font-semibold">{t("profile.title")}</h2>
            <div className="mt-6 flex items-start gap-4 border-y py-5">
              <Avatar profile={profile} relayUrl={relayUrl} size={64} />
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-lg font-semibold">{profile.name}</h3>
                {profile.about ? (
                  <p className="mt-1 break-words text-sm leading-5 text-muted-foreground">
                    {profile.about}
                  </p>
                ) : null}
              </div>
              <button
                className="inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-medium hover:bg-foreground/5"
                type="button"
                onClick={() => setEditingProfile(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
                {t("settings.editProfile")}
              </button>
            </div>
          </div>
        ) : section === "notifications" ? (
          <NotificationsSection notifications={notifications} />
        ) : section === "appearance" ? (
          <AppearanceSection />
        ) : section === "invites" ? (
          <div className="max-w-2xl">
            <h2 className="text-xl font-semibold">{t("settings.invites")}</h2>
            <div className="mt-6 border-y py-5">
              {canInvite ? (
                <button
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
                  type="button"
                  onClick={onOpenInvites}
                >
                  <UserRoundPlus className="h-4 w-4" />
                  {t("invite.title")}
                </button>
              ) : (
                <p className="text-sm text-muted-foreground">{t("settings.invitesUnavailable")}</p>
              )}
            </div>
          </div>
        ) : (
          <IdentitySection
            connectionState={connectionState}
            pubkey={pubkey}
            relayUrl={relayUrl}
            onSwitchIdentity={onSwitchIdentity}
          />
        )}
      </section>

      {editingProfile ? (
        <ProfileEditor
          profile={profile}
          onClose={() => setEditingProfile(false)}
          onUpdate={onUpdateProfile}
        />
      ) : null}
    </div>
  );
}
