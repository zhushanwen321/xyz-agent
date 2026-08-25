// src/__tests__/background-lifecycle.test.ts —— background 核心生命周期集成：
// 真实 spawn 边沿收尾 / 轮询器自动收尾 / killing intent 双侧 / timeout / 并发上限 /
// 收殓 / D15 abort / bash_output / bash_kill（黑盒：经工具 execute 断言使用者可见行为）
import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20000 });

// getAgentDir → 测试临时数据目录（工具 execute 内部调用，不写真 ~/.pi/agent）。
// hoisted 回调里不能引用顶层 import（初始化顺序），用可变引用在 import 完成后注入
const { dataDirRef } = vi.hoisted(() => ({ dataDirRef: { dir: "" } }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => dataDirRef.dir,
}));

// kill-tree 转发真实杀 + 记录调用（timeout 分支断言 killProcessTree 被调）
const { killTreeCalls } = vi.hoisted(() => ({ killTreeCalls: [] as number[] }));
vi.mock("../kill-tree.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../kill-tree.ts")>();
	return {
		...orig,
		killProcessTree: (pid: number): void => {
			killTreeCalls.push(pid);
			orig.killProcessTree(pid);
		},
	};
});

import { createBashKillToolDefinition } from "../bash-kill-tool.ts";
import { createBashOutputToolDefinition } from "../bash-output-tool.ts";
import { pollTickForTest, setOnTaskExit, stopPoller } from "../background/poller.ts";
import { getRegistryPath, readRegistry, taskToRegistryEntry, writeRegistryEntry } from "../background/registry.ts";
import { DEFAULT_MAX_CONCURRENT_BACKGROUND, spawnBackgroundTask } from "../background/spawn-background.ts";
import { clearTaskStoreForTest, getActiveTasks, getTask } from "../background/task-store.ts";
import { reapBackgroundTasksNow, resetProcessExitGuardForTest } from "../background/process-exit-guard.ts";
import { isPidAlive } from "../kill-tree.ts";

vi.setConfig({ testTimeout: 20000 });

const DATA_DIR = mkdtempSync(join(tmpdir(), "bte-data-"));
dataDirRef.dir = DATA_DIR;

const SESSION_ID = "sess-lifecycle";
const REGISTRY_PATH = getRegistryPath(DATA_DIR, SESSION_ID);

function makeCtx(): { cwd: string; sessionManager: { getSessionId: () => string } } {
	return { cwd: process.cwd(), sessionManager: { getSessionId: () => SESSION_ID } };
}

const bashOutput = createBashOutputToolDefinition();
const bashKill = createBashKillToolDefinition();

async function outputTool(args: { task_id?: string }): Promise<string> {
	const result = await bashOutput.execute("call-1", args, undefined, undefined, makeCtx() as never);
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

async function killTool(taskId: string): Promise<string> {
	const result = await bashKill.execute("call-1", { task_id: taskId }, undefined, undefined, makeCtx() as never);
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnBg(command: string, extra: { timeoutSec?: number } = {}) {
	return spawnBackgroundTask({
		command,
		cwd: process.cwd(),
		dataDir: DATA_DIR,
		sessionId: SESSION_ID,
		...extra,
	});
}

beforeEach(() => {
	killTreeCalls.length = 0;
});

afterEach(() => {
	// 残留活跃任务先杀干净再清表（防句柄/进程泄漏影响后续测试）
	for (const task of getActiveTasks()) {
		try {
			process.kill(-task.pid, "SIGKILL");
		} catch {
			try {
				process.kill(task.pid, "SIGKILL");
			} catch {
				// already dead
			}
		}
	}
	clearTaskStoreForTest();
	stopPoller();
	setOnTaskExit(undefined);
	resetProcessExitGuardForTest();
});

describe("real spawn lifecycle (poll edge finalization)", () => {
	it("short task: running → exited with exitCode 0, output file readable, registry terminal", async () => {
		const spawned = spawnBg("sleep 0.3 && echo done");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		expect(task.state).toBe("running");
		expect(existsSync(task.outputFile)).toBe(true);
		// registry 登记即写 running 条目（含 ownerPiPid，M5 属主判定依据）
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("running");
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.ownerPiPid).toBe(process.pid);

		await sleep(700); // 等命令退出 + libuv reap
		pollTickForTest();

		const finalized = getTask(task.taskId);
		expect(finalized?.state).toBe("exited");
		expect(finalized?.exitCode).toBe(0);
		expect(finalized?.reason).toBe("natural");
		expect(finalized?.durationMs).toBeGreaterThan(0);

		const registryEntry = readRegistry(REGISTRY_PATH).get(task.taskId);
		expect(registryEntry?.state).toBe("exited");
		expect(registryEntry?.reason).toBe("natural");

		const detail = JSON.parse(await outputTool({ task_id: task.taskId })) as { output: string; exitCode: number };
		expect(detail.output).toContain("done");
		expect(detail.exitCode).toBe(0);
	});

	it("poller interval auto-finalizes without manual tick (lazy start/stop)", async () => {
		const spawned = spawnBg("sleep 0.3 && echo auto");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		// 不手动 tick，等真实 2s 轮询边沿（命令 0.3s 已退出，首轮 tick 即收尾）
		await sleep(2800);
		expect(getTask(task.taskId)?.state).toBe("exited");
		// 无活跃条目后轮询器自停（防空转）
		expect(getActiveTasks()).toHaveLength(0);
	});

	it("nonzero exit code is surfaced (exitCode 1)", async () => {
		const spawned = spawnBg("sleep 0.2; exit 3");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		await sleep(600);
		pollTickForTest();
		expect(getTask(task.taskId)?.exitCode).toBe(3);
		const registryEntry = readRegistry(REGISTRY_PATH).get(task.taskId);
		expect(registryEntry?.exitCode).toBe(3);
	});

	it("onTaskExit callback (M3 hook point) fires with the finalized task", async () => {
		const seen: string[] = [];
		setOnTaskExit((task) => seen.push(`${task.taskId}:${task.state}:${task.reason}`));
		const spawned = spawnBg("true");
		if (!spawned.ok) throw new Error(spawned.error);
		await sleep(500);
		pollTickForTest();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBe(`${spawned.task.taskId}:exited:natural`);
	});
});

describe("bash_output tool", () => {
	it("list merges store + registry terminal entries, store wins on same id", async () => {
		// 单例表：一个 running 真任务
		const spawned = spawnBg("sleep 5");
		if (!spawned.ok) throw new Error(spawned.error);
		// registry 手写：另一个终态历史条目（不在单例表——模拟已被 LRU 淘汰后回落）
		writeRegistryEntry(REGISTRY_PATH, {
			taskId: "bt-9000-hist",
			pid: 1,
			command: "x".repeat(100),
			outputFile: "/tmp/gone.log",
			startedAt: 1,
			state: "exited",
			ownerPiPid: 1,
			sessionId: SESSION_ID,
			exitCode: 0,
			reason: "natural",
			endedAt: 2,
			durationMs: 1,
		});
		// registry 手写：与单例表同 id 的过期 exited 版本（须被单例表 running 覆盖）
		writeRegistryEntry(
			REGISTRY_PATH,
			taskToRegistryEntry({ ...spawned.task, state: "exited" as const, ownerPiPid: 1 }),
		);

		const listed = JSON.parse(await outputTool({})) as {
			tasks: Array<{ task_id: string; state: string; command: string }>;
		};
		const byId = new Map(listed.tasks.map((t) => [t.task_id, t]));
		expect(byId.get(spawned.task.taskId)?.state).toBe("running"); // 单例表优先
		expect(byId.get("bt-9000-hist")?.state).toBe("exited");
		// 命令展示截断（前 80 字符）
		expect(byId.get("bt-9000-hist")?.command.length).toBeLessThanOrEqual(81);
	});

	it("unknown task_id throws with list hint", async () => {
		await expect(outputTool({ task_id: "bt-none" })).rejects.toThrow(/No such task/);
	});

	it("deleted output file degrades to <lost> without crashing (§3.6)", async () => {
		const spawned = spawnBg("sleep 0.2 && echo gone");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		await sleep(500);
		pollTickForTest();
		unlinkSync(task.outputFile);
		const detail = JSON.parse(await outputTool({ task_id: task.taskId })) as {
			output: string;
			state: string;
		};
		expect(detail.output).toBe("<lost>");
		expect(detail.state).toBe("exited");
	});

	it("output tail respects line cap", async () => {
		// 2100 行输出 → tail 只保留最后 2000 行
		const spawned = spawnBg("for i in $(seq 1 2100); do echo line$i; done");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		await sleep(900);
		pollTickForTest();
		const detail = JSON.parse(await outputTool({ task_id: task.taskId })) as {
			output: string;
			truncated: boolean;
		};
		const lines = detail.output.split("\n");
		expect(lines.length).toBeLessThanOrEqual(2000);
		expect(detail.truncated).toBe(true);
		expect(detail.output).toContain("line2100");
		expect(detail.output).not.toContain("line50\n");
	});
});

describe("bash_kill tool (killing intent, single-point finalization)", () => {
	it("kill marks BOTH store and registry as killing before the poll edge lands", async () => {
		const spawned = spawnBg("sleep 60");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;

		const killResult = JSON.parse(await killTool(task.taskId)) as { killed: boolean; reason: string };
		expect(killResult.killed).toBe(true);

		// 轮询未收尾（sleep 60 才死、kill 后立即断言）：两侧 killing 即可见，无倒挂
		expect(getTask(task.taskId)?.state).toBe("killing");
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.state).toBe("killing");
		// kill-tree 确实对该 pid 发过令
		expect(killTreeCalls).toContain(task.pid);
	});

	it("kill edge: intent consumed → exited with reason killed", async () => {
		const spawned = spawnBg("sleep 60");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		await killTool(task.taskId);
		await sleep(500); // SIGKILL 生效
		pollTickForTest();
		const finalized = getTask(task.taskId);
		expect(finalized?.state).toBe("exited");
		expect(finalized?.reason).toBe("killed");
		expect(readRegistry(REGISTRY_PATH).get(task.taskId)?.reason).toBe("killed");
	});

	it("no such task → killed:false with hint", async () => {
		const result = JSON.parse(await killTool("bt-ghost")) as {
			killed: boolean;
			reason: string;
			hint: string;
		};
		expect(result.killed).toBe(false);
		expect(result.reason).toBe("no such task");
		expect(result.hint).toContain("bash_output");
	});

	it("already exited task → killed:false with exit code", async () => {
		const spawned = spawnBg("sleep 0.2");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		await sleep(500);
		pollTickForTest();
		const result = JSON.parse(await killTool(task.taskId)) as { killed: boolean; reason: string };
		expect(result.killed).toBe(false);
		expect(result.reason).toBe("already exited (code 0)");
	});
});

describe("concurrency cap (D10, default 8)", () => {
	it("rejects the 9th task with the oldest task id in the error", async () => {
		const tasks: string[] = [];
		for (let i = 0; i < DEFAULT_MAX_CONCURRENT_BACKGROUND; i++) {
			const spawned = spawnBg("sleep 30");
			if (!spawned.ok) throw new Error(spawned.error);
			tasks.push(spawned.task.taskId);
			await sleep(20); // 错开 startedAt 保证「最老」判定稳定
		}
		const ninth = spawnBg("echo should-fail");
		expect(ninth.ok).toBe(false);
		if (!ninth.ok) {
			expect(ninth.error).toContain(`max ${DEFAULT_MAX_CONCURRENT_BACKGROUND} concurrent`);
			expect(ninth.error).toContain(tasks[0]); // 最老 task_id
			expect(ninth.error).toContain("bash_kill");
		}
	});
});

describe("explicit background timeout (D6)", () => {
	it("fires kill-tree at the deadline and finalizes with reason timeout", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let taskId = "";
		let pid = -1;
		try {
			// fake 生效后 spawn：timeout 定时器进 fake 队列，由 advanceTimers 推进
			const spawned = spawnBg("sleep 30", { timeoutSec: 1 });
			if (!spawned.ok) throw new Error(spawned.error);
			taskId = spawned.task.taskId;
			pid = spawned.task.pid;

			vi.advanceTimersByTime(1000);
			// 到点：kill-tree 已发令 + 两侧 killing intent（reason 候选 timeout）
			expect(killTreeCalls).toContain(pid);
			expect(getTask(taskId)?.state).toBe("killing");
			expect(getTask(taskId)?.intent?.reason).toBe("timeout");
			expect(readRegistry(REGISTRY_PATH).get(taskId)?.state).toBe("killing");
		} finally {
			vi.useRealTimers();
		}

		// SIGKILL 已真实发出：轮询边沿收尾 → exited(reason:"timeout")，终态由边沿写
		await sleep(500);
		pollTickForTest();
		const finalized = getTask(taskId);
		expect(finalized?.state).toBe("exited");
		expect(finalized?.reason).toBe("timeout");
	});

	it("natural completion before the deadline cancels the timer (no late kill)", async () => {
		// 全程真实 timers：命令 0.2s 完成 < 1s 超时
		const before = killTreeCalls.length;
		const spawned = spawnBg("sleep 0.2 && echo quick", { timeoutSec: 1 });
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;

		await sleep(600); // 命令已退出（未到 1s deadline）
		pollTickForTest();
		expect(getTask(task.taskId)?.state).toBe("exited");
		expect(getTask(task.taskId)?.reason).toBe("natural");

		// 越过 deadline 的时间窗内不得再补杀（终态化必须已清 timer）
		await sleep(900);
		expect(killTreeCalls.length).toBe(before);
		expect(getTask(task.taskId)?.state).toBe("exited");
	});
});

describe("process-exit reap (D12)", () => {
	it("reaps all active tasks with reason process-exit, kills pids, writes registry terminal", async () => {
		const first = spawnBg("sleep 30");
		const second = spawnBg("sleep 30");
		if (!first.ok || !second.ok) throw new Error("spawn failed");
		const pids = [first.task.pid, second.task.pid];
		expect(pids.every((pid) => isPidAlive(pid))).toBe(true);

		reapBackgroundTasksNow();
		await sleep(300); // SIGKILL 发出到进程表移除是异步的

		for (const pid of pids) {
			expect(isPidAlive(pid)).toBe(false);
		}
		for (const t of [first.task, second.task]) {
			const finalized = getTask(t.taskId);
			expect(finalized?.state).toBe("exited");
			expect(finalized?.reason).toBe("process-exit");
			expect(readRegistry(REGISTRY_PATH).get(t.taskId)?.reason).toBe("process-exit");
		}
		expect(getActiveTasks()).toHaveLength(0);
	});
});

describe("D15: abort signal does not propagate to background tasks", () => {
	it("aborted execute-signal leaves the task running", async () => {
		const controller = new AbortController();
		const spawned = spawnBg("sleep 5");
		if (!spawned.ok) throw new Error(spawned.error);
		const { task } = spawned;
		// 模拟用户中断当前 turn：signal abort（后台分支不接触 signal，此处模拟上游已 abort）
		controller.abort();
		expect(controller.signal.aborted).toBe(true);

		await sleep(300);
		// 任务不受中断影响：进程活、状态 running
		expect(isPidAlive(task.pid)).toBe(true);
		expect(getTask(task.taskId)?.state).toBe("running");
	});
});

describe("spawn failure paths (§3.6)", () => {
	it("nonexistent cwd reports the builtin-style error", () => {
		const result = spawnBackgroundTask({
			command: "echo hi",
			cwd: "/definitely/not/exist/dir",
			dataDir: DATA_DIR,
			sessionId: SESSION_ID,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Working directory does not exist");
		}
	});

	it("missing shell reports a spawn failure error", () => {
		// 通过临时 SHELL 指向不存在路径模拟 shell 缺失（POSIX 分支）
		const original = process.env.SHELL;
		process.env.SHELL = "/no/such/shell-binary";
		try {
			const result = spawnBg("echo hi");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("Failed to start background command");
			}
		} finally {
			if (original === undefined) delete process.env.SHELL;
			else process.env.SHELL = original;
		}
	});
});
