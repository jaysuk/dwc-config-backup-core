# dwc-config-backup-core — working notes

Framework-free (no Vue/Pinia/Vuex/DWC imports) TypeScript library: whole-machine configuration
backup/restore for Duet 3D printer controllers. Published to npm as `dwc-config-backup-core`, and
consumed by **three separate host plugin repos** as a normal npm dependency — this is NOT a monorepo,
there are no workspaces, and a change here does nothing for any host until it's published and the
host's own dependency is bumped. See "The three consumers" below before assuming a code change here
is "done".

## Commands

- **Build**: `npm run build` (`tsc`, emits to `dist/`) — needed before `npm link`ing this repo into a
  host for local testing (hosts import from `dist/`, not `src/`).
- **Typecheck**: `npm run typecheck` — no `DWC_DIR` needed here (unlike every host repo), since this
  package has no DWC types to check against.
- **Tests**: `npm test` (vitest, happy-dom environment) — no DWC checkout needed either. Real crypto
  (Web Crypto `subtle`, and `@zip.js/zip.js`'s AES) runs for real in this environment, not mocked —
  `test/encryptedZip.test.ts` does genuine encrypt/decrypt round-trips.

## Architecture

- **`archive.ts`** — `buildArchive()`/`readArchive()`. Builds the zip (JSZip), assembles
  `manifest.json`/`redactions.json`, calls into `sanitise.ts` per file and `encryptedZip.ts` as the
  final step if `opts.encrypt` is set. This is the one place that ties the whole pipeline together.
- **`sanitise.ts`** — the redaction engine (Tier 1–5, see the file's own doc comment and
  `REDACTION-EXCLUSIONS-PLAN.md` for the full rule table). `isSensitiveName()`'s substring-match
  heuristic is the most false-positive-prone part of this codebase — see the `SENSITIVE_NAME_RE`/
  `SENSITIVE_NAME_ALLOWLIST` comments before touching it.
- **`encryptedZip.ts`** — password-protected backups (`encryptArchiveBlob`/`decryptArchiveBlob`/
  `isEncryptedArchiveBlob`), via `@zip.js/zip.js`. **Separate library from JSZip** (used for the
  archive itself) because JSZip has no encryption support at all. Wraps the already-built plain
  archive as one AES-encrypted entry inside a new outer zip — doesn't touch `archive.ts`'s internals.
  `useWebWorkers: false` is deliberate (see the module doc comment) — don't "fix" that into `true`
  without re-reading why.
- **`repair.ts`** / **`restore.ts`** — the restore-side counterpart to redaction: locating a
  `[FL-REDACTED:n]` tag or JSON-pointer site in a live/edited file, and applying the restore plan.
- **`credentials.ts`** — all `localStorage` reads/writes for the whole family (destination
  credentials, preferences, the optional AES-GCM credential-store encryption in `encryption.ts`).
  Every new per-destination preference follows the same three-line pattern — see
  `getEncryptPreference`/`setEncryptPreference` as the template.
- **`hostConfig.ts`** — the host seam. `configureHost()` sets the localStorage namespace + protected
  SD files; each host calls this once at plugin load. This is the ONLY thing that makes one npm
  package usable by three otherwise-independent hosts without them colliding in storage.
- **`destinations/*.ts`** — one file per cloud destination (github/dropbox/webdav/googleDrive/
  duetCloud/localZip), each exporting `uploadBackup`/`downloadBackup`/`listBackups`/etc. `github.ts`
  is the one with real complexity (Git Data API tree/commit assembly, history browsing) — see its own
  doc comment before changing the expanded-files-vs-zip push logic.
- **Design-plan docs** (`REDACTION-EXCLUSIONS-PLAN.md`, `ENCRYPTED-BACKUPS-PLAN.md`) — this repo's
  convention for a nontrivial feature: investigate with real evidence (fetch the actual library source/
  types, don't guess; verify claims empirically where possible), write a numbered plan with concrete
  file/line references and explicit open questions, then implement phase by phase (core first, one
  host to settle the UI, then port to the other two). Follow this pattern for the next one rather than
  improvising a new format.

## The three consumers

None of these live in this repo — they're separate git repos on this machine, each with their own
`npm install`ed (normally) copy of this package:

| Repo | Local path | Framework | Notes |
|---|---|---|---|
| Flexible Layouts | `c:\Users\live\Documents\Github\Flexible-Layouts` | Vue 3 (DWC 3.7) | Has its own `CLAUDE.md` — read it if working there. Bigger plugin; config backup is one feature among many. **Worked on from multiple concurrent Claude sessions** — check `git log`/`git status` before assuming you're the only writer. |
| duet-config-backup-plugin | `c:\Users\live\Documents\Github\duet-config-backup-plugin` | Vue 3 (DWC 3.7) | Standalone version of the same backup feature, no other functionality. Real `package.json`. |
| duet-config-backup-plugin-3.6 | `c:\Users\live\Documents\Github\duet-config-backup-plugin-3.6` | Vue 2 / Vuetify 2 (DWC 3.6) | **No `package.json` at all, by design** (see its own README's "Building" section) — pulls this package straight into a DWC 3.6 checkout's own `node_modules`. Its release workflow pins the version as a plain `CORE_VERSION` env var in `.github/workflows/release.yml`, not a dependency spec. |

DWC checkouts used to build/typecheck the hosts locally (both plain, untracked local source trees, NOT
git repos themselves):
- 3.7: `c:\Users\live\Documents\Github\DuetWebControl`
- 3.6: `c:\Users\live\Documents\Input Shaping\DuetWebControl-3.6-dev`

## Local cross-repo dev workflow (non-obvious, costs real time if skipped)

To test a change here against a host **before publishing to npm**, `npm link` alone in the host is
**not enough** — the host's typecheck/build also runs against whatever `dwc-config-backup-core` is
installed inside its **DWC checkout's own `node_modules`** (both hosts' build scripts force-install
this package there — see each host's release.yml "Install ... into DWC" step). Link (or install) in
**both** places:

```bash
# after any change here:
npm run build && npm link

# in EACH host repo:
npm link dwc-config-backup-core

# AND in that host's DWC checkout:
cd /path/to/DuetWebControl(-3.6-dev)
npm link dwc-config-backup-core   # (3.6: npm link, not npm install --save-dev, to override the pin)
```

Forgetting the DWC-checkout link is the single most common way to get a confusing "typecheck passes
but the feature doesn't work" or "uses the old published version" result. When done testing, unlink
and reinstall the real published version in all four places (three consumer repos + two DWC
checkouts) before tagging anything — a tag push triggers CI, which does its own fresh install from
npm regardless of local link state, but leaving links in place makes *local* verification silently
diverge from what CI will actually build.

## Release process

This package's own release is independent of any host's:

1. `npm version patch` (this family has always used patch bumps here, even for real features —
   0.1.x has stayed 0.1.x throughout; a deliberate convention, not an oversight).
2. `git push origin main --follow-tags`, then `npm publish`.
3. **Each host needs its own separate bump+tag+release** — publishing here does nothing for any host
   until: unlink, `npm install dwc-config-backup-core@<new version>` (3.7 hosts) or bump `CORE_VERSION`
   in `release.yml` (3.6), verify (tests + typecheck + a real build, not just typecheck), bump that
   host's own `plugin.json`/`package.json` version, commit, tag, push. The three repos' version
   numbers are **not** kept in lockstep with each other or with this package's version — they've
   diverged before (e.g. this package at 0.1.13 while both hosts are at 1.3.0) and that's expected.
4. All three plugin repos (not this one) generate GitHub Release notes via a shared changelog
   generator fetched from `jaysuk/dwc-plugin-runtime` at a pinned commit SHA
   (`RUNTIME_REF` in each host's `release.yml`) — categorised Conventional-Commit sections, a
   compare-range link, then a per-repo `scripts/release-footer.mjs` for install instructions. This
   repo itself has no release workflow of its own (no GitHub Release step) — just the npm publish above.

## Known gotchas

- **The `passw` vs `pass` fragment** in `SENSITIVE_NAME_RE` (`sanitise.ts`) is deliberately narrow —
  bare `pass` used to false-positive on ordinary bed-levelling loop counters (`maxpass`, `npass`).
  Don't widen it back to `pass` without re-reading that comment.
- **Tier-3/Tier-4 double-fire**: a `var`/`global` name that itself contains a Tier-4 content-pattern
  keyword (e.g. `var password = "..."` matches both the Tier-3 name check AND Tier-4's
  `password=value` content pattern) produces two redaction entries for one real secret. Harmless
  (still fully redacted) but means `redactions.length` isn't a reliable "how many distinct secrets"
  count — don't build a feature that assumes one entry per secret without checking for this.
- **GitHub + encryption**: when a backup is encrypted, the expanded-per-file push to GitHub is
  skipped entirely (`files: []`) — encrypting those too would make every backup show as a full-file
  rewrite in git history, defeating their only purpose (diffable `config.g` history). This is a
  deliberate, documented tradeoff (`ENCRYPTED-BACKUPS-PLAN.md` §3), not a bug — restore-by-history
  still works either way, since it reads via the zip's own stable-path commit history, not the
  expanded files.
- **The 3.6 plugin's local build.bat/release.yml build can take 3–4 minutes** (Vue-CLI/webpack,
  bundles monaco-editor/babylon/GCodeViewer alongside this plugin) — always run it with
  `run_in_background: true` (Bash/PowerShell tool) rather than waiting synchronously; it will exceed
  the default 120s tool timeout.
- **zip.js's wrong-password error is not part of its public API** — its internal
  `ERR_INVALID_AUTHENTICATION_CODE` constant isn't re-exported from the package's main entry.
  `decryptArchiveBlob` deliberately treats any decrypt failure as "wrong password or corrupted file"
  rather than pattern-matching that internal, unversioned string.
