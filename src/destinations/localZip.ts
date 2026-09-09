/** Local ZIP download destination - the simplest and always-available option (§6 Phase 3). */
import { downloadBlob } from "../browser.js";

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** `DuetBackup-config-<hostname>-<YYYYMMDD-HHmmss>.zip` (§4) - requested by Duet3D so a downloaded
 *  backup's filename identifies the FEATURE (shared across all three host plugins: Flexible Layouts,
 *  duet-config-backup-plugin, duet-config-backup-plugin-3.6), not whichever specific plugin happened to
 *  produce it - was previously hardcoded "FlexibleLayouts-config-..." even from the two standalone
 *  backup-only plugins, which made no sense outside that one host. */
export function backupFilename(hostname: string, at: Date = new Date()): string {
	const safeHost = hostname.replace(/[^A-Za-z0-9_-]+/g, "_") || "machine";
	const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
	return `DuetBackup-config-${safeHost}-${stamp}.zip`;
}

export function downloadArchive(blob: Blob, hostname: string): void {
	downloadBlob(backupFilename(hostname), blob, "application/zip");
}
