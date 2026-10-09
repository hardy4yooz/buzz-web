import { Copy, Download, LoaderCircle, Share2, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { t } from "@/shared/i18n";

function imageFilename(sourceUrl: string, alt: string): string {
  const fallback = "image";
  const label = alt.trim() || fallback;
  let extension = "";
  try {
    const pathname = new URL(sourceUrl).pathname;
    extension = pathname.match(/\.(?:avif|gif|jpe?g|png|webp)$/i)?.[0] ?? "";
  } catch {
    // A useful alt still gives the download a stable name for relative URLs.
  }
  const safeLabel = label
    .replace(/\.(?:avif|gif|jpe?g|png|webp)$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return `${safeLabel || fallback}${extension || ".png"}`;
}

async function imageFile(resolvedUrl: string, sourceUrl: string, alt: string): Promise<File> {
  const response = await fetch(resolvedUrl);
  if (!response.ok) throw new Error(t("message.imageActionFailed"));
  const blob = await response.blob();
  return new File([blob], imageFilename(sourceUrl, alt), {
    type: blob.type || "image/png",
  });
}

function ActionButton({
  label,
  children,
  destructive = false,
  disabled = false,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={`inline-flex h-10 w-10 flex-none items-center justify-center rounded-md border border-white/15 bg-black/45 text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-black/70 disabled:cursor-wait disabled:opacity-50 ${destructive ? "hover:text-red-300" : ""}`}
      disabled={disabled}
      title={label}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function ImageAttachmentViewer({
  alt,
  resolvedUrl,
  sourceUrl,
  onClose,
  onDeleteMessage,
}: {
  alt: string;
  resolvedUrl: string;
  sourceUrl: string;
  onClose: () => void;
  onDeleteMessage?: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busyAction, setBusyAction] = useState<"download" | "share" | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(sourceUrl);
      toast.success(t("message.imageLinkCopied"));
    } catch {
      toast.error(t("message.imageActionFailed"));
    }
  };

  const download = async () => {
    setBusyAction("download");
    try {
      const file = await imageFile(resolvedUrl, sourceUrl, alt);
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      toast.error(t("message.imageActionFailed"));
    } finally {
      setBusyAction(null);
    }
  };

  const share = async () => {
    setBusyAction("share");
    try {
      if (!navigator.share) {
        await navigator.clipboard.writeText(sourceUrl);
        toast.success(t("message.imageShareFallback"));
        return;
      }
      if (!navigator.canShare) {
        await navigator.share({ title: alt || t("message.attachmentImage"), url: sourceUrl });
        return;
      }
      try {
        const file = await imageFile(resolvedUrl, sourceUrl, alt);
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: alt || t("message.attachmentImage") });
          return;
        }
      } catch {
        // Cross-origin images may be viewable but unavailable to fetch as a File.
      }
      await navigator.share({ title: alt || t("message.attachmentImage"), url: sourceUrl });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error(t("message.imageActionFailed"));
    } finally {
      setBusyAction(null);
    }
  };

  return createPortal(
    <div
      aria-label={t("message.imageViewer")}
      aria-modal="true"
      className="fixed inset-0 z-[90] flex min-h-0 flex-col bg-black"
      role="dialog"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="relative z-10 flex min-h-14 items-center justify-between gap-3 border-b border-white/10 px-3 py-2 sm:px-4">
        <p className="min-w-0 truncate text-sm font-medium text-white/85">
          {alt || t("message.attachmentImage")}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <ActionButton
            disabled={busyAction !== null}
            label={t("message.downloadImage")}
            onClick={() => void download()}
          >
            {busyAction === "download" ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </ActionButton>
          <ActionButton
            disabled={busyAction !== null}
            label={t("message.shareImage")}
            onClick={() => void share()}
          >
            {busyAction === "share" ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Share2 className="h-4 w-4" />
            )}
          </ActionButton>
          <ActionButton label={t("message.copyImageLink")} onClick={() => void copyLink()}>
            <Copy className="h-4 w-4" />
          </ActionButton>
          {onDeleteMessage ? (
            <ActionButton
              destructive
              label={t("message.delete")}
              onClick={() => {
                onClose();
                onDeleteMessage();
              }}
            >
              <Trash2 className="h-4 w-4" />
            </ActionButton>
          ) : null}
          <button
            ref={closeRef}
            aria-label={t("common.close")}
            className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
            title={t("common.close")}
            type="button"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-6"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <img
          alt={alt || t("message.attachmentImage")}
          className="block max-h-full max-w-full object-contain"
          decoding="async"
          src={resolvedUrl}
        />
      </div>
    </div>,
    document.body,
  );
}
