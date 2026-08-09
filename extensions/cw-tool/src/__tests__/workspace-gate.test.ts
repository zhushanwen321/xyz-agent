/**
 * workspace 门控测试：probeCwCliNormalization 纯函数 + executeCwAction 门控决策。
 *
 * 门控语义（差异文档 §3 §4 + ADR-0045 Superseded）：cw-cli 支持 store 内部归一化
 * （probe 版本 >= MIN_CW_CLI_VERSION_FOR_NORMALIZATION）→ write action 不传 --workspace（纯封装）；
 * 不支持 → 兜底 ADR-0045 的 detectRepoWorkspace + --workspace。只读 action 始终不传（S-3）。
 *
 * detectRepoWorkspace 探测纯函数 + buildCwArgs 构造的测试在 detect-repo-workspace.test.ts，
 * 本文件只测门控决策（probe 三态 × action 两类 × git 环境）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeCwAction, probeCwCliNormalization } from "../cw-runner.ts";
import { type CwSpawner } from "../cw-spawn.ts";
import { DEV_ALLOWED } from "../index.ts";

// ── 临时目录管理（同 detect-repo-workspace.test.ts 风格）─────────

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

/** 建含一次空 commit 的 git repo，返回 realpath 规范化的 repo 根（macOS /tmp→/private/tmp 对齐）。 */
function createGitRepo(parentDir: string, name: string): string {
	const repo = path.join(parentDir, name);
	mkdirSync(repo);
	execSync("git init -q", { cwd: repo });
	execSync("git -c user.name=test -c user.email=test@test.local commit -q --allow-empty -m init", {
		cwd: repo,
	});
	return realpathSync(repo);
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── mock spawner：对 ['--version'] 可控，对 action 默认成功 ───────

interface GateSpawnerOpts {
	/** cw --version 的 stdout（如 "cw 1.6.1"）。 */
	versionStdout?: string;
	/** cw --version 的 exitCode（默认 0）。 */
	versionExitCode?: number;
	/** cw --version spawn 抛异常（模拟 cw 不在 PATH）。 */
	versionThrow?: boolean;
}

/**
 * 记录所有调用的 fake spawner：对 `['--version']`（probe）返回可控结果，
 * 对其他（action）返回默认成功 `{ stdout: "{}", exitCode: 0 }`。
 */
function gateSpawner(opts: GateSpawnerOpts = {}): {
	spawner: CwSpawner;
	calls: Array<{ args: string[] }>;
} {
	const calls: Array<{ args: string[] }> = [];
	const spawner: CwSpawner = vi.fn(async (args: string[]) => {
		calls.push({ args });
		if (args[0] === "--version") {
			if (opts.versionThrow) throw new Error("cw not in PATH (spawn error)");
			return {
				stdout: opts.versionStdout ?? "",
				stderr: "",
				exitCode: opts.versionExitCode ?? 0,
			};
		}
		return { stdout: "{}", stderr: "", exitCode: 0 };
	}) as unknown as CwSpawner;
	return { spawner, calls };
}

/** 从 calls 中取 action 调用（非 `['--version']` 的最后一个）。 */
function actionCall(calls: Array<{ args: string[] }>): { args: string[] } {
	const action = calls.filter((c) => c.args[0] !== "--version").pop();
	if (!action) throw new Error("无 action 调用（只有 probe 或未触发）");
	return action;
}

// ── probeCwCliNormalization 纯函数 ──────────────────────────────

describe("probeCwCliNormalization", () => {
	it("版本 >= MIN_CW_CLI_VERSION_FOR_NORMALIZATION → supported:true", async () => {
		const cwd = makeTempDir("probe-supported-");
		const { spawner } = gateSpawner({ versionStdout: "cw 99.9.9" });
		const cap = await probeCwCliNormalization(spawner, cwd);
		expect(cap.supported).toBe(true);
		expect(cap.version).toBe("99.9.9");
	});

	it("版本 < MIN → supported:false（当前 placeholder 99.0.0，真实 cw 1.6.1 不支持）", async () => {
		const cwd = makeTempDir("probe-unsupported-");
		const { spawner } = gateSpawner({ versionStdout: "cw 1.6.1" });
		const cap = await probeCwCliNormalization(spawner, cwd);
		expect(cap.supported).toBe(false);
		expect(cap.version).toBe("1.6.1");
	});

	it("cw --version exitCode 非 0 → supported:false（fail-safe）", async () => {
		const cwd = makeTempDir("probe-exit-");
		const { spawner } = gateSpawner({ versionExitCode: 127 });
		const cap = await probeCwCliNormalization(spawner, cwd);
		expect(cap.supported).toBe(false);
		expect(cap.version).toBeUndefined();
	});

	it("stdout 无版本号 → supported:false（parse 失败 fail-safe）", async () => {
		const cwd = makeTempDir("probe-parse-");
		const { spawner } = gateSpawner({ versionStdout: "garbage no version here" });
		const cap = await probeCwCliNormalization(spawner, cwd);
		expect(cap.supported).toBe(false);
		expect(cap.version).toBeUndefined();
	});

	it("spawn 抛异常（cw 不在 PATH）→ supported:false（fail-safe）", async () => {
		const cwd = makeTempDir("probe-throw-");
		const { spawner } = gateSpawner({ versionThrow: true });
		const cap = await probeCwCliNormalization(spawner, cwd);
		expect(cap.supported).toBe(false);
	});

	it("memoize：同 cwd 第二次不调 spawner（进程内缓存）", async () => {
		const cwd = makeTempDir("probe-memo-");
		const { spawner, calls } = gateSpawner({ versionStdout: "cw 99.9.9" });
		await probeCwCliNormalization(spawner, cwd);
		await probeCwCliNormalization(spawner, cwd);
		expect(calls.length).toBe(1);
	});

	it("memoize：不同 cwd 不命中缓存（各自探测）", async () => {
		const cwdA = makeTempDir("probe-memo-a-");
		const cwdB = makeTempDir("probe-memo-b-");
		const { spawner, calls } = gateSpawner({ versionStdout: "cw 99.9.9" });
		await probeCwCliNormalization(spawner, cwdA);
		await probeCwCliNormalization(spawner, cwdB);
		expect(calls.length).toBe(2);
	});
});

// ── executeCwAction workspace 门控（TC1-5）──────────────────────

describe("executeCwAction workspace 门控", () => {
	it("TC1: probe 支持 → write action 不传 --workspace（纯封装）", async () => {
		const base = makeTempDir("gate-tc1-");
		const repo = createGitRepo(base, "repo");
		const { spawner, calls } = gateSpawner({ versionStdout: "cw 99.9.9" });
		await executeCwAction("execute", DEV_ALLOWED, "cw_dev", "u1", {}, spawner, repo);
		expect(actionCall(calls).args).not.toContain("--workspace");
	});

	it("TC2: probe 不支持 → write action 兜底传 --workspace（ADR-0045 行为）", async () => {
		const base = makeTempDir("gate-tc2-");
		const repo = createGitRepo(base, "repo");
		const { spawner, calls } = gateSpawner({ versionStdout: "cw 1.6.1" });
		await executeCwAction("execute", DEV_ALLOWED, "cw_dev", "u1", {}, spawner, repo);
		const args = actionCall(calls).args;
		expect(args).toContain("--workspace");
		expect(args[args.indexOf("--workspace") + 1]).toBe(repo);
	});

	it("TC3: probe 失败（spawn error）→ fail-safe 兜底传 --workspace", async () => {
		const base = makeTempDir("gate-tc3-");
		const repo = createGitRepo(base, "repo");
		const { spawner, calls } = gateSpawner({ versionThrow: true });
		await executeCwAction("execute", DEV_ALLOWED, "cw_dev", "u1", {}, spawner, repo);
		expect(actionCall(calls).args).toContain("--workspace");
	});

	it("TC4: 只读 action（status）始终不传 --workspace（不 probe）", async () => {
		const base = makeTempDir("gate-tc4-");
		const repo = createGitRepo(base, "repo");
		const { spawner, calls } = gateSpawner({ versionStdout: "cw 99.9.9" });
		await executeCwAction("status", DEV_ALLOWED, "cw_dev", "u1", {}, spawner, repo);
		// 只读不 probe：仅 1 次调用（action），且不含 --workspace
		expect(calls.length).toBe(1);
		expect(calls[0].args).not.toContain("--workspace");
	});

	it("TC5: 非 git 目录 + probe 不支持 → detectRepoWorkspace undefined → 不传", async () => {
		const plain = makeTempDir("gate-tc5-plain-");
		const { spawner, calls } = gateSpawner({ versionStdout: "cw 1.6.1" });
		await executeCwAction("execute", DEV_ALLOWED, "cw_dev", "u1", {}, spawner, plain);
		expect(actionCall(calls).args).not.toContain("--workspace");
	});
});
