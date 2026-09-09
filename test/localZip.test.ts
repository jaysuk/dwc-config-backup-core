import { describe, expect, it } from "vitest";

import { backupFilename } from "../src/destinations/localZip";

// Regression coverage for a naming convention shared by all three consuming plugins (Flexible
// Layouts, duet-config-backup-plugin, duet-config-backup-plugin-3.6) - requested by Duet3D so a
// downloaded backup's filename identifies the FEATURE, not whichever specific host plugin produced it.
describe("backupFilename", () => {
	it("uses the DuetBackup-config prefix (not a host-specific plugin name)", () => {
		expect(backupFilename("my-printer", new Date(2026, 0, 5, 9, 3, 7))).toBe("DuetBackup-config-my-printer-20260105-090307.zip");
	});

	it("sanitises hostname characters that aren't safe in a filename", () => {
		expect(backupFilename("my printer.local!", new Date(2026, 0, 5, 9, 3, 7))).toBe("DuetBackup-config-my_printer_local_-20260105-090307.zip");
	});

	it("falls back to 'machine' for an empty/fully-unsafe hostname", () => {
		expect(backupFilename("", new Date(2026, 0, 5, 9, 3, 7))).toBe("DuetBackup-config-machine-20260105-090307.zip");
	});

	it("zero-pads the date/time stamp", () => {
		expect(backupFilename("host", new Date(2026, 0, 1, 1, 2, 3))).toBe("DuetBackup-config-host-20260101-010203.zip");
	});

	it("defaults to the current time when no date is given", () => {
		const before = Date.now();
		const name = backupFilename("host");
		const after = Date.now();
		const match = /^DuetBackup-config-host-(\d{8})-(\d{6})\.zip$/.exec(name);
		expect(match).not.toBeNull();
		const [, ymd, hms] = match!;
		const parsed = new Date(
			Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)),
			Number(hms.slice(0, 2)), Number(hms.slice(2, 4)), Number(hms.slice(4, 6)),
		);
		expect(parsed.getTime()).toBeGreaterThanOrEqual(before - 1000);
		expect(parsed.getTime()).toBeLessThanOrEqual(after + 1000);
	});
});
