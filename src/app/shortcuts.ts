import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  focusSession,
  launchPresetByIndex,
  openFolderAsProject,
  openSettings,
  requestCloseActiveSession,
  requestQuit,
  saveActiveFile,
  spawnShell,
} from "./actions";
import { currentProjectId, get, isLive, sessionsFor, set, workspaceOf } from "./store";
import { newChat, toggleChatFocus, toggleConversationList } from "@/features/chat/actions";
import { getChat, setChat } from "@/features/chat/store";

/**
 * Global shortcuts, handled in the capture phase so they work inside xterm and
 * Monaco too. Plain Esc is left to terminals (agents use it to interrupt).
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = get();
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey && !e.metaKey;
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const modal = s.dialog !== null || s.paletteOpen;
      // Monaco owns Ctrl+K chords (Ctrl+K Ctrl+C, …); there the palette is Ctrl+P / Ctrl+Shift+P.
      const inEditor = !!(e.target as Element | null)?.closest?.(".monaco-editor");

      if (ctrl && !e.shiftKey && !e.altKey && k === "k" && !inEditor) {
        handled();
        set({ paletteOpen: !s.paletteOpen, paletteMode: "all" });
        return;
      }
      if (inEditor && ctrl && !e.altKey && k === "p") {
        handled();
        set({ paletteOpen: true, paletteMode: e.shiftKey ? "commands" : "files" });
        return;
      }
      if (ctrl && !e.shiftKey && !e.altKey && k === "s") {
        handled();
        void saveActiveFile();
        return;
      }
      if (modal) return;

      // Chat (design v2: Ctrl N new chat · Ctrl / engine menu · Ctrl B list · Ctrl Shift F focus).
      // Esc-to-stop is handled inside ChatView, never globally.
      const projectId = currentProjectId(s);
      const inChat = s.screen === "workspace" && (projectId === null || workspaceOf(projectId).view === "chat");
      if (inChat && ctrl && !e.altKey && ((!e.shiftKey && (k === "n" || k === "b" || e.code === "Slash")) || (e.shiftKey && k === "f"))) {
        handled();
        if (e.shiftKey) toggleChatFocus();
        else if (k === "n") newChat(projectId);
        else if (k === "b") toggleConversationList();
        else setChat({ menuOpen: !getChat().menuOpen });
        return;
      }

      if (ctrl && !e.shiftKey && !e.altKey && k === ",") {
        handled();
        openSettings();
      } else if (ctrl && !e.shiftKey && !e.altKey && k === "o") {
        handled();
        void openFolderAsProject();
      } else if (ctrl && e.shiftKey && k === "n") {
        handled();
        set({ dialog: { type: "createProject" } });
      } else if (ctrl && e.shiftKey && e.code === "Backquote") {
        handled();
        if (s.activeProjectId) void spawnShell(s.activeProjectId);
      } else if (ctrl && e.shiftKey && !e.altKey && k === "w" && (s.focusSessionId || s.screen === "workspace")) {
        // Live sessions still go through the End session confirmation.
        handled();
        requestCloseActiveSession();
      } else if (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
        handled();
        launchPresetByIndex(Number(e.code.slice(5)));
      } else if (s.focusSessionId && ctrl && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        const focused = s.sessions[s.focusSessionId];
        const target = sessionsFor(s, focused?.projectId ?? null)[Number(e.code.slice(5)) - 1];
        if (target) {
          handled();
          set({ focusSessionId: target.id });
          focusSession(target.id);
        }
      } else if (s.focusSessionId && e.shiftKey && k === "escape") {
        handled();
        set({ focusSessionId: null });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Alt+F4 / taskbar close go through the same confirmation as the close button.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        const s = get();
        if (Object.values(s.sessions).some(isLive) || Object.keys(getChat().requests).length > 0 || Object.keys(s.dirty).length > 0) {
          event.preventDefault();
          requestQuit();
        }
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);
}
