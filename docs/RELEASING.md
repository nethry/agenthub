# Releasing AgentHub

Installed copies check GitHub Releases for `latest.json` (at start and once a day) and offer the new version in the app. Nothing downloads or restarts without the user's say-so.

## One-time setup

1. **Repository.** https://github.com/nethry/agenthub (remote `origin`, default branch `master`). CI runs on pull requests and on pushes to `master`.
2. **Release address.** `plugins.updater.endpoints` in `src-tauri/tauri.conf.json` points at that repository's `releases/latest/download/latest.json`. If the repository ever moves, change it: installed copies keep checking the address they were built with.
3. **Signing key.** The updater's key pair was generated with `pnpm tauri signer generate` and is in `%USERPROFILE%\.tauri\agenthub-updater.key` (private) and `.key.pub` (public; its contents are already `plugins.updater.pubkey`). It has **no password**: set one if you generate a new key.
   - On GitHub: repository → Settings → Secrets and variables → Actions → New repository secret. Add `TAURI_SIGNING_PRIVATE_KEY` (the **contents** of the `.key` file, not its path; or `gh secret set TAURI_SIGNING_PRIVATE_KEY < "$env:USERPROFILE\.tauri\agenthub-updater.key"`). Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only if the key has a password: GitHub doesn't accept empty secrets, and a missing one reaches the workflow as an empty string, which is right for a key without a password.
   - **Back the private key up somewhere safe, outside the repository, and never commit it.** Without it you can't sign updates any more, and installed copies can never update again (they would need a manual reinstall with a new public key).
4. **Windows code signing is not set up.** Installers are unsigned, so SmartScreen warns on first install. This is separate from the updater key above. Adding an Authenticode certificate (or Azure Trusted Signing) is a follow-up.

## Making a release

1. Pick the version and set it everywhere: `pnpm version:set 0.2.0` (updates `package.json`, `sidecar/package.json` and `src-tauri/Cargo.toml`; `tauri.conf.json` reads `package.json`). `pnpm version:check` fails if the files disagree.
2. Run the checks (`pnpm typecheck`, `pnpm test`, `pnpm sidecar:test`, `cargo test`, `cargo clippy`), commit, and tag: `git tag v0.2.0 && git push --tags`.
3. The **Release** workflow builds the NSIS and MSI installers, signs the update payload and creates a **draft** release with `latest.json`. Write the release notes in the draft: the app shows them (Markdown) in its update dialog.
4. **Publish the draft.** Only then does `releases/latest/download/latest.json` point at it and installed copies find it.

## Taking a bad release back

Never reuse or delete-and-recreate a version number that people may have installed. Publish a fixed higher version (e.g. 0.2.1). Unpublishing a release stops new downloads but doesn't undo installs.

## Notes

- The release workflow only runs on GitHub (`windows-latest`) and can't be tested locally. Try risky changes (workflow edits, updater changes) with a throwaway pre-release tag first.
- Known gap: the installed app still can't run Claude Agent or Copilot because the sidecar's `node_modules` (about 450 MB) aren't bundled (see the README roadmap). When that is fixed the installer, and so each full update, gets much larger.
- Updates are verified against the public key in `tauri.conf.json`; a payload with a missing or wrong signature is refused.
