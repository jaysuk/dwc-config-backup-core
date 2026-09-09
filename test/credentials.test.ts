import { beforeEach, describe, expect, it } from "vitest";

import {
	addBackedUpMachineKey, addRedactionExclusion, getAutoBackupNudgeSettings, getBackedUpMachineKeys,
	getDuetCloudFifoLimit, getEncryptPreference, getGoogleDriveSettings, getLastBackupAt, getLastBackupAttempt,
	getRedactionExclusions, getRedactPreference, hasAcknowledgedUnredacted, ls, removeRedactionExclusion,
	resetForTests, setAcknowledgedUnredacted, setAutoBackupNudgeSettings, setDuetCloudFifoLimit,
	setEncryptPreference, setGoogleDriveSettings, setLastBackupAt, setLastBackupAttempt, setRedactPreference,
} from "../src/credentials";
import { configureHost, resetHostConfigForTests } from "../src/hostConfig";

beforeEach(() => {
	resetForTests();
	resetHostConfigForTests();
});

describe("per-destination redact preference", () => {
	it("defaults to off for every destination", () => {
		expect(getRedactPreference("local")).toBe(false);
		expect(getRedactPreference("duet")).toBe(false);
	});

	it("remembers a per-destination choice independently", () => {
		setRedactPreference("duet", true);
		expect(getRedactPreference("duet")).toBe(true);
		expect(getRedactPreference("local")).toBe(false);
	});
});

describe("per-destination encrypt preference (ENCRYPTED-BACKUPS-PLAN.md §5.9)", () => {
	it("defaults to off for every destination, including local", () => {
		expect(getEncryptPreference("local")).toBe(false);
		expect(getEncryptPreference("github")).toBe(false);
	});

	it("remembers a per-destination choice independently, and independently of redact", () => {
		setEncryptPreference("github", true);
		expect(getEncryptPreference("github")).toBe(true);
		expect(getEncryptPreference("local")).toBe(false);
		expect(getRedactPreference("github")).toBe(false);
	});
});

describe("unredacted-destination acknowledgement", () => {
	it("defaults to not acknowledged", () => {
		expect(hasAcknowledgedUnredacted("github")).toBe(false);
	});
	it("remembers acknowledgement per destination", () => {
		setAcknowledgedUnredacted("github");
		expect(hasAcknowledgedUnredacted("github")).toBe(true);
		expect(hasAcknowledgedUnredacted("drive")).toBe(false);
	});
});

describe("Duet cloud FIFO limit", () => {
	it("defaults to 5", () => {
		expect(getDuetCloudFifoLimit()).toBe(5);
	});
	it("persists a custom limit", () => {
		setDuetCloudFifoLimit(10);
		expect(getDuetCloudFifoLimit()).toBe(10);
	});
});

describe("last backup timestamp", () => {
	it("defaults to null", () => {
		expect(getLastBackupAt()).toBeNull();
	});
	it("persists an ISO timestamp", () => {
		setLastBackupAt("2026-01-01T00:00:00.000Z");
		expect(getLastBackupAt()).toBe("2026-01-01T00:00:00.000Z");
	});
});

describe("last backup attempt (SCHEDULED-BACKUPS-PLAN.md §4.4)", () => {
	it("defaults to null", () => {
		expect(getLastBackupAttempt()).toBeNull();
	});
	it("persists a successful attempt", () => {
		setLastBackupAttempt({ at: "2026-01-01T00:00:00.000Z", ok: true, destination: "github" });
		expect(getLastBackupAttempt()).toEqual({ at: "2026-01-01T00:00:00.000Z", ok: true, destination: "github" });
	});
	it("persists a failed attempt with a message", () => {
		setLastBackupAttempt({ at: "2026-01-02T00:00:00.000Z", ok: false, destination: "dropbox", message: "401 Unauthorized" });
		expect(getLastBackupAttempt()).toEqual({ at: "2026-01-02T00:00:00.000Z", ok: false, destination: "dropbox", message: "401 Unauthorized" });
	});
	it("is independent of the success-only lastBackupAt - a failed attempt does not touch it", () => {
		setLastBackupAt("2026-01-01T00:00:00.000Z");
		setLastBackupAttempt({ at: "2026-01-05T00:00:00.000Z", ok: false, destination: "webdav", message: "network error" });
		expect(getLastBackupAt()).toBe("2026-01-01T00:00:00.000Z");
		expect(getLastBackupAttempt()).toEqual({ at: "2026-01-05T00:00:00.000Z", ok: false, destination: "webdav", message: "network error" });
	});
	it("the latest call wins - only one attempt is remembered", () => {
		setLastBackupAttempt({ at: "2026-01-01T00:00:00.000Z", ok: false, destination: "github", message: "boom" });
		setLastBackupAttempt({ at: "2026-01-02T00:00:00.000Z", ok: true, destination: "github" });
		expect(getLastBackupAttempt()).toEqual({ at: "2026-01-02T00:00:00.000Z", ok: true, destination: "github" });
	});
});

describe("backed-up machine keys", () => {
	it("defaults to empty", () => {
		expect(getBackedUpMachineKeys()).toEqual([]);
	});
	it("accumulates distinct keys without duplicates", () => {
		addBackedUpMachineKey("machine-a");
		addBackedUpMachineKey("machine-b");
		addBackedUpMachineKey("machine-a");
		expect(getBackedUpMachineKeys().sort()).toEqual(["machine-a", "machine-b"]);
	});
});

describe("redaction exclusions", () => {
	it("defaults to empty", () => {
		expect(getRedactionExclusions()).toEqual([]);
	});
	it("accumulates distinct names without duplicates, lowercased", () => {
		addRedactionExclusion("maxPass");
		addRedactionExclusion("pass");
		addRedactionExclusion("MAXPASS");
		expect(getRedactionExclusions().sort()).toEqual(["maxpass", "pass"]);
	});
	it("removes a name", () => {
		addRedactionExclusion("pass");
		addRedactionExclusion("maxpass");
		removeRedactionExclusion("PASS");
		expect(getRedactionExclusions()).toEqual(["maxpass"]);
	});
	it("removing a name that isn't excluded is a no-op", () => {
		addRedactionExclusion("pass");
		removeRedactionExclusion("nope");
		expect(getRedactionExclusions()).toEqual(["pass"]);
	});
});

describe("Google Drive settings (GOOGLE-DRIVE-DEVICE-FLOW-PLAN.md §4.2)", () => {
	it("defaults to null", () => {
		expect(getGoogleDriveSettings()).toBeNull();
	});

	it("persists a clientId/clientSecret pair", () => {
		setGoogleDriveSettings({ clientId: "id-1", clientSecret: "secret-1" });
		expect(getGoogleDriveSettings()).toEqual({ clientId: "id-1", clientSecret: "secret-1" });
	});

	it("removes the orphaned old drive.clientId key the first time the new settings are written", () => {
		// Simulate a pre-existing install that had the old GIS flow's bare client-ID key sitting in
		// localStorage - it must never be read by anything any more, but it should also not just be
		// left behind forever (§4.2: "the orphaned drive.clientId entry should be actively removed").
		configureHost({ storageNamespace: "flexibleLayouts.configBackup" });
		ls()?.setItem("flexibleLayouts.configBackup.drive.clientId", JSON.stringify("old-web-client-id"));

		setGoogleDriveSettings({ clientId: "id-1", clientSecret: "secret-1" });

		expect(ls()?.getItem("flexibleLayouts.configBackup.drive.clientId")).toBeNull();
	});
});

describe("automatic backup nudge settings", () => {
	it("defaults to all triggers on with a 7-day overdue threshold", () => {
		expect(getAutoBackupNudgeSettings()).toEqual({ configSaved: true, overdue: true, overdueDays: 7, newMachine: true });
	});
	it("persists a custom configuration", () => {
		setAutoBackupNudgeSettings({ configSaved: false, overdue: true, overdueDays: 14, newMachine: false });
		expect(getAutoBackupNudgeSettings()).toEqual({ configSaved: false, overdue: true, overdueDays: 14, newMachine: false });
	});
});
