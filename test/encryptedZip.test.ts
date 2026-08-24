import { describe, expect, it } from "vitest";

import { decryptArchiveBlob, DecryptError, encryptArchiveBlob, isEncryptedArchiveBlob } from "../src/encryptedZip";

async function blobText(blob: Blob): Promise<string> {
	return new TextDecoder().decode(await blob.arrayBuffer());
}

describe("encryptArchiveBlob / decryptArchiveBlob round-trip", () => {
	it("recovers byte-identical content with the right password", async () => {
		const original = new Blob(["not really a zip, just some bytes to round-trip"], { type: "application/zip" });
		const encrypted = await encryptArchiveBlob(original, "hunter2");
		const decrypted = await decryptArchiveBlob(encrypted, "hunter2");
		expect(await blobText(decrypted)).toBe(await blobText(original));
	});

	it("round-trips real binary content byte-for-byte", async () => {
		const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 137, 80, 78, 71]);
		const original = new Blob([bytes], { type: "application/zip" });
		const encrypted = await encryptArchiveBlob(original, "correct-horse-battery-staple");
		const decrypted = await decryptArchiveBlob(encrypted, "correct-horse-battery-staple");
		const decryptedBytes = new Uint8Array(await decrypted.arrayBuffer());
		expect(Array.from(decryptedBytes)).toEqual(Array.from(bytes));
	});

	it("throws DecryptError on the wrong password", async () => {
		const original = new Blob(["secret config"], { type: "application/zip" });
		const encrypted = await encryptArchiveBlob(original, "correct-password");
		await expect(decryptArchiveBlob(encrypted, "wrong-password")).rejects.toThrow(DecryptError);
	});

	it("throws DecryptError on a corrupted/unrelated blob", async () => {
		const notAZip = new Blob(["this is plainly not a zip file at all"], { type: "text/plain" });
		await expect(decryptArchiveBlob(notAZip, "anything")).rejects.toThrow(DecryptError);
	});
});

describe("isEncryptedArchiveBlob", () => {
	it("is true for an archive encryptArchiveBlob produced", async () => {
		const original = new Blob(["config"], { type: "application/zip" });
		const encrypted = await encryptArchiveBlob(original, "hunter2");
		expect(await isEncryptedArchiveBlob(encrypted)).toBe(true);
	});

	it("is false for an unrelated non-zip blob (never throws)", async () => {
		const notAZip = new Blob(["just text"], { type: "text/plain" });
		await expect(isEncryptedArchiveBlob(notAZip)).resolves.toBe(false);
	});
});

describe("the unencrypted how-to-open note", () => {
	it("is readable from the encrypted archive without a password", async () => {
		const original = new Blob(["config"], { type: "application/zip" });
		const encrypted = await encryptArchiveBlob(original, "hunter2");
		// A plain read via the same mechanism the app would use for any zip - no password supplied.
		const { ZipReader, BlobReader, TextWriter } = await import("@zip.js/zip.js");
		const zipReader = new ZipReader(new BlobReader(encrypted));
		const entries = await zipReader.getEntries();
		const howto = entries.find((e) => e.filename === "HOW-TO-OPEN.txt");
		expect(howto).toBeTruthy();
		expect(howto!.encrypted).toBe(false);
		const text = await (howto as { getData: (w: TextWriter) => Promise<string> }).getData(new TextWriter());
		expect(text).toContain("password-protected");
		await zipReader.close();
	});
});
