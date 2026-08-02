/**
 * Build a MachineIdentity / live-directories view from the (loosely-typed, externally-owned) object
 * model. Kept in one place so BackupCreatePanel / RestorePanel / CloudPanel agree on the mapping.
 */
import type { MachineIdentity } from "./archive.js";
import { DEFAULT_DIR_PATH } from "./constants.js";
import type { BackupDirKind } from "./constants.js";
import type { ManifestBoard } from "./types.js";
import { cyrb53 } from "./hash.js";

interface LooseBoard {
	canAddress?: number | null;
	shortName?: string;
	firmwareVersion?: string;
	firmwareName?: string;
	name?: string;
	uniqueId?: string | null;
}

export function buildMachineIdentity(model: unknown): MachineIdentity {
	const m = model as { boards?: Array<LooseBoard>; network?: { hostname?: string; name?: string } } | undefined;
	const boards = Array.isArray(m?.boards) ? m!.boards! : [];
	const mapped: Array<ManifestBoard> = boards.map((b) => ({
		canAddress: b?.canAddress ?? null,
		shortName: b?.shortName ?? "",
		firmwareVersion: b?.firmwareVersion ?? "",
		uniqueId: b?.uniqueId ?? null,
	}));
	const main = boards[0];
	return {
		hostname: m?.network?.hostname ?? "",
		name: m?.network?.name ?? "",
		firmwareName: main?.firmwareName ?? "",
		firmwareVersion: main?.firmwareVersion ?? "",
		electronics: main?.name ?? "",
		boards: mapped,
	};
}

/**
 * Short, stable, path-safe suffix derived from a machine's real hardware key (see
 * `computeMachineKey` in archive.ts). Appended to hostname-based destination folders/paths
 * (GitHub/Dropbox/WebDAV) by default so two machines that happen to share a hostname - a mainboard
 * swap that kept the old name, two boards both left on a firmware default, or plain coincidence -
 * don't collide in the same folder.
 *
 * The Duet Cloud service doesn't need this: it's already keyed by the real hardware GUID
 * (`boardGuid` in destinations/duetCloud.ts), with hostname carried along purely as a display label.
 * GitHub/Dropbox/WebDAV instead use a human-readable path as the actual storage key, so the
 * disambiguator has to live in the path itself.
 */
export function machineFolderSuffix(machineKey: string): string {
	return cyrb53(machineKey).slice(0, 6);
}

/**
 * Default machine folder/path name: `<hostname>-<suffix>`. Callers that offer an explicit override
 * (e.g. GitHub's "Machine name" setting) should use that verbatim instead of this - a user who
 * deliberately named their folder gets exactly that name, with no suffix appended on top; the
 * suffix is only for the un-overridden, hostname-derived default.
 */
export function defaultMachineFolder(hostname: string, machineKey: string): string {
	const safeHost = (hostname || "machine").replace(/[^A-Za-z0-9._-]/g, "-");
	return `${safeHost}-${machineFolderSuffix(machineKey)}`;
}

export function buildLiveDirectories(model: unknown): Record<BackupDirKind, string> {
	const m = model as { directories?: Partial<Record<BackupDirKind, string>> } | undefined;
	return {
		system: m?.directories?.system ?? DEFAULT_DIR_PATH.system,
		macros: m?.directories?.macros ?? DEFAULT_DIR_PATH.macros,
		filaments: m?.directories?.filaments ?? DEFAULT_DIR_PATH.filaments,
	};
}
