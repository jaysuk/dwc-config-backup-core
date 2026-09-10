import { describe, expect, it } from "vitest";

import { FAILURE_ESCALATION_THRESHOLD, isBackupOverdue, isUnseenMachine, shouldEscalateBackupFailureAlert } from "../src/nudgePredicates";
import { isMachineIdle } from "../src/printStatus";

describe("isBackupOverdue", () => {
	const now = new Date("2026-01-08T00:00:00.000Z").getTime();

	it("is overdue when there has never been a backup", () => {
		expect(isBackupOverdue(null, 7, now)).toBe(true);
	});
	it("is not overdue when the last backup is within the threshold", () => {
		expect(isBackupOverdue("2026-01-05T00:00:00.000Z", 7, now)).toBe(false);
	});
	it("is overdue once the threshold has elapsed", () => {
		expect(isBackupOverdue("2026-01-01T00:00:00.000Z", 7, now)).toBe(true);
	});
	it("is exactly at the boundary when the age equals the threshold", () => {
		expect(isBackupOverdue("2026-01-01T00:00:00.000Z", 7, now)).toBe(true);
	});
});

describe("isUnseenMachine", () => {
	it("is never unseen when nothing has ever been backed up (covered by the overdue nudge instead)", () => {
		expect(isUnseenMachine("machine-a", new Set())).toBe(false);
	});
	it("is unseen when other machines have backups but this one doesn't", () => {
		expect(isUnseenMachine("machine-a", new Set(["machine-b", "machine-c"]))).toBe(true);
	});
	it("is not unseen once this machine has a backup on record", () => {
		expect(isUnseenMachine("machine-a", new Set(["machine-a", "machine-b"]))).toBe(false);
	});
});

describe("shouldEscalateBackupFailureAlert", () => {
	it("does not escalate for a first failure", () => {
		expect(shouldEscalateBackupFailureAlert(1)).toBe(false);
	});
	it("does not escalate below the threshold", () => {
		expect(shouldEscalateBackupFailureAlert(FAILURE_ESCALATION_THRESHOLD - 1)).toBe(false);
	});
	it("escalates once the streak reaches the threshold", () => {
		expect(shouldEscalateBackupFailureAlert(FAILURE_ESCALATION_THRESHOLD)).toBe(true);
		expect(shouldEscalateBackupFailureAlert(FAILURE_ESCALATION_THRESHOLD + 5)).toBe(true);
	});
	it("never escalates for a streak of 0 (the state after any success)", () => {
		expect(shouldEscalateBackupFailureAlert(0)).toBe(false);
	});
});

describe("isMachineIdle - the auto-run gate (SCHEDULED-BACKUPS-PLAN.md §4.3 step 3)", () => {
	it("is true only for exactly 'idle'", () => {
		expect(isMachineIdle("idle")).toBe(true);
	});
	it("is false for every busy/print/transitional state and for undefined", () => {
		for (const s of ["processing", "paused", "pausing", "resuming", "busy", "changingTool", "updating", "halted", "off", undefined]) {
			expect(isMachineIdle(s)).toBe(false);
		}
	});
});
