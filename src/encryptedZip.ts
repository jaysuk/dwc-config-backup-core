/**
 * Password-protected backup archives (ENCRYPTED-BACKUPS-PLAN.md). Wraps an already-built plain
 * archive `Blob` (from `buildArchive` in archive.ts) as the single AES-256 encrypted entry of a new
 * outer zip, using `@zip.js/zip.js` - the only dependency here that can produce a genuinely
 * standards-compliant password-protected ZIP (JSZip, used for the archive itself, has no encryption
 * support at all). `archive.ts`/`restore.ts` never see this module - it's a pure wrap/unwrap step
 * either side of the existing plain-archive pipeline, not a replacement for any part of it.
 *
 * `useWebWorkers: false`: this runs entirely on the main thread, same as the existing JSZip-based
 * archive assembly (no worker-bundling configuration needed in any of the three hosts' bundlers).
 * Verified (ENCRYPTED-BACKUPS-PLAN.md §2) that zip.js's AES cipher itself never touches
 * `crypto.subtle` - only the optional PBKDF2 key-derivation step does, falling back to a pure-JS
 * implementation when unavailable - so unlike encryption.ts's credential-store feature, this works on
 * every Duet regardless of HTTP/HTTPS; no `isEncryptionAvailable()`-style gate is needed here.
 */
import { BlobReader, BlobWriter, TextReader, ZipReader, ZipWriter, configure } from "@zip.js/zip.js";

configure({ useWebWorkers: false });

export class DecryptError extends Error {
	constructor(message = "Couldn't open this backup - check the password and try again.") {
		super(message);
		this.name = "DecryptError";
	}
}

/** Fixed name of the encrypted inner entry - the caller never sees or chooses this. */
const INNER_ENTRY_NAME = "backup.zip";
const HOWTO_ENTRY_NAME = "HOW-TO-OPEN.txt";

const HOWTO_TEXT = `This file is a password-protected backup of a Duet 3D printer's configuration.

Extract it with 7-Zip, WinRAR, or another tool that supports AES-encrypted ZIP files.
Windows' built-in "Extract All" does not support this - use a third-party tool.

You'll need the password that was set when this backup was created.
`;

/**
 * Wrap `archiveBlob` (a plain archive, as produced by buildArchive) as the single AES-256-encrypted
 * entry of a new outer zip, alongside one small UNENCRYPTED note explaining what this is and how to
 * open it - for anyone who finds the file without this plugin.
 *
 * `level: 0` (store, no recompression): `archiveBlob` is already DEFLATE-compressed at level 9 by the
 * JSZip archive assembly in archive.ts - re-running DEFLATE over already-compressed bytes here costs
 * real main-thread CPU for no size benefit.
 */
export async function encryptArchiveBlob(archiveBlob: Blob, password: string): Promise<Blob> {
	const zipFileWriter = new BlobWriter("application/zip");
	const zipWriter = new ZipWriter(zipFileWriter);
	await zipWriter.add(HOWTO_ENTRY_NAME, new TextReader(HOWTO_TEXT));
	await zipWriter.add(INNER_ENTRY_NAME, new BlobReader(archiveBlob), { password, level: 0, encryptionStrength: 3 });
	return zipWriter.close();
}

/**
 * True if `blob` has at least one AES-encrypted entry - readable from the zip's central directory
 * alone, no password needed. False for a plain (unencrypted) archive, and false (never throws) for a
 * blob that isn't a readable zip at all - the caller doesn't need to distinguish "definitely not
 * encrypted" from "not even a zip", both mean "don't prompt for a password".
 */
export async function isEncryptedArchiveBlob(blob: Blob): Promise<boolean> {
	const zipReader = new ZipReader(new BlobReader(blob));
	try {
		const entries = await zipReader.getEntries();
		return entries.some((e) => e.encrypted);
	} catch {
		return false;
	} finally {
		try { await zipReader.close(); } catch { /* nothing to close if getEntries() itself failed */ }
	}
}

/**
 * Recover the original plain archive blob from one produced by encryptArchiveBlob. Throws
 * DecryptError on a wrong password OR a corrupted/unrelated file - deliberately not distinguished.
 * zip.js's own wrong-password error is a plain Error with an internal, unversioned message that isn't
 * part of its public API surface (confirmed by reading its source - the constant isn't re-exported
 * from the package's main entry), so pattern-matching it would be fragile across library versions.
 * Treating any failure here as "wrong password or corrupted file" is both simpler and more robust.
 */
export async function decryptArchiveBlob(encryptedBlob: Blob, password: string): Promise<Blob> {
	const zipReader = new ZipReader(new BlobReader(encryptedBlob));
	try {
		const entries = await zipReader.getEntries();
		const inner = entries.find((e) => e.filename === INNER_ENTRY_NAME);
		if (!inner || inner.directory) { throw new DecryptError(); }
		return await inner.getData(new BlobWriter("application/zip"), { password });
	} catch (e) {
		if (e instanceof DecryptError) { throw e; }
		throw new DecryptError();
	} finally {
		try { await zipReader.close(); } catch { /* already failed - nothing meaningful to close */ }
	}
}
