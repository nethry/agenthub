# AgentHub

**A lightweight, project-centric desktop workspace for code, terminals, and AI coding agents.**

AgentHub brings local projects, source files, persistent shells and one unified AI Chat into a single desktop application. Each project has its own conversations with local coding agents — **Claude Agent** (Claude Agent SDK), **OpenAI Codex**, **Gemini CLI**, **Google Antigravity**, **GitHub Copilot CLI** — or with direct APIs (**OpenAI**, **Anthropic**, **Gemini**), in Ask, Plan or Agent mode, with approvals, file-change review and session recovery.

> **Project status:** in active development, Windows first (the version is in `package.json`; releases are published on GitHub). The [Roadmap](#roadmap-and-history) lists what is built and what is next; [Verification status](#verification-status) says what has only been tested against recorded protocol fixtures or mock servers. macOS and Linux are planned, not built.

## Product vision

AgentHub is **not another full-featured IDE**. It is a focused workspace that makes switching between projects, editing files, and operating multiple agent terminals feel immediate and effortless.

Core principles:

- **Project-first:** each project is an independent space with its own files, terminals, and saved layout.
- **Minimal UI:** show the current task prominently; reveal secondary controls only when needed.
- **Native agents, one Chat:** drive each coding agent through its official SDK or structured protocol and show all of them — and direct APIs — in one conversation UI. AgentHub is the client; no other orchestrator sits in between.
- **Fast and lightweight:** use the OS webview and avoid an unnecessary local server.
- **Local-first:** project files remain on disk; application state is stored locally.
- **Cross-platform by design:** ship Windows first, with macOS and Linux planned.

## Target platforms

| Platform | Priority | Status |
| --- | --- | --- |
| Windows 10/11 | First | Supported |
| macOS | Later | Planned |
| Linux | Later | Planned |

Native terminal implementations and platform packaging will be validated separately for each operating system.

## Core features

### 1. Project management

- Create a project entry by selecting an existing local folder.
- Optionally create a new project folder.
- Display projects in a compact sidebar and searchable project switcher.
- Switch between project workspaces without closing their live terminal sessions.
- Remember recently opened projects and per-project workspace state.
- Remove a project from AgentHub **without deleting its files from disk**.

### 2. Multiple terminals per project

- Open multiple shell sessions in the selected project's working directory.
- Rename, reorder, focus, resize, and close individual sessions.
- Support **PowerShell 7** (default), **Windows PowerShell**, and **Command Prompt** on Windows; offer **WSL** as a preview shell profile.
- Restart an exited session with its original command and working directory.
- Run any command, including agent CLIs by hand. AgentHub's own agent sessions run in Chat, not in terminals (see [Terminals](#5-terminals)).
- Show basic states: starting, running, exited, failed.
- Split running into **busy** and **idle** on terminal tabs and session rows (see [Busy / idle](#busy--idle) below).
- Keep PTY processes owned by the backend, independent of what the frontend is displaying.
- Support terminal input/output, resize events, ANSI formatting, copy/paste, and scrollback.

**Lifecycle rule:** changing projects or hiding a terminal must not terminate its process. Closing AgentHub ends its managed processes; reattaching terminal sessions across application restarts is **not supported**.

### 3. File explorer and editor

- Browse directories and files inside a registered project root.
- Create, rename, and delete files and folders from the explorer: right-click menu, `F2` to rename, `Del` to delete, plus Copy path / Copy relative path / Reveal in Explorer. Deleting always moves to the **Recycle Bin** (`trash` crate) after a confirmation; it never deletes permanently. Renaming a file or folder carries open tabs and their unsaved edits along.
- Stay in sync with the disk: every registered project root is watched (`notify` + `notify-debouncer-full`, ignoring `.git`, `node_modules`, `target`). The tree and the palette's file index refresh by themselves. An open file that changed on disk reloads silently when it has no unsaved edits. Otherwise a banner offers **Reload from disk** or **Keep my changes**, and a deleted file is flagged ("Saving creates it again").
- Open files with syntax highlighting in Monaco Editor.
- Edit, save, and detect unsaved changes. Saves are atomic: the file is written to a temp file next to it, then renamed over it, with a fallback to a direct write when the rename is refused.
- Encodings (`encoding_rs`): UTF-8 (with or without BOM) and, by BOM, UTF-16 LE/BE open automatically and are saved back the same way. A file that isn't valid UTF-8 can be reopened from the status bar or the error panel in another encoding (e.g. Windows-1250, ISO-8859-2, Windows-1252, Shift JIS). Characters the encoding can't hold are refused on save, never silently replaced.
- Files over 5 MB open **read-only**; files over 50 MB and binary files don't open.
- Switch the sidebar between **Files** and **Source control** (Git, below).
- Support multiple open files and restore the active file per project.
- Provide keyboard shortcuts for common editing actions. Monaco's `Ctrl K` chords work in the editor; there the palette opens with `Ctrl P` (files) or `Ctrl Shift P` (commands).
- Prompt before losing unsaved changes: closing a tab, quitting (with **Save all and quit**), and removing a project (lists the unsaved files and offers **Save all and remove**).
- Preview Markdown files, live as you type. They open in Preview; the Code / Split / Preview toggle in the breadcrumb bar switches view per file. Rendered with `react-markdown` + `remark-gfm` (GitHub tables, task lists, strikethrough). File content is untrusted: raw HTML isn't rendered, images aren't fetched (shown as a placeholder with their alt text), relative links open the file in the editor and can't leave the project root, and only http(s) links open externally.

The editor stays a lightweight code editor, **not** a complete IDE: no built-in debugger, extension marketplace, or full language-server platform. Git is covered by the Source control sidebar below.

#### Source control (Git)

Git lives inside the Editor, sized for reviewing and sharing what coding agents changed (design canvas page **v2 · Editor & Git**, trimmed). The sidebar switches between **Files** and **Source control**; the workspace header shows a branch chip (`⑂ main ↓1 ↑2`) and the editor status bar the branch and sync counts. Agents never commit or push: you review, stage and commit their changes.

- **Changes:** Conflicts, Staged changes and Changes, each file with its status letter (M, A/U, D, R, C), an **AI** badge when an agent changed it in Chat and it isn't committed yet, and **PART** when it is partly staged (e.g. from a terminal). Stage, unstage and discard work on **whole files**; discarding asks inline and moves the current file to the **Recycle Bin** first. Clicking a row opens the file (the diff tab is planned). The file tree shows the same letters.
- **Commit:** message box with a 72-character subject counter, **Amend last commit** (only while it isn't pushed), and **Add AI co-author trailer** when staged files include agent changes (`Co-authored-by: OpenAI Codex <noreply@openai.com>`; one vendor noreply address per engine; default in Settings › Git). Commit, or **& Push**; `Ctrl Enter` / `Ctrl Shift Enter` in the box. Hook output streams while hooks run; a failing hook commits nothing.
- **Sync:** Fetch (all remotes), Pull (fetch, then fast-forward or rebase local commits onto the upstream with autostash), Push (never forced), Publish (`push -u` for a branch without upstream). A rejected push explains why and offers **Pull & push**. Progress streams and can be cancelled.
- **Stopped operations:** when a pull's rebase (or a rebase, merge, cherry-pick or revert started in a terminal) stops on conflicts, a banner lists the conflicted files: fix the markers in the editor, stage the files (staging a file that still has markers asks first), then **Continue**, or **Abort** (confirmed).
- **Safety:** git runs as the system `git` (Git for Windows 2.41+, path override in Settings › Git) with argument lists in the repository folder, never a shell string, `GIT_TERMINAL_PROMPT=0`, and in a Windows Job Object so cancel ends its helpers too. Sign-in goes through Git Credential Manager; AgentHub stores no Git secrets and redacts tokens and `user:pass@` URLs from git output. Operations that rewrite files (discard, pull, Continue, Abort) are refused while affected editor files have unsaved changes (the banner offers **Save all**), and editors reload afterwards. A folder Git doesn't trust (dubious ownership) offers **Trust this folder** (adds it to `safe.directory`).
- **Not built yet:** the canvas shows more than is implemented. Planned, in this order (see Phase 6): typed editor tabs with a read-only diff tab, then branches (picker, Branches tab, switch with stash), then History with the commit graph, Revert, Undo last commit and Reset. **Left out on purpose:** hunk and line staging, merging branches and the 3-way resolver, interactive rebase, a Stashes panel (stash only from the switch dialog), blame, cherry-pick, detached checkout, "Branch here", remote management, and the AI helpers "Draft message" and "Suggest resolution".

### 4. Unified Chat (coding agents and direct APIs)

Chat is the only AI surface. Every project has its own conversations (**Chat** tab); **General** (labelled **Ask** in the UI: the button next to the title-bar search) holds conversations that belong to no project. Project chats use a coding agent in Plan or Agent mode; General chats use a direct API in Ask, so General shows no mode picker. One conversation model, one transcript and one composer serve eight engines in two groups:

| Group | Engine | Integration | Modes AgentHub can enforce |
| --- | --- | --- | --- |
| Coding agents (local) | **Claude Agent** | Official Claude Agent SDK in the Node sidecar, with your **Anthropic API key** | Ask · Plan · Agent |
| | **OpenAI Codex** | `codex app-server` (JSON-RPC over stdio) | Plan · Agent |
| | **Gemini CLI** | `gemini --acp` (Agent Client Protocol v1), with your **Gemini API key** | Ask · Plan · Agent |
| | **Antigravity** | Google's official Antigravity ACP server `agy_acp_server` (Agent Client Protocol v1, from the ACP registry as `antigravity-acp`), with your **Google account** | Ask · Plan · Agent |
| | **Copilot CLI** | Official GitHub Copilot SDK in the Node sidecar (your Copilot login: Copilot CLI or GitHub CLI; the SDK's bundled runtime if the CLI isn't installed) | Ask · Plan · Agent |
| Direct API (Ask only) | **OpenAI API**, **Anthropic API**, **Gemini API** | Rust HTTPS: Responses API, Messages API, `streamGenerateContent` (SSE) | Ask |

AgentHub is the client and orchestrator: there is no OpenCode or other middle layer, and no terminal output is ever parsed. Runtimes are started with argument lists (never shell strings) in the project folder; their processes are owned by the chat runtime, separate from terminals.

- **Modes.** *Ask* (General only, direct APIs) answers from the conversation, with no file or tool access. *Plan* may read and search project files, never edit or run anything; plans render as a plan card with **Implement in Agent mode**, **Copy as Markdown** and **Revise plan**. *Agent* edits files and runs tools with your approval. Escalating to Agent always shows an inline confirmation; the conversation and its history stay the same. A mode the runtime can't keep within these rules is disabled with the reason (e.g. Gemini CLI or Copilot without a mode it can enforce). Project chats offer only coding agents in Plan or Agent (a new one starts in Plan; `@` attaches project files); General offers only direct APIs in Ask. The backend refuses new chats, engine switches and mode switches that break this; chats made before the rule keep their engine and mode.
- **Enforcement.** Every permission request from every runtime goes through `chat::policy` before the runtime gets an answer, whatever the runtime's own modes promise: Ask denies everything; Plan allows reads inside the project and denies the rest; Agent follows the conversation's **approval policy** — *Ask before edits & commands* (default), *Auto-approve edits · ask for commands*, *Auto-approve all in this project* (deletes, `git push`, network installs and anything outside the project still ask). Unknown operations are never auto-approved, and approvals are never remembered beyond a runtime session. Per runtime: Claude runs with `settingSources: []`, an explicit `default` permission mode, no tools in Ask and only Read/Glob/Grep in Plan, and a hook that sends every tool call to AgentHub; Codex runs in a read-only sandbox with `approvalPolicy: "untrusted"`, so every edit and non-trusted command is an approval AgentHub answers; Gemini CLI and Antigravity route project reads and writes through AgentHub's `fs/*` handlers and ask before edits and commands (AgentHub never picks one of their auto-approving modes); because Antigravity's own permission settings also apply, AgentHub checks each of its finished tool calls and ends the turn with an error if it edited, ran or (in Ask) read something without asking; Copilot gets no tools in Ask and has every non-read permission rejected in Plan. Known limits are listed in Settings › AI integrations (e.g. no command sandbox on native Windows for Claude; an approved Codex command may re-run outside Codex's sandbox).
- **Approvals.** A permission card (an `alertdialog` that takes focus) shows the command or files, with **Approve once**, **Allow for this session** (only where the runtime can scope it to the session), **Deny**, **Cancel task**, and for commands **Run it yourself in a terminal** (opens a terminal with the command typed in, never run). Decisions made by the policy appear as compact rows ("APPROVED ONCE · BY POLICY").
- **Activity and output.** Text, reasoning (collapsed), tool rows (grouped into an Activity block), command cards with expandable output and exit status, plan cards, file-change summaries, system notes and errors are stored as typed items of the assistant message, so the transcript is rebuilt exactly after a restart. Token usage and cost appear under an answer only as the engine reported them.
- **Changes.** Before AgentHub lets a write through it takes a checkpoint of the file (app data folder, not SQLite). When the turn ends, each changed file becomes a file-change item with +/− counts. The **Changes** panel (agent chats) shows the diff against the checkpoint, **Open in editor**, **Revert** per file, **Keep all** and **Revert all** (confirmed; reverting a file the agent created moves it to the Recycle Bin). The editor marks agent-changed files with an **AI** badge, and if an agent changes a file that has unsaved edits, nothing is overwritten: the banner offers *Keep my edits*, *Load agent version* (confirmed) and *Open conversation*.
- **Sessions and recovery.** Conversations store the engine, model, mode, policy, status and the runtime's own session/thread id. Switching projects or conversations never stops a turn. The next turn resumes the runtime session (Claude `resume`, Codex `thread/resume`, Gemini `session/load`, Copilot `resumeSession`; Antigravity keeps one server per conversation and switches model and mode in place, and since its `session/load` replays nothing, a restarted conversation always gets the recap); if that fails, a fresh session starts, the transcript says so, and earlier messages are passed as a plain-text recap — the runtime's private context is never claimed to have survived. After a crash or quit mid-turn the conversation shows *Interrupted*; nothing re-runs automatically. An agent conversation is bound to its runtime: picking another runtime starts a new chat (API chats can switch provider in place).
- **Status chips** (list, header, Overview, rail): *Streaming*, *Running* (both glow), *Approve*, *Interrupted*, *Error*, *Stopped*, *Done*. Approve, Interrupted and Error add to the amber count on the rail and on the Chat tab.
- **Direct APIs** keep the v1 behavior: streaming, Stop (`Esc`), Regenerate/Retry (never automatic), normalized errors, context rebuilt from local storage within ~90k tokens (older messages left out are counted in the transcript). Gemini answers end on the chunk carrying `finishReason`; a `400 API_KEY_INVALID` is reported as an invalid key.
- **Keys and accounts.** OpenAI, Anthropic and Gemini API keys live in the OS credential store (read only in Rust; the UI sees the last four characters). The Anthropic key is also what Claude Agent uses — Anthropic doesn't allow third-party apps to offer claude.ai subscription login through the Agent SDK, so AgentHub doesn't. Gemini CLI uses the Gemini API key (Google no longer lets personal accounts sign in to Gemini CLI; they use Antigravity). Codex and Copilot use their own sign-in; Antigravity signs in with Google through **Sign in with Google** in Settings, which runs the server's own browser sign-in only when you click it. AgentHub never reads any runtime's credential files.
- **Settings › AI integrations** lists each runtime's detection (path, version, account label, sign-in state, enforceable modes and notes) with **Recheck**, a path override, and install/sign-in commands typed into a terminal for you to run; then the direct-API keys (save & test, replace, remove, list models, custom model IDs, Anthropic max output tokens), the capability matrix and the default approval policy. Every integration has an on/off switch (the backend owns it: `engines_disabled` setting). A turned-off integration is never probed or started (Codex's usage windows aren't fetched either), its turns are refused, its idle runtime sessions are closed, and its chats, models, status, usage meter and changed files are hidden everywhere (engine menu, chat lists, Overview, palette, rail and tab counts). Nothing is deleted, and turning it back on re-probes it. Turning one off is refused while one of its turns runs. A direct-API key stays editable while an agent that runs on it (Claude Agent on Anthropic, Gemini CLI on Gemini) is on. **Settings › Chat** holds the default engines (a coding agent for projects, a direct API for Ask) and the send key.

#### Usage limits

The usage readout in the composer bar follows the chat's engine. With Codex it's a meter of OpenAI Codex's 5-hour session and weekly windows (top bar / bottom bar); click it for the details (percentages, reset times, running Codex chats, sync time, refresh, thresholds from Settings › General; defaults 80% and 95%). Numbers come from `codex app-server` (`account/rateLimits/read` on start, every 5 minutes and when the details open, plus `account/rateLimits/updated` while a Codex chat runs); Codex uses its own sign-in. Claude Agent runs on an API key, which has no plan windows, and Gemini reports none, so for every other engine the readout shows the tokens and cost (when reported) that this chat's answers reported, and each answer shows its own. The v1 Claude status-line relay was removed: it only worked for Claude sessions launched in terminals.

### 5. Terminals

Terminals are for shells and your own commands. **Saved commands** (Settings › Terminals & shells; `Alt 1–9`) start ordinary terminal sessions; built-in agent presets from v1 were migrated (a custom executable path became the engine's path override) and removed. You can still run `claude`, `codex`, `gemini` or `copilot` by hand in any terminal; AgentHub just doesn't manage those as agent sessions.

#### Busy / idle

While a session is running, AgentHub reports one of two activity states. Each is derived from one of two sources, and the chip's tooltip names which:

- **Shell prompt marks (plain PowerShell and Command Prompt sessions).** AgentHub adds [OSC 133](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md) markers when it starts the shell. PowerShell gets `-NoExit -Command` with a fixed script that wraps `prompt` (and `PSConsoleHostReadLine` when PSReadLine is loaded) after your profile has run. Command Prompt gets a `PROMPT` environment variable that wraps your own. Your profile files are never modified. *Idle* = the prompt is showing; *busy* = a command is running, even a silent one.
- **Terminal output (custom commands, WSL, and any shell without marks).** *Busy* = the program printed output in the last 2 s, ignoring keystroke echo (300 ms after input) and resize redraws (500 ms). *Idle* = 2 s of silence. A CLI that keeps a spinner moving shows busy while it works.

Known limitations:

- A silent program shows idle on the output source.
- A program started by hand inside a shell session shows busy for as long as it runs, because the shell's command is running.
- WSL sessions use the output source only.

The logic lives in `src-tauri/src/terminals/activity.rs`.

Busy/idle describes terminals only. Agent conversations get their state from the runtime's structured events (Running, Approve, Done…), never from output silence.

### 6. Automatic updates

Installed copies find new versions by themselves and install them only when you say so (no canvas design; plain Midnight HUD dialogs).

- **Checks:** about 30 seconds after start and then once a day (at most every 12 hours, so frequent restarts don't hit the host), from Rust: the webview's CSP is closed to remote origins, so the updater plugin (`tauri-plugin-updater`) checks, downloads and installs in the backend and the UI only calls AgentHub's own commands. **Settings › General › Updates** shows the state, has **Check now** and a switch for the automatic checks.
- **You decide:** a found version shows an **Update** chip in the title bar and a dot on the Settings button. The dialog shows the release notes (Markdown, no raw HTML) with **Later**, **Skip this version** and **Download**. Downloading doesn't restart anything and can be hidden while you work. When it's ready the chip says **Restart**.
- **Restart safety:** the restart step lists what it would interrupt, with the same check as quitting (terminal sessions, chat turns, running Git operations and unsaved files), and offers **Save all and restart**. Only that confirmation runs the installer: it ends terminals and chat turns like Quit does, and on Windows the installer closes the app and starts the new version. Projects and layout are restored; interrupted turns are marked as such.
- **Trust:** every update is verified against the public key in `tauri.conf.json`; a missing or wrong signature is refused. The signing key is kept outside the repository (back it up: without it installed copies can never update again).
- **Releases:** GitHub Releases (`latest.json` plus the signed NSIS installer) of the repository named in `plugins.updater.endpoints` in `tauri.conf.json`. One version in `package.json` (`pnpm version:set x.y.z` keeps the Cargo manifests and the sidecar package in step, `pnpm version:check` verifies). `.github/workflows/release.yml` builds a draft release from a `v*` tag; see [docs/RELEASING.md](docs/RELEASING.md). Not done yet: Windows code signing (installers are unsigned, so SmartScreen warns).

## User experience

### Overall layout

The application uses a **project-centric dashboard**, not a traditional VS Code-style IDE layout:

1. **Title bar (40 px, custom):** AgentHub mark, global search (`Ctrl K`: chats, files, commands, projects), the **Ask** button (chats without a project), an **Update** chip while an update is waiting, window controls.
2. **Project rail (232 px, or 60 px collapsed):** the projects with their full names (initials only when collapsed with the »/« button; the choice is saved), an add-project button and Settings. **General** (chats without a project) is the button next to the title-bar search, with the same signals. An amber count shows conversations that need you (Approve, Interrupted, Error); a cyan dot means a chat is running; a green dot means a terminal is.
3. **Workspace header (48 px):** name and path, view tabs **Overview · Chat · Code · Terminals** (General, titled **Ask**, has only Chat; the Chat tab carries the amber count), and the Chat focus button (`Ctrl Shift F` hides rail, list and panel).
4. **Overview:** four lists with actions — Conversations, AI activity (needs approval / running / interrupted, with Review · Watch · Resume), Recently changed files (by agents) and Terminals. Design: "v2 · Project overview".
5. **Chat:** conversation list (268 px; search, status chips, rename, delete), conversation header (title, mode, engine · model · policy, status, Changes toggle), transcript (max 760 px), composer (engine & model menu `Ctrl /`, Plan/Agent switch in projects, policy chip, `@` attachments and pasted images, Send/Stop), and the Changes / Activity panel (380 px, agent chats). See [Unified Chat](#4-unified-chat-coding-agents-and-direct-apis).
6. **Editor view:** a sidebar that is either the project-scoped explorer (modified, **AI** and Git status markers) or **Source control**, and the Monaco editor with tabs, breadcrumbs, unsaved indicator, conflict banner and a status bar (branch and sync counts, line/column, language, encoding, line endings). Opening a file from anywhere switches here.
7. **Terminals view:** shells and saved commands only — a draggable session list (inline rename) beside split terminal panes, plus terminal focus mode (numbered tabs, `Shift Esc` to exit).

Overlays and secondary screens:

- **Command palette (`Ctrl K`):** fuzzy search across Chats (all projects and General), Projects, Files (`@`), Sessions (`#`), and Commands (`>`, including *New Agent chat with …*); `Enter` opens, `Ctrl Enter` opens a terminal in focus mode. Switching projects never ends live sessions or chat turns.
- **First run:** *Open existing folder* (`Ctrl O`) or *Create new folder* (`Ctrl Shift N`), plus **Connect AI**: the runtime probe and an *Add key* shortcut.
- **Settings (`Ctrl ,`):** General (default shell, updates, usage thresholds), Appearance, AI integrations, Chat, Editor, Git, Terminals & shells, Keyboard shortcuts.
- **Dialogs:** Add project, Unsaved changes, End running session, Remove project (its chats move to Ask), Quit with running work, Delete conversation (file changes on disk are kept), Revert all changes, Update available / Restart to update, custom saved command — each states its consequence explicitly.

Panels can be resized or collapsed. The app should remember the selected view and basic layout for each project.

Default keyboard shortcuts (also listed in Settings › Keyboard shortcuts). They are handled globally, so they work inside terminals and the editor:

| Action | Shortcut |
| --- | --- |
| Command palette / search | `Ctrl K` (in the editor: `Ctrl P` files, `Ctrl Shift P` commands) |
| Explorer: rename / delete | `F2` / `Del` |
| Settings | `Ctrl ,` |
| Open existing folder as project | `Ctrl O` |
| Create new project folder | `Ctrl Shift N` |
| Chat: new chat / engine & model / list / focus | `Ctrl N` / `Ctrl /` / `Ctrl B` / `Ctrl Shift F` (only in Chat) |
| Chat: send / new line | `Enter` / `Shift Enter` (or `Ctrl Enter` / `Enter`, per Settings › Chat) |
| Chat: stop the turn | `Esc` (only while focus is in Chat) |
| Source control: commit / commit & push (in the message box) | `Ctrl Enter` / `Ctrl Shift Enter` |
| New terminal (default shell) | ``Ctrl Shift ` `` |
| Run saved command 1–9 | `Alt 1`–`Alt 9` |
| Close active terminal (asks first if its process is running) | `Ctrl Shift W` |
| Save file | `Ctrl S` |
| Terminal copy / paste | `Ctrl Shift C` / `Ctrl Shift V` (also `Ctrl C` with a selection, `Ctrl V`) |
| Terminal focus mode: switch session | `Ctrl 1`–`Ctrl 9` |
| Exit terminal focus mode | `Shift Esc` |
| Close palette or dialog | `Esc` |

Two deliberate departures from the designs: focus mode exits with `Shift Esc` (not plain `Esc`), and its session tabs switch with `Ctrl` + number (not a bare number). Plain `Esc` and digits must reach the terminal, because agents such as Claude Code use `Esc` to interrupt.

### Visual direction: Midnight HUD

A **dark-only**, precise heads-up-display look: square corners, thin lines, one holographic blue accent, and glow reserved for live state. The design source of truth is the AgentHub design canvas, page **v2 · Unified workspace** (interactive showcase, project overview, Chat Plan/Agent/Ask scenarios, chat states, compact 1024 px, editor conflict, terminals, AI integrations, overlays, component inventory, handoff). Page v1 is kept for history.

**Color**

| Token | Value | Use |
| --- | --- | --- |
| Ground | `#05080D` | App background, title bar, rails |
| Surface | `#0A111A` | Panels, cards, dialogs |
| Well | `#03060A` | Editor, terminal, inputs |
| Line | `#1C3049` | Borders and dividers |
| Line (strong) | `#3A4F69` | Neutral chip and avatar borders |
| Accent (holo) | `#4DA3FF` | Primary actions, focus, selection, links |
| Accent hover | `#A8D1FF` | Link hover |
| On accent | `#020A18` | Text on accent fills |
| Selected | `#4DA3FF` @ 10% fill / 45% border | Selected rows, active project |
| Text primary | `#DCEBFF` | Headings, key content |
| Text body | `#A3B8CF` | Body copy |
| Terminal text | `#BCD0E6` | Terminal output |
| Text muted | `#8AA0B8` | Secondary labels, readouts |
| Text dim | `#4C627A` | Line numbers, gutters |
| Running / success | `#3DF5A0` | Running status, additions |
| Starting / warn | `#FFB547` | Starting status, caution |
| Failed / danger | `#FF5470` | Failed status, destructive actions |
| Tag | `#B79CFF` | Tags, keywords |
| Mode · Ask | `#4DA3FF` | Ask mode (same as accent) |
| Mode · Plan | `#B79CFF` | Plan mode, plan cards, read-only |
| Mode · Agent | `#38E1FF` | Agent mode, running agents, AI badge |
| Raised | `#0F1A28` | User messages |

Mode colors never stand alone: every mode also shows its label, and Agent adds the policy chip. Only *Streaming* and *Running* chips (and a running agent's avatar) glow.

Syntax highlighting: keyword `#B79CFF`, function `#4DA3FF`, type `#FFB547`, string `#7CF5B8`, comment `#6E86A0`.

**Typography**

| Role | Font | Spec |
| --- | --- | --- |
| Display | Rajdhani 700 | 40 px, uppercase, +6% tracking |
| Workspace title | Rajdhani 700 | 24 px, uppercase, +14% tracking |
| Buttons, labels, tabs, section headers | Rajdhani 600–700 | 12–13 px, uppercase, +12–16% tracking |
| Body | Chakra Petch 400–600 (fallback Segoe UI) | 13/20 px |
| Code | JetBrains Mono 400–500 | 12.5/21 px (focus-mode terminal 14/23) |
| Readouts | JetBrains Mono | 10.5–11 px, uppercase, real values only |

**Shape, texture, and motion**

| Aspect | Rule |
| --- | --- |
| Radius | 0 everywhere; 8 px chamfered corners only on primary and danger buttons |
| Frames | 1 px lines; corner brackets on panels, cards, and dialogs |
| Texture | 40 px grid (~3.5% accent) on the ground; faint scanlines in terminal wells |
| Glow | Only on active, focused, or running state |
| Motion | 180–280 ms via **Motion for React**; brackets draw in; all motion off with OS **reduced motion** |
| Icons | Lucide, 16 px, stroke 1.5, square caps, miter joins; no emoji |

**Process status** chips always combine color, glyph, and label so they never rely on color alone: `STARTING` (amber arc), `RUNNING` (green filled square), `EXIT <code>` (muted hollow square), `FAILED` (red ✕). Once activity is known, `RUNNING` shows as `BUSY` (orange `#FFB547` square, pulsing glow; steady glow under reduced motion) or `IDLE` (green square, no glow). The project rail dot and count turn orange and pulse when any of that project's sessions is busy. Agent executable detection uses separate labels: `ONLINE`, `NOT FOUND`, `NOT ON PATH`.

Design guidelines:

- Limit the accent to interactive and selected elements; keep everything else in the neutral line/text scale.
- Use blur only for transient overlays (command palette scrim).
- Keep editor and terminal content high contrast; body text must meet 4.5:1.
- Static decoration (grid, scanlines, empty-state reticle) stays low-opacity and never animates continuously.
- Write plain, specific copy; destructive dialogs state exactly what will and won't happen.

## Technology stack

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Desktop runtime | **Tauri 2** | Native windows, IPC, packaging, OS integration |
| Frontend | **React + TypeScript + Vite** | Workspace UI |
| Components | **shadcn/ui** | Accessible component primitives |
| Styling | **Tailwind CSS** | Theme and layout |
| Animation | **Motion for React** | UI transitions |
| Client state | **Zustand** | Active project, views, transient UI state |
| Code editor | **Monaco Editor** | Syntax-highlighted file editing |
| Markdown | **react-markdown** + **remark-gfm** | Editor preview, chat answers, release notes (no raw HTML) |
| Terminal renderer | **xterm.js** + `@xterm/addon-webgl` | Terminal display and keyboard input; the WebGL renderer (as in VS Code) draws block and box characters itself, falling back to the DOM renderer without WebGL |
| Native backend | **Rust** | File system, sessions, process management |
| Terminal processes | **portable-pty** | Windows ConPTY; Unix PTY on macOS/Linux later |
| Local storage | **SQLite** | Registered projects, preferences, saved workspace metadata, chat history |
| Direct APIs | **reqwest** (`native-tls`: SChannel on Windows) + `futures-util`, `tokio` | Streaming requests to the OpenAI, Anthropic and Gemini APIs |
| Native agents (Rust) | stdio JSON-RPC (`chat/agents/jsonrpc.rs`), ACP core (`chat/agents/acp.rs`) | `codex app-server`, `gemini --acp`, `agy_acp_server` (Antigravity ACP server, proprietary, installed by the user from the ACP registry) |
| Native agents (Node sidecar) | **@anthropic-ai/claude-agent-sdk** (proprietary, Anthropic Commercial Terms), **@github/copilot-sdk** (MIT) in `sidecar/`, run with Node.js ≥ 20.19 | Claude Agent and Copilot CLI sessions, supervised by Rust |
| Diffs | **similar** | Checkpoint diffs and +/− counts |
| Base64 | **base64** | Pasted chat images between the UI, Rust and the runtimes |
| Updates | **tauri-plugin-updater** (`native-tls`) | Signed updates from GitHub Releases: checked, downloaded and installed from Rust |
| Git | system **git** (Git for Windows ≥ 2.41) + **windows-sys** Job Objects | Source control: status, staging, commits, sync; git and its helpers end together on cancel |
| Secrets | **keyring** 3 (`windows-native`; Keychain / Secret Service later) | Direct-API keys (and Claude Agent's Anthropic key) in the OS credential store |

Prefer established, maintained dependencies and note any new one in this table.

## High-level architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│ Tauri window · React + TypeScript                                │
│  ├─ Project rail, Ask button, palette, settings, update chip     │
│  ├─ Chat (own Zustand store): list · transcript · composer ·     │
│  │   approvals · Changes panel                                   │
│  ├─ Editor (Monaco outside React) · Files / Source control       │
│  │   (Source control has its own Zustand store)                  │
│  └─ Terminals (xterm.js outside React)                           │
└────────────────────────────┬─────────────────────────────────────┘
                             │ Tauri commands · events · Channels
┌────────────────────────────▼─────────────────────────────────────┐
│ Rust backend                                                     │
│  ├─ projects · filesystem (root-scoped) · watchers · SQLite      │
│  ├─ terminals: PTY manager (shells and saved commands)           │
│  ├─ git ───────argv, no shell──────► system git (Job Object)     │
│  ├─ updates ─────HTTPS───────► GitHub Releases (signed updates)  │
│  └─ chat                                                         │
│      ├─ service: one turn per conversation; direct APIs ─HTTPS─► │
│      │            OpenAI · Anthropic · Gemini                    │
│      ├─ policy: mode + approval policy, every permission request │
│      ├─ agents::turn: events → items, approvals, checkpoints     │
│      ├─ agents::codex ──stdio JSON-RPC──► codex app-server       │
│      ├─ agents::acp ──stdio ACP─┬─────► gemini --acp (gemini)    │
│      │                          └─────► agy_acp_server (antigr.) │
│      └─ agents::sidecar ─stdio JSON-RPC─► node sidecar/main.mjs  │
│                                           ├─ Claude Agent SDK    │
│                                           └─ Copilot SDK         │
└──────────────────────────────────────────────────────────────────┘
```

**Turn data flow:** `chat_send` / `chat_regenerate` take a Tauri `Channel`. The backend stores the user message (and its attachments) and a `streaming` placeholder in one transaction, then streams `started` → `delta` / `item` / `output` / `status` / `usage` … → `finished`, each tagged with the conversation and request id, so late events of a stopped or other turn are dropped. Direct APIs stream text into the message; agent adapters emit normalized `AgentEvent`s that `agents::turn` turns into stored items. Approval requests wait in Rust until the policy or the user answers (`chat_respond_approval`). Partial text and items are saved as they arrive (every ~1.5 s), and a turn left running by a crash is marked *interrupted* at the next start.

**Processes:** Codex runs one long-lived app-server with a thread per conversation; Gemini runs one ACP process per conversation; the Node sidecar hosts the Claude and Copilot SDK sessions. Each is restarted after a crash on the next turn, and in-flight turns fail with "runtime exited" instead of hanging. All of them end when AgentHub quits.

**Data flow (terminals):** terminal output and lifecycle updates arrive as events; the backend owns PTYs; the frontend renders.

**Data flow (Git and updates):** the Git service runs the system `git` and returns a status snapshot with every operation; a watcher on the git directory emits `git-changed` so the sidebar also follows commits made in a terminal. The update service checks, downloads and installs from Rust; the UI only calls its commands and listens for `update-available`.

## Draft domain model

```text
Project
  id
  name
  directory_path
  created_at
  last_opened_at

TerminalSession
  id
  project_id
  title
  shell_or_command
  working_directory
  status
  started_at
  exited_at?

WorkspaceState
  project_id
  open_files[]
  active_file?
  active_terminal_id?
  selected_view
  layout_preferences

SavedCommand          # v1 "presets"; terminal commands only
  id
  display_name
  executable
  arguments[]
  shell_profile
  working_directory   # project root or relative subfolder
  enabled

Conversation          # chat_conversations (migration v3)
  id
  project_id?         # null = General
  title               # from the first message; renamable
  engine              # claude-code | codex | gemini-cli | antigravity | copilot-cli | openai-api | anthropic-api | gemini-api
  model
  mode                # ask | plan | agent
  policy              # ask | auto_edits | auto_all
  status              # idle | running | waiting_for_approval | completed | failed | cancelled | interrupted
  runtime_session_id? # the engine's own session/thread id
  created_at, updated_at

ChatMessage
  id, conversation_id, seq
  role                # user | assistant
  content             # visible text only
  status              # complete | streaming | stopped | error
  engine?, model?     # what produced an answer
  error?, usage?      # normalized error; token counts / reported cost

ChatItem              # agent activity and attachments, ordered within a message
  id, message_id, idx
  kind                # text | thinking | tool | command | permission | plan | file_change | system | error | attachment | image
  status              # pending | running | completed | failed | declined | cancelled
  payload             # typed JSON (never raw protocol messages)

EngineProbe           # cached detection result per runtime (no secrets)
```

Migrations are versioned and each runs in one transaction with its `user_version` bump (a failure leaves the database unchanged). **v3** renames `provider` to `engine` (`openai`→`openai-api`, `anthropic`→`anthropic-api`), adds project, mode, policy, status and runtime-session columns (existing chats land in General), adds `chat_items` and `engine_probes`, turns built-in agent presets into engine path overrides (when you had customized the path) and deletes them; user-made presets stay as saved terminal commands. Removing a project moves its chats to General.

Persist project registration, saved commands, preferences, restorable UI state, conversations and items to SQLite. Live PTY handles, terminal buffers and runtime processes are **not** in the database; file checkpoints and pasted chat images are files in the app data folder (`checkpoints/` and `chat-images/<conversation>/`). Preferences are JSON values in the `settings` key/value table (`editor`, `terminal`, `usage`, `chat`, `git`, `updates`, `ui`); keys owned by the backend (`engine_path:*`, `git_path`, `engines_disabled`, `updates_last_check`) can't be written from the UI. Git status and update state aren't stored: the repository and the release host are the source of truth.

## Repository structure

```text
agenthub/
├── README.md
├── AGENTS.md                # shared instructions for AI coding agents
├── CLAUDE.md                # Claude Code entry point (imports AGENTS.md)
├── GEMINI.md                # Gemini CLI entry point (imports AGENTS.md)
├── opencode.jsonc           # OpenCode config (CodeGraph MCP server)
├── package.json             # pnpm scripts (dev, build, test, tauri); the one app version
├── scripts/set-version.mjs  # sets or checks the version in package.json, the sidecar and Cargo.toml
├── docs/RELEASING.md        # how to cut a release
├── .github/workflows/       # ci.yml (checks), release.yml (tag → draft release with latest.json)
├── sidecar/                 # Node sidecar: Claude Agent SDK + Copilot SDK adapters (TypeScript)
├── vite.config.ts
├── src/
│   ├── app/                 # shell: store, actions, title bar, workspace, dialogs, shortcuts
│   ├── components/ui/       # shadcn-style primitives on Radix (button, dialog, menu, form, status)
│   ├── features/
│   │   ├── projects/        # rail, welcome screen, add/create/remove dialogs
│   │   ├── explorer/        # lazy file tree
│   │   ├── editor/          # Monaco setup, theme, file models, editor pane
│   │   ├── terminals/       # xterm registry, panes, Terminals view, focus mode, new-terminal menu
│   │   ├── overview/        # Overview: conversations, AI activity, changed files, terminals
│   │   ├── palette/         # command palette
│   │   ├── chat/            # unified Chat: store, flows, view, list, items, composer, engine menu, changes panel
│   │   ├── usage/           # chat usage readout and details
│   │   ├── git/             # Source control sidebar, branch chip, git store and flows
│   │   ├── updates/         # update badge, dialog, store and flows
│   │   └── settings/        # settings screen, AI integrations, Chat, saved commands
│   ├── lib/                 # typed IPC client, types, utils
│   └── styles/globals.css   # Midnight HUD tokens (Tailwind v4 @theme)
└── src-tauri/
    ├── src/
    │   ├── commands/        # Tauri command handlers (thin)
    │   ├── projects/        # project registry + workspace state
    │   ├── filesystem/      # root-scoped file service
    │   ├── terminals/       # PTY session manager, shell detection
    │   ├── presets/         # saved terminal commands (v1 presets)
    │   ├── chat/            # service, repository, policy, engines, checkpoints, images, secrets,
    │   │                    # providers/{openai,anthropic,gemini},
    │   │                    # agents/{turn,jsonrpc,codex,acp,gemini,antigravity,sidecar}
    │   ├── usage/           # Codex usage windows
    │   ├── updates/         # update check, download, install; the daily check
    │   ├── git/             # git runner, status, staging, commit, sync, git-dir watcher
    │   └── persistence/     # SQLite + migrations
    ├── capabilities/        # scoped Tauri permissions
    └── tauri.conf.json
```

Terminal output reaches the frontend through the `terminal-output` and `terminal-status` events. Each `SessionInfo` carries a monotonic `version`, so the frontend keeps the newest snapshot when an event and a command reply arrive out of order. xterm.js instances live in `src/features/terminals/registry.ts`, outside React, so hiding a view never loses scrollback.

## Roadmap and history

Phases 1–5 delivered the original scope (workspace, terminals, Chat) and stay here as history. Phases 6 and 7 and the unchecked items are the current work. Tick a box only when the item actually works.

### Phase 1 — Workspace foundation

- [x] Scaffold Tauri 2 + React + TypeScript.
- [x] Implement Midnight HUD theme and main application shell.
- [x] Add/import/remove projects (without deleting local folders).
- [x] Implement fast project switching and search.
- [x] Build project-scoped file explorer.
- [x] Integrate Monaco Editor and basic save workflow.
- [x] Persist registered projects and workspace metadata.

### Phase 2 — Terminal sessions

- [x] Implement Windows PTY session creation and termination.
- [x] Wire terminal output/input to xterm.js.
- [x] Handle terminal resize, cleanup, and exit status.
- [x] Support multiple terminals per project.
- [x] Preserve live sessions while navigating between projects.
- [x] Add session rename, focus, close, and basic split/focus modes.

### Phase 3 — AI agent workflow (v1; superseded by Phase 5)

In v1 agents ran as terminal presets. Phase 5 moved them into Chat; the items below describe v1 and were replaced, not removed silently.

- [x] Add presets for Claude Code, Codex CLI, and OpenCode.
- [x] Detect available CLI executables or allow manual executable configuration.
- [x] Launch a chosen agent inside a project terminal.
- [x] Show accurate process status on agent cards.
- [x] Add command palette and keyboard shortcuts.
- [x] Polish transitions and restore preferred workspace layout.

### Phase 4 — AI Chat (v1; became Ask mode in Phase 5)

- [x] Chat screen from the project rail, with conversation list, header, transcript and composer (design: AI Chat artboards).
- [x] SQLite history (migration v2): create, rename, switch, delete; restored after restart.
- [x] API keys in the OS credential store with save, replace, remove and a real connection test (now Settings › AI integrations).
- [x] OpenAI Responses API and Anthropic Messages API adapters with streaming, stop, regenerate and normalized errors.
- [x] Model selection with built-in and custom model IDs, saved per conversation.
- [x] Markdown answers with Monaco-highlighted, copyable code blocks.

### Phase 5 — Unified Chat (v2)

- [x] Conversations per project and General; migration v3 keeps v1 history, moves it to General, and migrates presets.
- [x] Engine catalog with enforceable modes and a startup probe (path, version, sign-in, models); Settings › AI integrations and Settings › Chat.
- [x] Each AI integration can be turned on or off; turned-off ones are never started and their data is hidden (chats stay stored).
- [x] Direct APIs: OpenAI, Anthropic and **Gemini** (streaming, usage, model listing, normalized errors).
- [x] Policy engine for Ask / Plan / Agent and the three approval policies; inline approvals; Agent escalation confirmation.
- [x] Typed items (text, thinking, tools, commands, approvals, plans, file changes, attachments) persisted and rendered.
- [x] Paste clipboard images into project and Ask chats; sent natively to every coding agent and direct API (tested against fake peers and mock servers only).
- [x] Checkpoints before writes, diffs, Revert / Keep, Changes panel; editor AI badge and conflict banner.
- [x] Codex adapter (app-server JSON-RPC) and Gemini CLI adapter (ACP), tested against recorded protocol fixtures.
- [x] Antigravity adapter (official ACP server) on the shared ACP core, with Google sign-in from Settings; tested against fake ACP peers only (see [Verification status](#verification-status)).
- [x] Gemini CLI on Gemini API keys only (personal Google sign-in was retired by Google).
- [x] Claude Agent and Copilot adapters in the Node sidecar, supervised from Rust.
- [x] Workspace rail with General, Chat tab, v2 Overview; terminals for shells and saved commands only.
- [x] Project chats are coding agents in Plan/Agent and General chats direct APIs in Ask; full-name project rail (collapsible), General in the title bar, usage readout in the composer for the chat's engine.
- [ ] Live end-to-end runs of every runtime on this machine (see [Verification status](#verification-status)).
- [ ] Chat compact layouts below 1200 px (panel overlay, list drawer) and the raw-log developer view.
- [ ] Release packaging of the sidecar: `pnpm tauri build` bundles only `sidecar/main.mjs`; an installed build also needs the sidecar's production `node_modules` (the SDKs and their platform runtimes, ~450 MB, e.g. from `pnpm --filter agenthub-sidecar deploy --prod`) next to it, and Node.js on the user's machine. Until then Claude Agent and Copilot work only in dev builds.

### Phase 6 — Git in the Editor

- [x] Source control sidebar: status with AI and PART badges, whole-file stage / unstage / discard, commit with amend guard and AI co-author trailer, fetch / pull (rebase + autostash) / push / publish, push rejected → Pull & push, stopped-operation banner with Continue / Abort, branch chip, status bar readout, file tree letters, Settings › Git.
- [ ] Typed editor tabs and a read-only DIFF tab (split / inline).
- [ ] Branches: picker, Branches tab (local, remote, tags), create / rename / delete / publish, switch with Stash & switch / Bring changes.
- [ ] History: commit graph, filters, file history, commit detail, Revert / Undo last commit / Reset; palette commands and Git shortcuts.

### Phase 7 — Automatic updates

- [x] Version in one place (`pnpm version:set` / `version:check`), updater plugin with signed updates, `update_check` / `update_download` / `update_install` in Rust, a daily check, Settings › General › Updates, the title-bar chip and dialog with release notes, Skip this version, download progress, and a restart that lists and protects running work.
- [x] Release pipeline: `ci.yml`, `release.yml` and `docs/RELEASING.md`; the GitHub repository exists and the updater endpoint points at its releases.
- [ ] Confirm an end-to-end update between two published versions, including a refused bad signature, and record it under Verification status.
- [ ] Windows code signing (Authenticode or Azure Trusted Signing).

### Later enhancements

- macOS and Linux packaging and shell profiles.
- Terminal search, session naming templates, and richer layouts.
- Optional structured agent status via supported integration hooks.
- Project templates and custom launch commands.
- Optional portable or exportable workspace configuration.

## Security and reliability requirements

Because AgentHub can edit local files and spawn arbitrary programs, these are first-class requirements:

- Restrict file operations to user-approved project directories; validate canonical paths and symlink traversal.
- Never interpolate arguments into a shell command: runtimes and terminals start with argument lists; Windows `.cmd` shims are resolved to the real executable or `node <script>`.
- Do not store API keys or credentials in SQLite or logs. Direct-API keys (and Claude Agent's Anthropic key) live in the OS credential store, are read only in Rust and reach a runtime only through its process environment; the UI sees the last four characters. Gemini CLI gets the Gemini API key the same way. Codex, Copilot and Antigravity keep their own sign-in; AgentHub never reads their credential files.
- Every agent permission request is checked by `chat::policy` (mode, approval policy, project root with `..` and symlinks resolved) before the runtime is answered; unknown operations are never auto-approved, approvals never outlive a runtime session, and a file is checkpointed before any write is allowed.
- Direct APIs never get tools; files reach them only as explicit attachments read through the root-scoped file service.
- **Pasted images.** `Ctrl V` in the composer attaches clipboard images in project and Ask chats (up to 4 per message, 5 MB each). AgentHub decides the type from the bytes (PNG, JPEG, GIF or WebP; anything else is refused), stores them in the app data folder, never in the project, and deletes them with the chat. Each runtime gets the bytes in its own protocol, so none reads a file outside the project: Claude Agent as image blocks, Codex as `image` inputs with a `data:` URL, Copilot as `blob` attachments, Gemini CLI and Antigravity as ACP `image` blocks only when the agent advertises `promptCapabilities.image` (otherwise the turn fails with a clear error). Direct APIs (Ask) get them as OpenAI `input_image`, Anthropic `image` and Gemini `inlineData` parts; Gemini takes no GIF. Because an API request resends the conversation, the 8 newest images of the history go with it and older ones become a one-line note. Regenerate sends them again.
- Model output is untrusted: no raw HTML, no remote images, only http(s) links, opened in the browser. AgentHub never runs a command it types into a terminal for you.
- **Git.** The system `git` runs with argument lists (never a shell), `GIT_TERMINAL_PROMPT=0` and in a Windows Job Object; pushes are never forced; operations that rewrite files are refused while those files have unsaved editor changes; discards move the current file to the Recycle Bin first; Git credentials belong to Git Credential Manager (AgentHub stores none) and git output is redacted.
- **Updates.** Check, download and install run in Rust (the webview's CSP is closed to remote origins); updates are verified against the public key in `tauri.conf.json`; nothing installs or restarts without the user's confirmation, with the same running-work check as quitting; the updater's private key never enters the repository.
- Scope Tauri permissions/capabilities to the minimum needed for the UI.
- Sanitize external links and treat terminal output and file content as untrusted input.
- Handle binary files, large files, encoding errors, and external file changes gracefully.
- Confirm destructive operations and protect unsaved editor changes.
- Implement clear behavior for terminal termination, process cleanup, and app shutdown.
- Test interactive terminal compatibility (colors, arrow keys, prompts, resize, Ctrl+C) with each supported CLI.

## Development environment

Prerequisites (Windows):

- Node.js 24+ (ships Corepack; pnpm is pinned via `packageManager` in `package.json`).
- Rust stable (MSVC toolchain) and Cargo.
- Visual Studio Build Tools with the C++ workload.
- WebView2 runtime (preinstalled on current Windows).
- Node.js 20.19+ on `PATH` for the agent sidecar (Claude Agent, Copilot CLI).
- Git for Windows 2.41+ for Source control (everything else works without it).
- Optional agent runtimes: Claude Code (or the SDK's bundled copy), Codex CLI (or the Codex desktop app), Gemini CLI (with a Gemini API key), the Antigravity ACP server (download `antigravity-acp` for your system from the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json), unzip it, keep its files together, and add the folder to `PATH` or choose `agy_acp_server.exe` in Settings), Copilot CLI; and/or API keys for OpenAI, Anthropic, Gemini.

Commands (run from the repo root). If `pnpm` isn't on your `PATH`, prefix each command with `corepack`, e.g. `corepack pnpm install`.

| Task | Command |
| --- | --- |
| Install dependencies (app + sidecar workspace) | `pnpm install` |
| Build the agent sidecar (`sidecar/dist/main.mjs`; `pnpm install`, dev and release builds do it too) | `pnpm sidecar:build` |
| Sidecar tests (mocked SDKs) | `pnpm sidecar:test` |
| Run the app (Vite + Tauri, hot reload) | `pnpm tauri dev` |
| Type-check the frontend | `pnpm typecheck` |
| Frontend unit tests | `pnpm test` |
| One frontend test | `pnpm vitest run src/lib/utils.test.ts -t "fuzzyMatch"` |
| Backend unit tests | `cargo test --manifest-path src-tauri/Cargo.toml` |
| One backend test | `cargo test --manifest-path src-tauri/Cargo.toml filesystem::tests::rejects_paths_outside_root` |
| Live smoke tests (real CLIs; probes only, no paid turns) | `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored live` |
| Lint Rust | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` |
| Frontend production bundle | `pnpm build` |
| Release app + installers (NSIS, MSI, signed update payload; needs `TAURI_SIGNING_PRIVATE_KEY`) | `pnpm tauri build` |
| Set or check the app version everywhere | `pnpm version:set 0.2.0` / `pnpm version:check` |

CI (`.github/workflows/ci.yml`) runs the version check, typecheck, tests, `pnpm build`, `cargo test` and `cargo clippy -D warnings` on pull requests and on pushes to `master`. Releases follow [docs/RELEASING.md](docs/RELEASING.md).

App data (SQLite database `agenthub.db`, `checkpoints/` for agent edits and `chat-images/` for pasted images) is stored in `%APPDATA%\com.agenthub.desktop`. Delete that folder to reset AgentHub; this never touches project files.

### Verification status

- **Automated (CI-safe):** frontend unit/render tests (`pnpm test`), backend tests (`cargo test`): migrations against a v2 database, policy, checkpoints, the turn driver with a scripted adapter, direct APIs against a local mock HTTP server, and the Codex, ACP (Gemini CLI, Antigravity) and sidecar adapters against in-memory fake runtimes built from the protocol schemas. No test calls a paid API.
- **Git (automated):** the `git` module runs the real `git` in temporary repositories with isolated config and a local bare origin: staging and discard (Recycle Bin mocked), commit with trailer and amend guard, a failing hook, push rejected then Pull & push, a pull that stops on conflicts then Continue and Abort, publish, and the git-dir watcher. Skipped when git is missing or older than 2.41.
- **Updates (automated):** scheduling, settings and endpoint logic in Rust, and the update flows in the UI with the backend mocked.
- **Checked live on the development machine:** probes only — Codex (app-server handshake, `account/read`, `model/list`), Claude Agent (Claude Code 2.1.311 found, models listed through the SDK) and Copilot (SDK-bundled runtime, signed in through the GitHub CLI login).
- **Not yet run live:** real agent turns for any runtime (costs money; needs keys/sign-in), Gemini CLI and Copilot CLI (not installed on the development machine), and Antigravity (no live run of `agy_acp_server` yet: its mode ids, whether it sends every edit and command through `fs/*` and permission requests, and its sign-in are taken from its documentation and still to be confirmed; run `cargo test --manifest-path src-tauri/Cargo.toml antigravity::tests::live_probe -- --ignored --nocapture` with `AGENTHUB_ANTIGRAVITY` set to the program). Treat their behavior as protocol-correct but unproven until you run them.
- **Not yet exercised:** downloading and installing a real release and the refusal of a bad signature (they need a published release); Git Credential Manager and SSH prompts against real remotes; and the sidecar isn't packaged, so installed builds can't run Claude Agent or Copilot.

### Working with AI coding agents

Agent guidance for this repository lives in [`AGENTS.md`](AGENTS.md), which Codex CLI, OpenCode, and other AGENTS.md-aware tools read automatically. `CLAUDE.md` imports it for Claude Code. Update `AGENTS.md` when architecture rules, conventions, or commands change.

## Acceptance criteria

The Windows app does its job when a user can:

1. Register at least two local project folders and switch between them.
2. Browse, open, edit, and save a text/code file within each project.
3. Start multiple interactive shell sessions in one project.
4. Switch to another project and back without interrupting terminals or chat turns.
5. Hold several conversations per project (a coding agent, in Plan or Agent mode) and in General (a direct API, in Ask).
6. Approve or deny an agent's edits and commands, review its file changes as diffs and revert them.
7. See accurate terminal status and structured agent status, and stop either intentionally.
8. Restart AgentHub and recover projects, layout, conversations and their runtime sessions where the runtime supports it.
9. Use the complete workflow with a consistent dark theme and keyboard navigation.
10. Review what agents changed, then stage, commit and push it from Source control without leaving AgentHub.
11. Receive an update, read what changed, and install it when it suits them, without losing running work unknowingly.

## Non-goals

- Replacing VS Code, Rider, or other full IDEs. Git covers reviewing and sharing agent work (see Source control), not a full Git client.
- Cloud synchronization or a hosted backend.
- A separate orchestration framework or proxy (e.g. OpenCode) between AgentHub and the runtimes.
- Tools for direct APIs (function calling, MCP, web search): they stay Ask only.
- Guaranteed continuation of terminal processes or agent turns after AgentHub exits (runtime sessions are resumed, turns are not re-run).
- Moving a runtime's private session state to a different runtime.
- Remote terminal connections or multi-user collaboration.

## License

License to be determined before public distribution.
