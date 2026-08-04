/**
 * Archive-format and protocol constants for the whole-machine config backup/restore feature.
 *
 * Everything here is part of the on-disk/on-the-wire contract and is shared by every host. Values
 * that differ per host (route paths, the host's own protected SD files) live in hostConfig.ts.
 */

/**
 * Archive format identifiers. These are WRITTEN INTO and MATCHED AGAINST every backup ZIP, so they
 * are frozen: renaming them (however much "flexible-layouts" reads oddly in a shared package) would
 * mean archives written by one host no longer restore in another. Cross-host round-tripping is the
 * main reason this package exists - don't break it for cosmetics.
 */
export const ARCHIVE_KIND = "flexible-layouts-config-backup";
export const ARCHIVE_SCHEMA_VERSION = 1;

export const REDACTIONS_KIND = "flexible-layouts-redactions";
export const REDACTIONS_SCHEMA_VERSION = 1;

/** Sentinel written in place of a redacted value. Also the marker `repair.ts` scans for. */
export const REDACTED_VALUE = "[REDACTED]";
/** Trailing tag appended to a redacted G-code line; `<n>` is the redactions.json entry id. */
export const REDACTED_TAG_PREFIX = "[FL-REDACTED:";
/** Captures a comma-separated id list, e.g. "[FL-REDACTED:3,4]" for a line with 2+ redactions. */
export const REDACTED_TAG_RE = /\[FL-REDACTED:([\d,]+)\]/;

/** Directory kinds collected into a backup, keyed the same as `model.directories`. */
export type BackupDirKind = "system" | "macros" | "filaments";
export const BACKUP_DIR_KINDS: ReadonlyArray<BackupDirKind> = ["system", "macros", "filaments"];

/** Archive-relative folder name for each directory kind (`files/<folder>/…`). */
export const DIR_FOLDER: Record<BackupDirKind, string> = {
	system: "sys",
	macros: "macros",
	filaments: "filaments",
};

/** Fallback machine-relative path for a directory kind if `model.directories` is unset. */
export const DEFAULT_DIR_PATH: Record<BackupDirKind, string> = {
	system: "0:/sys/",
	macros: "0:/macros/",
	filaments: "0:/filaments/",
};

/** Recursion depth cap for directory walking - a runaway symlink-like structure can't loop forever. */
export const MAX_WALK_DEPTH = 8;

/** Default per-file size cap in bytes (D6). Configurable per backup. */
export const DEFAULT_MAX_FILE_BYTES = 1 * 1024 * 1024;
/** Default total-archive size cap in bytes (D6, informational - not enforced hard). */
export const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** File extensions never collected (D7): firmware images and logs. Case-insensitive, no dot. */
export const EXCLUDED_EXTENSIONS: ReadonlySet<string> = new Set(["bin", "uf2", "hex", "zip", "log", "gz"]);

/** Extensions read as binary (base64 in the archive) rather than text. */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "bmp", "ico", "dat"]);

// Files Mirror mode must never delete now live in hostConfig.ts (ALWAYS_PROTECTED + the host's own
// additions), since the set depends on which plugin wrote state to the SD card.

/** FIFO limit bounds for the Duet cloud backup service (§6 Phase 6). */
export const DUET_FIFO_DEFAULT_LIMIT = 5;
export const DUET_FIFO_MIN_LIMIT = 1;
export const DUET_FIFO_MAX_LIMIT = 20;

/**
 * Base URL of the Duet backup service. History: 2026-07-26, a bare IP with no domain; 2026-07-30,
 * moved to `http://backup.duet3d.com:3377` (same bare host:port shape, still plain HTTP only);
 * 2026-07-31, the backend's maintainers added a genuine HTTPS front (nginx) at
 * `https://backup.duet3d.com/api`, which THIS constant now points at - resolving the mixed-content
 * caveat that applied to every earlier form of this URL, for every DWC page regardless of which
 * protocol it's served over (see below).
 *
 * **Non-obvious path quirk, confirmed by direct request - do not "fix" this without re-testing
 * first**: nginx strips exactly one `/api/` segment before proxying upstream, and the backend's own
 * Express routes are registered AS `/api/<endpoint>` (unchanged from the old server). So the existing
 * call-site pattern of `${apiUrl}/api/get-backup-list` etc. needs `apiUrl` to already end in `/api`
 * to land correctly - i.e. the real request path is `/api/api/get-backup-list`, which looks wrong at
 * a glance but is exactly what both the client code and the nginx config expect. Verified: a single
 * `/api/get-backup-list` 404s ("Cannot GET /get-backup-list" - the `/api` nginx stripped never
 * reaches the Express route it needs); `/api/api/get-backup-list` correctly 401s.
 *
 * **Why this alone covers both HTTP- and HTTPS-served DWC pages, with no protocol-detection needed**:
 * mixed-content blocking is one-directional - a browser blocks an HTTPS page from fetching plain HTTP,
 * but an HTTP page fetching an HTTPS resource is unrestricted. The old plain-HTTP-only URL was
 * reachable from HTTP pages but blocked from HTTPS ones; this HTTPS URL is reachable from both, so a
 * single default now serves every user rather than needing to pick per-protocol.
 *
 * The plain-HTTP form (`http://backup.duet3d.com:3377`) is still live as of this writing but is no
 * longer used here - nothing depends on it continuing to work.
 *
 * This is the ONLY value used - it is deliberately not user-visible or user-editable (a product
 * decision: there is no URL field anywhere in the UI).
 */
export const DUET_BACKUP_API_DEFAULT = "https://backup.duet3d.com/api";

/**
 * The Duet backup service's human-facing web UI (as opposed to `DUET_BACKUP_API_DEFAULT`, the API
 * base this package's own client code talks to) - where a signed-in user can browse/manage their
 * uploaded backups outside of any DWC plugin. Same host, no `/api` suffix. Verified live (2026-08-04,
 * plain `GET /` returns 200 text/html).
 */
export const DUET_BACKUP_WEB_URL = "https://backup.duet3d.com/";

/** Upload/download endpoint pair actually used (§2.3 Q2: the zip endpoint, hard 2 MB cap). */
export const DUET_UPLOAD_PATH = "/api/upload-backup-zip";
export const DUET_DOWNLOAD_PATH = "/api/download-backup-zip-by-id";
// The expanded-files alternative, kept adjacent per the plan: no size cap, but pairs with
// /api/download-backup-by-id instead - switching endpoints means switching both paths together.
// export const DUET_UPLOAD_PATH = "/api/upload-backup";
// export const DUET_DOWNLOAD_PATH = "/api/download-backup-by-id";

/** Hard cap enforced by the shared backend's multer config for the zip upload endpoint. */
export const DUET_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

export const ARCHIVE_README = `This ZIP is a configuration backup for a Duet 3D printer controller.

Contents:
  manifest.json       - machine identity, firmware, file list and hashes
  redactions.json      - record of sensitive values found (and, if redaction was enabled, replaced)
  object-model.json   - a snapshot of the machine's object model (network identity always redacted -
                        this is a shared privacy scrubber used by every plugin's diagnostics reports,
                        so it applies even when the rest of this backup is verbatim)
  diagnostics/         - M122 output for the mainboard and each connected CAN-FD board
  files/sys/…          - contents of 0:/sys/
  files/macros/…       - contents of 0:/macros/
  files/filaments/…    - contents of 0:/filaments/

Restore this backup from the "Backup & restore config" page in DuetWebControl.
`;
