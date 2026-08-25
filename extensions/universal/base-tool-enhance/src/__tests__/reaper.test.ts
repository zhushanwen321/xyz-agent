// src/__tests__/reaper.test.ts —— M5 reaper 孤儿收殓：三分支判定（属主活跳过 /
// 属主死+任务活补杀 / 属主死+任务死终态收尾）+ pid 复用防御（start-time 匹配）+
// 保守跳过路径 + file-lock 并发串行化 + 损坏目录容忍 + 多目录扫描 + 幂等。
// 全程真进程（detached spawn——与生产 spawn 路径同构：pgid=pid，kill-tree 杀
// 进程组不会波及测试进程组），无 mock getAgentDir（reaper 直收 dataDir 参数）。
// 每用例独立 dataDir：残留 running 条目（afterEach 杀掉的进程）不污染后续用例
// 的分支计数断言。
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20000 });

import { getRegistryPath, readRegistry, writeRegistryEntry } from "../background/registry.ts";
import type { RegistryEntry } from "../background/types.ts";
import { isPidAlive } from "../kill-tree.ts";
import { getProcessStartTimeSec, reapOrphanedTasks, type RegistryEntryStartTime } from "../reaper.ts";

let dataDir: string;

/** 本测试 spawn 的全部进程（owner / task），afterEach 统一杀进程组清理。 */
const spawnedPids: number[] = [];

/** detached spawn（pgid=pid）：kill-tree 杀 -pid 精确命中，不波及测试进程组。 */
function spawnDetached(command: string, args: string[]): ChildProcess {
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.unref();
	if (child.pid === undefined) throw new Error(`spawn ${command} failed: no pid`);
	spawnedPids.push(child.pid);
	return child;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等进程退出（测试里构造「已死属主 / 已死任务」用）。 */
async function waitProcessExit(pid: number, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (isPidAlive(pid)) {
		if (Date.now() > deadline) throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
		await sleep(50);
	}
}

type EntryOverrides = Partial<RegistryEntry> & Partial<RegistryEntryStartTime> & {
	pid: number;
	ownerPiPid: number;
	sessionId: string;
};

/** 手写 registry 条目（走真实 writeRegistryEntry——锁内 RMW + 原子写路径）。 */
function writeTestEntry(overrides: EntryOverrides): string {
	const taskId = overrides.taskId ?? `bt-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const entry: RegistryEntry & RegistryEntryStartTime = {
		taskId,
		pid: overrides.pid,
		command: overrides.command ?? "sleep 60",
		outputFile: overrides.outputFile ?? join(dataDir, "unused.log"),
		startedAt: overrides.startedAt ?? Date.now(),
		state: overrides.state ?? "running",
		ownerPiPid: overrides.ownerPiPid,
		sessionId: overrides.sessionId,
		...(overrides.exitCode !== undefined ? { exitCode: overrides.exitCode } : {}),
		...(overrides.pidStartTime !== undefined ? { pidStartTime: overrides.pidStartTime } : {}),
	};
	const written = writeRegistryEntry(getRegistryPath(dataDir, overrides.sessionId), entry);
	if (!written.success) throw new Error(written.error);
	return taskId;
}

function entryState(sessionId: string, taskId: string): string | undefined {
	return readRegistry(getRegistryPath(dataDir, sessionId)).get(taskId)?.state;
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "bte-reaper-"));
});

afterEach(() => {
	// 杀干净全部探针进程（进程组优先，防 detached 子进程泄漏影响后续用例）
	for (const pid of spawnedPids) {
		if (!isPidAlive(pid)) continue;
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already dead
			}
		}
	}
	spawnedPids.length = 0;
});

describe("getProcessStartTimeSec (platform probe sanity)", () => {
	it("returns a sane epoch-seconds value for a live process", () => {
		const sec = getProcessStartTimeSec(process.pid);
		expect(sec).toBeDefined();
		const nowSec = Math.floor(Date.now() / 1000);
		// 本进程必然启动于 [now - 10min, now + 5s]（时钟容差）
		expect(sec!).toBeGreaterThan(nowSec - 600);
		expect(sec!).toBeLessThan(nowSec + 5);
	});

	it("returns undefined for a dead pid", async () => {
		const short = spawnDetached("sleep", ["0.1"]);
		await waitProcessExit(short.pid!);
		expect(getProcessStartTimeSec(short.pid!)).toBeUndefined();
	});
});

describe("branch ①: owner alive → skip (S8-B no-false-kill)", () => {
	it("skips entries whose owner process is alive; task and owner both survive", async () => {
		const owner = spawnDetached("sleep", ["30"]);
		const task = spawnDetached("sleep", ["30"]);
		const taskId = writeTestEntry({ pid: task.pid!, ownerPiPid: owner.pid!, sessionId: "s-owner-alive" });

		const result = await reapOrphanedTasks(dataDir);

		expect(result.ownerAliveSkipped).toBe(1);
		expect(result.killedOrphans).toBe(0);
		expect(result.finalizedOrphans).toBe(0);
		// 防误杀断言：任务进程仍存活（reaper 不介入属主存活的任务）
		expect(isPidAlive(task.pid!)).toBe(true);
		expect(isPidAlive(owner.pid!)).toBe(true);
		expect(entryState("s-owner-alive", taskId)).toBe("running");
	});

	it("treats ownerPiPid === current process pid as owner-alive (defensive)", async () => {
		const task = spawnDetached("sleep", ["30"]);
		const taskId = writeTestEntry({ pid: task.pid!, ownerPiPid: process.pid, sessionId: "s-self-owner" });

		const result = await reapOrphanedTasks(dataDir);

		expect(result.ownerAliveSkipped).toBe(1);
		expect(isPidAlive(task.pid!)).toBe(true);
		expect(entryState("s-self-owner", taskId)).toBe("running");
	});

	it("skips killing-intent entries while owner alive (owner's own poller finalizes)", async () => {
		const owner = spawnDetached("sleep", ["30"]);
		const task = spawnDetached("sleep", ["30"]);
		const taskId = writeTestEntry({
			pid: task.pid!,
			ownerPiPid: owner.pid!,
			sessionId: "s-killing-owner-alive",
			state: "killing",
		});

		const result = await reapOrphanedTasks(dataDir);

		expect(result.ownerAliveSkipped).toBe(1);
		expect(isPidAlive(task.pid!)).toBe(true);
		expect(entryState("s-killing-owner-alive", taskId)).toBe("killing");
	});
});

describe("branch ②: owner dead + task alive → kill-tree + orphaned (S5)", () => {
	it("kills the orphan task and marks the entry orphaned", async () => {
		const owner = spawnDetached("sleep", ["0.1"]); // 短命属主
		const task = spawnDetached("sleep", ["60"]); // 活孤儿任务
		await waitProcessExit(owner.pid!);
		// startedAt = 写条目时刻（晚于任务 spawn）→ 降级校验 actual <= floor(startedAt) 满足
		const taskId = writeTestEntry({ pid: task.pid!, ownerPiPid: owner.pid!, sessionId: "s-orphan-kill" });

		const result = await reapOrphanedTasks(dataDir);

		expect(result.killedOrphans).toBe(1);
		await sleep(300); // SIGKILL 发出到进程表移除是异步的
		expect(isPidAlive(task.pid!)).toBe(false);
		expect(entryState("s-orphan-kill", taskId)).toBe("orphaned");
	});

	it("reaps killing-intent entries the same way when owner is dead", async () => {
		const owner = spawnDetached("sleep", ["0.1"]);
		const task = spawnDetached("sleep", ["60"]);
		await waitProcessExit(owner.pid!);
		const taskId = writeTestEntry({
			pid: task.pid!,
			ownerPiPid: owner.pid!,
			sessionId: "s-killing-orphan",
			state: "killing",
		});

		const result = await reapOrphanedTasks(dataDir);

		expect(result.killedOrphans).toBe(1);
		await sleep(300);
		expect(isPidAlive(task.pid!)).toBe(false);
		expect(entryState("s-killing-orphan", taskId)).toBe("orphaned");
	});

	it("precise pidStartTime field match authorizes the kill (exact comparison path)", async () => {
		const owner = spawnDetached("sleep", ["0.1"]);
		const task = spawnDetached("sleep", ["60"]);
		await waitProcessExit(owner.pid!);
		const startSec = getProcessStartTimeSec(task.pid!);
		expect(startSec).toBeDefined();
		const taskId = writeTestEntry({
			pid: task.pid!,
			ownerPiPid: owner.pid!,
			sessionId: "s-exact-match",
			pidStartTime: startSec,
		});

		const result = await reapOrphanedTasks(dataDir);

		expect(result.killedOrphans).toBe(1);
		await sleep(300);
		expect(isPidAlive(task.pid!)).toBe(false);
		expect(entryState("s-exact-match", taskId)).toBe("orphaned");
	});
});

describe("branch ③: owner dead + task dead → terminal-only (no kill)", () => {
	it("marks the stale running entry orphaned without any kill", async () => {
		const owner = spawnDetached("sleep", ["0.1"]);
		const task = spawnDetached("sleep", ["0.1"]);
		await waitProcessExit(owner.pid!);
		await waitProcessExit(task.pid!);
		const taskId = writeTestEntry({ pid: task.pid!, ownerPiPid: owner.pid!, sessionId: "s-terminal-only" });

		const result = await reapOrphanedTasks(dataDir);

		expect(result.finalizedOrphans).toBe(1);
		expect(result.killedOrphans).toBe(0); // 不补杀
		expect(result.conservativelySkipped).toBe(0);
		expect(entryState("s-terminal-only", taskId)).toBe("orphaned");
	});
});

describe("pid-reuse defense (§3.6 start-time verification)", () => {
	it("does NOT kill when actual start time is newer than the entry (pid reuse suspicion)", async () => {
		const owner = spawnDetached("sleep", ["0.1"]);
		const task = spawnDetached("sleep", ["60"]);
		await waitProcessExit(owner.pid!);
		// startedAt 拨回很久以前（epoch 早期）：活任务进程 start time 必然晚于它
		// → 降级判据 actual > floor(startedAt) → 复用嫌疑 → 不杀
		const taskId = writeTestEntry({
			pid: task.pid!,
			ownerPiPid: owner.pid!,
			sessionId: "s-reuse-degraded",
			startedAt: 1000,
		});

		const result = await reapOrphanedTasks(dataDir);

		expect(result.conservativelySkipped).toBe(1);
		expect(result.killedOrphans).toBe(0);
		expect(isPidAlive(task.pid!)).toBe(true); // 无辜进程未被误杀
		expect(entryState("s-reuse-degraded", taskId)).toBe("running"); // 不转终态，交下一周期
	});

	it("does NOT kill when precise pidStartTime mismatches the live process", async () => {
		const owner = spawnDetached("sleep", ["0.1"]);
		const task = spawnDetached("sleep", ["60"]);
		await waitProcessExit(owner.pid!);
		const taskId = writeTestEntry({
			pid: task.pid!,
			ownerPiPid: owner.pid!,
			sessionId: "s-reuse-exact",
			pidStartTime: 1, // 1970 年：与实际进程 start time 必然不等 → 复用嫌疑
		});

		const result = await reapOrphanedTasks(dataDir);

		expect(result.conservativelySkipped).toBe(1);
		expect(isPidAlive(task.pid!)).toBe(true);
		expect(entryState("s-reuse-exact", taskId)).toBe("running");
	});

	it("conservatively skips the whole disposal when start time is unreadable (platform without ps)", async () => {
		const owner = spawnDetached("sleep", ["0.1"]);
		const task = spawnDetached("sleep", ["60"]);
		await waitProcessExit(owner.pid!);
		const taskId = writeTestEntry({ pid: task.pid!, ownerPiPid: owner.pid!, sessionId: "s-no-starttime" });

		// 注入「平台取不到 start time」：不补杀也不转终态（宁延迟勿误杀）
		const result = await reapOrphanedTasks(dataDir, { getProcessStartTimeSec: () => undefined });

		expect(result.conservativelySkipped).toBe(1);
		expect(result.killedOrphans).toBe(0);
		expect(result.finalizedOrphans).toBe(0);
		expect(isPidAlive(task.pid!)).toBe(true);
		expect(entryState("s-no-starttime", taskId)).toBe("running");
	});
});

describe("file-lock serialization (concurrent reapers stay idempotent)", () => {
	it("two concurrent reaper runs dispose each orphan exactly once", async () => {
		const owner = spawnDetached("sleep", ["0.1"]);
		const task = spawnDetached("sleep", ["60"]);
		await waitProcessExit(owner.pid!);
		const taskId = writeTestEntry({ pid: task.pid!, ownerPiPid: owner.pid!, sessionId: "s-concurrent" });

		const [first, second] = await Promise.all([
			reapOrphanedTasks(dataDir),
			reapOrphanedTasks(dataDir),
		]);

		// 锁串行化 + 终态跳过：合计恰好处置一次（后进锁者见 orphaned 终态 no-op）
		expect(first.killedOrphans + second.killedOrphans).toBe(1);
		expect(first.conservativelySkipped + second.conservativelySkipped).toBe(0);
		await sleep(300);
		expect(isPidAlive(task.pid!)).toBe(false);
		expect(entryState("s-concurrent", taskId)).toBe("orphaned");

		// 幂等：第三遍扫描对已终态条目完全 no-op
		const third = await reapOrphanedTasks(dataDir);
		expect(third.killedOrphans).toBe(0);
		expect(third.finalizedOrphans).toBe(0);
		expect(third.ownerAliveSkipped).toBe(0);
		expect(third.conservativelySkipped).toBe(0);
	});
});

describe("scan robustness (corrupt dir tolerance + multi-dir)", () => {
	it("skips a corrupt registry dir without breaking the scan of other dirs", async () => {
		// 目录 A：损坏 registry.json（非法 JSON——readRegistry rename .corrupt + 空表重建）
		const corruptDir = join(dataDir, "base-tool-enhance", "s-corrupt");
		mkdirSync(corruptDir, { recursive: true });
		writeFileSync(join(corruptDir, "registry.json"), "{ not valid json !!", "utf8");
		// 目录 B：正常孤儿（分支②）
		const owner = spawnDetached("sleep", ["0.1"]);
		const task = spawnDetached("sleep", ["60"]);
		await waitProcessExit(owner.pid!);
		const taskId = writeTestEntry({ pid: task.pid!, ownerPiPid: owner.pid!, sessionId: "s-healthy-next-door" });

		const result = await reapOrphanedTasks(dataDir);

		expect(result.scannedDirs).toBeGreaterThanOrEqual(2);
		expect(result.killedOrphans).toBe(1); // B 目录孤儿照常处置，A 目录损坏不中断
		expect(entryState("s-healthy-next-door", taskId)).toBe("orphaned");
	});

	it("scans multiple session dirs and applies per-entry branches independently", async () => {
		// 目录 A：属主活条目（跳过）；目录 B：孤儿（补杀）；目录 C：终态遗留（收尾）
		const aliveOwner = spawnDetached("sleep", ["30"]);
		const aliveTask = spawnDetached("sleep", ["30"]);
		writeTestEntry({ pid: aliveTask.pid!, ownerPiPid: aliveOwner.pid!, sessionId: "s-multi-a" });

		const deadOwner = spawnDetached("sleep", ["0.1"]);
		const orphanTask = spawnDetached("sleep", ["60"]);
		await waitProcessExit(deadOwner.pid!);
		const orphanId = writeTestEntry({ pid: orphanTask.pid!, ownerPiPid: deadOwner.pid!, sessionId: "s-multi-b" });

		const finOwner = spawnDetached("sleep", ["0.1"]);
		const finTask = spawnDetached("sleep", ["0.1"]);
		await waitProcessExit(finOwner.pid!);
		await waitProcessExit(finTask.pid!);
		const finId = writeTestEntry({ pid: finTask.pid!, ownerPiPid: finOwner.pid!, sessionId: "s-multi-c" });

		const result = await reapOrphanedTasks(dataDir);

		expect(result.ownerAliveSkipped).toBe(1);
		expect(result.killedOrphans).toBe(1);
		expect(result.finalizedOrphans).toBe(1);
		expect(isPidAlive(aliveTask.pid!)).toBe(true); // 属主活的任务毫发无损
		expect(entryState("s-multi-b", orphanId)).toBe("orphaned");
		expect(entryState("s-multi-c", finId)).toBe("orphaned");
	});

	it("handles a missing base dir gracefully (no background tasks ever created)", async () => {
		const result = await reapOrphanedTasks(join(dataDir, "never-exists"));
		expect(result.scannedDirs).toBe(0);
		expect(result.killedOrphans).toBe(0);
	});
});
