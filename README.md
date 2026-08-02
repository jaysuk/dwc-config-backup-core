# dwc-config-backup-core

Framework-free core of the whole-machine **configuration backup & restore** feature for
DuetWebControl plugins.

Extracted from the [Flexible Layouts](https://github.com/jaysuk/Flexible-Layouts) plugin so that a
DWC 3.7 (Vue 3) host and a DWC 3.6 (Vue 2) host can share one implementation of the parts where a
bug actually costs someone their machine configuration: the archive format, the redaction engine,
the restore planner, credential storage/encryption, and the cloud destination adapters.

**Contains no Vue, no Pinia/Vuex and no DWC import.** The only runtime dependency is `jszip`.

## What's in here

| Area | Modules |
| --- | --- |
| Archive format | `constants` (frozen format ids), `types`, `archive` (build/read ZIP) |
| Collection | `collect` (directory walk, object-model dump, M122 capture) |
| Redaction | `sanitise` (5 tiers), `repair` (locate + resolve redactions on restore) |
| Restore | `restore` (plan, machine diff, Mirror-mode deletion rules, verified writes) |
| Storage | `credentials`, `credentialsSdSync`, `encryption` (AES-256-GCM, opt-in) |
| Destinations | `destinations/{localZip,duetCloud,github,dropbox,webdav,googleDrive}` |
| Helpers | `hash`, `printStatus`, `nudgePredicates`, `browser` |

## Host integration

Two things are injected by the host. Everything else is pure.

### 1. `configureHost()` — call once at plugin load

```ts
import { configureHost } from "dwc-config-backup-core";

configureHost({
    // Prefix for every localStorage key this package writes.
    storageNamespace: "myPlugin.configBackup",
    // Extra SD files Mirror-mode restore must never delete (your plugin's own state).
    protectedFiles: new Set(["my-plugin.state.json"]),
});
```

Both fields are optional. The defaults are the original Flexible Layouts values, frozen for
backward compatibility — an existing FL install already has credentials under
`flexibleLayouts.configBackup.*`, and changing the default would silently orphan them.

> **Hosts sharing a browser origin must use different namespaces** unless they genuinely intend to
> share saved credentials.

A small set of plugin state files (`ALWAYS_PROTECTED`) is protected regardless of configuration, and
is cumulative: a machine may have been managed by a different host before, and a Mirror restore run
from one host must not wipe another's saved layout or credential bundle.

### 2. `MachineIO` — passed per call

This is the one piece that genuinely differs between hosts, so it stays an explicit argument rather
than global configuration. Implementations **must be fully silent** — no progress toasts, no
success/error notifications — because backup and restore drive hundreds of calls and report their
own aggregated progress.

```ts
import type { MachineIO } from "dwc-config-backup-core";

// DWC 3.7 (Pinia)
const io: MachineIO = {
    getFileList: (d) => machineStore.getFileList(d),
    downloadText: (f) => machineStore.download({ filename: f, type: "text" }, false, false, false, false),
    // …
};

// DWC 3.6 (Vuex) — same interface, different plumbing
const io: MachineIO = {
    getFileList: (d) => store.dispatch("machine/getFileList", d),
    // …
};
```

## Compatibility contract

`ARCHIVE_KIND` (`"flexible-layouts-config-backup"`) and `REDACTIONS_KIND` are written into and
matched against every backup ZIP. They are **frozen** — however oddly "flexible-layouts" reads in a
shared package, renaming them would mean archives written by one host no longer restore in another.
Cross-host round-tripping is the main reason this package exists.

The same applies to `ARCHIVE_SCHEMA_VERSION` / `REDACTIONS_SCHEMA_VERSION`: bump them only with a
matching reader migration.

## Imports

The root export carries everything except the destination adapters, which are namespaced because
`dropbox`/`duetCloud`/`github`/`webdav` all legitimately export
`listBackups`/`uploadBackup`/`downloadBackup`/`deleteBackup`:

```ts
import { buildArchive, sanitiseFile, duetCloud } from "dwc-config-backup-core";
await duetCloud.listBackups(apiUrl, guid);

// or by subpath
import { listBackups } from "dwc-config-backup-core/destinations/duetCloud";
```

## Known environment constraints

These are browser/platform facts, not limitations of this package — hosts should surface them
honestly rather than offering controls that silently fail:

- **Encryption needs a secure context.** `crypto.subtle` is unavailable over plain HTTP, which is how
  most Duets serve DWC. `isEncryptionAvailable()` detects this.
- **Google Drive needs HTTPS**, by Google's OAuth policy — `isOriginSupported()` gates it.
- **The Duet backup service is HTTPS** (`DUET_BACKUP_API_DEFAULT` in `constants.ts`), which is
  reachable from a DWC page served over either HTTP or HTTPS — mixed-content blocking only ever
  applies in the other direction (an HTTPS page fetching plain HTTP), so this needs no
  protocol-detection logic on the client. `assertHttpsCompatible()` in `destinations/duetCloud.ts`
  still guards the general case (it would reject an http:// URL if this constant were ever changed
  back to one), but the guard sits idle against the current default.

## Development

```bash
npm install
npm run typecheck
npm run build      # tsc -> dist/
npm test           # vitest, 246 tests
```

Relative imports carry explicit `.js` extensions so the built output is valid ESM under Node as well
as bundlers.

## License

GPL-3.0-or-later, inherited from Flexible Layouts, which this code was extracted from.
