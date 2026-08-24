# Password-protected & encrypted backups — implementation plan

Status: **proposed**, not started. Builds on the investigation already done (see the conversation this
plan came out of) - the findings below are re-derived here with file/line grounding so this document
stands alone.

## §1 The two asks, and why they're one feature

1. "Add a password to any zip file that's downloaded."
2. "Add an encryption/decryption facility so backups only ever leave the printer encrypted."

Today every destination - local download, GitHub, Dropbox, WebDAV, Google Drive, the Duet cloud
service - just pushes or pulls the same plain `Blob` `buildArchive()` produces
([archive.ts:72](src/archive.ts#L72)); none of them inspect its contents. So a single change -
optionally password-protecting that blob before it leaves `buildArchive` - satisfies both asks with
one mechanism: the local download becomes a real password-protected zip, and every cloud destination
receives that same protected blob instead of a plaintext one, with no destination-specific code.

## §2 Feasibility - verified, not assumed

**JSZip (the current dependency) has no encryption support at all** - confirmed via its own package
metadata: `"Create, read and edit .zip files"`, keywords `zip, deflate, inflate`. Nothing else.

**`@zip.js/zip.js` does the real thing**, confirmed by fetching its actual package data and source,
not from memory:

- Its `ZipWriter` accepts a `password` option and produces genuine **AES-256 encrypted entries** (the
  WinZip "AE-2" format) - not homegrown crypto. Legacy `ZipCrypto` is also available but the library's
  own docs discourage it (*"not recommended... can be easily broken"*) - AES only, this plan doesn't
  consider ZipCrypto further.
- **Zero runtime dependencies** (`dependencies: undefined` in its published `package.json`).
- Runs entirely on the main thread via `configure({ useWebWorkers: false })` - no worker-bundling
  fight with either bundler this project uses (Vite for two hosts, Vue-CLI/webpack for the 3.6 plugin).
- **Bundle cost, measured, not estimated**: `index.min.js` is 172 KB minified, **77,569 bytes
  gzipped** (`gzip -c index.min.js | wc -c`, run against the real published 2.8.57 file).
- **Caveat worth stating plainly**: plain Windows Explorer's built-in "Extract All" cannot open
  AES-encrypted zips - it needs 7-Zip or similar. macOS Archive Utility handles it better. This is
  inherent to AES zips generally, not a zip.js limitation, and should be said in the UI copy
  ("open with 7-Zip or similar - not Windows' built-in extractor").
- **Wrong-password detection**: zip.js throws a plain `Error` on decrypt failure
  (`ERR_INVALID_AUTHENTICATION_CODE` / message `"Invalid signature"` for AES entries, confirmed by
  reading `lib/core/streams/common-crypto.js` in the source tree) - but **this constant is not
  re-exported from the public package entry** (`lib/zip.js`'s exports don't include it). Don't build
  retry logic that pattern-matches an internal, unversioned string. Treat any thrown error from
  `getData()` as "wrong password or corrupted file" and say so generically - simpler and more robust
  to library upgrades than string-matching an undocumented constant.
- **Detecting "is this encrypted" needs no password**: an `Entry`'s `encrypted: boolean` flag is
  readable from the central directory alone, before `getData()` is ever called - confirmed in the type
  definitions. This is what makes a clean "detect, then prompt" restore flow possible.
- **No secure-context requirement - verified by reading the actual cipher code, and a real advantage
  over the existing credential-store encryption.** `encryption.ts`'s feature requires `crypto.subtle`
  outright (`isCryptoAvailable()`), which most Duets fail since they serve DWC over plain HTTP (stated
  plainly in `credentials.ts`'s own module doc comment). zip.js's AES path is different: reading
  `lib/core/streams/aes-crypto-stream.js`, the actual cipher and authentication
  (`cipher.aes`/`mode.ctrGladman`/`misc.hmacSha1`) come from the bundled pure-JS `sjcl.js` codec and
  **never call `crypto.subtle` at all**. Only the PBKDF2 key-derivation step optionally uses
  `crypto.subtle` when present (`SUBTLE_API_SUPPORTED`), falling back to `sjcl`'s own PBKDF2
  (`misc.importKey`) otherwise. **This feature works on every Duet regardless of HTTP/HTTPS** - no
  `isEncryptionAvailable()`-style gate or "degrade honestly" messaging is needed for it, unlike the
  credential-store feature it otherwise resembles.

## §3 The GitHub fork (already resolved in the prior discussion, restated here for completeness)

Confirmed from the real code, not the doc comment alone: `github.ts`'s `pushBackup`
([github.ts:72-121](src/destinations/github.ts#L72-L121)) puts the **expanded plaintext files** under
`machines/<name>/…` **and** the zip itself at a stable `machines/<name>/backup.zip` **in the same
commit** ([github.ts:91-105](src/destinations/github.ts#L91-L105)). `BackupCreatePanel.vue`'s
`sendToGithub` builds that file list by calling `readArchive(built.blob)` - reading the *same* blob
it's about to push as the zip.

Encrypting only the zip half doesn't protect the expanded-files half - that's pulled from a plain
read of the same underlying archive regardless. And encrypting the expanded files too defeats their
entire purpose: AES output is unrelated-looking for any plaintext change, so every backup would show
as a full-file rewrite in git, destroying both "`config.g` changes diff across backups" and "View on
GitHub" per-line browsing.

**Resolved design: when encryption is on, GitHub gets treated like every other destination - only the
encrypted zip, no expanded-files push.** Verified this is a clean drop, not a workaround:
`pushBackup`'s tree-building loop (`for (const f of opts.files)`,
[github.ts:93-100](src/destinations/github.ts#L93-L100)) does nothing when `files` is `[]` - no
special-casing needed, `files: []` "just works" today.

**What's *not* lost**: restore-by-history (`GET .../commits?path=machines/<name>/backup.zip`, per the
module doc comment at [github.ts:13-16](src/destinations/github.ts#L13-L16)) reads via the zip's own
stable-path commit history, independent of whether expanded files were ever pushed. Encrypted GitHub
backups keep full "browse every past backup, restore any past commit" - they only lose the *in-repo
diff view* of file content. Say this precisely in the UI; the loss is smaller than "no more history."

**A consequence that needs its own decision, not an assumption**: the existing "unredacted backup to
a public repo" block (`if (!isRedacted) { ...confirm... }` inside `sendToGithub`) and the *general*
pre-send warning in `onCreate()`
(`if (!useRedact && destination.value !== "local" && !hasAcknowledgedUnredacted(...))`) both exist to
stop secrets leaving in the clear. Encryption satisfies that exact concern independently of redaction.
**Both gates need `|| isEncrypted` added to their negation** - a user who encrypts should not be nagged
with a warning about sending unredacted data that's no longer true. This applies to *every*
destination's general warning, not just GitHub's public-repo-specific one.

## §4 What already exists (and what doesn't transfer)

`encryption.ts` and `credentials.ts`'s "Credential storage & encryption" feature
(`enableEncryption`/`unlockSession`/`PassphraseDialog.vue`) is a real, working AES-256-GCM +
PBKDF2-derived-key implementation with an established passphrase-entry UX - but it protects
**localStorage credentials at rest on this device**, encrypting small JSON strings
(`encryptValue(key, plaintext: string)`, [encryption.ts:60](src/encryption.ts#L60) - note: takes a
*string*, not arbitrary bytes) with a **session-persistent** key that stays unlocked in memory until
reload.

That threat model doesn't match backups. A credential is always "the current secret" - re-encrypting
it under a new passphrase is fine, the old value is gone anyway. A **backup is a historical artifact**:
one taken in January with password A must still open in June even if the user has since started using
password B for new backups. A single "session-unlocked, applies to everything" model - correct for
credentials - would be actively wrong here: it invites "why can't my current password open this old
backup?" confusion. §5.2 below designs around this explicitly. The crypto primitive itself
(`crypto.subtle`, AES-GCM) is proven and could inform the new code, but the module, the key lifecycle,
and the UI component are new - see §5.5.

## §5 Design decisions

### §5.1 Encryption lives inside `buildArchive`, not as a separate host-side wrap

`BuildArchiveOptions` gains one optional field:

```ts
export interface BuildArchiveOptions {
  // ...unchanged...
  /** Password-protect the built archive (§2) - AES-256, via @zip.js/zip.js. Absent = plain zip,
   *  unchanged from today. The caller (host UI) is responsible for obtaining the password before
   *  calling buildArchive - this mirrors how `redact: boolean` already works: archive.ts takes the
   *  final decision, never shows a dialog itself. */
  encrypt?: { password: string };
}
```

`BuildArchiveResult` gains `encrypted: boolean` (mirrors `Manifest.redacted`), set from
`opts.encrypt != null`, so a host can show "Encrypted" in the result summary without re-inspecting
its own options object.

Internally, `buildArchive` calls a new `encryptArchiveBlob(blob, password)` (§5.4) as its very last
step, replacing the returned `blob` before constructing `BuildArchiveResult`.

**Why inside, not a separate host-side wrapping call** (the alternative considered and rejected):
a host-side wrap would need a second exported function every call site remembers to invoke, and would
leave `built.blob` ambiguous about whether it's already encrypted. Doing it inside `buildArchive`
means **every existing call site downstream is already correct with zero changes**, verified by
tracing each one:

- `downloadArchive(built.blob, ...)`, `duetUploadBackup(apiUrl, built.blob, ...)`,
  `dropboxUploadBackup(..., built.blob)`, `webdavUploadBackup(..., built.blob)`,
  `driveUploadBackup(..., built.blob)` - all already just forward whatever `built.blob` is. No changes.
- `preflightSize(built.blob)` in `sendToDuetCloud` - already checks whatever `built.blob` actually is,
  so it naturally checks the *post-encryption* size (what's actually uploaded) with no threading
  changes needed. AES adds a small, fixed per-entry overhead (tens of bytes for header/auth-tag) -
  negligible against the 2 MB cap.
- Only `sendToGithub` needs real changes (§3), because it's the one place something *other* than
  "forward the blob" happens with `built.blob`.

### §5.2 Password model: typed fresh per backup, not a persistent session

**No reuse of the credential-store's `sessionKey`/`unlockSession` machinery** (§4) - a backup
passphrase is a different secret with a different lifecycle. Recommended default: **prompt for a
password every time encryption is used**, with an **in-memory-only, per-tab "remember for the rest of
this session" checkbox** for convenience when taking several backups in one sitting (e.g. backing up
to local + Dropbox + GitHub in a row) - never written to `localStorage`, cleared on reload, exactly
like today's `sessionKey` but a *separate* variable with its own narrower scope, not the same one.

This is a genuine UX cost (retyping, or at least re-confirming, more often than a "set once" model)
in exchange for the correctness property that matters for a backup: **what password decrypts a given
backup is exactly what was typed for that backup, never ambiguous, never silently stale.**

### §5.3 Whether to enforce a minimum password strength

Not enforced. A soft length hint in the UI (something like "8+ characters recommended") is enough -
this protects the user's own data under their own risk tolerance, the same way any consumer zip tool's
password field works. Not a core-package concern either way; if added, it's UI-only validation.

### §5.4 The new core module: `encryptedZip.ts`

Kept separate from `archive.ts` (which stays focused on archive *assembly*) and from `sanitise.ts`,
matching the existing one-concern-per-module convention (`repair.ts`, `hash.ts`, etc.):

```ts
export class DecryptError extends Error {}

/** Wrap `archiveBlob` as the single AES-encrypted entry of a new outer zip. The outer zip also gets
 *  one small UNENCRYPTED entry - a plain-text note explaining what this is and how to open it, for
 *  anyone who finds the file without this plugin (§5.6). */
export async function encryptArchiveBlob(archiveBlob: Blob, password: string): Promise<Blob>;

/** True if `blob` has at least one AES-encrypted entry - readable from the central directory alone,
 *  no password needed (§2). False for a plain (today's-format) archive OR an unrelated non-zip blob. */
export async function isEncryptedArchiveBlob(blob: Blob): Promise<boolean>;

/** Recover the original archive blob. Throws DecryptError on a wrong password OR a corrupted file -
 *  deliberately not distinguished (§2's finding on zip.js's error surface not being a stable public
 *  API to pattern-match against). */
export async function decryptArchiveBlob(encryptedBlob: Blob, password: string): Promise<Blob>;
```

No format marker/magic byte needed to recognise "this is one of ours": `isEncryptedArchiveBlob` checks
generically for an encrypted entry, and if someone feeds the restore flow an unrelated password-zip,
decrypting it with a guessed password produces garbage that `readArchive`'s existing tolerant parsing
already rejects safely (`loadFile`'s existing `if (parsed.manifest.files.length === 0) throw` check,
[RestorePanel.vue:559](../Flexible-Layouts/src/configBackup/RestorePanel.vue#L559) in Flexible
Layouts' copy) - no new safety net required, the old one already covers it.

`readArchive` itself is **not** made encryption-aware - it keeps operating on a plain blob only, exactly
as today. The host calls `decryptArchiveBlob` first, then hands the *resulting* plain blob to the
unchanged `readArchive`. Keeps a well-tested function's contract stable; all the new logic lives in the
one new module.

### §5.5 `encryptValue`/`decryptValue` in `encryption.ts` are not reused directly

They operate on string plaintext (`encryptValue(key, plaintext: string)`) and produce a JSON-friendly
`{iv, ciphertext}` shape - built for small credential values, not a multi-megabyte binary `Blob`, and
not a real zip format either. zip.js's own AES implementation (§2) is what actually produces an
openable zip; `encryption.ts` isn't extended or touched by this plan.

### §5.6 The unencrypted "how to open this" note

`encryptArchiveBlob` adds one small plaintext entry alongside the encrypted one - e.g.
`HOW-TO-OPEN.txt`, matching the existing `ARCHIVE_README` convention
([constants.ts:129-143](src/constants.ts#L129-L143), the README already written into every archive).
Something like:

```
This file is a password-protected backup of a Duet 3D printer's configuration.

Extract it with 7-Zip, WinRAR, or another tool that supports AES-encrypted ZIP files.
Windows' built-in "Extract All" does not support this - use a third-party tool.

You'll need the password that was set when this backup was created.
```

Cheap to add (one more unencrypted `ZipWriter.add()` call), and the entire reason it's worth doing:
someone who finds this file with no memory of what plugin made it, or without DWC available at all,
still has a fighting chance of getting the contents out.

**The encrypted entry itself must be added with `level: 0` (store, no recompression).** `archiveBlob`
is already DEFLATE-compressed at level 9 by the JSZip archive assembly in `archive.ts`
([archive.ts:162-164](src/archive.ts#L162-L164)) - re-running DEFLATE over already-compressed bytes
inside the outer zip.js wrap costs real CPU (blocking the main thread, per §2's `useWebWorkers: false`
choice) for no size benefit, since already-compressed data doesn't compress further.

### §5.7 GitHub-specific host logic (the one real per-host change)

`sendToGithub` gains an `isEncrypted` parameter alongside its existing `isRedacted` one:

```ts
async function sendToGithub(built, identity, isRedacted: boolean, isEncrypted: boolean) {
  if (!isRedacted && !isEncrypted) { /* existing public-repo check, unchanged */ }
  const files = isEncrypted ? [] : /* existing readArchive(built.blob) + map, unchanged */;
  await pushBackup({ ..., files, zip: { path: "backup.zip", blob: built.blob } });
}
```

And in `onCreate()`, the general pre-send warning gate gains the same `|| useEncrypt`:

```ts
if (!useRedact && !useEncrypt && destination.value !== "local" && !hasAcknowledgedUnredacted(...)) { ... }
```

**Left as an open question, not resolved by this plan (§9):** once a machine's GitHub history has
*some* unencrypted expanded-file commits and then switches to encrypted-only, those old paths stay in
the git tree going forward (unchanged, since `pushBackup`'s tree build uses `base_tree` and only
touches paths it's given) - not actively harmful, but a slightly confusing "half the history has
per-file diffs, half doesn't" repo shape. Explicitly deleting `machines/<name>/files/**` from the tree
the first time encryption is used is possible via the Git Data API (set `sha: null` for removed paths)
but adds real scope - deferred.

### §5.8 `onQuickBackup` deliberately never encrypts

`RestorePanel.vue`'s one-click "back up first" safety copy, taken *during* a restore
([RestorePanel.vue:610-632](../Flexible-Layouts/src/configBackup/RestorePanel.vue#L610-L632)), calls
`buildArchive` directly with only `redact: getRedactPreference("local")` - no dialog, no password, by
design (the entire point is zero-friction). Wiring encryption into this call site the same way as the
main Create-tab flow would mean a password dialog interrupting an already-in-progress restore for an
unrelated action - a real regression, not a neutral gap.

**Decision: `onQuickBackup` never encrypts, regardless of the `local` destination's remembered
preference.** It already hardcodes `"local"` implicitly (always a local download, never a cloud
destination), so this is one more deliberate exception in the same spot, not a new inconsistency - and
it matches the existing reasoning for why the general unredacted-warning gate already excludes `local`
entirely (§3): nothing here leaves the machine, so the "leaves in the clear" motivation for encryption
doesn't apply to this specific safety-net action either. Worth a one-line code comment at that call
site so a future edit doesn't "fix" this into blocking a restore for a password prompt.

### §5.9 Where the toggle lives, and what it's called

Mirrors the existing "Redact sensitive values" switch exactly - same section of the Create tab, same
per-destination-remembered pattern (`getRedactPreference`/`setRedactPreference` in `credentials.ts`
becomes the model for `getEncryptPreference`/`setEncryptPreference`, same storage-key shape:
`${ns()}.encrypt.${destination}`). Offered for **every** destination including `local` - unlike the
"unredacted" warning (which is skipped for `local` because nothing leaves the machine), encryption's
motivation for local is independent: protecting the file at rest once it's on the user's own computer,
in an email, in a personal cloud drive, etc.

Help copy should say plainly what §3 established: redaction and encryption solve overlapping but
different problems, and for GitHub specifically only one preserves per-file diffing. Don't auto-toggle
one when the other changes - both are the user's explicit choice.

## §6 Implementation phases

### Phase 0 - spike (before committing to the full build)

Confirm `@zip.js/zip.js` actually builds cleanly through the 3.6 plugin's Vue-CLI/webpack pipeline,
not just Vite. Everything in §2 supports this working (plain ESM/CJS exports, zero dependencies, no
worker requirement), but it hasn't been run through that specific bundler yet - a 15-minute spike
(`npm install`, one `encryptArchiveBlob` call, `build.bat`) is cheap insurance against a phase-3
surprise.

### Phase 1 - core (`dwc-config-backup-core`)

1. Add `@zip.js/zip.js` as a dependency.
2. New `src/encryptedZip.ts` (§5.4): `encryptArchiveBlob`, `isEncryptedArchiveBlob`,
   `decryptArchiveBlob`, `DecryptError`, configured with `useWebWorkers: false`.
3. `archive.ts`: `BuildArchiveOptions.encrypt?: { password: string }`,
   `BuildArchiveResult.encrypted: boolean` (§5.1); call `encryptArchiveBlob` as the last step of
   `buildArchive` when `opts.encrypt` is set.
4. `credentials.ts`: `getEncryptPreference`/`setEncryptPreference` per destination (§5.9), following
   the exact `getRedactPreference` pattern at [credentials.ts:244-249](src/credentials.ts#L244-L249).
5. Export the new module and types from `index.ts` (picked up automatically via the existing
   `export * from "./..."` pattern, no manual export list to maintain).

### Phase 2 - UI in one host first (`duet-config-backup-plugin`, matching the redaction-exclusions
precedent of settling the interaction in the smallest host before duplicating it)

1. A "Set a password" dialog on backup creation (two fields, must match, "remember for this session"
   checkbox per §5.2) - same Promise-based pattern as the existing `askUnredacted`/
   `askPublicRepoConfirm` in `BackupCreatePanel.vue`.
2. A "Enter password" dialog on restore (one field, retry loop on `DecryptError`) - inserted at the
   **single** choke point every restore source already funnels through: `loadFile(file: File)`
   ([RestorePanel.vue:553](../Flexible-Layouts/src/configBackup/RestorePanel.vue#L553) in FL's copy -
   confirmed every cloud destination's restore action already calls `loadFile(new File([blob], ...))`,
   so this is one insertion point, not one per destination).
3. "Encrypt this backup" switch next to "Redact sensitive values" (§5.9). `onQuickBackup` (§5.8) is
   explicitly NOT wired to it - add the one-line comment there while touching that file.
4. `sendToGithub`'s `isEncrypted` parameter and the general warning-gate change (§5.7).
5. i18n strings, following the existing `redaction.*`/`create.*` namespacing.

### Phase 3 - port to Flexible Layouts and the 3.6 plugin

Same shape as the redaction-exclusions port: Flexible Layouts is a near-identical Vue 3 copy; the 3.6
plugin is a genuine Vue 2 / Vuetify 2 rewrite of the same interaction (`v-dialog`, `text`/`dense`
props, Options API), not a copy-paste.

## §7 Testing

Core (`test/encryptedZip.test.ts`, new; `test/archive.test.ts` additions):

- `encryptArchiveBlob` → `decryptArchiveBlob` round-trips to byte-identical content;
- `decryptArchiveBlob` with the wrong password throws `DecryptError`;
- `isEncryptedArchiveBlob` is `true` for an encrypted archive, `false` for a plain one, `false` (not
  throwing) for an arbitrary non-zip blob;
- the unencrypted `HOW-TO-OPEN.txt` entry is readable without a password;
- `buildArchive` with no `encrypt` option behaves exactly as before (regression guard, same pattern as
  the redaction-exclusions plan's own regression test);
- `buildArchive` with `encrypt` set produces a blob `isEncryptedArchiveBlob` recognises, and
  `BuildArchiveResult.encrypted` is `true`.

Host: a `sendToGithub` test (or equivalent) confirming `files: []` is sent and the public-repo check
is skipped when `isEncrypted` is true; a restore-flow test confirming `loadFile` prompts for a
password when given an encrypted blob and proceeds straight to the tree step for a plain one.

## §8 Risks

| Risk | Mitigation |
| --- | --- |
| Windows Explorer can't open AES zips | Stated plainly in UI copy and the in-zip `HOW-TO-OPEN.txt` (§5.6) |
| Forgotten backup password = permanently unrecoverable backup | Inherent to real encryption, same as any password manager; UI should say this clearly at set-password time, not just on failure |
| GitHub repos end up with mixed encrypted/unencrypted history shape | Documented as a known, deferred edge case (§5.7); not silently wrong, just not cleaned up automatically |
| zip.js doesn't build cleanly under the 3.6 plugin's webpack pipeline | Phase 0 spike, before Phase 3 work begins |
| A user encrypts thinking it also redacts (or vice versa) | Help copy explicitly distinguishes the two (§5.9) rather than presenting them as stackable safety levels with no tradeoff |
| Bundle size growth (~78 KB gzip) on every host | Comparable to JSZip's own footprint already shipped; not flagged as a blocker, but worth knowing going in |

## §9 Open questions

1. Should turning on encryption for a GitHub destination retroactively clean up previously-pushed
   expanded files from the tree, or leave history exactly as it is (§5.7)?
2. Should `manifest.json` itself record `encrypted: true` once decrypted, for audit/informational
   purposes - noting this can't help *detect* encryption before decrypting (that's
   `isEncryptedArchiveBlob`'s job), only document it after the fact?
3. Is the "remember for this session" checkbox (§5.2) worth the added state, or should every backup
   simply prompt fresh, full stop, favouring simplicity over the retyping cost?
4. Should the local-download filename change in any way for an encrypted backup (e.g. a suffix), or
   stay exactly `backupFilename()`'s existing pattern since it's still genuinely a `.zip`?
