/**
 * Dropbox destination. Authenticated with an access token generated directly in the Dropbox App
 * Console (App Console -> your app -> "Generated access token") - no interactive OAuth redirect, so
 * unlike Google Drive this works fine from a plain-HTTP DWC origin. Both Dropbox API hosts
 * (`api.dropboxapi.com` for metadata calls, `content.dropboxapi.com` for upload/download) are
 * CORS-open for browser apps.
 *
 * Scopes each call needs, taken from Dropbox's own API spec (dropbox/dropbox-api-spec) rather than
 * inferred - the app must have ALL of these enabled before the token is generated:
 *   account_info.read     users/get_current_account  ({@link verifyToken}, i.e. the Save button)
 *   files.metadata.read   files/list_folder          ({@link listMachineFolders}, {@link listBackups})
 *   files.content.write   files/upload, files/delete_v2
 *   files.content.read    files/download
 * A token is only ever granted the scopes its app had AT GENERATION TIME, so enabling a scope later
 * requires generating a replacement token - see {@link TOKEN_REJECTED_HINT}.
 */
export class DropboxError extends Error {
	constructor(message: string) { super(message); this.name = "DropboxError"; }
}

const API = "https://api.dropboxapi.com/2";
const CONTENT_API = "https://content.dropboxapi.com/2";
const ROOT_FOLDER = "/Duet Config Backups";

function sanitiseSegment(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]+/g, "_") || "machine";
}

function folderFor(hostname: string): string {
	return `${ROOT_FOLDER}/${sanitiseSegment(hostname)}`;
}

/**
 * Every caller of this module gets `token` straight from an unvalidated UI text field (see
 * CloudPanel.vue in each consuming plugin) and it is stored/round-tripped verbatim afterward -
 * nothing upstream trims it. A trailing newline or leading/trailing space from a copy-paste (common:
 * many "copy" affordances on a web page include the line's own trailing newline) survives all the way
 * into the `Authorization` header. Some Dropbox-side auth handling can reject a header shaped like
 * that as fundamentally unparseable rather than as "a specific, wrong token" - the AuthError union's
 * enumerated reasons (invalid_access_token, expired_access_token, missing_scope, ...) are for a
 * well-formed-but-wrong credential, not a malformed header value, so this class of failure is a
 * plausible source of the unhelpfully generic `.tag: "other"` on /users/get_current_account or
 * /files/upload. Trimmed once, here, so every exported function is protected regardless of what the
 * caller passed in - cheaper and more robust than fixing every UI's input field individually.
 */
function authHeader(token: string): string {
	return `Bearer ${token.trim()}`;
}

/**
 * Dropbox's `error_summary` is a debug string built by walking the response's error union tag(s),
 * e.g. `"path/not_found/.."` or, for an unclassified/uncategorised failure the server itself couldn't
 * pin to a specific known variant, just `"other/.."`. On its own that string doesn't say which union
 * produced it (auth, access/scope, rate-limit, or the route's own error type each have their own "
 * other" catch-all) - the HTTP status is what narrows that down (401 = auth, 403 = access/scope,
 * 409 = the route's own error, 429 = rate limit) - so it's folded into every thrown message here
 * rather than discarded, even when Dropbox did send a structured body.
 *
 * That structured `{error_summary, error}` body is only sent for ROUTE-level errors. A request that
 * fails before routing even happens - malformed `Dropbox-API-Arg` JSON, a bad Content-Type, other
 * request-shape problems - gets a PLAIN TEXT body instead (confirmed against real reports of Dropbox
 * 400s), which `res.json()` can't parse at all. That used to be silently swallowed by a bare
 * `.catch(() => null)`, discarding the one piece of diagnostic detail Dropbox actually sent for
 * exactly the class of error that most needs it. Read the body as text once, then try to parse it as
 * JSON; either way something Dropbox actually said survives into the thrown error.
 */
/**
 * Every 401 from Dropbox means the same practical thing - "this token isn't allowed to do that" -
 * but the tag alone never tells a USER what to do about it, and the most common cause here is
 * genuinely non-obvious: enabling a scope in the App Console does NOT grant it to tokens that
 * already exist. Dropbox is explicit that "just adding a scope to your app via the App Console does
 * not retroactively grant that scope to existing access tokens", so the token has to be regenerated
 * by hand afterwards - which reads as "I already fixed the permissions and it's still broken".
 *
 * `missing_scope` says this outright, but the generic `other` catch-all (and a bare `invalid_access_token`)
 * doesn't, so the hint is attached to every 401 rather than only the tagged case.
 */
const TOKEN_REJECTED_HINT = "The Dropbox access token was rejected. If you just changed this app's "
	+ "permissions in the Dropbox App Console, you must click Generate there to create a NEW access "
	+ "token and paste it in again - changing an app's scopes never updates tokens that already exist. "
	+ "Check that account_info.read, files.metadata.read, files.content.read and files.content.write "
	+ "are all enabled BEFORE generating the new token.";

async function describeError(res: Response): Promise<string> {
	const text = await res.text().catch(() => "");
	let summary: string | undefined;
	try { summary = (JSON.parse(text) as { error_summary?: string } | null)?.error_summary; } catch { /* not JSON - the raw text itself is Dropbox's detail */ }
	const detail = summary || text;
	const base = detail ? `${detail} (HTTP ${res.status})` : `Dropbox API error (HTTP ${res.status}).`;
	return res.status === 401 ? `${base} — ${TOKEN_REJECTED_HINT}` : base;
}

async function apiCall(path: string, token: string, body: unknown): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
	const res = await fetch(`${API}${path}`, {
		method: "POST", headers: { Authorization: authHeader(token), "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
	});
	if (!res.ok) { throw new DropboxError(await describeError(res)); }
	return res.json();
}

export interface DropboxBackupEntry { path: string; name: string; size: number; serverModified: string }

/** Lists the per-machine subfolders under the shared backup root - the cross-machine restore path
 * (e.g. after a mainboard swap, the old machine's folder is still listed here). Empty if nothing has
 * ever been backed up to this account yet. */
export async function listMachineFolders(token: string): Promise<Array<string>> {
	try {
		const data = await apiCall("/files/list_folder", token, { path: ROOT_FOLDER, recursive: false });
		return (data.entries ?? [])
			.filter((e: { [".tag"]: string }) => e[".tag"] === "folder")
			.map((e: { name: string }) => e.name);
	} catch (e) {
		if (e instanceof DropboxError && /not_found/i.test(e.message)) { return []; }
		throw e;
	}
}

/** Lists backups for one machine's folder. A never-backed-up-yet machine (folder doesn't exist) is
 * an empty list, not an error. */
export async function listBackups(token: string, hostname: string): Promise<Array<DropboxBackupEntry>> {
	try {
		const data = await apiCall("/files/list_folder", token, { path: folderFor(hostname), recursive: false });
		return (data.entries ?? [])
			.filter((e: { [".tag"]: string }) => e[".tag"] === "file")
			.map((e: { path_lower: string; name: string; size: number; server_modified: string }) => ({
				path: e.path_lower, name: e.name, size: e.size, serverModified: e.server_modified,
			}));
	} catch (e) {
		if (e instanceof DropboxError && /not_found/i.test(e.message)) { return []; }
		throw e;
	}
}

export async function uploadBackup(token: string, hostname: string, filename: string, blob: Blob): Promise<DropboxBackupEntry> {
	const path = `${folderFor(hostname)}/${filename}`;
	const res = await fetch(`${CONTENT_API}/files/upload`, {
		method: "POST",
		headers: {
			Authorization: authHeader(token),
			"Content-Type": "application/octet-stream",
			"Dropbox-API-Arg": JSON.stringify({ path, mode: "add", autorename: true, mute: true }),
		},
		body: blob,
	});
	if (!res.ok) { throw new DropboxError(await describeError(res)); }
	const data = await res.json();
	return { path: data.path_lower, name: data.name, size: data.size, serverModified: data.server_modified };
}

export async function downloadBackup(token: string, path: string): Promise<Blob> {
	const res = await fetch(`${CONTENT_API}/files/download`, {
		method: "POST", headers: { Authorization: authHeader(token), "Dropbox-API-Arg": JSON.stringify({ path }) },
	});
	if (!res.ok) { throw new DropboxError(await describeError(res)); }
	return res.blob();
}

export async function deleteBackup(token: string, path: string): Promise<void> {
	await apiCall("/files/delete_v2", token, { path });
}

/** Verifies the token works at all (a cheap `users/get_current_account` call) - used by the
 * configuration panel's "Save" button to confirm the token before persisting it. */
export async function verifyToken(token: string): Promise<string> {
	const data = await apiCall("/users/get_current_account", token, null);
	return data?.name?.display_name ?? data?.email ?? "Dropbox account";
}
