import { afterEach, describe, expect, it, vi } from "vitest";

import { pollDeviceToken, requestDeviceCode, uploadBackup } from "../src/destinations/googleDrive";

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

	it("returns {status:\"authorized\", accessToken} on a successful 200 response", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ access_token: "token-123", expires_in: 3600 })));
		const outcome = await pollDeviceToken("client-id", "client-secret", "device-code");
		expect(outcome).toEqual({ status: "authorized", accessToken: "token-123" });
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
