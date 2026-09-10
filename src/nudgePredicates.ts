/**
 * Pure decision logic for the automatic backup reminders.
 *
 * Only the predicates live here. The wiring that turns them into actual toasts - subscribing to
 * DWC's `fileUploaded` event, watching connection state, calling the UI store's log/notification API
 * and routing the click-through - is host-specific (Pinia + `Events` on DWC 3.7, Vuex +
 * `makeNotification` on 3.6) and stays in the host plugin.
 *
 * These are reminders, never silent uploads or downloads. There is no true background/scheduled
 * trigger available to a browser-only plugin: every nudge can only fire while DWC is open in a tab,
 * the same constraint as the rest of this feature.
 */

export function isBackupOverdue(lastBackupAt: string | null, thresholdDays: number, now: number = Date.now()): boolean {
	if (!lastBackupAt) { return true; }
	const ageMs = now - new Date(lastBackupAt).getTime();
	return ageMs >= thresholdDays * 24 * 60 * 60 * 1000;
}

/** Only "unseen" once at least one backup has been taken for *some* machine - a completely fresh
 * install (no backup history at all) is covered by the overdue nudge instead, so the two don't both
 * fire on first connect. */
export function isUnseenMachine(machineKey: string, knownMachineKeys: ReadonlySet<string>): boolean {
	return knownMachineKeys.size > 0 && !knownMachineKeys.has(machineKey);
}

/** Suggested minimum gap between two "config.g was saved" nudges, so actively editing a file doesn't
 * produce a toast per save. Hosts enforce this - it's advisory, not applied here. */
export const CONFIG_SAVE_COOLDOWN_MS = 5 * 60 * 1000;

/** Once an automatic backup has failed this many times in a row, the failure alert copy escalates
 * from a one-off "it failed" to "it keeps failing - check the connection settings"
 * (SCHEDULED-BACKUPS-PLAN.md §4.4 item 3). A destination with an expired token fails identically on
 * every connect, so repeating the same toast indefinitely trains the user to ignore it. */
export const FAILURE_ESCALATION_THRESHOLD = 3;

/** Whether a run of `consecutiveFailures` failed backup attempts (see `getBackupFailureStreak`) has
 * reached the point where the alert should tell the user something is persistently wrong rather than
 * just reporting one more failure. Pure - the host decides what to do with the answer. */
export function shouldEscalateBackupFailureAlert(
	consecutiveFailures: number, threshold: number = FAILURE_ESCALATION_THRESHOLD,
): boolean {
	return consecutiveFailures >= threshold;
}
