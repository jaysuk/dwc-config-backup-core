/**
 * The host seam. This package is deliberately free of Vue, Pinia/Vuex and any DWC import so it can
 * be consumed by both a DWC 3.7 (Vue 3) plugin and a DWC 3.6 (Vue 2) one. The few values that are
 * genuinely host-specific are injected here instead.
 *
 * Machine I/O is NOT configured here - it stays an explicit `MachineIO` argument threaded through
 * `collect`/`restore` (see collect.ts), because it's per-call rather than per-install and keeping it
 * as a parameter is what makes those modules unit-testable without a running DWC.
 */

export interface HostConfig {
	/**
	 * Prefix for every `localStorage` key this package writes (destination settings, credentials,
	 * encryption salt/canary, backup history).
	 *
	 * Hosts sharing a browser origin MUST use different namespaces unless they genuinely intend to
	 * share saved credentials - the stored shape is versioned per host, so two hosts writing the same
	 * namespace can drift.
	 */
	storageNamespace: string;

	/**
	 * Extra file basenames Mirror-mode restore must never delete, on top of {@link ALWAYS_PROTECTED} -
	 * typically the host plugin's own SD-card state files. Matched on basename, not full path.
	 */
	protectedFiles: ReadonlySet<string>;
}

/**
 * Plugin state files that are never safe for a Mirror restore to delete, regardless of which host is
 * running. Frozen and cumulative on purpose: a machine may have been managed by a different host
 * before (e.g. Flexible Layouts on DWC 3.7, then the standalone plugin on 3.6), and a Mirror restore
 * run from one must not wipe the other's saved layout or credential bundle. Protecting a file that
 * isn't present is a harmless no-op, so this set only ever grows.
 */
export const ALWAYS_PROTECTED: ReadonlySet<string> = new Set([
	"flexible-layouts.backup.json",
	"flexible-layouts.backup.bak.json",
	"flexible-layouts.credentials.json",
]);

/**
 * Defaults are the ORIGINAL Flexible Layouts values, frozen for backward compatibility - an existing
 * FL install already has credentials sitting under `flexibleLayouts.configBackup.*`, and changing
 * the default would silently orphan them. Same reasoning as ARCHIVE_KIND in constants.ts. A host
 * should still call `configureHost()` explicitly rather than rely on this.
 */
const DEFAULTS: HostConfig = {
	storageNamespace: "flexibleLayouts.configBackup",
	protectedFiles: new Set(),
};

let current: HostConfig = { ...DEFAULTS };

/** Call once at plugin load, before any backup/restore/credential call. Partial - unset keys keep their default. */
export function configureHost(patch: Partial<HostConfig>): void {
	current = { ...current, ...patch };
}

export function getHostConfig(): Readonly<HostConfig> {
	return current;
}

/** True if Mirror-mode restore must never delete this basename. */
export function isProtectedFile(basename: string): boolean {
	return ALWAYS_PROTECTED.has(basename) || current.protectedFiles.has(basename);
}

/** Test-only: restore the frozen defaults. */
export function resetHostConfigForTests(): void {
	current = { ...DEFAULTS };
}
