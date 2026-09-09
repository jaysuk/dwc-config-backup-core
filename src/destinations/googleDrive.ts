/**
 * Google Drive destination (§6 Phase 8; device-flow rewrite: GOOGLE-DRIVE-DEVICE-FLOW-PLAN.md).
 *
 * Uses the OAuth 2.0 Device Authorization Grant (RFC 8628), not Google's Identity Services
 * (`initTokenClient`) popup flow. GIS is fundamentally origin-bound - it performs a postMessage
 * handshake with an iframe scoped to the calling page's own registered origin, which a `.local` mDNS
 * hostname (the overwhelmingly common way a Duet is actually reached) can never satisfy, HTTPS or not.
 * The device flow has NO origin or redirect-URI requirement at all: the user authorizes on a SEPARATE
 * device/tab via a short code and a fixed URL, so nothing about this page's own hostname is ever
 * presented to Google. This works from plain HTTP, `.local` hostnames, and bare LAN IPs alike - see the
 * plan's §2 for the live CORS verification this relies on.
 *
 * Requires a "TVs and Limited Input devices" OAuth client (client ID + client secret) rather than the
 * old flow's "Web application" client ID alone - see credentials.ts's `GoogleDriveSettings`. The
 * `client_secret` here is not a real secrecy regression: Google's own docs for this client type say
 * plainly it "is obviously not treated as a secret", since it ships inside a distributed app/plugin
 * bundle by design.
 *
 * Uses `drive.file` scope only - the plugin can never see the user's other Drive files, only ones it
 * creates itself. The OAuth access token is memory-only (never persisted); only the client ID/secret
 * are stored (in credentials.ts).
 */

export class GoogleDriveError extends Error {
	constructor(message: string) { super(message); this.name = "GoogleDriveError"; }
}

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const BACKUP_FOLDER_NAME = "Duet Config Backups";
const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCodeInfo {
	deviceCode: string;
	userCode: string;
	verificationUrl: string;
	expiresInSeconds: number;
	pollIntervalSeconds: number;
}

/** Step 1 of the device flow: request a device code. Shows the user `userCode`/`verificationUrl` to
 * act on, on ANY device (including a second tab in this same browser) - nothing about THIS page's own
 * origin is ever sent to Google, unlike the old GIS popup flow this replaces. */
export async function requestDeviceCode(clientId: string): Promise<DeviceCodeInfo> {
	const res = await fetch(DEVICE_CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: clientId, scope: DRIVE_SCOPE }),
	});
	const body = await res.json().catch(() => null);
	if (!res.ok || !body?.device_code) {
		throw new GoogleDriveError(body?.error_description ?? body?.error ?? `Could not start Google sign-in (${res.status}).`);
	}
	return {
		deviceCode: body.device_code,
		userCode: body.user_code,
		// Google's own field name - RFC 8628 specifies "verification_uri", Google does not send that.
		verificationUrl: body.verification_url,
		expiresInSeconds: body.expires_in,
		pollIntervalSeconds: body.interval,
	};
}

export type DeviceTokenOutcome =
	| { status: "authorized"; accessToken: string }
	| { status: "pending" }      // authorization_pending (HTTP 428) - keep polling, THE COMMON CASE
	| { status: "slowDown" }     // slow_down (403) - caller must INCREASE its poll interval
	| { status: "denied" }       // access_denied (403) - user refused
	| { status: "expired" }      // invalid_grant (400) - code expired or already used; needs a restart
	| { status: "error"; message: string };  // invalid_client, admin_policy_enforced, network failures

/** Step 2 of the device flow, called once per poll interval until a terminal outcome.
 *
 * Deliberately does NOT use `driveFetch` below: Google's "still waiting" response - the case that
 * happens on nearly every single poll - is HTTP 428, not 200, and `driveFetch`'s `!res.ok` throw
 * (correct for the Drive API calls it serves) would turn that into a thrown error on every poll before
 * the user finishes authorizing, so the flow would never succeed. This reads and parses the JSON body
 * regardless of HTTP status and branches on the body's `error` field - never the status code, since
 * `slow_down` and `access_denied` both come back as 403 (GOOGLE-DRIVE-DEVICE-FLOW-PLAN.md §4.5).
 * Never throws for a protocol-level outcome; only `{status:"error"}` carries a message. */
export async function pollDeviceToken(clientId: string, clientSecret: string, deviceCode: string): Promise<DeviceTokenOutcome> {
	let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
	try {
		const res = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				device_code: deviceCode,
				grant_type: DEVICE_GRANT_TYPE,
			}),
		});
		body = await res.json();
	} catch {
		return { status: "error", message: "Could not reach Google - check the network connection." };
	}
	if (body?.access_token) { return { status: "authorized", accessToken: body.access_token }; }
	// Google's error strings, NOT RFC 8628's ("expired_token" is the RFC name; Google sends
	// "invalid_grant" instead - see the plan's §4.5 correction 2).
	switch (body?.error) {
		case "authorization_pending": return { status: "pending" };
		case "slow_down": return { status: "slowDown" };
		case "access_denied": return { status: "denied" };
		case "invalid_grant": return { status: "expired" };
		default: return { status: "error", message: body?.error_description ?? body?.error ?? "Google sign-in failed." };
	}
}

async function driveFetch(accessToken: string, url: string, init?: RequestInit): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
	const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers as Record<string, string> | undefined) } });
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new GoogleDriveError(body?.error?.message ?? `Google Drive API error (${res.status}).`);
	}
	return res.status === 204 ? null : res.json();
}

async function findOrCreateFolder(accessToken: string, name: string, parentId?: string): Promise<string> {
	const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentId ? ` and '${parentId}' in parents` : ""}`);
	const list = await driveFetch(accessToken, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
	if (list.files?.length > 0) { return list.files[0].id; }
	const created = await driveFetch(accessToken, "https://www.googleapis.com/drive/v3/files", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : undefined }),
	});
	return created.id;
}

export interface UploadResult { fileId: string; webViewLink?: string }

/** Upload a backup ZIP into `Duet Config Backups/<hostname>/<filename>`, creating folders as needed. */
export async function uploadBackup(accessToken: string, hostname: string, filename: string, blob: Blob): Promise<UploadResult> {
	const rootFolder = await findOrCreateFolder(accessToken, BACKUP_FOLDER_NAME);
	const machineFolder = await findOrCreateFolder(accessToken, hostname, rootFolder);

	const metadata = { name: filename, parents: [machineFolder] };
	const boundary = `flexlayouts-${Date.now()}`;
	const metadataPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
	const filePartHeader = `--${boundary}\r\nContent-Type: application/zip\r\n\r\n`;
	const closing = `\r\n--${boundary}--`;
	const body = new Blob([metadataPart, filePartHeader, blob, closing]);

	const created = await driveFetch(accessToken, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
		method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
	});
	return { fileId: created.id, webViewLink: created.webViewLink };
}
