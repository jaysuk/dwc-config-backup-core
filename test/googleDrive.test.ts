import { afterEach, describe, expect, it, vi } from "vitest";

import {
	deleteBackup, downloadBackup, listBackups, listMachineFolders, pollDeviceToken,
	refreshAccessToken, requestDeviceCode, uploadBackup,
} from "../src/destinations/googleDrive";

function jsonResponse(body: unknown, status = 200): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("requestDeviceCode", () => {
	it("parses a device/code response into DeviceCodeInfo - field names verified against Google's live docs", async () => {
		// snake_case, Google's actual spelling: "verification_url", NOT RFC 8628's "verification_uri".
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
			device_code: "device-abc",
			user_code: "ABCD-EFGH",
			verification_url: "https://www.google.com/device",
			expires_in: 1800,
			interval: 5,
		})));
		const info = await requestDeviceCode("client-id");
		expect(info).toEqual({
			deviceCode: "device-abc",
			userCode: "ABCD-EFGH",
			verificationUrl: "https://www.google.com/device",
			expiresInSeconds: 1800,
			pollIntervalSeconds: 5,
		});
	});

	it("throws with Google's error description when the request is rejected", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_client", error_description: "Unknown client ID." }, 401)));
		await expect(requestDeviceCode("bad-client-id")).rejects.toThrow(/Unknown client ID/);
	});
});

describe("pollDeviceToken", () => {
	it("returns {status:\"pending\"} for an HTTP 428 response - the common case on nearly every poll", async () => {
		// This is THE test that a naive `res.ok` implementation breaks (§4.5 correction 1): Google's
		// normal "still waiting" response is a non-2xx status, not 200.
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "authorization_pending" }, 428)));
		const outcome = await pollDeviceToken("client-id", "client-secret", "device-code");
		expect(outcome).toEqual({ status: "pending" });
	});

	it("returns {status:\"authorized\", accessToken, refreshToken, expiresInSeconds} on a successful 200 response", async () => {
		// Google's device flow ALWAYS returns a refresh_token (confirmed in Google's own docs) - no
		// access_type=offline or other extra param needed, unlike the classic web flow.
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ access_token: "token-123", refresh_token: "refresh-abc", expires_in: 3600 })));
		const outcome = await pollDeviceToken("client-id", "client-secret", "device-code");
		expect(outcome).toEqual({ status: "authorized", accessToken: "token-123", refreshToken: "refresh-abc", expiresInSeconds: 3600 });
	});

	it("distinguishes slow_down from access_denied despite both sharing HTTP 403 (§4.5 correction 3)", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "slow_down" }, 403)));
		expect(await pollDeviceToken("client-id", "client-secret", "device-code")).toEqual({ status: "slowDown" });

		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "access_denied" }, 403)));
		expect(await pollDeviceToken("client-id", "client-secret", "device-code")).toEqual({ status: "denied" });
	});

	it("maps invalid_grant (400) to \"expired\", NOT RFC 8628's expired_token (§4.5 correction 2)", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)));
		expect(await pollDeviceToken("client-id", "client-secret", "device-code")).toEqual({ status: "expired" });
	});

	it("maps invalid_client (401) and admin_policy_enforced (400) to a distinct error message each", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_client", error_description: "Bad client type." }, 401)));
		expect(await pollDeviceToken("client-id", "client-secret", "device-code")).toEqual({ status: "error", message: "Bad client type." });

		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "admin_policy_enforced", error_description: "Blocked by admin." }, 400)));
		expect(await pollDeviceToken("client-id", "client-secret", "device-code")).toEqual({ status: "error", message: "Blocked by admin." });
	});

	it("returns {status:\"error\"} rather than throwing on a network failure", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
		const outcome = await pollDeviceToken("client-id", "client-secret", "device-code");
		expect(outcome.status).toBe("error");
	});

	it("returns {status:\"error\"} rather than throwing on an unparseable body", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError("not json"); } } as unknown as Response)));
		const outcome = await pollDeviceToken("client-id", "client-secret", "device-code");
		expect(outcome.status).toBe("error");
	});
});

describe("uploadBackup", () => {
	it("creates the backup root folder, the per-hostname folder, then uploads", async () => {
		const calls: Array<string> = [];
		vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
			if (url.includes("/files?q=")) { return jsonResponse({ files: [] }); } // no existing folder either time
			if (url.includes("/upload/drive/v3/files")) { return jsonResponse({ id: "file-1", webViewLink: "https://drive.google.com/x" }); }
			return jsonResponse({ id: "folder-id" });
		}));
		const result = await uploadBackup("token", "voron24", "backup.zip", new Blob(["zip"]));
		expect(result.fileId).toBe("file-1");
		expect(calls.filter((c) => c.startsWith("POST") && c.endsWith("googleapis.com/drive/v3/files"))).toHaveLength(2); // 2 folders created
	});

	it("reuses an existing folder instead of creating a duplicate", async () => {
		vi.stubGlobal("fetch", vi.fn(async (url: string) => {
			if (url.includes("/files?q=")) { return jsonResponse({ files: [{ id: "existing-folder", name: "x" }] }); }
			if (url.includes("/upload/")) { return jsonResponse({ id: "file-1" }); }
			throw new Error("should not create a folder when one already exists: " + url);
		}));
		const result = await uploadBackup("token", "voron24", "backup.zip", new Blob(["zip"]));
		expect(result.fileId).toBe("file-1");
	});
});

describe("refreshAccessToken", () => {
	it("returns a fresh access token from a valid refresh token", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ access_token: "new-token", expires_in: 3599 })));
		expect(await refreshAccessToken("client-id", "client-secret", "refresh-abc")).toEqual({ accessToken: "new-token", expiresInSeconds: 3599 });
	});

	it("returns null (not a throw) when the refresh token is rejected - caller falls back to the device flow", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)));
		expect(await refreshAccessToken("client-id", "client-secret", "revoked")).toBeNull();
	});

	it("returns null rather than throwing on a network failure", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
		expect(await refreshAccessToken("client-id", "client-secret", "refresh-abc")).toBeNull();
	});
});

// listMachineFolders/listBackups mirror Dropbox's own "absence isn't a failure" contract - a machine
// (or the whole backup root) that's never been backed up to this account is an empty list, not an error.
describe("listMachineFolders", () => {
	it("is empty when the backup root folder doesn't exist yet", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ files: [] })));
		expect(await listMachineFolders("token")).toEqual([]);
	});

	it("lists the machine subfolder names under the root", async () => {
		vi.stubGlobal("fetch", vi.fn(async (url: string) => {
			if (url.includes("Duet%20Config%20Backups")) { return jsonResponse({ files: [{ id: "root-id", name: "Duet Config Backups" }] }); }
			return jsonResponse({ files: [{ id: "f1", name: "voron24" }, { id: "f2", name: "ratrig" }] });
		}));
		expect(await listMachineFolders("token")).toEqual(["voron24", "ratrig"]);
	});

	// Regression: a `drive.file` re-consent (or a race) can leave two folders of the same name, and
	// without an explicit order upload and restore each picked "whatever Drive returned first" - which
	// could differ, so restore listed a different folder than the last backup was written to. The
	// folder lookup must ask Drive to order by createdTime (oldest first) so the choice is stable.
	it("asks Drive to order folder lookups by createdTime so a duplicate-named folder is resolved deterministically", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ files: [{ id: "oldest", name: "Duet Config Backups" }, { id: "newer", name: "Duet Config Backups" }] }));
		vi.stubGlobal("fetch", fetchMock);
		await listMachineFolders("token");
		// The first call is the root findFolder() - it must ask Drive to sort, so upload and restore
		// both land on the same (oldest) folder when more than one of the name exists.
		expect(fetchMock.mock.calls[0][0]).toContain("orderBy=createdTime");
	});
});

describe("listBackups", () => {
	it("is empty when the machine's folder doesn't exist yet", async () => {
		vi.stubGlobal("fetch", vi.fn(async (url: string) => {
			if (url.includes("Duet%20Config%20Backups")) { return jsonResponse({ files: [{ id: "root-id", name: "x" }] }); }
			return jsonResponse({ files: [] }); // machine folder lookup finds nothing
		}));
		expect(await listBackups("token", "voron24")).toEqual([]);
	});

	it("lists each backup's fileId/name/size/modifiedTime", async () => {
		let call = 0;
		vi.stubGlobal("fetch", vi.fn(async () => {
			call += 1;
			if (call === 1) { return jsonResponse({ files: [{ id: "root-id", name: "x" }] }); } // root folder
			if (call === 2) { return jsonResponse({ files: [{ id: "machine-id", name: "voron24" }] }); } // machine folder
			return jsonResponse({ files: [{ id: "file-1", name: "DuetBackup-config-voron24-20260101-120000.zip", size: "1234", modifiedTime: "2026-01-01T12:00:00Z" }] });
		}));
		expect(await listBackups("token", "voron24")).toEqual([
			{ fileId: "file-1", name: "DuetBackup-config-voron24-20260101-120000.zip", size: 1234, modifiedTime: "2026-01-01T12:00:00Z" },
		]);
	});
});

describe("downloadBackup", () => {
	it("returns the raw blob without trying to parse it as JSON", async () => {
		const blob = new Blob(["zip content"]);
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob } as unknown as Response)));
		expect(await downloadBackup("token", "file-1")).toBe(blob);
	});

	it("throws on a non-ok response", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 } as unknown as Response)));
		await expect(downloadBackup("token", "file-1")).rejects.toThrow(/404/);
	});
});

describe("deleteBackup", () => {
	it("succeeds silently on a 404 (already gone is the desired end state)", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 } as unknown as Response)));
		await expect(deleteBackup("token", "file-1")).resolves.toBeUndefined();
	});

	it("throws on a real error status", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 } as unknown as Response)));
		await expect(deleteBackup("token", "file-1")).rejects.toThrow(/500/);
	});
});
