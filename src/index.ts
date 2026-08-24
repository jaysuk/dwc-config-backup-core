/**
 * dwc-config-backup-core - whole-machine configuration backup & restore for Duet controllers,
 * factored out of the Flexible Layouts DWC plugin so a DWC 3.6 (Vue 2) and a DWC 3.7 (Vue 3) host
 * can share one implementation of the parts where a bug actually costs someone their config: the
 * archive format, the redaction engine, the restore planner and the cloud destination adapters.
 *
 * The package contains NO Vue, NO Pinia/Vuex and NO DWC import. Two things are injected by the host:
 *
 *   1. `configureHost()` (hostConfig.ts) - the localStorage namespace and any extra SD files that
 *      Mirror-mode restore must never delete. Call once at plugin load.
 *   2. A `MachineIO` implementation (collect.ts) - passed per call to collect/restore, since it's the
 *      one thing that genuinely differs between hosts (Pinia methods vs Vuex dispatches).
 *
 * Destination adapters are NOT re-exported flat: dropbox/duetCloud/github/webdav all legitimately
 * export `listBackups`/`uploadBackup`/`downloadBackup`/`deleteBackup`, so they're namespaced here and
 * also reachable via subpath (`dwc-config-backup-core/destinations/github`).
 */

// --- Host seam ----------------------------------------------------------------------------------
export { ALWAYS_PROTECTED, configureHost, getHostConfig, isProtectedFile, resetHostConfigForTests } from "./hostConfig.js";
export type { HostConfig } from "./hostConfig.js";

// --- Archive format + shared types --------------------------------------------------------------
export * from "./constants.js";
export * from "./types.js";

// --- Pipeline -----------------------------------------------------------------------------------
export * from "./collect.js";
export * from "./archive.js";
export * from "./encryptedZip.js";
export * from "./sanitise.js";
export * from "./repair.js";
export * from "./restore.js";
export * from "./machineIdentity.js";

// --- Storage, credentials, encryption -----------------------------------------------------------
export * from "./credentials.js";
export * from "./credentialsSdSync.js";
export * from "./credentialsMigrate.js";
export * from "./encryption.js";

// --- Utilities ----------------------------------------------------------------------------------
export * from "./hash.js";
export * from "./printStatus.js";
export * from "./nudgePredicates.js";
export { downloadBlob, sanitizeModel } from "./browser.js";

// --- Destinations (namespaced - see note above) --------------------------------------------------
export * as dropbox from "./destinations/dropbox.js";
export * as duetCloud from "./destinations/duetCloud.js";
export * as github from "./destinations/github.js";
export * as googleDrive from "./destinations/googleDrive.js";
export * as localZip from "./destinations/localZip.js";
export * as webdav from "./destinations/webdav.js";
