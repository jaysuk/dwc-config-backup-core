/**
 * Machine-status check used by restore.ts to refuse writing files mid-print.
 *
 * Extracted from Flexible Layouts' `util/printLock.ts`, which also carries per-widget lock defaults
 * typed against FL's own `Widget` union - that half is host UI concern and stays there. Only the
 * status predicate is shared.
 */

/** Machine statuses that count as an active print session (mirrors DWC's isPrinting, incl. paused). */
export const PRINTING_STATUSES: ReadonlySet<string> = new Set([
	"pausing", "paused", "cancelling", "resuming", "processing", "simulating",
]);

export function isPrintingStatus(status?: string): boolean {
	return !!status && PRINTING_STATUSES.has(status);
}

/** Strictly "sitting there doing nothing" - the only state in which an opportunistic auto-backup
 * (SCHEDULED-BACKUPS-PLAN.md §4.3 step 3) should start walking the machine's filesystem. Deliberately
 * stricter than `!isPrintingStatus(...)`: "busy" (running a macro), "changingTool", "updating" etc.
 * are all moments the machine - or the user - is mid-task, so an auto-run defers to the nudge instead.
 * §9 Q3 settled on strictly-idle as the safe default. */
export function isMachineIdle(status?: string): boolean {
	return status === "idle";
}
