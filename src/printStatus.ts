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
