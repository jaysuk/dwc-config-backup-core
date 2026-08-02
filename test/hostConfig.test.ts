import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	ALWAYS_PROTECTED, configureHost, getHostConfig, isProtectedFile, resetHostConfigForTests,
} from "../src/hostConfig";
import { getGithubSettings, resetForTests, setGithubSettings } from "../src/credentials";

beforeEach(() => {
	resetHostConfigForTests();
	resetForTests();
});
afterEach(() => {
	resetHostConfigForTests();
	resetForTests();
});

describe("defaults", () => {
	// These are frozen for backward compatibility: an existing Flexible Layouts install already has
	// credentials under this namespace, so changing the default would silently orphan them.
	it("keeps the legacy Flexible Layouts storage namespace", () => {
		expect(getHostConfig().storageNamespace).toBe("flexibleLayouts.configBackup");
	});
	it("adds no host-specific protected files until configured", () => {
		expect(getHostConfig().protectedFiles.size).toBe(0);
	});
});

describe("configureHost", () => {
	it("applies a partial patch without clearing the other field", () => {
		configureHost({ storageNamespace: "myPlugin.backup" });
		expect(getHostConfig().storageNamespace).toBe("myPlugin.backup");
		expect(getHostConfig().protectedFiles.size).toBe(0);

		configureHost({ protectedFiles: new Set(["my-plugin.state.json"]) });
		expect(getHostConfig().storageNamespace).toBe("myPlugin.backup"); // not reset by the second call
		expect(getHostConfig().protectedFiles.has("my-plugin.state.json")).toBe(true);
	});
});

describe("isProtectedFile", () => {
	it("protects the always-protected plugin state files with no configuration at all", () => {
		for (const f of ALWAYS_PROTECTED) {
			expect(isProtectedFile(f)).toBe(true);
		}
	});

	it("protects host additions on top of the always-protected set", () => {
		configureHost({ protectedFiles: new Set(["other-plugin.state.json"]) });
		expect(isProtectedFile("other-plugin.state.json")).toBe(true);
	});

	// The reason ALWAYS_PROTECTED exists rather than being purely host-supplied: a machine may have
	// been managed by a different host before, and a Mirror restore run from one host must not wipe
	// the other's saved layout/credentials.
	it("still protects another host's state files after a host configures its own", () => {
		configureHost({ protectedFiles: new Set(["other-plugin.state.json"]) });
		expect(isProtectedFile("flexible-layouts.backup.json")).toBe(true);
		expect(isProtectedFile("flexible-layouts.credentials.json")).toBe(true);
	});

	it("does not protect an ordinary config file", () => {
		expect(isProtectedFile("config.g")).toBe(false);
		expect(isProtectedFile("homeall.g")).toBe(false);
	});
});

describe("storage namespace is honoured by credentials", () => {
	// Asserted by round-trip through the module's own API rather than by reading a raw localStorage
	// key: in this environment `window.localStorage` exists but is non-functional, so credentials.ts
	// transparently falls back to an in-memory store (see its `ls()` helper). Poking localStorage
	// directly would test the environment, not the namespacing.
	//
	// The round-trip below is the stronger assertion anyway - it can only pass if the key is actually
	// namespaced. If configureHost() merely reset state, switching back to host A would return
	// undefined rather than recovering "tok-a".
	//
	// The namespace is read through a function on every access rather than captured in a module-level
	// const, so a host calling configureHost() after credentials.ts was first imported still gets its
	// own namespace. This test would fail if that were ever refactored back to a const.
	it("isolates two hosts sharing one browser origin", () => {
		configureHost({ storageNamespace: "hostA.backup" });
		setGithubSettings({ token: "tok-a", repo: "a/a", branch: "main", machineName: "" });

		configureHost({ storageNamespace: "hostB.backup" });
		expect(getGithubSettings()?.token).toBeUndefined();

		setGithubSettings({ token: "tok-b", repo: "b/b", branch: "main", machineName: "" });
		expect(getGithubSettings()?.token).toBe("tok-b");

		// switching back must still see host A's value, not host B's
		configureHost({ storageNamespace: "hostA.backup" });
		expect(getGithubSettings()?.token).toBe("tok-a");
	});
});
