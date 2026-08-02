/**
 * Small browser helpers vendored from `dwc-plugin-runtime` rather than imported.
 *
 * That package declares `vue` as a peer dependency and ships Vue components alongside these, which
 * would drag a Vue 3 requirement into a package that must also work inside a Vue 2 (DWC 3.6) build.
 * Both functions below are pure DOM/data with no framework involvement, so copying is cheaper and
 * safer than either a peer dep or another injection port.
 *
 * Keep `sanitizeModel` behaviourally identical to the runtime's copy - it's the shared privacy
 * scrubber every Duet plugin's diagnostics report uses, and a backup's object-model dump is expected
 * to be scrubbed the same way regardless of which plugin wrote it.
 */

const REDACTED = "<redacted>";

function mapReplacer(_key: string, value: unknown): unknown {
	return value instanceof Map ? Object.fromEntries(value as Map<string, unknown>) : value;
}

function deepClone<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		return JSON.parse(JSON.stringify(value, mapReplacer)) as T;
	}
}

/**
 * Deep-clone an object model and redact privacy-sensitive values (IP/SSID/MAC, hostnames, board
 * serials, G-code file names) while keeping the structure intact. Returned object is safe to share.
 */
export function sanitizeModel(model: unknown): unknown {
	if (!model || typeof model !== "object") return model;
	const clone = deepClone(model) as Record<string, any>;
	const net = clone.network;
	if (net && typeof net === "object") {
		if (net.hostname) net.hostname = REDACTED;
		if (net.name) net.name = REDACTED;
		if (Array.isArray(net.interfaces)) {
			for (const i of net.interfaces) {
				if (!i || typeof i !== "object") continue;
				for (const k of ["actualIP", "configuredIP", "gateway", "subnet", "dnsServer", "mac", "ssid"]) {
					if (k in i) i[k] = REDACTED;
				}
			}
		}
	}
	if (Array.isArray(clone.boards)) for (const b of clone.boards) { if (b && b.uniqueId) b.uniqueId = REDACTED; }
	const job = clone.job;
	if (job && typeof job === "object") {
		if (job.lastFileName) job.lastFileName = REDACTED;
		if (job.file && job.file.fileName) job.file.fileName = REDACTED;
	}
	return clone;
}

/** Trigger a browser download of `content` as a file named `filename`. */
export function downloadBlob(filename: string, content: BlobPart, mimeType = "application/octet-stream"): void {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
