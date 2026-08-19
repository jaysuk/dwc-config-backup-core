import { beforeEach, describe, expect, it } from "vitest";

import { importPlaintextCredentials, isNamespaceEncrypted, readPlaintextCredentials } from "../src/credentialsMigrate";
import {
	enableEncryption, getDropboxSettings, getDuetCloudSession, getGithubSettings,
	getGoogleDriveClientId, getWebDavSettings, resetForTests, setDropboxSettings,
	setDuetCloudSession, setGithubSettings, setGoogleDriveClientId, setWebDavSettings,
} from "../src/credentials";
import { configureHost, resetHostConfigForTests } from "../src/hostConfig";

const FULL_SOURCE_SETTINGS = {
	github: { token: "ghp_plain", repo: "user/repo", branch: "main" },
	dropbox: { token: "dbx_plain" },
	webdav: { url: "https://nas.example.com", username: "james", password: "hunter2" },
	googleDriveClientId: "client-id-123",
};

// Simulates two independently-bundled plugins sharing one browser's localStorage (the real scenario -
// each plugin's build embeds its own copy of this package with its own configureHost() singleton;
// the only thing they actually share at runtime is window.localStorage itself). Switching the active
// namespace via configureHost() between "source" and "dest" writes/reads faithfully mirrors that.
const SOURCE_NS = "duetConfigBackup";
const DEST_NS = "flexibleLayouts.configBackup";

beforeEach(() => {
	resetForTests();
	resetHostConfigForTests();
});

describe("isNamespaceEncrypted", () => {
	it("false when the source has never configured anything", () => {
		expect(isNamespaceEncrypted(SOURCE_NS)).toBe(false);
	});

	it("true once the source has enabled encryption", async () => {
		configureHost({ storageNamespace: SOURCE_NS });
		await enableEncryption("passphrase");
		expect(isNamespaceEncrypted(SOURCE_NS)).toBe(true);
	});
});

describe("readPlaintextCredentials", () => {
	it("null when the source has nothing stored at all", () => {
		expect(readPlaintextCredentials(SOURCE_NS)).toBeNull();
	});

	it("null when the source has its own encryption enabled - that's the SD/file path's job instead", async () => {
		configureHost({ storageNamespace: SOURCE_NS });
		setGithubSettings({ token: "ghp_plain", repo: "user/repo", branch: "main" });
		await enableEncryption("passphrase");
		expect(readPlaintextCredentials(SOURCE_NS)).toBeNull();
	});

	it("reads every plaintext credential stored under the source namespace", () => {
		configureHost({ storageNamespace: SOURCE_NS });
		setGithubSettings({ token: "ghp_plain", repo: "user/repo", branch: "main" });
		setDropboxSettings({ token: "dbx_plain" });
		setWebDavSettings({ url: "https://nas.example.com", username: "james", password: "hunter2" });
		setGoogleDriveClientId("client-id-123");
		const session = { token: "tok", username: "james", expiresAt: Date.now() + 100000 };
		setDuetCloudSession(session);

		const creds = readPlaintextCredentials(SOURCE_NS);
		expect(creds).toEqual({
			duetSession: session,
			github: { token: "ghp_plain", repo: "user/repo", branch: "main" },
			googleDriveClientId: "client-id-123",
			dropbox: { token: "dbx_plain" },
			webdav: { url: "https://nas.example.com", username: "james", password: "hunter2" },
		});
	});

	it("does not read from the currently-configured host's own namespace by accident - only the explicit source", () => {
		configureHost({ storageNamespace: DEST_NS });
		setGithubSettings({ token: "dest_own_token", repo: "dest/repo", branch: "main" });
		// Nothing was ever written under SOURCE_NS.
		expect(readPlaintextCredentials(SOURCE_NS)).toBeNull();
	});
});

describe("importPlaintextCredentials", () => {
	it("writes every credential through the destination's own setters, respecting its own encryption state", () => {
		// Source: standalone plugin, plaintext (no HTTPS).
		configureHost({ storageNamespace: SOURCE_NS });
		setGithubSettings(FULL_SOURCE_SETTINGS.github);
		setDropboxSettings(FULL_SOURCE_SETTINGS.dropbox);
		setWebDavSettings(FULL_SOURCE_SETTINGS.webdav);
		setGoogleDriveClientId(FULL_SOURCE_SETTINGS.googleDriveClientId);
		const creds = readPlaintextCredentials(SOURCE_NS)!;

		// Destination: Flexible Layouts, also unencrypted (same browser, same no-HTTPS situation).
		configureHost({ storageNamespace: DEST_NS });
		expect(getGithubSettings()).toBeNull();
		importPlaintextCredentials(creds);

		expect(getGithubSettings()).toEqual(FULL_SOURCE_SETTINGS.github);
		expect(getDropboxSettings()).toEqual(FULL_SOURCE_SETTINGS.dropbox);
		expect(getWebDavSettings()).toEqual(FULL_SOURCE_SETTINGS.webdav);
		expect(getGoogleDriveClientId()).toBe(FULL_SOURCE_SETTINGS.googleDriveClientId);
	});

	it("migrates a Duet cloud session token too", () => {
		configureHost({ storageNamespace: SOURCE_NS });
		const session = { token: "tok", username: "james", expiresAt: Date.now() + 100000 };
		setDuetCloudSession(session);
		const creds = readPlaintextCredentials(SOURCE_NS)!;

		configureHost({ storageNamespace: DEST_NS });
		expect(getDuetCloudSession()).toBeNull();
		importPlaintextCredentials(creds);
		expect(getDuetCloudSession()).toEqual(session);
	});

	it("leaves fields the source never had untouched on the destination, rather than clearing them", () => {
		configureHost({ storageNamespace: DEST_NS });
		setWebDavSettings({ url: "https://existing.example.com", username: "u", password: "p" });

		configureHost({ storageNamespace: SOURCE_NS });
		setGithubSettings({ token: "ghp_plain", repo: "user/repo", branch: "main" });
		const creds = readPlaintextCredentials(SOURCE_NS)!;

		configureHost({ storageNamespace: DEST_NS });
		importPlaintextCredentials(creds);

		expect(getGithubSettings()).toEqual({ token: "ghp_plain", repo: "user/repo", branch: "main" });
		// webdav was never part of the source's credentials, so the destination's own existing value survives.
		expect(getWebDavSettings()).toEqual({ url: "https://existing.example.com", username: "u", password: "p" });
	});

	it("does not clear an existing destination value when the source never had that field at all", () => {
		configureHost({ storageNamespace: DEST_NS });
		setGithubSettings({ token: "keep-me", repo: "user/repo", branch: "main" });

		configureHost({ storageNamespace: SOURCE_NS });
		setDropboxSettings({ token: "dbx_plain" }); // source has SOMETHING, just not github
		const creds = readPlaintextCredentials(SOURCE_NS)!;

		configureHost({ storageNamespace: DEST_NS });
		importPlaintextCredentials(creds);

		expect(getGithubSettings()).toEqual({ token: "keep-me", repo: "user/repo", branch: "main" });
		expect(getDropboxSettings()).toEqual({ token: "dbx_plain" });
	});
});
