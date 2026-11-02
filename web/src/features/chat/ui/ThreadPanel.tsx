import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fallbackProfile } from "@/features/chat/lib/chat-model";
import type {
  AttachmentDescriptor,
  ChannelMember,
  TimelineMessage,
  UserProfile,
} from "@/features/chat/lib/chat-types";
import { MessageComposer } from "@/features/chat/ui/MessageComposer";
import { MessageRow } from "@/features/chat/ui/MessageList";
import { t } from "@/shared/i18n";
import { RightPanelResizeHandle } from "@/shared/ui/right-panel-sizing";

export function ThreadPanel({
  root,
  messages,
  members,
  profiles,
  presence,
  relayUrl,
  disabled,
  maximumWidth,
  minimumWidth,
  panelWidth,
  onClose,
  onReact,
  onResize,
  onSend,
  onTyping,
  currentPubkey,
  canModerate,
  onEdit,
  onDelete,
  draftKey,
  initialReplyTarget = null,
  focusedMessageId = null,
}: {
  root: TimelineMessage;
  messages: TimelineMessage[];
  members: ChannelMember[];
  profiles: Record<string, UserProfile>;
  presence: Record<string, "online" | "away" | "offline">;
  relayUrl: string;
  disabled: boolean;
  maximumWidth: number;
  minimumWidth: number;
  panelWidth: number;
  onClose: () => void;
  onReact: (message: TimelineMessage, emoji: string) => Promise<void>;
  onResize: (width: number) => void;
  onSend: (
    content: string,
    attachments: AttachmentDescriptor[],
    replyTarget: TimelineMessage,
  ) => Promise<void>;
  onTyping: (replyTarget: TimelineMessage) => void;
  currentPubkey: string;
  canModerate: boolean;
  onEdit: (message: TimelineMessage) => void;
  onDelete: (message: TimelineMessage) => void;
  draftKey: string;
  initialReplyTarget?: TimelineMessage | null;
  focusedMessageId?: string | null;
}) {
  const [replyTarget, setReplyTarget] = useState<TimelineMessage | null>(initialReplyTarget);
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadMessages = [root, ...messages.filter((message) => message.rootId === root.event.id)];
  const threadMessageCount = threadMessages.length;
  const focusedMessageLoaded = threadMessages.some(
    (message) => message.event.id === focusedMessageId,
  );
  const replyTargetPubkey = replyTarget?.event.pubkey.toLowerCase() ?? "";
  const replyTargetProfile = replyTarget
    ? (profiles[replyTargetPubkey] ?? fallbackProfile(replyTargetPubkey))
    : null;

  useEffect(() => {
    if (threadMessageCount < 1) return;
    if (focusedMessageLoaded) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [focusedMessageLoaded, threadMessageCount]);

  return (
    <aside
      aria-label={t("thread.title")}
      className="relative flex min-h-0 shrink-0 flex-col border-l bg-background/95 backdrop-blur-xl xl:bg-background/65 xl:backdrop-blur-none max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:shadow-xl max-sm:!w-full"
      style={{ width: panelWidth }}
    >
      <RightPanelResizeHandle
        label={t("thread.resize")}
        maximum={maximumWidth}
        minimum={minimumWidth}
        panelWidth={panelWidth}
        onResize={onResize}
      />
      <header className="flex h-11 shrink-0 items-center justify-between border-b px-3">
        <div>
          <h2 className="text-sm font-semibold">{t("thread.title")}</h2>
          <p className="text-[11px] text-muted-foreground">
            {t("message.replyCount", { count: threadMessages.length - 1 })}
          </p>
        </div>
        <button
          aria-label={t("thread.close")}
          className="buzz-icon-button"
          title={t("thread.close")}
          type="button"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="buzz-scrollbar min-h-0 flex-1 overflow-y-auto py-3">
        {threadMessages.map((message) => {
          const pubkey = message.event.pubkey.toLowerCase();
          const profile = profiles[pubkey] ?? fallbackProfile(pubkey);
          return (
            <MessageRow
              canModerate={canModerate}
              currentPubkey={currentPubkey}
              focused={message.event.id === focusedMessageId}
              key={message.event.id}
              message={message}
              profile={profile}
              profiles={profiles}
              relayUrl={relayUrl}
              presence={presence[pubkey]}
              showThreadAction={false}
              onReply={message.event.id === root.event.id ? undefined : setReplyTarget}
              onDelete={onDelete}
              onEdit={onEdit}
              onReact={onReact}
            />
          );
        })}
        <div ref={bottomRef} className="h-px" data-testid="thread-bottom" />
      </div>
      <MessageComposer
        compact
        disabled={disabled}
        draftKey={draftKey}
        members={members}
        placeholder={t("thread.reply")}
        profiles={profiles}
        relayUrl={relayUrl}
        replyTarget={
          replyTarget && replyTargetProfile
            ? {
                id: replyTarget.event.id,
                author: replyTargetProfile.name,
                body: replyTarget.content,
              }
            : null
        }
        onCancelReply={() => setReplyTarget(null)}
        onSend={async (content, attachments) => {
          await onSend(content, attachments, replyTarget ?? root);
          setReplyTarget(null);
        }}
        onTyping={() => onTyping(replyTarget ?? root)}
      />
    </aside>
  );
}
