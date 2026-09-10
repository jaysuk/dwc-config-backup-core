# Scheduled backups & missed/failed-backup alerts — implementation plan

Status: **proposed**, not started. Follows this repo's usual convention (see
`ENCRYPTED-BACKUPS-PLAN.md`/`REDACTION-EXCLUSIONS-PLAN.md`): investigate with real evidence, write a
grounded plan, implement phase by phase.

Origin: a forum user asked for (a) the ability to **schedule backups** and (b) to be **alerted if a
backup didn't complete or was missed**.

## §1 The honest constraint, stated before anything else

**A DWC plugin cannot run a true background schedule.** It is JavaScript in a browser tab. There is no
persistent worker, no cron, no wake-on-timer. RRF itself can't help either - gcode/macros have no
outbound-HTTP capability, so the firmware can't push a backup out on a timer on the plugin's behalf.

This isn't a new finding; it's already written down as a deliberate constraint by whoever built the
nudge system ([nudgePredicates.ts:9-12](src/nudgePredicates.ts#L9-L12)):

> *"These are reminders, never silent uploads or downloads. There is no true background/scheduled
> trigger available to a browser-only plugin: every nudge can only fire while DWC is open in a tab,
> the same constraint as the rest of this feature."*

**What this plan therefore delivers is opportunistic scheduling: "when DWC is open and a backup is
due, take it automatically."** That is a real, useful upgrade over today's "remind me and I'll click" -
but it must be described to users in exactly those terms. Anyone promising unattended nightly backups
on the forum will be wrong, and the UI copy must not imply it (§5.4).

**The honest ceiling, worth saying out loud in the forum reply:** genuinely unattended scheduling needs
something outside the plugin - a cron job on an SBC (or any always-on machine) hitting the Duet HTTP
API directly. That's out of scope here, but it's the correct answer for anyone whose actual requirement
is "backs up whether or not I ever open a browser."

## §2 What already exists (a lot more than the request assumes)

Roughly half of ask (b) is already shipped, and the request may partly reflect not knowing it's there:

- **`isBackupOverdue(lastBackupAt, thresholdDays)`** ([nudgePredicates.ts:14-18](src/nudgePredicates.ts#L14-L18))
  - the entire "is a backup due" decision, already pure and already tested.
- **`AutoBackupNudgeSettings`** ([credentials.ts:322-336](src/credentials.ts#L322-L336)) -
  `{ configSaved, overdue, overdueDays, newMachine }`, defaulting to `overdueDays: 7`, with a
  get/set pair and an established localStorage shape.
- **Host wiring with a proper lifecycle** ([autoBackupNudges.ts](../Flexible-Layouts/src/model/configBackup/autoBackupNudges.ts))
  - `installAutoBackupNudges()`/`uninstallAutoBackupNudges()`, wired at
  [index.ts:113](../Flexible-Layouts/src/index.ts#L113) and torn down on `dwcPluginUnloaded`
  ([index.ts:128](../Flexible-Layouts/src/index.ts#L128)). It already watches `machineStore.isConnected`
  and fires a click-through toast on connect.
- **A settings UI pattern** ([CloudPanel.vue:115-125](../Flexible-Layouts/src/configBackup/CloudPanel.vue#L115-L125))
  - checkboxes + a numeric threshold field, saved via `saveNudgeSettings()`.
- **Failure already leaves state correct.** `setLastBackupAt()` is called *only* on the success path
  ([BackupCreatePanel.vue:455](../Flexible-Layouts/src/configBackup/BackupCreatePanel.vue#L455)), after
  every `await`, inside the `try`. A failed backup therefore leaves `lastBackupAt` stale and the machine
  correctly stays "overdue" - the existing nudge already re-fires. **Ask (b) is thus partly satisfied
  today**, just implicitly and only on the *next* connect.

What's genuinely missing: actually *running* the backup (ask a), and telling the user **at the time**
that an attempt failed rather than silently staying overdue (the sharp end of ask b).

## §3 The blocker nobody would guess from the outside

**The backup logic is not callable. It lives inside a Vue component and is entangled with both UI state
and interactive dialogs.** `onCreate()`
([BackupCreatePanel.vue:~380-462](../Flexible-Layouts/src/configBackup/BackupCreatePanel.vue#L380-L462))
reads component refs (`destination.value`, `redact.value`, `encrypt.value`, `scope`), writes component
refs (`busy`, `stage`, `stageDone`, `stageTotal`, `result`, `error`), and - critically - **blocks on up
to three interactive dialogs**:

| Prompt | Condition | Line |
| --- | --- | --- |
| `askEncryptPassword()` | encryption on, no remembered password | [~396-399](../Flexible-Layouts/src/configBackup/BackupCreatePanel.vue#L396-L399) |
| `askUnredacted(...)` | unredacted **and** non-local **and** not previously acknowledged | [~423-433](../Flexible-Layouts/src/configBackup/BackupCreatePanel.vue#L423-L433) |
| `askPublicRepoConfirm()` | inside `sendToGithub`, unredacted + public repo | in `sendToGithub` |

Plus `sendToDrive` calls `signIn()`, which is interactive OAuth by definition.

**A scheduled run can answer none of these.** "Just call `onCreate()`" is not available, and any plan
that assumes it is will fail on first contact. Extracting a headless core is therefore not a
nice-to-have refactor - it is the prerequisite (§4.1).

## §4 Design

### §4.1 Extract a headless `runBackup()` — the prerequisite

Pull everything between "collect" and "send" out of `BackupCreatePanel.vue` into a host-side model
module (e.g. `model/configBackup/runBackup.ts`), taking an explicit config object instead of reading
component refs, and taking **callbacks** instead of showing dialogs:

```ts
export interface RunBackupConfig {
  destination: BackupDestinationId;
  scope: /* existing scope type */;
  redact: boolean;
  encryptPassword?: string;          // caller resolves this; runBackup never prompts
  onProgress?: (stage, done, total) => void;
}

export type RunBackupResult =
  | { ok: true; manifest: Manifest; encrypted: boolean }
  | { ok: false; reason: "needsInput" | "failed"; message: string };
```

`runBackup` **never** shows a dialog. If it reaches a point that would have needed one, it returns
`{ ok: false, reason: "needsInput" }` rather than hanging. The interactive Create tab keeps its current
behaviour by resolving the prompts *first* and passing the answers in; the scheduler simply refuses to
run destinations that would need input (§4.2).

**This refactor must be behaviour-preserving for the existing UI, and that's the risky part** - it
touches the single most important code path in the whole feature. It gets its own phase, its own
verification, and ships *before* any scheduling exists (§6 Phase 1). Note `setLastBackupAt()` and
`addBackedUpMachineKey()` currently sit at the end of `onCreate`; they move inside `runBackup` so both
callers record success identically.

### §4.2 Which destinations can run unattended — and which genuinely cannot

Determined by whether a run can complete with zero human input:

| Destination | Unattended? | Why |
| --- | --- | --- |
| `local` | **No** | A browser download to disk isn't meaningful unprompted; also the one destination where "it left the machine" isn't true, so automating it has little value |
| `github` | **Yes**\* | Token is stored; \*only if redaction is on, or unredacted was already acknowledged for it |
| `dropbox` | **Yes**\* | Stored token; same redaction caveat |
| `webdav` | **Yes**\* | Stored credentials; same redaction caveat |
| `duet` | **Yes**\* | Stored session; same redaction caveat |
| `drive` | **No** | Access token is memory-only and OAuth sign-in is interactive by design. **Still true after the device-flow migration** (`GOOGLE-DRIVE-DEVICE-FLOW-PLAN.md`) - device flow is *more* interactive, not less. Only changes if that plan's open question 4 (storing a refresh token) is answered "yes" |

**Encryption blocks unattended runs**, for any destination. The password is deliberately never
persisted (`ENCRYPTED-BACKUPS-PLAN.md` §5.2 chose per-backup prompting precisely so a backup's password
is never ambiguous). Auto-backup and per-destination encryption are therefore **mutually exclusive**,
and the settings UI must say so plainly rather than letting a user enable both and quietly get nothing.
Do not "solve" this by persisting the password - that would silently reverse a decision made
deliberately in another plan.

A destination that can't run unattended isn't dropped - it **falls back to today's nudge**, which is
exactly the right degradation and needs no new code.

### §4.3 The trigger: on-connect, opportunistic

Extend the existing `checkOnConnect()`
([autoBackupNudges.ts:60-86](../Flexible-Layouts/src/model/configBackup/autoBackupNudges.ts#L60-L86))
rather than adding a parallel mechanism. New logic, in order:

1. Auto-backup enabled, and the chosen destination is eligible (§4.2)? If not → existing nudge, unchanged.
2. `isBackupOverdue(getLastBackupAt(), overdueDays)`? If not → nothing.
3. Machine idle? **Do not start a backup mid-print.** `collectAll` does a lot of HTTP file reads;
   firing that at a printer partway through a job is a real-world risk, not a theoretical one. Gate on
   `machineStore.model.state.status` being idle-ish, and if not, defer to the existing nudge instead.
4. Run `runBackup()`, showing a non-blocking toast that it started.
5. On success → success toast + `setLastBackupAt` (inside `runBackup`, §4.1).
6. On failure → **failure alert** (§4.4).

The existing `checkedThisSession` guard ([autoBackupNudges.ts:36](../Flexible-Layouts/src/model/configBackup/autoBackupNudges.ts#L36))
already prevents re-firing on reconnect flaps and applies here unchanged - important, since a
reconnect loop that re-triggered a full backup each time would be considerably worse than a duplicated toast.

**Explicitly rejected: a `setInterval` "every N hours" timer.** It only ticks while the tab is open, so
it doesn't buy real scheduling; it adds a second trigger path to reason about; and it can fire mid-print
with no natural gate. On-connect + overdue gives the same practical outcome with one trigger.

### §4.4 Failure and "missed" alerting — the second half of the ask

Today a failed backup is invisible until the next connect. Add explicit tracking, in `credentials.ts`
alongside `getLastBackupAt`/`setLastBackupAt` ([credentials.ts:309-314](src/credentials.ts#L309-L314)):

```ts
export interface LastBackupAttempt { at: string; ok: boolean; destination: BackupDestinationId; message?: string }
export function getLastBackupAttempt(): LastBackupAttempt | null;
export function setLastBackupAttempt(a: LastBackupAttempt): void;
```

Recorded on **every** attempt, automatic or manual, success or failure - unlike `lastBackupAt`, which
stays success-only (do not conflate them; "when did a backup last *succeed*" is what drives overdue,
and folding failures in would break it).

This gives three things the current system can't express:

1. **Immediate failure alert** - an error-level toast when an automatic run fails, at the time, naming
   the destination and reason.
2. **A persistent state, not just a transient toast.** A toast fires once and is gone; a user away from
   the screen misses it entirely. Surface the last-attempt state in the Create tab (e.g. "Last automatic
   backup failed 3 days ago - Dropbox: 401 Unauthorized"), so it's discoverable after the fact. This is
   the part that actually answers *"alert me if it didn't complete"*.
3. **Repeated-failure escalation** - a destination whose token expired will fail identically every
   connect. Track consecutive failures and escalate copy after the 2nd or 3rd ("Automatic backups to
   Dropbox have failed 4 times - check the connection settings"), rather than emitting the same toast
   indefinitely.

**"Missed" needs no new mechanism**: a backup that never ran leaves `lastBackupAt` stale, which the
existing overdue nudge already detects. It's already correct - worth verifying rather than rebuilding.

### §4.5 Settings

Extend `AutoBackupNudgeSettings` rather than introducing a second settings object (the existing
`{ ...DEFAULT, ...parsed }` merge at [credentials.ts:333](src/credentials.ts#L333) means added fields
default cleanly for existing users - no migration needed):

```ts
export interface AutoBackupNudgeSettings {
  configSaved: boolean; overdue: boolean; overdueDays: number; newMachine: boolean;  // existing
  autoRun: boolean;                        // NEW - default FALSE (see below)
  autoRunDestination: BackupDestinationId | null;  // NEW
}
```

**`autoRun` defaults to `false`.** An update that silently starts pushing a user's config to a cloud
destination on its own - however well-intentioned - is not an acceptable default. Opt-in only.

## §5 UI

1. An "Automatically back up when overdue" checkbox + destination picker, in the existing nudge
   settings block ([CloudPanel.vue:115-125](../Flexible-Layouts/src/configBackup/CloudPanel.vue#L115-L125)),
   reusing `saveNudgeSettings()`.
2. The destination picker offers **only** eligible destinations (§4.2), with ineligible ones shown
   disabled-with-a-reason rather than hidden - "Google Drive (needs sign-in each time)" teaches;
   silently missing entries look like a bug.
3. If the chosen destination has encryption enabled, show the conflict inline (§4.2) - don't let it be
   enabled and silently do nothing.
4. **Copy must not overpromise (§1).** Something like *"When DWC is open and a backup is overdue, take
   one automatically. This can only happen while DWC is open in a browser."* Say the limitation in the
   feature's own words, not buried in help text.
5. Last-attempt status surfaced in the Create tab (§4.4 item 2).

## §6 Phases

**Phase 1 — headless extraction (no user-visible change). DONE (FL).** §4.1. `collectForBackup()` +
`runBackup()` in `Flexible-Layouts/src/model/configBackup/runBackup.ts`; the Create tab drives them
and behaves identically.

**Phase 2 — failure/attempt tracking + alerting. DONE (core + FL).** §4.4. `LastBackupAttempt` +
`getBackupFailureStreak()` in `credentials.ts`; surfaced in the Create tab.

**Phase 3 — the auto-run trigger. DONE (core + FL).** §4.3 + §4.5 + §5. `AutoBackupNudgeSettings`
gained `autoRun` / `autoRunDestination` (default off); `shouldEscalateBackupFailureAlert` +
`isMachineIdle` predicates; `autoBackupNudges.ts`'s `checkOnConnect()` runs an opportunistic backup
when opted-in + eligible + overdue + idle; CloudPanel.vue has the checkbox + eligible-destination
picker + encryption-conflict warning. Implemented in Flexible Layouts first rather than
`duet-config-backup-plugin` (the user is actively testing FL builds).

**Phase 4 — port** to `duet-config-backup-plugin` and the 3.6 plugin (the latter a genuine Vue 2 /
Options API rewrite, not copy-paste). The core half (settings fields, predicates) is already shared.

## §7 Testing

Core (pure, straightforward):
- `getLastBackupAttempt`/`setLastBackupAttempt` round-trip; absent → `null`.
- New settings fields default correctly when merged over an **existing** stored settings blob without
  them (the migration-free path §4.5 relies on).
- Any consecutive-failure-count logic, as a pure predicate alongside `isBackupOverdue`.

Host:
- `runBackup` returns `{ ok: false, reason: "needsInput" }` - never hangs - when a config would have
  required a prompt (encryption with no password; unredacted+unacknowledged non-local).
- The Create tab still succeeds end-to-end post-refactor (the Phase 1 regression guard that matters).
- Auto-run does **not** fire: when disabled; when not overdue; when the machine isn't idle (§4.3 step 3);
  when the destination is ineligible (§4.2).
- A failed auto-run records the attempt and raises an error-level toast.

## §8 Risks

| Risk | Mitigation |
| --- | --- |
| **§4.1's refactor breaks manual backups** - the single highest risk here, touching the feature's core path | Its own phase, behaviour-preserving by construction, regression-tested before anything is built on it |
| Users expect true unattended scheduling and are disappointed | §1/§5.4: say the constraint in the feature's own copy; point at SBC-cron for the real requirement |
| An auto-backup fires mid-print and disturbs a job | Idle gate (§4.3 step 3), deferring to a nudge instead |
| Auto-backup enabled + encryption enabled = silently never runs | Surfaced as an inline conflict (§4.2/§5.3), not left to be discovered |
| Reconnect flapping triggers repeated backups | Existing `checkedThisSession` guard already covers it (§4.3) |
| A stale token makes every connect fail noisily forever | Consecutive-failure escalation (§4.4 item 3) |
| Silently enabling cloud uploads on upgrade | `autoRun` defaults `false` (§4.5) |

## §9 Open questions

1. **Multiple destinations per run, or one?** This plan assumes one (`autoRunDestination`). "Back up to
   GitHub *and* Dropbox automatically" is a plausible ask, but multiplies partial-failure states
   ("succeeded to one, failed to the other" - is that overdue or not?). One destination first;
   revisit only if asked for.
2. **Should a *manual* backup failure also raise the new alert**, or is the existing inline `error.value`
   in the Create tab enough? Leaning: record the attempt either way (§4.4), but only *toast* for
   automatic runs - the user is already looking at the screen for a manual one.
3. **Idle-gate strictness** (§4.3 step 3): is `status === "idle"` right, or should `paused` also
   qualify? Paused-mid-print is arguably a fine moment to back up, but it's also a moment the user may
   be actively editing config. Needs a call; defaulting to strictly-idle is the safe start.
4. Should auto-run also honour the existing `configSaved` trigger (back up shortly after `config.g` is
   written, rather than only when overdue)? Attractive - it's the moment a backup is most valuable -
   but it needs a debounce well beyond the existing 5-minute nudge cooldown to avoid backing up
   repeatedly during an editing session.
