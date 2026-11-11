// Chat UI state. SQLite (via the backend) is the source of truth for
// conversations, messages and items; this store caches what's on screen and
// the turns in flight. Kept apart from the app store so streaming tokens only
// re-render Chat.
import { create } from "zustand";
import {
  defaultChatPrefs,
  type ApprovalPolicy,
  type BacklogRef,
  type ChatMessage,
  type ChatMode,
  type ChatPrefs,
  type ChatProvider,
  type Conversation,
  type EngineId,
  type EngineInfo,
  type ProviderStatus,
} from "@/lib/types";

/** Settings of the not-yet-created chat in a workspace. */
export interface NewChatConfig {
  engine: EngineId;
  model: string;
  mode: ChatMode;
  policy: ApprovalPolicy;
}

/** An image pasted into the composer, not sent yet. */
export interface PendingImage {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** `data:` URL: the preview, and the bytes sent with the message. */
  url: string;
}

/** A pending escalation to Agent mode, waiting for the inline confirmation. */
export interface ModeConfirm {
  /** Conversation id, or `null` for the new-chat draft of `ws`. */
  conversationId: string | null;
  ws: string;
}

export interface ChatState {
  loaded: boolean;
  conversations: Conversation[];
  /** Selected conversation per workspace key; null = the new-chat screen. */
  active: Record<string, string | null>;
  /** Loaded transcripts by conversation id. */
  messages: Record<string, ChatMessage[]>;
  /** Turn in flight per conversation id (request id). */
  requests: Record<string, string>;
  /** Earlier messages left out of the last API request, per conversation id. */
  omitted: Record<string, number>;
  /** Unsent text, attached project files and pasted images per draft key (`draftKey`). */
  drafts: Record<string, string>;
  attachments: Record<string, string[]>;
  images: Record<string, PendingImage[]>;
  /** The backlog item a draft is about (its context goes with the message). */
  backlog: Record<string, BacklogRef>;
  /** New-chat settings per workspace key; absent follows the defaults. */
  newChat: Record<string, NewChatConfig>;
  /** A send that failed before it started (e.g. no key, engine missing). */
  composerError: string | null;
  engines: EngineInfo[];
  providers: Partial<Record<ChatProvider, ProviderStatus>>;
  prefs: ChatPrefs;
  menuOpen: boolean;
  /** Conversation id being renamed inline. */
  renamingId: string | null;
  /** Conversation search per workspace key. */
  query: Record<string, string>;
  panel: { open: boolean; tab: "changes" | "activity"; itemId: string | null };
  modeConfirm: ModeConfirm | null;
  /** Chat focus mode (Ctrl Shift F): hides rail, list and panel. */
  focus: boolean;
}

export const initialChatState = (): ChatState => ({
  loaded: false,
  conversations: [],
  active: {},
  messages: {},
  requests: {},
  omitted: {},
  drafts: {},
  attachments: {},
  images: {},
  backlog: {},
  newChat: {},
  composerError: null,
  engines: [],
  providers: {},
  prefs: defaultChatPrefs,
  menuOpen: false,
  renamingId: null,
  query: {},
  panel: { open: true, tab: "changes", itemId: null },
  modeConfirm: null,
  focus: false,
});

export const useChat = create<ChatState>(initialChatState);
export const setChat = useChat.setState;
export const getChat = useChat.getState;

/** Draft key: the conversation id, or `new:<workspace>` for a new chat. */
export const draftKey = (ws: string, conversationId: string | null) => conversationId ?? `new:${ws}`;

export const isGenerating = (s: ChatState, conversationId: string | null) => !!conversationId && !!s.requests[conversationId];
