/**
 * detectRepoWorkspace 真实 git 探测测试 + buildCwArgs 纯函数构造测试。
 *
 * executeCwAction 的 workspace 门控行为测试已移到 workspace-gate.test.ts
 * （门控后 spawner 被调两次：probe `cw --version` + action，calls[0] 语义变化，
 * 集成测试在那里用区分 probe/action 的 gateSpawner 覆盖）。本文件只测两个纯函数。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect）。
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCwArgs, detectRepoWorkspace } from "../cw-runner.ts";

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

/** 建 bare repo + worktree workspace（xyz-agent 模式：.bare + worktree 子目录）。
 *  返回 realpath 规范化的 worktree 路径。bare repo worktree 内 git-common-dir basename 是 .bare（非 .git），
 *  是 detectRepoWorkspace 加固分支的核心场景（设计文档 §2.4 / 决策 2）。 */
function createBareRepoWorkspace(parentDir: string, name: string): string {
	const wsRoot = path.join(parentDir, name);
	mkdirSync(wsRoot);
	// 先建普通 seed repo（含初始 commit，bare repo 不能直接 commit）
	const seed = path.join(parentDir, `${name}-seed`);
	mkdirSync(seed);
	execSync("git init -q", { cwd: seed });
	execSync("git -c user.name=test -c user.email=test@test.local commit -q --allow-empty -m init", { cwd: seed });
	// clone --bare 成 .bare，再 worktree add
	execSync(`git clone -q --bare ${seed} .bare`, { cwd: wsRoot });
	const worktree = path.join(wsRoot, "main");
	execSync('git --git-dir=.bare worktree add -q main', { cwd: wsRoot });
	return realpathSync(worktree);
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

// ── detectRepoWorkspace（bare repo + worktree 模式）──────────────

describe("detectRepoWorkspace（bare repo + worktree 模式）", () => {
	it("bare repo worktree（.bare）→ undefined（dirname(.bare)=容器根非 git 目录，不传 --workspace）", () => {
		const base = makeTempDir("cw-bare-");
		const worktree = createBareRepoWorkspace(base, "ws");
		expect(detectRepoWorkspace(worktree)).toBeUndefined();
	});

	it("防误用：--is-bare-repository 在 worktree 内返回 false（不可作 bare 判据）", () => {
		const base = makeTempDir("cw-bare-isbare-");
		const worktree = createBareRepoWorkspace(base, "ws");
		const isBare = execSync("git rev-parse --is-bare-repository", { cwd: worktree })
			.toString()
			.trim();
		expect(isBare).toBe("false");
	});

	it("bare repo worktree：common-dir basename 是 .bare（非 .git）", () => {
		const base = makeTempDir("cw-bare-commondir-");
		const worktree = createBareRepoWorkspace(base, "ws");
		const commonDir = execSync(
			"git -C . rev-parse --path-format=absolute --git-common-dir",
			{ cwd: worktree },
		)
			.toString()
			.trim();
		expect(path.basename(commonDir)).toBe(".bare");
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
