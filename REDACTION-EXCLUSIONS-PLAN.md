# User-managed redaction exclusions — implementation plan

Status: **proposed**, not started. Phase 0 (below) is done and covers the reported bug on its own;
everything from Phase 1 on is the durable feature.

Phase 1 is specified to the point of being directly implementable. Phase 2 carries one decision that
must be made first (§6.2 step 2) — it is written up with a recommendation, not left open, but it is
a choice about UX and memory, not a mechanical step.

## §1 Problem

The Tier-3 sensitive-name heuristic in `sanitise.ts` is a bare substring test against `var` /
`set global.` names and JSON keys. Any name *containing* a credential-ish fragment is redacted, so
ordinary macro variables collide with it. Reported case — a user's `bed.g`:

```gcode
var maxpass = 5                     ; safety cap on levelling passes
var i = 0
var pass = 0
```

Both `maxpass` and `pass` were redacted as passwords. This is the same class of collision already
documented in-code for `author` (`auth`) and `rapidRate` (`api`), and handled the same way: a
hardcoded `SENSITIVE_NAME_ALLOWLIST`. That list can't scale — it only ever grows by someone
reporting a bug, and it can't know any given user's own macro vocabulary.

The ask (from the user report): let users click a row in the redaction summary and say *"exclude
from redaction"*, then re-run the backup.

## §2 Phase 0 — narrow the regex (done, unreleased)

`SENSITIVE_NAME_RE` fragment `pass` → `passw` ([sanitise.ts:64](src/sanitise.ts#L64)).

Every real credential name the rule must catch (`password`, `passwd`, `pwd`, `wifiPassword`,
`adminPassword`) contains `passw`; bare `pass` appears in none of them. Unlike `auth`/`api` — which
are genuine *prefixes* of real credential names (`authToken`, `apiKey`), so only an allowlist can
narrow them safely — `pass` has no compound-credential form that `passw` would miss.

Tests added: `maxpass`/`pass`/`npass` pass through untouched; `password`/`adminPassword`/`passwd`
still redact. Suite green at 277/277.

**This fixes the reported bug.** Phases 1–3 exist because the *next* collision (`keyswitch`,
`credit`, `apiary`, …) is a matter of time, not because this one is unresolved.

## §3 Key constraint — what is actually excludable

This is the single most important design fact, and it must shape the UI.

A name-based exclusion list can only ever suppress **name-heuristic** matches. It cannot touch the
hardcoded command rules or the content-pattern scanners, because those never consult a name:

| Tier | What it matches | Driven by a name? | Excludable? |
| --- | --- | --- | --- |
| 1 | `M551 P`, `M587 S/P`, `M589 S/P`, `M586.4 U/K/C` | no — fixed command+param table | **no** |
| 2 | `M540 P`, `M552/M553/M554 P`, `M587 I/J/K/L` | no — same table | **no** |
| 3 | `var X` / `set global.X`, JSON keys | **yes** — `isSensitiveName()` | **yes** |
| 4 | JWTs, PEM blocks, `key=value`, webhook URLs, emails | no — content regexes | not in Phase 1 |
| 5 | M122 Board/Unique ID, MAC, IP | no — line regexes | **no** |

That's a genuine safety property worth stating plainly: **no user exclusion can ever un-redact a
WiFi password set via `M587`, a machine password via `M551`, or a board ID in M122 output.** The
blast radius is confined to the heuristic tier — exactly the tier that produces false positives.

It's also a scope limit the UI must be honest about. Applied to the reported screenshot (8 rows):

| Row | Tier | Excludable | Note |
| --- | --- | --- | --- |
| `config.g:12` IP address | 2 | no | command rule |
| `bed.g:29` Variable `maxpass` | 3 | **yes** | ← the actual false positive |
| `bed.g:31` Variable `pass` | 3 | **yes** | ← the actual false positive |
| `configtool.json` `/configTool/password` | 3 | yes | but a **real secret** |
| `configtool.json` `/configTool/wifi/ssid` | 3 | yes | but a **real secret** |
| `configtool.json` `/configTool/wifi/psk` | 3 | yes | but a **real secret** |
| `m122-mainboard.txt:3` Board/Unique ID | 5 | no | M122 rule |
| `m122-can-11.txt:3` Board/Unique ID | 5 | no | M122 rule |

So of 8 rows: 3 aren't excludable at all, 3 are excludable but shouldn't be, and 2 are the real
targets. An "exclude" action offered indiscriminately on every row would be misleading on 3 and
actively dangerous on 3. **Rows must render the action only when the entry is excludable**, and the
confirm step should push back when the name is a strong credential word (§5.4).

## §4 What already exists (and cuts the cost)

- **A re-scan path.** `BackupCreatePanel.vue` already performs a dry-run
  `buildArchive(collected, { redact: false, … })` to populate the pre-send unredacted warning
  (FL copy, ~line 291). Re-scanning after an exclusion reuses this, rather than needing new
  machinery.
- **A precedent for the storage shape.** `getBackedUpMachineKeys()` /
  `addBackedUpMachineKey()` ([credentials.ts:296](src/credentials.ts#L296)) is already a
  plain-`localStorage` string-set with the exact read/add semantics needed.
- **A precedent for the allowlist semantics.** `SENSITIVE_NAME_ALLOWLIST` already does exactly
  this job, globally, by exact lowercased name. The user list is the same check with a second
  source — no new matching semantics to invent or test.

## §5 Design decisions

### §5.1 Exact whole-name match, never patterns

Exclusions are compared as `name.toLowerCase()` against a `Set`, identical to the existing hardcoded
allowlist. **No wildcards, no regex, no fragments.** Excluding `pass` must not exempt `password`.

This is the primary safety control. A user who could write `*key*` could silently disable most of
the heuristic tier in one action; a user excluding exact names can only ever disable the specific
names they've seen and judged.

### §5.2 Global by name, not per (file, name)

Recommended: one flat set of names, applied everywhere.

- Matches the existing hardcoded-allowlist semantics — one code path, not two.
- `pass` in `bed.g` is very likely `pass` in `mesh.g` and `wipe.g` too; per-file would mean
  excluding the same name repeatedly.
- Simpler storage and a simpler management list.

Rejected: per-`(file, name)` pairs. Tighter blast radius, but multiplies storage keys, UI rows and
the "why is this still redacted?" support burden. Revisit only if a real case appears where the same
name is a secret in one file and noise in another.

Mitigation for the looser scope: the management list (§6.2 step 5) shows every active exclusion, so
the blast radius is always visible and one click to undo.

### §5.3 Add an explicit `excludableName` to `RedactionEntry`

`RedactionEntry` currently carries the name only implicitly, and differently per kind:

- `kind: "gcode-command"`, `code: "VAR" | "GLOBAL"` → the name is `params[0]`
- `kind: "json-value"` → the name is **not carried at all**. Only `pointer` is, and recovering the
  key from it means splitting on `/` and reversing RFC-6901 escaping (`~1` → `/`, `~0` → `~`).

Making three separate hosts each re-derive that is duplicated, untested, easy-to-get-wrong logic in
the UI layer — and for the JSON case they'd be reconstructing a value core already had in hand and
threw away. Instead core sets one optional field, from the raw key at the point of the match:

```ts
/** The name this entry was matched on, verbatim as it appears in the file (`maxPass`, not
 *  `maxpass`), when it came from the Tier-3 name heuristic and can therefore be suppressed via
 *  the user exclusion list. Absent = not excludable (see §3). */
excludableName?: string;
```

Case handling, stated once so it isn't re-litigated at each layer: **this field is raw**, so the UI
shows the user exactly what's in their file. **The stored exclusion set is lowercased** (§5.6), and
`isSensitiveName` lowercases before comparing. So `var maxPass` displays as `maxPass`, stores as
`maxpass`, and a later `var MAXPASS` is still matched.

Because core sets this from the key it already holds, **no pointer parsing or unescaping happens
anywhere** — that's the point of the field, and there is correspondingly nothing to test about
unescaping.

The UI rule then collapses to `v-if="entry.excludableName"` — which simultaneously solves "which
rows get the action" from §3, with no tier logic in the view at all. Presence of the field *is* the
excludability test.

### §5.4 Warn on strong credential words

Excluding `pass` is fine. Excluding `password`, `psk`, `token`, `secret`, `apikey`, `pwd` almost
certainly isn't. The confirm dialog should escalate its wording (and require an explicit second
action) when the name matches a small strong-word list — the `configtool.json` rows in §3 are
exactly this case, and a user skimming a table of 8 rows could plausibly exclude them by accident.

Not a hard block: a user with a genuine non-secret field literally named `token` needs an out.

### §5.5 Thread the set through explicitly; no module-level mutable state

`sanitise.ts`'s doc comment opens by declaring the module **PURE** — no runtime imports, trivially
unit-testable. A module-level `setUserExclusions()` global would be a smaller diff (one call site
instead of threading through six signatures) but would make every `redact*` function's result depend
on hidden state, break test isolation, and contradict the module's stated design.

Thread an optional parameter instead. Cost: signature churn across `sanitiseFile`,
`redactGcodeFile`, `redactText`, `redactGcodeLine`, `redactJson`, `redactJsonValue`,
`isSensitiveName`. All are internal or core-public with few callers.

Recommended shape — a single options bag rather than a seventh positional arg, since these
signatures are already at 4 positionals:

```ts
export interface SanitiseOptions {
  /** Lowercased names the user has excluded from the Tier-3 name heuristic (§5.1). */
  excludedNames?: ReadonlySet<string>;
}
```

Default `undefined` everywhere, so every existing call site and test keeps working unchanged.

### §5.6 Storage: plain localStorage, not the encrypted path

Put it in `credentials.ts` beside `getRedactPreference` (same module already owns backup prefs), but
follow the **`getBackedUpMachineKeys` pattern — raw `ls()`, not `getJson`/`setJson`**.
`getJson`/`setJson` route through `isEncryptable()`/the session-key cache, which would make the
exclusion list unreadable while the credential store is locked. An exclusion list is a preference,
not a secret; it must never gate on passphrase entry.

Key: `${ns()}.redactionExclusions`, value `Array<string>` (lowercased, deduped).

Note the module's standing rule — nothing under this namespace may enter a diagnostics report or the
SD-card sync. The exclusion list isn't sensitive, but it stays on the same side of that line for
consistency rather than carving out an exception.

### §5.7 No restore/repair changes at all

An excluded name never produces a `RedactionEntry`, so there is nothing for `repair.ts` to locate,
suggest, or repair. `RedactionSite`, `RepairAction`, the `[FL-REDACTED:n]` tag format and
`redactions.json`'s schema are all untouched.

Corollary to state in the UI: **exclusions are not retroactive.** Backups already taken keep their
baked-in `[FL-REDACTED:n]` tags and restore exactly as before. Exclusions affect the next backup
only — which is precisely the "exclude, then run the backup again" flow the user described.

## §6 Implementation phases

### Phase 1 — core (`dwc-config-backup-core`)

1. `types.ts`: add `excludableName?: string` to `RedactionEntry` (§5.3).
2. `sanitise.ts`:
   - add `SanitiseOptions` (§5.5);
   - `isSensitiveName(name, excluded?)` — check user set after the hardcoded allowlist, before the
     regex;
   - set `excludableName` on the two Tier-3 emit sites:
     - `redactGcodeLine`'s `VAR`/`GLOBAL` branch — trivial, `varName` is right there;
     - `redactJsonValue`'s string branch — **not** trivial. It currently receives
       `keyIsSensitive: boolean` and no key name. Replace that parameter with the key itself
       (`sensitiveKey: string | null` — non-null meaning "sensitive, and this is the name"), so the
       string branch can stamp `excludableName`. Watch the **array case**: the existing code
       propagates `keyIsSensitive` unchanged into `value.map(...)` so elements under a sensitive key
       inherit it — the key name must inherit by the same path, or elements of
       `"tokens": ["a","b"]` end up with no `excludableName` while still being redacted, which
       renders them un-excludable and silently breaks the §3 "field presence = excludable" contract
       the UI depends on.
   - thread `opts` through `sanitiseFile` → `redactGcodeFile`/`redactText`/`redactJson` →
     `redactGcodeLine`/`redactJsonValue`.
3. `archive.ts`: `BuildArchiveOptions.excludedNames?: ReadonlySet<string>` → pass into `sanitiseFile`
   at the one call site (line 88).
4. `credentials.ts`: `getRedactionExclusions()` / `addRedactionExclusion(name)` /
   `removeRedactionExclusion(name)` (§5.6).
5. Export the new type/functions from `index.ts`.

Ships as a `dwc-config-backup-core` minor. Fully backward compatible — every new parameter is
optional.

### Phase 2 — UI in one host first (`duet-config-backup-plugin`, 3.7)

Smallest of the three, Vue 3, own i18n namespace — best place to settle the interaction before
duplicating it.

1. `RedactionSummary.vue`: third column, action shown only when `entry.excludableName` (§5.3);
   confirm dialog with the §5.4 escalation; emit `exclude` upward. The component is rendered at
   **two** call sites — the post-backup summary and the pre-send unredacted-warning dialog. Add the
   action to the post-backup summary only, via an `allowExclude` prop defaulting to `false`: the
   dialog is mid-`await` on a promise the user must resolve, and re-scanning underneath it means
   mutating the very list the open dialog is describing.
2. **Decide where the re-scan gets its input.** This is the one genuine unknown in this phase, and
   it must be settled before any UI is written. `collected` is a `const` local inside `onCreate()`,
   so it is gone by the time the summary is on screen, and `result` holds only
   `{ blob, manifest, redactions, sizeBySection }` — no file contents. Re-reading `built.blob` via
   `readArchive` recovers text **only when the backup was verbatim**; if redaction was on, the
   originals are already `[REDACTED]` and no re-scan can undo that.

   Options:
   - **(a) Hold `collected` in a `ref`, released/replaced on the next run.** Enables a true in-place
     re-scan in both redact modes. Cost: keeps the whole collected config in memory between
     backups — bounded by the existing per-file cap and ~20 MB soft total, so acceptable, but it is
     real and should be dropped on unmount.
   - **(b) No in-place re-scan.** Exclude → persist → toast "Excluded `pass`. Run the backup again
     to apply." This is literally the flow the original request described, costs nothing, and cannot
     desync. The table simply goes stale until the next run.

   **Recommended: (b) for the first release**, (a) only if the re-run friction actually annoys
   people. (b) removes the memory question, the stale-state question, and the redact-on
   impossibility in one move; the whole feature is then a persist + a toast.
3. Pass `excludedNames: new Set(getRedactionExclusions())` into **both** `buildArchive` calls
   (dry-run and real) — missing the second would show an accurate preview and then write a backup
   that ignored it.
4. i18n strings under `plugins.duetConfigBackup.configBackup.redaction.*`.
5. **The management list** — the mitigation §5.2 and §8 both depend on, so it is not optional. A
   section on the Configuration tab (next to "Redact sensitive values", which already lives there)
   listing every active exclusion with a remove action, plus an empty state. Without it an exclusion
   is invisible once made and effectively permanent, which is the feature's main standing risk.

### Phase 3 — port to the other two hosts

- **Flexible Layouts** (`src/configBackup/`): near-identical Vue 3 / `<script setup>`; namespace
  `plugins.flexibleLayouts.*`; uses `v-table`.
- **3.6 plugin** (`dwc-src/`): Vue 2 Options API, `v-simple-table`, `text dense small` button props,
  `style="gap: 8px"` instead of `ga-2`. A genuine rewrite of the same markup, not a copy-paste.

Each host also needs its own bump of `dwc-config-backup-core`, rebuild, and release. The three hosts
pin the core version in **three different places** — miss one and that host silently builds against
the old core:

| Host | Where the version is pinned |
| --- | --- |
| Flexible Layouts | `package.json` (+ lockfile) |
| 3.7 plugin | `package.json` (+ lockfile) |
| 3.6 plugin | no `package.json` — `CORE_VERSION` in `.github/workflows/release.yml`, and the local DWC 3.6 checkout's own `node_modules` for `build.bat` builds |

### Phase 4 — optional, only if asked for

Non-name exclusion axes, in rough value order:

- **Per-file opt-out of Tier-4 content scanning** (e.g. "don't pattern-scan `notes.txt`") — would
  cover the email-address false positives, which are currently unexcludable.
- **Per-category toggles** ("never redact IP addresses") — would cover the Tier-2/Tier-5 rows in §3,
  but weakens the §3 safety guarantee and needs its own careful thought. Not recommended without a
  concrete user need.

## §7 Testing

Core (`test/sanitise.test.ts`, `test/archive.test.ts`):

- an excluded name is not redacted, in both G-code and JSON;
- exclusion is exact — excluding `pass` leaves `password` still redacted (§5.1);
- exclusion is case-insensitive on both sides;
- a Tier-1/2 command param and an M122 line stay redacted even when a matching-looking name is
  excluded (locks in the §3 guarantee — the highest-value test here);
- `excludableName` is set on Tier-3 entries and absent on all others;
- `excludableName` is the **raw** name, not lowercased (`var maxPass` → `"maxPass"`);
- array elements under a sensitive JSON key each carry `excludableName` (the §6.1 inheritance trap);
- `buildArchive` with no `excludedNames` behaves exactly as before (regression guard).

Hosts: a component test that the action renders only for rows with `excludableName`.

## §8 Risks

| Risk | Mitigation |
| --- | --- |
| User excludes a genuine secret (the `configtool.json` rows in §3) | Exact-match only; §5.4 escalated confirm; management list makes it visible and reversible |
| Preview and real backup disagree | §6.2 step 3 — one shared source for `excludedNames`, both call sites |
| Silent under-redaction over time | Management view; consider surfacing "N exclusions active" next to the redact switch |
| 3× UI duplication drifts | Land 3.7 first, port deliberately; core holds all logic (§5.3) so hosts stay thin |
| Scope creep into Tier 4/5 | Explicitly deferred to Phase 4 |

## §9 Open questions

1. Should the count of active exclusions be shown next to the "Redact sensitive values" switch, so a
   long-lived list can't be forgotten?
2. Should exclusions travel with the SD-card credential sync so a user's list follows them between
   hosts/machines? (Convenient; cuts against §5.6's "same side of the line" choice.)
3. Should `redactions.json` record which names were excluded when the backup was made, for later
   audit of why something wasn't redacted?
