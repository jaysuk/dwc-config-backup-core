/**
 * Same-browser, same-origin credential migration between two hosts sharing this package - e.g. the
 * standalone duet-config-backup-plugin and Flexible Layouts' built-in copy of this feature, both
 * installed on the same DWC instance. Unlike the SD-card/file export path (credentialsSdSync.ts,
 * exportEncryptedBundle/importEncryptedBundle), this never leaves the browser at all: it reads the
 * OTHER host's raw localStorage keys directly and writes them through THIS host's normal setters, so
 * nothing is ever serialised to disk, the SD card or the network.
 *
 * That's what makes it usable with no `crypto.subtle` at all. `isEncryptionAvailable()`'s secure-
 * context requirement (HTTPS/localhost) exists because the SD/file path hands ciphertext to something
 * outside the browser - a same-origin, same-browser copy never does, so it's exactly as safe as the
 * plaintext already sitting in this browser's localStorage today (see credentials.ts's own module doc
 * comment: readable by devtools regardless, encryption or not). Most Duets are plain HTTP, where
 * `crypto.subtle` is simply unavailable in every browser - this is the path that still works there.
 *
 * Deliberately scoped to the case that's actually broken without HTTPS: reads the SOURCE host's
 * credentials only when THEY are stored in plaintext (source encryption off). If the source has its
 * OWN encryption enabled, `crypto.subtle` must have been available when it was set up, so the existing
 * SD-card/file-export path (which correctly threads a single passphrase-derived key through) is the
 * right tool for that case - this module deliberately returns null rather than trying to also handle it.
 */
import {
	type DropboxSettings, type DuetCloudSession, type GithubSettings, type WebDavSettings,
	ls, setDropboxSettings, setDuetCloudSession, setGithubSettings, setGoogleDriveClientId, setWebDavSettings,
} from "./credentials.js";

// Deliberately reuses credentials.ts's own ls() rather than touching window.localStorage directly -
// see that export's doc comment for why a second, separate storage accessor here would be a real bug,
// not just a test artifact.
function readRaw(namespace: string, suffix: string): string | null {
	try { return ls()?.getItem(`${namespace}.${suffix}`) ?? null; } catch { return null; }
}

function readJson<T>(namespace: string, suffix: string): T | null {
	const raw = readRaw(namespace, suffix);
	if (!raw) { return null; }
	try { return JSON.parse(raw) as T; } catch { return null; }
}

/** True if `sourceNamespace` (another host's storageNamespace, sharing this same browser/origin) has
 *  its own encryption turned on - the signal that the SD-card/file path is the right tool instead of
 *  this module, not a plaintext copy. */
export function isNamespaceEncrypted(sourceNamespace: string): boolean {
	return readRaw(sourceNamespace, "encryption.enabled") === "1";
}

export interface MigratableCredentials {
	duetSession: DuetCloudSession | null;
	github: GithubSettings | null;
	googleDriveClientId: string | null;
	dropbox: DropboxSettings | null;
	webdav: WebDavSettings | null;
}

/**
 * Read every plaintext credential stored under `sourceNamespace`. Returns null if the source has its
 * own encryption enabled (see the module doc comment for why - use the SD-card/file path instead) or
 * if nothing at all is stored there, so callers can use "is this non-null" directly to decide whether
 * to offer an import action in the first place.
 */
export function readPlaintextCredentials(sourceNamespace: string): MigratableCredentials | null {
	if (isNamespaceEncrypted(sourceNamespace)) { return null; }
	const creds: MigratableCredentials = {
		duetSession: readJson(sourceNamespace, "duet.session"),
		github: readJson(sourceNamespace, "github"),
		googleDriveClientId: readJson(sourceNamespace, "drive.clientId"),
		dropbox: readJson(sourceNamespace, "dropbox"),
		webdav: readJson(sourceNamespace, "webdav"),
	};
	const hasAny = Object.values(creds).some((v) => v != null);
	return hasAny ? creds : null;
}

/**
 * Write `creds` into THIS host's own storage, via the normal setters - so the destination's own
 * encryption state (on and unlocked, or off) is respected exactly as if the operator had typed each
 * value in by hand. Only non-null fields are written; anything null/absent in `creds` leaves whatever
 * the destination already had untouched, rather than clearing it.
 */
export function importPlaintextCredentials(creds: MigratableCredentials): void {
	if (creds.duetSession) { setDuetCloudSession(creds.duetSession); }
	if (creds.github) { setGithubSettings(creds.github); }
	if (creds.googleDriveClientId) { setGoogleDriveClientId(creds.googleDriveClientId); }
	if (creds.dropbox) { setDropboxSettings(creds.dropbox); }
	if (creds.webdav) { setWebDavSettings(creds.webdav); }
}
