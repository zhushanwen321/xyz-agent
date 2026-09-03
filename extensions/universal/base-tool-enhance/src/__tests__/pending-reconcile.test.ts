// src/__tests__/pending-reconcile.test.ts —— M3 session_start 对账单元（§3.5 接入细则 4）：
// 差集收集 / 三类僵尸场景 appendEntry 权威路径 + 尽力 emit / 活任务与缺条目保守跳过
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	collectUnsettledTaskIds,
	reconcilePendingEntries,
	type ReconcilePi,
} from "../background/pending-reconcile.ts";
import { getRegistryPath, writeRegistryEntry } from "../background/registry.ts";
import type { RegistryEntry } from "../background/types.ts";

const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-reconcile-"));
const SESSION_ID = "sess-reconcile";

function createMockPi(overrides: Partial<Pick<ReconcilePi, "appendEntry">> = {}): ReconcilePi {
	return {
		appendEntry: vi.fn(),
		events: { emit: vi.fn() },
		...overrides,
	};
}

function makeRegistryEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
	return {
		taskId: "bt-1700000000-zomb01",
		pid: 99999,
		command: "sleep 3600",
		outputFile: "/tmp/out.log",
		startedAt: 1_700_000_000_000,
		state: "orphaned",
		ownerPiPid: 1,
		sessionId: SESSION_ID,
		...overrides,
	};
}

/** 已死 pid：spawnSync 同步等待退出 + libuv reap，返回时 pid 必已终止。 */
function deadPid(): number {
	const result = spawnSync("true");
	if (result.pid === undefined) throw new Error("no pid acquired for dead-pid probe");
	return result.pid;
}

function registerEntry(id: string) {
	return { customType: "pending:register", data: { id, type: "bash", name: "sleep 3600" } };
}

afterEach(() => {
	rmSync(DATA_DIR, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("collectUnsettledTaskIds (bt- prefixed register/unregister diff)", () => {
	it("collects bt- registers without a matching unregister", () => {
		const ids = collectUnsettledTaskIds([
			registerEntry("bt-a"),
			registerEntry("bt-b"),
			{ customType: "pending:unregister", data: { id: "bt-b", reason: "completed" } },
		]);
		expect([...ids]).toEqual(["bt-a"]);
	});

	it("ignores non-bt ids (subagent bg-/run- namespace not ours)", () => {
		const ids = collectUnsettledTaskIds([
			registerEntry("bg-1"),
			registerEntry("run-x-1"),
			registerEntry("bt-a"),
		]);
		expect([...ids]).toEqual(["bt-a"]);
	});

	it("dedupes repeated registers and tolerates malformed entries", () => {
		const ids = collectUnsettledTaskIds([
			null,
			undefined,
			{ customType: "pending:register" }, // data 缺失
			{ customType: "pending:register", data: { id: 42 } }, // id 非字符串
			registerEntry("bt-a"),
			registerEntry("bt-a"),
			{ customType: "other" },
		]);
		expect([...ids]).toEqual(["bt-a"]);
	});
});

describe("reconcile scenario ①: graceful-exit leftover (registry exited, entry never written)", () => {
	it("appends pending:unregister {id, reason, status} matching pending-notifications entry shape + best-effort emit", () => {
		const entry = makeRegistryEntry({
			taskId: "bt-1700000000-zomb01",
			state: "exited",
			reason: "natural",
			exitCode: 0,
		});
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(result.reconciled).toBe(1);
		// 落盘形态逐字段对齐 pending-notifications index.ts unregister listener：{id, reason, status}
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "completed",
			status: "completed",
		});
		// emit 形态 {id, reason}（status 由 listener mapReasonToStatus 计算）
		expect(pi.events.emit).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "completed",
		});
	});

	it("maps exited reason/exitCode through the same mapping as the exit edge", () => {
		const cases: Array<[RegistryEntry, string]> = [
			[makeRegistryEntry({ state: "exited", reason: "natural", exitCode: 3 }), "failed"],
			[makeRegistryEntry({ state: "exited", reason: "timeout", exitCode: null }), "time_limited"],
			[makeRegistryEntry({ state: "exited", reason: "killed", exitCode: null }), "cancelled"],
			[makeRegistryEntry({ state: "exited", reason: "process-exit", exitCode: null }), "cancelled"],
		];
		for (const [entry, expectedReason] of cases) {
			writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
			const pi = createMockPi();
			reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);
			expect(pi.appendEntry).toHaveBeenCalledWith(
				"pending:unregister",
				{ id: entry.taskId, reason: expectedReason, status: expectedReason },
			);
		}
	});
});

describe("reconcile scenario ②: collector-only orphan (registry orphaned, session file untouched)", () => {
	it("appends unregister with cancelled for orphaned entries", () => {
		const entry = makeRegistryEntry({ state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(result.reconciled).toBe(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "cancelled",
			status: "cancelled",
		});
	});
});

describe("reconcile scenario ③: running entry whose pid is already dead (fact-terminal)", () => {
	it("appends unregister with cancelled when kill(pid,0) says dead", () => {
		const entry = makeRegistryEntry({ state: "running", pid: deadPid() });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(result.reconciled).toBe(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("pending:unregister", {
			id: entry.taskId,
			reason: "cancelled",
			status: "cancelled",
		});
	});
});

describe("conservative no-op paths", () => {
	it("running entry with LIVE pid is not settled (D12 task survives session replacement)", () => {
		const entry = makeRegistryEntry({ state: "running", pid: process.pid }); // 当前测试进程 = 活 pid
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();

		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry(entry.taskId)]);

		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual([entry.taskId]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("registry has no entry for the id → skip (terminal state unverifiable)", () => {
		const pi = createMockPi();
		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [registerEntry("bt-unknown")]);
		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual(["bt-unknown"]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("entries with no bt- register → early no-op", () => {
		const pi = createMockPi();
		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			{ customType: "pending:register", data: { id: "bg-1", type: "subagent" } },
			{ customType: "user" },
		]);
		expect(result.reconciled).toBe(0);
		expect(result.skipped).toEqual([]);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("unsettled set empty (unregister already present) → no-op", () => {
		const entry = makeRegistryEntry({ state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), entry);
		const pi = createMockPi();
		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			registerEntry(entry.taskId),
			{ customType: "pending:unregister", data: { id: entry.taskId, reason: "cancelled" } },
		]);
		expect(result.reconciled).toBe(0);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
});

describe("appendEntry failure tolerance", () => {
	it("one appendEntry throw does not block the remaining zombie (count only successful)", () => {
		const first = makeRegistryEntry({ taskId: "bt-1700000000-zomb01", state: "orphaned" });
		const second = makeRegistryEntry({ taskId: "bt-1700000000-zomb02", state: "orphaned" });
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), first);
		writeRegistryEntry(getRegistryPath(DATA_DIR, SESSION_ID), second);
		const appendEntry = vi.fn((customType: string, data?: unknown) => {
			if ((data as { id: string }).id === first.taskId) throw new Error("append failed");
		});
		const pi = createMockPi({ appendEntry });

		const result = reconcilePendingEntries(pi, DATA_DIR, SESSION_ID, [
			registerEntry(first.taskId),
			registerEntry(second.taskId),
		]);

		expect(appendEntry).toHaveBeenCalledTimes(2);
		expect(result.reconciled).toBe(1); // 仅第二条成功计数
		expect(result.skipped).toEqual([]);
	});
});
