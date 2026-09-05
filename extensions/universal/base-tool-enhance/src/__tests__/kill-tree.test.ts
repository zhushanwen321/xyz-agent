// src/__tests__/kill-tree.test.ts —— 进程树 kill 真实进程验证（POSIX 进程组语义）
// + pid 身份判据（getProcessStartTimeSec / pidStartMatchesRegistered——原 reaper.test.ts
// 覆盖平移：收殓下沉 runtime 后 helper 移入本文件，kill 侧自防御仍消费）
import { spawn, spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20000 });

import {
	getProcessStartTimeSec,
	isPidAlive,
	killProcessTree,
	pidStartMatchesRegistered,
} from "../kill-tree.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询直到期望状态出现或超时：真实进程事件（退出 → libuv reap → pid 释放）在满载
 * 下延迟不可预估，固定 sleep 后单次断言是满载 flake 源——等状态而非猜时刻。
 */
async function pollUntil(check: () => boolean, deadlineMs: number, what: string): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error(`timed out after ${deadlineMs}ms waiting for ${what}`);
		}
		await sleep(25);
	}
}

/** pgrep -P 组内枚举：列组长直接子 pid（仅本进程组内，非全机扫描）。 */
function listChildPids(pid: number): number[] {
	const result = spawnSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" });
	// exit 1 = 无匹配（空表正常态）；解析失败按空表处理，由轮询重试兜住 spawn 竞态
	return (result.stdout ?? "")
		.split("\n")
		.map((line) => Number.parseInt(line.trim(), 10))
		.filter((n) => Number.isInteger(n) && n > 0);
}

/** 真实 detached spawn（与本包后台任务同款形态：自成进程组）。 */
function spawnDetached(command: string) {
	const child = spawn("/bin/sh", ["-c", command], {
		detached: true,
		stdio: "ignore",
	});
	child.on("error", () => {});
	child.unref();
	return child;
}

describe("isPidAlive", () => {
	it("current process is alive", () => {
		expect(isPidAlive(process.pid)).toBe(true);
	});

	it("exited process is dead (pid freed after reap)", async () => {
		const child = spawnDetached("true");
		const pid = child.pid;
		if (pid === undefined) throw new Error("no pid");
		// 轮询等退出 + libuv reap（SIGCHLD → waitpid 后 pid 释放）
		await pollUntil(() => !isPidAlive(pid), 5000, "pid to be freed after reap");
		expect(isPidAlive(pid)).toBe(false);
	});

	it("invalid pid (0/negative) is treated as dead", () => {
		expect(isPidAlive(0)).toBe(false);
		expect(isPidAlive(-1)).toBe(false);
	});
});

describe("killProcessTree (process group semantics)", () => {
	it("kills the whole detached process group including grandchildren", async () => {
		// 组长 sh + 两个子 sleep：进程组 kill 必须全部覆盖
		const child = spawnDetached("sleep 30 & sleep 30 & wait");
		const pid = child.pid;
		if (pid === undefined) throw new Error("no pid");
		// 轮询等两个孙子 sleep 真正 fork 出来，并在 kill 之前用组内枚举（pgrep -P）
		// 记录孙子 pid 快照——kill 后只对这些记录过的 pid 断言，禁止全机 pgrep -f
		// 扫描（满载并行时其他包测试会真实 spawn 同名命令，跨包互踩）
		let grandchildPids: number[] = [];
		await pollUntil(
			() => {
				grandchildPids = listChildPids(pid);
				return isPidAlive(pid) && grandchildPids.length >= 2;
			},
			5000,
			"grandchildren to spawn inside the group",
		);
		expect(isPidAlive(pid)).toBe(true);

		killProcessTree(pid);
		// 轮询组长死（等 libuv reap，deadline 5s）
		await pollUntil(() => !isPidAlive(pid), 5000, "group leader to die");

		// 记录过的孙子 pid 也不得残留。覆盖面说明：killProcessTree 是进程组 kill
		// （POSIX kill -- -<pgid>），孙子与组长同组、组长死后 reparent 不换组，
		// 故「组 kill + 组内 pid 记录」已覆盖「reparent 后孙子也能被杀」的原始意图；
		// pid 复用概率在 5s 轮询窗口内可忽略
		await pollUntil(
			() => grandchildPids.every((gpid) => !isPidAlive(gpid)),
			5000,
			"recorded grandchildren to die",
		);
	});

	it("killing an already-dead pid is a silent no-op", async () => {
		const child = spawnDetached("true");
		const pid = child.pid;
		if (pid === undefined) throw new Error("no pid");
		// 轮询等死透再 kill：断言语义是「对已死 pid 发令为无害 no-op」
		await pollUntil(() => !isPidAlive(pid), 5000, "pid to die");
		expect(() => killProcessTree(pid)).not.toThrow();
	});
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
		const child = spawnDetached("sleep 0.1");
		const pid = child.pid;
		if (pid === undefined) throw new Error("no pid");
		// 轮询等退出 + libuv reap（满载下延迟不可预估）
		await pollUntil(() => getProcessStartTimeSec(pid) === undefined, 5000, "ps record to vanish");
		expect(getProcessStartTimeSec(pid)).toBeUndefined();
	});
});

describe("pidStartMatchesRegistered (pid identity predicate, §3.6)", () => {
	it("exact match on registered pidStartTime authorizes (precise path)", () => {
		expect(pidStartMatchesRegistered(1000, 1000, 1_700_000_000_000)).toBe(true);
	});

	it("registered mismatch (pid reuse suspicion) rejects", () => {
		expect(pidStartMatchesRegistered(2000, 1000, 1_700_000_000_000)).toBe(false);
	});

	it("missing registration degrades to startedAt-seconds bound: original process authorizes", () => {
		// 登记发生在 spawn 之后 → 原进程 start time 必然 ≤ floor(startedAt/1000)
		const startedAtMs = 1_700_000_123_456; // floor = 1_700_000_123
		expect(pidStartMatchesRegistered(1_700_000_123, undefined, startedAtMs)).toBe(true);
		expect(pidStartMatchesRegistered(1_700_000_122, undefined, startedAtMs)).toBe(true);
	});

	it("missing registration degrades: newer-than-registration start time rejects (reuse)", () => {
		const startedAtMs = 1_700_000_123_456;
		expect(pidStartMatchesRegistered(1_700_000_124, undefined, startedAtMs)).toBe(false);
	});
});
