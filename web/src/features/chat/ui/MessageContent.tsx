import { Bot, Download, ImageOff, LoaderCircle } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMentions from "@/features/chat/lib/remark-mentions";
import { ImageAttachmentViewer } from "@/features/chat/ui/ImageAttachmentViewer";
import { authenticatedMediaObjectUrl } from "@/shared/api/media-client";
import { relayHttpOrigin } from "@/shared/config/runtime-config";
import { t } from "@/shared/i18n";

const IMAGE_MAX_WIDTH = 384;
const IMAGE_MAX_HEIGHT = 256;
const DEFAULT_IMAGE_DIMENSIONS = { width: IMAGE_MAX_WIDTH, height: IMAGE_MAX_HEIGHT };

type ImageDimensions = { width: number; height: number };

export type MessageMention = {
  pubkey: string;
  name: string;
  isAgent: boolean;
};

type MarkdownRenderContextValue = {
  dimensionsByUrl: ReadonlyMap<string, ImageDimensions>;
  mentionsByName: ReadonlyMap<string, MessageMention>;
  onDeleteMessage?: () => void;
  relayUrl: string;
};

const MarkdownRenderContext = createContext<MarkdownRenderContextValue | null>(null);

function useMarkdownRenderContext(): MarkdownRenderContextValue {
  const context = useContext(MarkdownRenderContext);
  if (!context) throw new Error("Message markdown rendered without its context");
  return context;
}

function dimensionsFromDim(value: string | undefined): ImageDimensions | null {
  const match = value?.match(/^(\d+)x(\d+)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function imetaImageDimensions(mediaTags: readonly (readonly string[])[] | undefined) {
  const dimensions = new Map<string, ImageDimensions>();
  for (const tag of mediaTags ?? []) {
    if (tag[0] !== "imeta") continue;
    const url = tag.find((part) => part.startsWith("url "))?.slice(4);
    const dim = tag.find((part) => part.startsWith("dim "))?.slice(4);
    const parsed = dimensionsFromDim(dim);
    if (url && parsed) dimensions.set(url, parsed);
  }
  return dimensions;
}

function isRelayMediaUrl(value: string | undefined, relayUrl: string): boolean {
  if (!value) return false;
  try {
    const origin = relayHttpOrigin(relayUrl);
    const url = new URL(value, origin);
    return url.origin === new URL(origin).origin && url.pathname.startsWith("/media/");
  } catch {
    return false;
  }
}

function ProtectedImage({
  src,
  alt,
  relayUrl,
  dimensions,
  onDeleteMessage,
}: {
  src?: string;
  alt?: string;
  relayUrl: string;
  dimensions?: ImageDimensions;
  onDeleteMessage?: () => void;
}) {
  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setResolved(null);
    if (!src) return;
    void authenticatedMediaObjectUrl(src, relayUrl)
      .then((url) => {
        if (!cancelled) setResolved(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [relayUrl, src]);
  const intrinsic = dimensions ?? DEFAULT_IMAGE_DIMENSIONS;
  const scale = dimensions
    ? Math.min(1, IMAGE_MAX_WIDTH / dimensions.width, IMAGE_MAX_HEIGHT / dimensions.height)
    : 1;
  const frameStyle = dimensions
    ? {
        aspectRatio: `${dimensions.width} / ${dimensions.height}`,
        width: `min(100%, ${Math.max(1, Math.round(dimensions.width * scale))}px)`,
      }
    : { height: `${IMAGE_MAX_HEIGHT}px`, width: `min(100%, ${IMAGE_MAX_WIDTH}px)` };

  return (
    <span
      className="relative inline-flex max-w-full items-center justify-center overflow-hidden rounded-md bg-foreground/5 align-top"
      data-protected-image-frame="true"
      style={frameStyle}
    >
      {failed ? (
        <span className="inline-flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <ImageOff className="h-4 w-4" /> {t("message.imageFailed")}
        </span>
      ) : !resolved ? (
        <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          <button
            aria-label={t("message.expandImage", { name: alt || t("message.attachmentImage") })}
            className="block h-full w-full cursor-zoom-in"
            title={t("message.expandImage", { name: alt || t("message.attachmentImage") })}
            type="button"
            onClick={() => setViewerOpen(true)}
          >
            <img
              alt={alt || t("message.attachmentImage")}
              className="block h-full w-full object-contain"
              decoding="async"
              height={intrinsic.height}
              loading="lazy"
              src={resolved}
              width={intrinsic.width}
            />
          </button>
          {viewerOpen ? (
            <ImageAttachmentViewer
              alt={alt || t("message.attachmentImage")}
              resolvedUrl={resolved}
              sourceUrl={new URL(src ?? resolved, relayHttpOrigin(relayUrl)).toString()}
              onClose={() => setViewerOpen(false)}
              onDeleteMessage={onDeleteMessage}
            />
          ) : null}
        </>
      )}
    </span>
  );
}

function ProtectedLink({
  href,
  children,
  relayUrl,
}: {
  href?: string;
  children: React.ReactNode;
  relayUrl: string;
}) {
  const [loading, setLoading] = useState(false);
  if (!isRelayMediaUrl(href, relayUrl)) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (!href || loading) return;
        setLoading(true);
        void authenticatedMediaObjectUrl(href, relayUrl)
          .then((url) => {
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = String(children) || "attachment";
            anchor.click();
          })
          .finally(() => setLoading(false));
      }}
    >
      {loading ? (
        <LoaderCircle className="mr-1 inline h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="mr-1 inline h-3.5 w-3.5" />
      )}
      {children}
    </a>
  );
}

const MarkdownImage: NonNullable<Components["img"]> = ({ src, alt }) => {
  const { dimensionsByUrl, onDeleteMessage, relayUrl } = useMarkdownRenderContext();
  return (
    <ProtectedImage
      src={src}
      alt={alt}
      dimensions={src ? dimensionsByUrl.get(src) : undefined}
      relayUrl={relayUrl}
      onDeleteMessage={onDeleteMessage}
    />
  );
};

const MarkdownLink: NonNullable<Components["a"]> = ({ href, children }) => {
  const { relayUrl } = useMarkdownRenderContext();
  return (
    <ProtectedLink href={href} relayUrl={relayUrl}>
      {children}
    </ProtectedLink>
  );
};

function MarkdownMention({ children }: { children?: React.ReactNode }) {
  const { mentionsByName } = useMarkdownRenderContext();
  const text = String(children ?? "");
  const label = text.replace(/^@/, "");
  const mention = mentionsByName.get(label.trim().toLocaleLowerCase());
  if (!mention) return <>{children}</>;
  return (
    <span
      className="buzz-message-mention"
      data-mention=""
      data-mention-agent={mention.isAgent || undefined}
      data-mention-pubkey={mention.pubkey}
    >
      {mention.isAgent ? (
        <Bot aria-hidden="true" className="buzz-message-mention-icon" />
      ) : (
        <span className="buzz-message-mention-prefix">@</span>
      )}
      {label}
    </span>
  );
}

const MARKDOWN_COMPONENTS = {
  img: MarkdownImage,
  a: MarkdownLink,
  mention: MarkdownMention,
} as Components;

function displayContent(content: string): string {
  if (!content.trim().startsWith("{")) return content;
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const text = value.message ?? value.text ?? value.action;
    return typeof text === "string" ? text : content;
  } catch {
    return content;
  }
}

export function MessageContent({
  content,
  relayUrl,
  mentions = [],
  mediaTags,
  canDeleteMessage = false,
  onDeleteMessage,
}: {
  content: string;
  relayUrl: string;
  mentions?: readonly MessageMention[];
  mediaTags?: readonly (readonly string[])[];
  canDeleteMessage?: boolean;
  onDeleteMessage?: () => void;
}) {
  const mentionsByName = new Map(
    mentions.map((mention) => [mention.name.trim().toLocaleLowerCase(), mention]),
  );
  const mentionNames = [...mentionsByName.values()].map((mention) => mention.name);
  const dimensionsByUrl = imetaImageDimensions(mediaTags);

  return (
    <MarkdownRenderContext.Provider
      value={{
        dimensionsByUrl,
        mentionsByName,
        onDeleteMessage: canDeleteMessage ? onDeleteMessage : undefined,
        relayUrl,
      }}
    >
      <div className="buzz-message-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks, [remarkMentions, { mentionNames }]]}
          components={MARKDOWN_COMPONENTS}
        >
          {displayContent(content)}
        </ReactMarkdown>
      </div>
    </MarkdownRenderContext.Provider>
  );
}
