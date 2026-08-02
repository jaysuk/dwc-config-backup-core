import { describe, expect, it } from "vitest";

import { defaultMachineFolder, machineFolderSuffix } from "../src/machineIdentity";

describe("machineFolderSuffix", () => {
	it("is deterministic for the same key", () => {
		expect(machineFolderSuffix("D0043-0N1KL-DA3T4-7NTDS-WBGTT-70000")).toBe(machineFolderSuffix("D0043-0N1KL-DA3T4-7NTDS-WBGTT-70000"));
	});
	it("differs for different keys", () => {
		expect(machineFolderSuffix("guid-a")).not.toBe(machineFolderSuffix("guid-b"));
	});
	it("is short (a disambiguator, not a full hash)", () => {
		expect(machineFolderSuffix("guid-a").length).toBeLessThanOrEqual(6);
	});
});

describe("defaultMachineFolder", () => {
	it("appends the suffix to the hostname", () => {
		const folder = defaultMachineFolder("voron24", "guid-a");
		expect(folder).toBe(`voron24-${machineFolderSuffix("guid-a")}`);
	});

	// The whole point: two machines that happen to share a hostname (mainboard swap that kept the old
	// name, two boards left on a firmware default, plain coincidence) must not collide in the same
	// GitHub/Dropbox/WebDAV/Drive folder, since those destinations key by path, not hardware GUID.
	it("gives two machines with the same hostname different folders", () => {
		const folderA = defaultMachineFolder("voron24", "guid-a");
		const folderB = defaultMachineFolder("voron24", "guid-b");
		expect(folderA).not.toBe(folderB);
	});

	it("falls back to a generic name for an empty hostname", () => {
		expect(defaultMachineFolder("", "guid-a")).toBe(`machine-${machineFolderSuffix("guid-a")}`);
	});

	it("sanitises path-unsafe characters in the hostname", () => {
		expect(defaultMachineFolder("my printer/../etc", "guid-a")).toBe(`my-printer-..-etc-${machineFolderSuffix("guid-a")}`);
	});

	it("is deterministic - the same machine always gets the same folder", () => {
		expect(defaultMachineFolder("voron24", "guid-a")).toBe(defaultMachineFolder("voron24", "guid-a"));
	});
});
