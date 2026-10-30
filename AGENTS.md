# AGENTS.md

Shared instructions for AI coding agents (Claude Code, Codex CLI, OpenCode, Cursor, Copilot, and others) working in this repository. This is the single source of truth for agent guidance; tool-specific files such as `CLAUDE.md` should only point here and add tool-specific notes.

## Status

AgentHub is in active development (Windows first; the version is in `package.json`). Built: the unified Chat, Git source control in the Editor (Phase 6, milestone 1 of 4) and automatic updates (Phase 7): `src/` (React frontend), `src-tauri/` (Rust backend) and `sidecar/` (Node.js agent sidecar for the Claude Agent SDK and GitHub Copilot SDK). The folder is a git repository hosted on GitHub; releases follow `docs/RELEASING.md`.

`README.md` is the source of truth for product intent, repo layout, domain model, and the roadmap. If your change conflicts with the README, stop and flag it rather than silently diverging.

## What AgentHub is

A project-centric desktop workspace (not a full IDE) combining local projects, a Monaco-based file editor, persistent shell terminals, and one unified Chat for coding agents (Claude Agent via the Claude Agent SDK, OpenAI Codex via app-server, Gemini CLI and Google Antigravity via ACP, GitHub Copilot via its SDK) and direct APIs (OpenAI, Anthropic, Gemini). Windows 10/11 is the first target; macOS/Linux come later.

## Stack

- **Shell:** Tauri 2
- **Frontend:** React + TypeScript + Vite, shadcn/ui, Tailwind CSS, Motion for React, Zustand
- **Editor / terminal:** Monaco Editor, xterm.js
- **Backend:** Rust with a PTY abstraction (ConPTY on Windows; evaluate `portable-pty`)
- **Persistence:** SQLite
- **Agent runtimes:** Rust drives `codex app-server`, `gemini --acp` and Antigravity's `agy_acp_server` (user-installed from the ACP registry) over stdio JSON-RPC; a supervised Node sidecar (`sidecar/`, Node ≥ 20.19) hosts `@anthropic-ai/claude-agent-sdk` and `@github/copilot-sdk`
- **Dev prerequisites:** Node.js + pnpm, Rust/Cargo, MSVC C++ build tools, WebView2

Exact crates and plugins are still to be selected; prefer established, maintained dependencies and note any new choice in the README's technology stack table.

## Commands

Verified on Windows. Use `corepack pnpm …` if `pnpm` isn't on `PATH` (pnpm is pinned in `package.json`). Keep this list in sync with the README's "Development environment".

```sh
pnpm install                     # dependencies (app + sidecar workspace)
pnpm sidecar:build               # agent sidecar → sidecar/dist/main.mjs (postinstall, dev and build run it too)
pnpm sidecar:test                # sidecar tests (vitest, mocked SDKs)
pnpm tauri dev                   # run the app (Vite on :1420 + Tauri, hot reload)
pnpm typecheck                   # tsc -b (TypeScript 7)
pnpm version:check               # package.json, sidecar and Cargo.toml versions agree (pnpm version:set x.y.z sets them)
pnpm test                        # vitest (src/**/*.test.{ts,tsx})
pnpm vitest run src/lib/utils.test.ts -t "fuzzyMatch"          # one frontend test
cargo test --manifest-path src-tauri/Cargo.toml                # backend tests (incl. a real ConPTY round-trip)
cargo test --manifest-path src-tauri/Cargo.toml filesystem::tests::rejects_paths_outside_root   # one backend test
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored live   # optional live probes of installed CLIs (no paid turns)
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
pnpm build                       # frontend bundle → dist/
pnpm tauri build                 # release exe + NSIS/MSI installers
```

Before calling a change done: `pnpm typecheck`, `pnpm test`, the sidecar tests, `cargo test`, and `cargo clippy` should all be clean.

## Code map

- `src/app/store.ts`: Zustand store (transient UI state, mirrored session status; `workspace` is `general` or `project`, see `currentProjectId`). `src/app/actions.ts`: flows that span backend and store (`prefillTerminal` types a command into a new terminal without running it; agent file changes fan out through `agentChangedFiles`).
- `src/lib/ipc.ts` + `src/lib/types.ts`: the **only** place that calls `invoke`. Types mirror Rust structs (serde camelCase); change both sides together.
- `src/features/terminals/registry.ts`: xterm.js instances live outside React. Components only attach/detach the DOM node, so views can unmount freely. It uses the WebGL renderer (DOM fallback) and sets `windowsPty` from `app_info`'s `windowsBuild`; without them block-character art (e.g. the Claude Code logo) and ConPTY repaints after a resize render wrong.
- `src/features/editor/models.ts`: open files are Monaco models outside React; the store only tracks dirty flags (and the transient Markdown view mode, `mdView`; absent means preview, see `effectiveMdView`).
- `src/features/editor/MarkdownPreview.tsx` + `markdown.ts`: Markdown preview of the live model (`MarkdownView` renders plain text with the same rules). Never enable raw HTML (`rehype-raw`) or remote images; links go through `resolveMdLink`.
- `src-tauri/src/terminals/`: PTY manager. Every (re)start bumps a `generation` so stale reader/waiter threads are ignored. Each `SessionInfo` has a monotonic `version`, and the frontend keeps the highest one it has seen. `activity.rs` tracks busy/idle per session; plain pwsh/cmd shells get prompt markers in `build_command`, and one ticker thread checks for quiet output.
- `src-tauri/src/git/`: Source control on the system `git`. `runner.rs` is the only place git is spawned (argv only, fixed env: `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=:`, reads with `GIT_OPTIONAL_LOCKS=0`; Windows Job Object; caps, timeouts, cancel). `mod.rs` is `GitService` (repo discovery via `rev-parse`, per-repo `index`/`net` locks, status, whole-file stage/unstage/discard, commit, Continue/Abort of a stopped operation; guards enforced here), `remote.rs` fetch/pull (rebase + autostash)/push (never forced)/publish, `status.rs` the porcelain v2 parser, `watch.rs` the git-dir watcher (`git-changed`), `error.rs` `AppError::Git` kinds (`git_*`) from git's C-locale messages. Commands are `commands/git.rs` (they join Chat's file changes for the AI badges). Tests run real git in temp repos with isolated config and a bare local origin (skipped when git is missing).
- `src/features/git/`: own Zustand store (per project status, busy op, banner, commit box), `actions.ts` (flows; pass unsaved editor paths to every op that rewrites files; call the app's `fsChanged` through `onGitTreeChanged`), `model.ts` (pure: groups, letters, trailer, readouts), `SourceControl.tsx` (sidebar, `SourceControlView` is the testable view), `BranchChip.tsx` (header chip + status bar readout). Settings › Git is `src/features/settings/GitSection.tsx`.
- `src-tauri/src/updates/`: app updates with `tauri-plugin-updater`. `Updates` (in `AppState`) holds the announced `Update` and, once downloaded and verified, its bytes; `check` / `download` / `install` are separate steps (on Windows `install` ends the app, so it runs only after the user confirmed a restart, and `commands/updates.rs` closes terminals and chat turns first). `start_scheduler` checks 30 s after launch and then daily (at most every 12 h, `updates_last_check` setting kept by Rust; the `updates` setting `{autoCheck, skipped}` is the UI's) and emits `update-available`. An updater endpoint that still contains the `OWNER/REPO` placeholder is treated as "not set up" (`endpoints_configured`); the real address lives in `plugins.updater.endpoints` in `tauri.conf.json`.
- `src/features/updates/`: own store (`idle | checking | available | downloading | ready | error`), `actions.ts` (flows), `UpdateBadge.tsx` (title-bar chip, Settings dot), `UpdateDialog.tsx`; Settings › General › Updates is `features/settings/UpdatesPanel.tsx`. `src/app/work.ts` is the shared "what a quit or restart interrupts" check (sessions, chat turns, unsaved files, running Git operations) used by Quit and Update.
- `src-tauri/src/usage/`: OpenAI Codex usage windows via a short-lived `codex app-server` (`codex.rs`) and `account/rateLimits/updated` pushed by the Codex chat adapter (`Usage::update_openai`). Never read agent credential files (`~/.claude/.credentials.json`, `~/.codex/auth.json`). The v1 Claude status-line relay is gone (Claude Agent uses an API key; no plan windows). The UI is `src/features/usage/` (`ChatUsage` in the composer bar follows the chat's engine: Codex's plan windows, else the chat's reported tokens/cost; `format.ts` holds the threshold and reset-time rules).
- `src-tauri/src/filesystem/`: every path from the frontend is *relative to a project root* and goes through `resolve()`. Rename/delete operate on the entry itself via `entry_path()` (resolved parent + name, so a symlink is renamed, not its target). Deletes go to the Recycle Bin (`trash`), never permanent. `text.rs` decodes and encodes (`encoding_rs`); `watch.rs` watches every project root and emits `fs-changed`.
- `src-tauri/src/chat/`: unified Chat. `mod.rs` is the domain (`Engine`, `Mode`, `Policy`, `ConversationStatus`, `Item`/`ItemBody`, `ChatEvent`). `service.rs` runs one turn per conversation: direct APIs stream here (`providers/{openai,anthropic,gemini}.rs`, SSE via `sse.rs`, `context_turns` within `CONTEXT_BUDGET_CHARS`, never auto-retried), agent turns go to `agents::turn::AgentRuntime`. `policy.rs` decides every permission request (mode + approval policy + project root; unknown → ask); `engines.rs` is the capability catalog (only modes AgentHub can enforce) and the probe cache. An integration can be turned off (`ChatService::set_enabled`, `engines_disabled` setting, `EngineInfo.enabled`): it is then never probed or started and its turns are refused; `checkpoints.rs` snapshots files before writes and computes diffs (`similar`); `images.rs` checks and stores pasted images (`ItemBody::Image`, `TurnRequest.images`). `repository.rs` is the SQLite history (migrations v2–v3; `begin_reply` is one transaction; `chat_items` hold typed activity; `recover_interrupted` marks crashed turns). `secrets.rs` keeps API keys in the OS credential store (`keyring`); provider text goes through `chat::redact`.
- `src-tauri/src/chat/agents/`: `mod.rs` is the adapter contract (`EngineAdapter`, `TurnRequest`, `AgentEvent`, `WriteGuard`); `turn.rs` turns events into items, answers approvals by policy or waits for the user (`respond`), checkpoints before allowing writes and records file changes; `jsonrpc.rs` is the stdio JSON-RPC peer (+ `testing::fake_peer`); `codex.rs` (app-server, read-only sandbox + `approvalPolicy: "untrusted"`), `acp.rs` (Agent Client Protocol core: sessions, `fs/*` reads/writes via AgentHub, permissions, replay suppression, routing checks) with one `Profile` per runtime: `gemini.rs` (Gemini CLI, Gemini API key only via `GEMINI_API_KEY` + `authenticate gemini-api-key`; personal Google sign-in is retired) and `antigravity.rs` (Google sign-in only from Settings › `chat_engine_sign_in`, model/mode switched in place, no trusted `session/load`, `verify_routing` ends a turn whose tool acted without AgentHub), `sidecar.rs` (supervises `node sidecar/dist/main.mjs` for Claude Agent and Copilot). Adapters must end every turn with exactly one `Done`, translate every native permission prompt into `AgentEvent::Approval`, and never enable a runtime's own auto/yolo/bypass mode. Tests use recorded/fake protocol peers, never real CLIs or paid APIs (live probes are `#[ignore]`).
- `sidecar/`: TypeScript sidecar speaking JSON-RPC with Rust (`turn/start`, `turn/event`, `turn/approval`, …). Claude Agent runs with the user's Anthropic API key (Anthropic doesn't allow third-party apps to use claude.ai login through the SDK) and `settingSources: []`; every tool call is routed to Rust for a decision. Never log prompts or keys. The SDKs stay external to the esbuild bundle (they locate their native runtimes from their install folder); release packaging of the sidecar's `node_modules` is not done yet (see the README roadmap).
- `src/features/chat/`: `store.ts` (own Zustand store; per-workspace selection, drafts and attachments via `draftKey`, new-chat config, engines, panel), `actions.ts` (flows; deltas batched ~30 ms; events from a stale request are dropped; Chat reaches the editor/terminals only through app actions), `models.ts` (engine/model catalog, `modeAvailability`, `statusChip`, pure helpers; `engineOn` / `visibleConversations` hide a turned-off integration's chats, models and usage, so any new view that lists conversations or engines must filter with them), `ChatView` (list + transcript + composer + `ChangesPanel`), `items.tsx` (tool rows, command cards, permission cards, plan cards, file changes), `Composer`/`EngineMenu`. Code blocks are highlighted with Monaco's `colorize` (`highlight.ts`, imported lazily). Settings › AI integrations and › Chat are `src/features/settings/AiIntegrationsSection.tsx`.
- `src/features/overview/OverviewDashboard.tsx`: v2 Overview (conversations, AI activity, recently changed files, terminals). `src/features/terminals/NewSessionMenu.tsx`: shells and saved commands (no agents).
- File changes fan out from `actions.ts` `fsChanged()` to the editor models (`handleFsChange`), the palette index (`features/palette/fileIndex.ts`), and the explorer (`features/explorer/fsEvents.ts`). AgentHub's own file operations call it too, so the UI updates without waiting for the watcher.
- Zustand v5: selectors that build new arrays/objects must use `useShallow` (see `useSessions`), or React loops.

## Architecture rules to preserve

- **Backend owns PTYs.** The Rust terminal session manager owns PTY/process lifetime; the frontend only renders (xterm.js) and holds transient UI state (Zustand). Frontend talks to the backend via Tauri commands and events.
- **Lifecycle:** switching projects or hiding a terminal must never kill its process. Terminating managed processes on app exit is acceptable; reattaching sessions across restarts is not supported.
- **Persistence split:** SQLite stores projects, saved terminal commands, preferences, restorable workspace metadata, conversations, messages and typed chat items (never raw protocol messages). Live PTY handles, terminal buffers and runtime processes stay in memory; file checkpoints and pasted chat images (`chat::images`) are files in the app data folder.
- **Terminal status ≠ agent status:** terminal status is process-level (starting/running/exited/failed) plus busy/idle from OSC 133 prompt marks or output activity (`src-tauri/src/terminals/activity.rs`), and the UI names its source. Agent conversation state (running, waiting for approval, done, interrupted…) comes only from the runtime's structured events — never from output silence or parsed terminal text.
- **Agents are not terminals:** coding agents run in Chat through their SDK/protocol adapters, owned by `chat::agents`, never as PTY sessions. Users may still run any CLI by hand in a terminal. AgentHub never runs a command it prefills in a terminal.
- **Scope:** this is a lightweight workspace, not an IDE — no debugger, extension marketplace, or full language-server platform. See the README's non-goals before adding features.
- **Modes are enforced by AgentHub, not trusted to runtimes.** Project chats are coding agents in Plan/Agent; General chats are direct APIs in Ask (`chatModes`/`chatEngines` in the UI, `check_workspace` in `chat::service` for new chats and switches). Ask: no file/tool access. Plan: read-only inside the project. Agent: per approval policy. Every permission request goes through `chat::policy`; unknown operations are never auto-approved; approvals never outlive a runtime session (no global/permanent approvals); a mode a runtime can't enforce is unavailable for it, with the reason. Escalating to Agent needs explicit confirmation. Direct APIs never get tools. Don't add automatic retries of turns (cost, repeated actions).
- **Sessions:** a conversation is bound to its engine's runtime session; switching runtimes starts a new chat. When a resume fails, say so and pass a plain-text recap — never claim the context survived.

## Security requirements (first-class)

- Restrict file operations to user-approved project roots; validate canonical paths and symlink traversal.
- Spawn agents by direct process invocation; never interpolate arguments into a shell string when avoidable.
- Never store API keys/credentials in SQLite or logs. Direct-API keys (also used by Claude Agent) are OS-credential-store only, read only in Rust, passed to a runtime only through its process environment, never in React state, events, logs or error text (provider/runtime messages go through `chat::redact`); the UI gets just the last 4 characters. Gemini CLI gets the Gemini key the same way. Codex, Copilot and Antigravity keep their own sign-in; never read their credential files.
- Pasted images: type from the magic bytes only, limits in `chat::images` (mirrored in `models.ts`), stored in the app data folder (never the project), sent to runtimes as bytes, never as paths.
- Updates: check, download and install stay in Rust (the CSP stays closed to remote origins); never restart or install without the user's confirmation, and run the same running-work check as Quit; keep the updater private key out of the repo; one app version, set with `pnpm version:set` and verified by `pnpm version:check`.
- Git: never spawn git outside `git/runner.rs`; never force-push; refuse ops that rewrite files while they have unsaved editor changes; discard moves the current file to the Recycle Bin first; never store Git credentials (Git Credential Manager owns them) and redact git output.
- Checkpoint a file before any agent write is allowed; reverts go back to the checkpoint (new files to the Recycle Bin). Never overwrite unsaved editor buffers silently.
- Keep Tauri capabilities minimal; treat terminal output and file contents as untrusted; sanitize external links.
- Removing a project from AgentHub must never delete files on disk; confirm destructive actions and protect unsaved editor changes.

## UI conventions ("Midnight HUD")

The design source of truth is the AgentHub design canvas (private Claude artifact: https://claude.ai/artifact/F4gQg1pgutRkPtDAJ1rvuL), page **v2 · Unified workspace**: interactive showcase, Project overview, Chat scenarios A–E (Ask streaming, Plan, Agent with approval, running, engine unavailable), chat states, compact 1024 px, editor conflict, terminals, AI integrations, overlays, component inventory & tokens, and the Handoff board (IA, journeys, migration map). Page **v2 · Editor & Git** is the design for Source control; it is implemented in a trimmed form (see the README's Source control section for what is built and what was left out). Page v1 is history (still the reference for Foundations, Usage limits and terminal focus mode). If code and canvas disagree, follow the canvas and flag it. Full token tables are in the README's "Visual direction" section.

- **Theme:** dark-only. Ground `#05080D`, surface `#0A111A`, code/terminal well `#03060A`, line `#1C3049` (strong/neutral chip border `#3A4F69`). Single accent "holo" `#4DA3FF` (hover `#A8D1FF`, text on accent `#020A18`); selected = accent at 10% fill + 45% border. Text: primary `#DCEBFF`, body `#A3B8CF`, terminal text `#BCD0E6`, muted `#8AA0B8`, dim (line numbers) `#4C627A`.
- **Semantic colors:** success/running `#3DF5A0`, warn/starting `#FFB547`, danger/failed `#FF5470`, tag `#B79CFF`. Chat modes: Ask `#4DA3FF`, Plan `#B79CFF` (`plan`), Agent `#38E1FF` (`agent`); user messages on `raised` `#0F1A28`. Mode color is always paired with its label.
- **Typography:** Rajdhani (500–700) for display, titles, labels, tabs and buttons — uppercase with +12–16% letter-spacing. Chakra Petch (400–600, fallback Segoe UI) for body text at 13/20. JetBrains Mono for code (12.5/21), terminals (14/23 in focus mode) and readouts (10.5–11 px, uppercase).
- **Shape:** `border-radius: 0` everywhere. 8 px chamfered corners (clip-path) only on primary and danger buttons. 1 px lines; corner brackets on panels, cards, and dialogs.
- **Texture:** 40 px grid at ~3.5% accent on the app ground; faint scanlines in terminal wells. Static decoration stays low-opacity and never animates continuously.
- **Glow:** only for active, focused, or running state (focused input, selected tab, running dot, cursor). Never on idle elements.
- **Motion:** 180–280 ms; brackets draw in on panel/dialog open; everything off under `prefers-reduced-motion`.
- **Icons:** Lucide, 16 px, stroke 1.5, square caps and miter joins. No emoji.
- **Chat status chips** (`statusChip` / `Chip`): Streaming, Running (both glow), Approve, Interrupted, Error, Stopped, Done; Approve/Interrupted/Error feed the amber rail and Chat-tab count.
- **Process status chips** (terminals) always pair color + glyph + label: `STARTING` (amber arc), `RUNNING` (green filled square, glow), `EXIT <code>` (muted hollow square), `FAILED` (red ✕). Running splits into `BUSY` (orange/warn square, `.busy-pulse` glow) and `IDLE` (green square, no glow) once activity is known; tooltips come from `activityTitle`. These states aren't on the design canvas yet. Executable detection (`ONLINE` / `NOT FOUND` / `NOT ON PATH`) is a separate indicator — don't mix it with process status.
- **Readouts** (PID, uptime `T+hh:mm:ss`, `cols×rows`, counts like `SESSIONS 03 /04`, usage percentages) show real values only; never fake data. A usage window past its reset time shows "—", not its old percentage.
- **Copy:** plain and specific; destructive dialogs state the consequence (e.g. "The folder and its files stay on disk").
- **Accessibility:** real `<button>`/`<input>`/`<label>` elements, `aria-label` on icon-only buttons, proper `tablist`/`listbox`/`dialog` roles; keep text contrast ≥ 4.5:1.
- **Implementation:** tokens are Tailwind v4 `@theme` colors in `src/styles/globals.css` (`bg-ground`, `bg-surface`, `bg-well`, `border-line`, `text-accent`, `text-muted`, …). Use the `.hud`, `.chamfer`, `.gridbg`, `.scan`, and `.label-caps` utilities and the primitives in `src/components/ui/` instead of hand-rolling styles. Fonts are bundled via `@fontsource` (no CDN).
- **Keyboard:** global shortcuts live in `src/app/shortcuts.ts` (capture phase). Never bind plain `Esc` or bare digits globally: terminals need them. Leave `Ctrl K` to Monaco while focus is inside `.monaco-editor`. Chat's `Ctrl N` / `Ctrl B` / `Ctrl /` / `Ctrl Shift F` apply only while the Chat view is showing; its `Esc`-to-stop is a local handler in `ChatView`. `Alt 1–9` runs saved terminal commands.

## Working conventions for agents

- **Follow the proposed layout** in the README (`src/features/<feature>/`, `src-tauri/src/<module>/`) unless there is a documented reason to change it; update the README if you do.
- **Keep docs in sync.** When you scaffold, add commands, or change architecture, update `AGENTS.md` and the README in the same change. Tick roadmap checkboxes in the README only when the item is actually working.
- **Small, reviewable changes.** Prefer one roadmap item or concern per change; don't mix refactors with features.
- **Verify before claiming done.** Run the relevant build/lint/test commands once they exist and report failures honestly. Until then, state clearly what was not verified.
- **Windows first.** The primary dev environment is Windows (PowerShell). Avoid POSIX-only scripts in `package.json` or build steps; keep paths and shell assumptions cross-platform where practical.
- **Multiple agents may work here.** Don't overwrite or reformat files outside your task, don't delete work you didn't create, and leave the tree in a buildable state. If you find conflicting in-progress changes, stop and ask.
- **No secrets.** Never commit credentials, tokens, or local machine paths into source or config.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
