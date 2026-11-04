import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  PlugZap,
  Plus,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import buzzAppIcon from "@/assets/app-icon@3x.png";
import type { RuntimeConfig } from "@/shared/config/runtime-config";
import { t } from "@/shared/i18n";
import {
  deleteVault,
  listVaultMetadata,
  saveSecretKey,
  unlockSecretKey,
  type VaultMetadata,
} from "@/shared/lib/identity-vault";
import {
  activateLocalSigner,
  activateNip07Signer,
  clearActiveSigner,
  generateIdentitySecretKey,
  getActiveSignerPubkey,
  parseSecretKey,
  publicKeyFromSecret,
  restoreIdentityBackup,
} from "@/shared/lib/nostr-signer";

type IdentityMode = "saved" | "import" | "create" | "restore";

function shortPubkey(pubkey: string): string {
  return `${pubkey.slice(0, 12)}...${pubkey.slice(-8)}`;
}

export function IdentityGate({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: (identity: { pubkey: string; signOut: () => void; demo: boolean }) => React.ReactNode;
}) {
  const [pubkey, setPubkey] = useState<string | null>(() =>
    config.demoMode ? "f".repeat(64) : getActiveSignerPubkey(),
  );
  const queryClient = useQueryClient();
  const [vaults, setVaults] = useState<VaultMetadata[]>([]);
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null);
  const [checkingVault, setCheckingVault] = useState(!config.demoMode);
  const [mode, setMode] = useState<IdentityMode>("saved");
  const [showSecret, setShowSecret] = useState(false);
  const [secretInput, setSecretInput] = useState("");
  const [backupInput, setBackupInput] = useState("");
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [remember, setRemember] = useState(false);
  const [acknowledgedLoss, setAcknowledgedLoss] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadVaults = useCallback(async () => {
    const next = await listVaultMetadata();
    setVaults(next);
    setSelectedPubkey((current) =>
      current && next.some((vault) => vault.pubkey === current)
        ? current
        : (next[0]?.pubkey ?? null),
    );
    return next;
  }, []);

  useEffect(() => {
    if (config.demoMode) return;
    void reloadVaults()
      .catch((vaultError) =>
        setError(vaultError instanceof Error ? vaultError.message : t("error.vaultRead")),
      )
      .finally(() => setCheckingVault(false));
  }, [config.demoMode, reloadVaults]);

  if (pubkey) {
    return children({
      pubkey,
      demo: config.demoMode,
      signOut: () => {
        queryClient.clear();
        clearActiveSigner();
        setPubkey(null);
        setPassphrase("");
        setConfirmPassphrase("");
        setSecretInput("");
        setBackupInput("");
        setBackupPassphrase("");
        setMode("saved");
        void reloadVaults().catch((vaultError) =>
          setError(vaultError instanceof Error ? vaultError.message : t("error.vaultRead")),
        );
      },
    });
  }

  const run = async (operation: () => Promise<string>) => {
    setWorking(true);
    setError(null);
    try {
      setPubkey(await operation());
    } catch (operationError) {
      setError(
        operationError instanceof Error ? operationError.message : t("error.identityUnlock"),
      );
    } finally {
      setWorking(false);
    }
  };

  const changeMode = (next: IdentityMode) => {
    setMode(next);
    setError(null);
    setPassphrase("");
    setConfirmPassphrase("");
    setBackupPassphrase("");
    setAcknowledgedLoss(false);
  };

  const formInputClass =
    "mt-1.5 h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30";

  return (
    <div className="buzz-app-surface flex min-h-dvh items-center justify-center p-4">
      <main className="w-full max-w-[440px] overflow-hidden rounded-lg border border-black/10 bg-background/95 shadow-2xl backdrop-blur-xl dark:border-white/10">
        <div className="border-b px-6 pb-5 pt-7 text-center">
          <img alt="Buzz" className="mx-auto h-14 w-14 rounded-[13px]" src={buzzAppIcon} />
          <h1 className="mt-4 text-xl font-semibold">{config.communityName}</h1>
          <p className="mt-1 truncate text-xs text-muted-foreground">{config.relayUrl}</p>
        </div>

        {checkingVault ? (
          <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> {t("identity.checking")}
          </div>
        ) : mode === "saved" ? (
          <div className="space-y-4 p-6">
            {vaults.length ? (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!selectedPubkey) return;
                  void run(async () => {
                    const secret = await unlockSecretKey(selectedPubkey, passphrase);
                    try {
                      return activateLocalSigner(secret);
                    } finally {
                      secret.fill(0);
                    }
                  });
                }}
              >
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-xs font-medium">
                    {t("identity.savedIdentities")}
                  </legend>
                  {vaults.map((vault) => (
                    <label
                      className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 ${selectedPubkey === vault.pubkey ? "border-primary/50 bg-primary/5" : "hover:bg-foreground/5"}`}
                      key={vault.pubkey}
                    >
                      <input
                        checked={selectedPubkey === vault.pubkey}
                        name="saved-identity"
                        type="radio"
                        value={vault.pubkey}
                        onChange={() => {
                          setSelectedPubkey(vault.pubkey);
                          setPassphrase("");
                          setError(null);
                        }}
                      />
                      <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                        {shortPubkey(vault.pubkey)}
                      </span>
                      <button
                        aria-label={t("identity.forget")}
                        className="buzz-icon-button h-8 w-8 flex-none text-muted-foreground hover:text-destructive"
                        title={t("identity.forget")}
                        type="button"
                        onClick={() => {
                          if (!window.confirm(t("identity.forgetConfirm"))) return;
                          void deleteVault(vault.pubkey)
                            .then(reloadVaults)
                            .catch((vaultError) =>
                              setError(
                                vaultError instanceof Error
                                  ? vaultError.message
                                  : t("error.vaultOperation"),
                              ),
                            );
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </label>
                  ))}
                </fieldset>
                <label className="block text-xs font-medium">
                  {t("identity.passphrase")}
                  <input
                    autoComplete="current-password"
                    className={formInputClass}
                    type="password"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                </label>
                {error ? <p className="text-xs text-destructive">{error}</p> : null}
                <button
                  className="flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground disabled:opacity-40"
                  disabled={!selectedPubkey || !passphrase || working}
                  type="submit"
                >
                  {working ? (
                    <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="mr-2 h-4 w-4" />
                  )}
                  {t("identity.unlock")}
                </button>
              </form>
            ) : (
              <p className="text-center text-sm text-muted-foreground">{t("identity.noSaved")}</p>
            )}

            <button
              className="flex h-10 w-full items-center justify-center rounded-md border bg-background text-sm font-medium hover:bg-foreground/5 disabled:opacity-40"
              disabled={working}
              type="button"
              onClick={() => void run(activateNip07Signer)}
            >
              <PlugZap className="mr-2 h-4 w-4" /> {t("identity.nip07")}
            </button>
            <div className="grid grid-cols-3 gap-2">
              <button
                className="inline-flex h-10 min-w-0 items-center justify-center rounded-md border bg-background px-2 text-xs font-medium hover:bg-foreground/5"
                type="button"
                onClick={() => changeMode("import")}
              >
                <KeyRound className="mr-1.5 h-4 w-4" /> {t("identity.import")}
              </button>
              <button
                className="inline-flex h-10 min-w-0 items-center justify-center rounded-md border bg-background px-2 text-xs font-medium hover:bg-foreground/5"
                type="button"
                onClick={() => changeMode("create")}
              >
                <Plus className="mr-1.5 h-4 w-4" /> {t("identity.create")}
              </button>
              <button
                className="inline-flex h-10 min-w-0 items-center justify-center rounded-md border bg-background px-2 text-xs font-medium hover:bg-foreground/5"
                type="button"
                onClick={() => changeMode("restore")}
              >
                <Upload className="mr-1.5 h-4 w-4" /> {t("identity.restore")}
              </button>
            </div>
            {!vaults.length && error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        ) : (
          <div className="space-y-4 p-6">
            <button
              className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
              type="button"
              onClick={() => changeMode("saved")}
            >
              <ArrowLeft className="mr-1 h-4 w-4" /> {t("identity.backToIdentities")}
            </button>

            <div>
              <h2 className="text-sm font-semibold">
                {mode === "import"
                  ? t("identity.importTitle")
                  : mode === "create"
                    ? t("identity.createTitle")
                    : t("identity.restoreTitle")}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {mode === "create" ? t("identity.lossWarning") : t("identity.privateKeyNotice")}
              </p>
            </div>

            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  if (passphrase !== confirmPassphrase) {
                    throw new Error(t("error.passphraseMismatch"));
                  }
                  const secret =
                    mode === "create"
                      ? generateIdentitySecretKey()
                      : mode === "restore"
                        ? restoreIdentityBackup(backupInput, backupPassphrase)
                        : parseSecretKey(secretInput);
                  try {
                    const identityPubkey = publicKeyFromSecret(secret);
                    if (mode === "create" || mode === "restore" || remember) {
                      await saveSecretKey(secret, identityPubkey, passphrase);
                    }
                    const activatedPubkey = activateLocalSigner(secret);
                    setSecretInput("");
                    setBackupInput("");
                    return activatedPubkey;
                  } finally {
                    secret.fill(0);
                  }
                });
              }}
            >
              {mode === "import" ? (
                <label className="block text-xs font-medium">
                  {t("identity.secret")}
                  <span className="relative mt-1.5 block">
                    <input
                      autoComplete="off"
                      className="h-10 w-full rounded-md border bg-background px-3 pr-10 font-mono text-xs outline-none focus:ring-2 focus:ring-primary/30"
                      spellCheck={false}
                      type={showSecret ? "text" : "password"}
                      value={secretInput}
                      onChange={(event) => setSecretInput(event.target.value)}
                    />
                    <button
                      aria-label={showSecret ? t("identity.hideSecret") : t("identity.showSecret")}
                      className="buzz-icon-button absolute right-1 top-1 h-8 w-8 flex-none"
                      type="button"
                      onClick={() => setShowSecret((show) => !show)}
                    >
                      {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </span>
                </label>
              ) : null}

              {mode === "restore" ? (
                <>
                  <label className="block text-xs font-medium">
                    {t("identity.backupValue")}
                    <textarea
                      className="mt-1.5 min-h-20 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-primary/30"
                      spellCheck={false}
                      value={backupInput}
                      onChange={(event) => setBackupInput(event.target.value)}
                    />
                  </label>
                  <label className="block text-xs font-medium">
                    {t("identity.backupPassphrase")}
                    <input
                      autoComplete="off"
                      className={formInputClass}
                      type="password"
                      value={backupPassphrase}
                      onChange={(event) => setBackupPassphrase(event.target.value)}
                    />
                  </label>
                </>
              ) : null}

              {mode === "import" ? (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    checked={remember}
                    type="checkbox"
                    onChange={(event) => setRemember(event.target.checked)}
                  />
                  {t("identity.remember")}
                </label>
              ) : null}

              {mode === "create" || mode === "restore" || remember ? (
                <>
                  <label className="block text-xs font-medium">
                    {t("identity.newPassphrase")}
                    <input
                      autoComplete="new-password"
                      className={formInputClass}
                      minLength={8}
                      type="password"
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                    />
                  </label>
                  <label className="block text-xs font-medium">
                    {t("identity.confirmPassphrase")}
                    <input
                      autoComplete="new-password"
                      className={formInputClass}
                      minLength={8}
                      type="password"
                      value={confirmPassphrase}
                      onChange={(event) => setConfirmPassphrase(event.target.value)}
                    />
                  </label>
                </>
              ) : null}

              {mode === "create" ? (
                <label className="flex items-start gap-2 text-xs text-muted-foreground">
                  <input
                    checked={acknowledgedLoss}
                    className="mt-0.5"
                    type="checkbox"
                    onChange={(event) => setAcknowledgedLoss(event.target.checked)}
                  />
                  {t("identity.lossAcknowledgement")}
                </label>
              ) : null}

              {error ? <p className="text-xs text-destructive">{error}</p> : null}
              <button
                className="flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground disabled:opacity-40"
                disabled={
                  working ||
                  (mode === "import" && !secretInput.trim()) ||
                  (mode === "restore" && (!backupInput.trim() || !backupPassphrase)) ||
                  ((mode === "create" || mode === "restore" || remember) &&
                    (passphrase.length < 8 || passphrase !== confirmPassphrase)) ||
                  (mode === "create" && !acknowledgedLoss)
                }
                type="submit"
              >
                {working ? (
                  <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                ) : mode === "restore" ? (
                  <Upload className="mr-2 h-4 w-4" />
                ) : mode === "create" ? (
                  <Plus className="mr-2 h-4 w-4" />
                ) : (
                  <KeyRound className="mr-2 h-4 w-4" />
                )}
                {mode === "restore"
                  ? t("identity.restore")
                  : mode === "create"
                    ? t("identity.create")
                    : t("identity.connectRelay")}
              </button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
