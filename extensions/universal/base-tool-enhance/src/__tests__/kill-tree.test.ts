// src/__tests__/kill-tree.test.ts —— 进程树 kill 真实进程验证（POSIX 进程组语义）
import { spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20000 });

import { isPidAlive, killProcessTree } from "../kill-tree.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
		// 等退出 + libuv reap（SIGCHLD → waitpid 后 pid 释放）
		await sleep(300);
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
		await sleep(300); // 让子 sleep 起来
		expect(isPidAlive(pid)).toBe(true);

		killProcessTree(pid);
		await sleep(300);

		expect(isPidAlive(pid)).toBe(false);
		// 子进程也不得残留：枚举验证（pgrep -P 组长；组长死后 reparent，改为全 pgrep 命令串兜底）
		const leftover = spawn("/usr/bin/pgrep", ["-f", "sleep 30"]);
		const stdout: string[] = [];
		leftover.stdout?.on("data", (d: Buffer) => stdout.push(d.toString()));
		const status = await new Promise<number | null>((resolve) => leftover.on("close", resolve));
		// pgrep 自身命令行含 "sleep 30" 会自匹配吗：pgrep -f 匹配其他进程，不匹配自身（pgrep 默认排除自己）
		const others = stdout.join("").split("\n").filter((line) => line.trim() !== "");
		expect(others).toEqual([]);
		expect(status).not.toBe(0); // 无匹配 → pgrep exit 1
	});

	it("killing an already-dead pid is a silent no-op", async () => {
		const child = spawnDetached("true");
		const pid = child.pid;
		if (pid === undefined) throw new Error("no pid");
		await sleep(300);
		expect(() => killProcessTree(pid)).not.toThrow();
	});
});
