/**
 * detectRepoWorkspace 真实 git 测试 + executeCwAction 集成（真实 cwd）。
 *
 * 与 cw-tool.test.ts 分开：该文件 mock 了 node:child_process（spawnSync 被替换），
 * 而本文件需要真实 git 探测，故不 mock，直接对临时 git repo 验证。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildCwArgs,
	detectRepoWorkspace,
	executeCwAction,
	type CwSpawner,
} from "../cw-runner.ts";
import { DEV_ALLOWED } from "../index.ts";

// ── 临时目录管理 ────────────────────────────────────────────────

const tmpDirs: string[] = [];

/** 建一个独立临时目录（afterEach 统一清理）。 */
function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

/** 在 dir 下初始化一个含一次空 commit 的 git repo，返回 realpath 规范化后的 repo 根。 */
function createGitRepo(parentDir: string, name: string): string {
	const repo = path.join(parentDir, name);
	mkdirSync(repo);
	execSync("git init -q", { cwd: repo });
	execSync("git -c user.name=test -c user.email=test@test.local commit -q --allow-empty -m init", {
		cwd: repo,
	});
	// macOS 上 /tmp → /private/tmp：git rev-parse 输出 realpath，与 mkdtempSync 返回路径不一致，
	// 统一以 realpath 为准（--workspace 最终传的也是 git 输出的规范化路径）。
	return realpathSync(repo);
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── detectRepoWorkspace（真实 git）─────────────────────────────

describe("detectRepoWorkspace（真实 git）", () => {
	it("git repo 根目录 → 返回 repo 根（等于 --show-toplevel）", () => {
		const base = makeTempDir("cw-detect-");
		const repo = createGitRepo(base, "repo");
		const toplevel = execSync("git rev-parse --show-toplevel", { cwd: repo })
			.toString()
			.trim();
		expect(detectRepoWorkspace(repo)).toBe(toplevel);
	});

	it("repo 子目录（cwd 不在根）→ 仍返回 repo 根", () => {
		const base = makeTempDir("cw-detect-");
		const repo = createGitRepo(base, "repo");
		const sub = path.join(repo, "src", "deep");
		mkdirSync(sub, { recursive: true });
		const toplevel = execSync("git rev-parse --show-toplevel", { cwd: sub })
			.toString()
			.trim();
		expect(detectRepoWorkspace(sub)).toBe(toplevel);
	});

	it("同一 repo 的所有 worktree 返回相同值（repo 级统一，MF-1 核心证据）", () => {
		const base = makeTempDir("cw-detect-");
		const repo = createGitRepo(base, "repo");
		const wtDir = path.join(base, "wt1");
		execSync(`git worktree add -q ${wtDir}`, { cwd: repo });

		const mainWs = detectRepoWorkspace(repo);
		const wtWs = detectRepoWorkspace(wtDir);
		expect(mainWs).toBe(repo);
		expect(wtWs).toBe(repo);
		expect(wtWs).toBe(mainWs);
	});

	it("非 git 目录 → undefined", () => {
		const plain = makeTempDir("cw-detect-plain-");
		expect(detectRepoWorkspace(plain)).toBeUndefined();
	});

	it("不存在的路径 → undefined（不抛）", () => {
		const base = makeTempDir("cw-detect-");
		expect(detectRepoWorkspace(path.join(base, "does-not-exist"))).toBeUndefined();
	});
});

// ── executeCwAction 集成（真实 cwd，fake spawner 记录 args）─────

describe("executeCwAction 集成（真实 git cwd）", () => {
	/** 记录 args 的 fake spawner（不真调 cw）。 */
	function recordingSpawner(): { spawner: CwSpawner; calls: Array<{ args: string[] }> } {
		const calls: Array<{ args: string[] }> = [];
		const spawner: CwSpawner = vi.fn(async (args: string[]) => {
			calls.push({ args });
			return { stdout: "{}", stderr: "", exitCode: 0 };
		}) as unknown as CwSpawner;
		return { spawner, calls };
	}

	it("cwd 在 git repo 内 → args 含 --workspace <repo 根>", async () => {
		const base = makeTempDir("cw-int-");
		const repo = createGitRepo(base, "repo");
		const { spawner, calls } = recordingSpawner();
		await executeCwAction("status", DEV_ALLOWED, "cw_dev", "u1", {}, spawner, repo);
		expect(calls[0].args).toContain("--workspace");
		expect(calls[0].args[calls[0].args.indexOf("--workspace") + 1]).toBe(repo);
	});

	it("cwd 在 linked worktree 内 → --workspace 指向 repo 主目录", async () => {
		const base = makeTempDir("cw-int-");
		const repo = createGitRepo(base, "repo");
		const wtDir = path.join(base, "wt1");
		execSync(`git worktree add -q ${wtDir}`, { cwd: repo });
		const { spawner, calls } = recordingSpawner();
		await executeCwAction("status", DEV_ALLOWED, "cw_dev", "u1", {}, spawner, wtDir);
		expect(calls[0].args).toContain("--workspace");
		expect(calls[0].args[calls[0].args.indexOf("--workspace") + 1]).toBe(repo);
	});

	it("cwd 为非 git 目录 → args 不含 --workspace", async () => {
		const plain = makeTempDir("cw-int-plain-");
		const { spawner, calls } = recordingSpawner();
		await executeCwAction("status", DEV_ALLOWED, "cw_dev", "u1", {}, spawner, plain);
		expect(calls[0].args).not.toContain("--workspace");
	});

	it("cwd 不存在 → args 不含 --workspace（探测失败不抛）", async () => {
		const base = makeTempDir("cw-int-");
		const { spawner, calls } = recordingSpawner();
		await executeCwAction(
			"status",
			DEV_ALLOWED,
			"cw_dev",
			"u1",
			{},
			spawner,
			path.join(base, "missing"),
		);
		expect(calls[0].args).not.toContain("--workspace");
	});
});

// ── buildCwArgs 纯函数（workspace 参数）─────────────────────────

describe("buildCwArgs（workspace 参数）", () => {
	it("workspace + commitHash → --workspace 位于 --commitHash 之后", () => {
		expect(buildCwArgs("execute", "u1", { commitHash: "abc" }, "/repo/root")).toEqual([
			"execute",
			"--unitId",
			"u1",
			"--commitHash",
			"abc",
			"--workspace",
			"/repo/root",
		]);
	});

	it("workspace 为空字符串 → 不追加", () => {
		expect(buildCwArgs("status", "u1", {}, "")).toEqual(["status", "--unitId", "u1"]);
	});
});
