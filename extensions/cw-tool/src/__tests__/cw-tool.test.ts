/**
 * cw-tool 测试。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 * 不真调 cw：通过 fake spawner 注入。白名单拦截在 spawn 之前，故拒绝用例断言 spawner 未被调用。
 */
import { EventEmitter } from "node:events";
import type * as cp from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// node:child_process 是原生 CJS 模块，ESM 命名导出不可重定义（vi.spyOn 报 "not configurable"）。
// 改用 vi.mock + vi.hoisted：工厂替换整个模块，hoisted vi.fn 作为 spawn，测试内动态配置实现。
const spawnMock = vi.hoisted(() => vi.fn());
// detectRepoWorkspace 的 git 探测同样走 node:child_process（spawnSync），mock 掉以保持纯单元；
// 默认返回失败（非 git 目录语义），executeCwAction 因此不附加 --workspace，现有断言不受影响。
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock, spawnSync: spawnSyncMock }));

// 默认：git 探测失败（status 128）→ detectRepoWorkspace 返回 undefined。
spawnSyncMock.mockImplementation((_cmd: string, _args: string[], _opts: object) => ({
	status: 128,
	stdout: "",
	stderr: "not a git repository",
}));

import {
	buildCwArgs,
	type CwDetails,
	executeCwAction,
	isReadonlyAction,
	rejectDisallowedAction,
	rejectMissingUnitId,
} from "../cw-runner.ts";
import { type CwSpawner, type CwSpawnResult } from "../cw-spawn.ts";
import {
	DEV_ALLOWED,
	PLANNING_ALLOWED,
	REVIEW_ALLOWED,
	WAVE_ALLOWED,
	buildTool,
	defaultCwSpawner,
} from "../index.ts";

// ── fake spawner 工具 ───────────────────────────────────────────

interface CapturedCall {
	args: string[];
	input: string | undefined;
	cwd: string;
}

/** 造一个按队列返回预设结果的 spawner，并记录每次调用参数。 */
function fakeSpawner(responses: CwSpawnResult[]): { spawner: CwSpawner; calls: CapturedCall[] } {
	const calls: CapturedCall[] = [];
	let i = 0;
	const spawner: CwSpawner = vi.fn(async (args, input, cwd, _signal): Promise<CwSpawnResult> => {
		// 门控 probe（['--version']）是内部细节：返回低版本（不支持归一化）让 write action
		// 走兜底路径，且不入 calls（测试断言的是 action 调用，probe 透明）。
		if (args[0] === "--version") {
			return { stdout: "cw 1.0.0", stderr: "", exitCode: 0 };
		}
		calls.push({ args, input, cwd });
		const r = responses[i] ?? { stdout: "", stderr: "", exitCode: 0 };
		i += 1;
		return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
	});
	return { spawner, calls };
}

/** 造一个「若被调用即失败」的 spawner（用于白名单拒绝用例，断言不该被调到）。 */
function forbiddenSpawner(): CwSpawner {
	// 回调签名由变量类型 CwSpawner 提供 contextual typing；签名漂移会编译失败（消除假绿）。
	const spawner: CwSpawner = vi.fn(async (_args, _input, _cwd, _signal): Promise<CwSpawnResult> => {
		throw new Error("spawner must not be called for a rejected action");
	});
	return spawner;
}

// execute 的 ctx 是完整 ExtensionContext（SDK 类型，字段多）；测试仅消费 cwd。
// satisfies 校验 cwd 形状，再经 unknown 桥接到完整类型（partial mock of SDK type）。
const fakeCtx = ({
	cwd: "/tmp/fake-workspace",
} satisfies Pick<ExtensionContext, "cwd">) as unknown as ExtensionContext;

// ── 白名单拦截：每个工具至少 1 个被拒 action ────────────────────

describe("白名单拦截（executeCwAction）", () => {
	const cases: Array<{
		name: string;
		allowed: readonly string[];
		reject: string;
	}> = [
		{ name: "cw_planning", allowed: PLANNING_ALLOWED, reject: "design-review" },
		{ name: "cw_planning", allowed: PLANNING_ALLOWED, reject: "exec-review" },
		{ name: "cw_wave", allowed: WAVE_ALLOWED, reject: "execute" },
		{ name: "cw_wave", allowed: WAVE_ALLOWED, reject: "test" },
		{ name: "cw_wave", allowed: WAVE_ALLOWED, reject: "design-review" },
		{ name: "cw_wave", allowed: WAVE_ALLOWED, reject: "exec-review" },
		{ name: "cw_dev", allowed: DEV_ALLOWED, reject: "design-review" },
		{ name: "cw_dev", allowed: DEV_ALLOWED, reject: "clarify" },
		{ name: "cw_review", allowed: REVIEW_ALLOWED, reject: "execute" },
		{ name: "cw_review", allowed: REVIEW_ALLOWED, reject: "plan" },
		{ name: "cw_review", allowed: REVIEW_ALLOWED, reject: "test" },
	];

	for (const { name, allowed, reject } of cases) {
		it(`${name} 拒绝 "${reject}"（不在白名单，spawner 不被调用）`, async () => {
			const spawner = forbiddenSpawner();
			const details = await executeCwAction(
				reject,
				allowed,
				name,
				"unit-1",
				{},
				spawner,
				fakeCtx.cwd,
			);

			expect(details.ok).toBe(false);
			if (details.ok) throw new Error("unreachable");
			expect(details.error).toContain(reject);
			expect(details.error).toContain(name);
			expect(spawner).not.toHaveBeenCalled();
		});
	}

	it("rejectDisallowedAction 直接返回含 action 与工具名的消息", () => {
		const msg = rejectDisallowedAction("execute", REVIEW_ALLOWED, "cw_review");
		expect(msg).toContain('"execute"');
		expect(msg).toContain("cw_review");
		expect(rejectDisallowedAction("status", REVIEW_ALLOWED, "cw_review")).toBeUndefined();
	});
});

// ── 允许的 action：mock spawn，不真调 cw ────────────────────────

describe("允许的 action（mock spawn）", () => {
	const okCases: Array<{ name: string; allowed: readonly string[]; action: string }> = [
		{ name: "cw_planning", allowed: PLANNING_ALLOWED, action: "design" },
		{ name: "cw_planning", allowed: PLANNING_ALLOWED, action: "execute" },
		{ name: "cw_wave", allowed: WAVE_ALLOWED, action: "design" },
		{ name: "cw_dev", allowed: DEV_ALLOWED, action: "execute" },
		{ name: "cw_dev", allowed: DEV_ALLOWED, action: "test" },
		{ name: "cw_review", allowed: REVIEW_ALLOWED, action: "design-review" },
		{ name: "cw_review", allowed: REVIEW_ALLOWED, action: "exec-review" },
	];

	for (const { name, allowed, action } of okCases) {
		it(`${name} 允许 "${action}"：stdout 是 JSON → ok:true + parsed data`, async () => {
			const payload = { nextAction: { command: `cw ${action}` }, ok: true };
			const { spawner, calls } = fakeSpawner([
				{ stdout: JSON.stringify(payload), stderr: "", exitCode: 0 },
			]);

			const details = await executeCwAction(
				action,
				allowed,
				name,
				"unit-42",
				{},
				spawner,
				fakeCtx.cwd,
			);

			expect(details.ok).toBe(true);
			if (!details.ok) throw new Error("unreachable");
			expect(details.action).toBe(action);
			expect(details.unitId).toBe("unit-42");
			expect(details.parsed).toBe(true);
			if (!details.parsed) throw new Error("unreachable");
			expect(details.data).toEqual(payload);

			// 参数构造正确：cwd 透传，args 含 action + --unitId
			expect(calls).toHaveLength(1);
			expect(calls[0].cwd).toBe(fakeCtx.cwd);
			expect(calls[0].args[0]).toBe(action);
			expect(calls[0].args).toContain("--unitId");
			expect(calls[0].args).toContain("unit-42");
		});
	}

	it("stdout 非 JSON → ok:true + parsed:false + 原样 stdout", async () => {
		const { spawner } = fakeSpawner([{ stdout: "not a json", stderr: "", exitCode: 0 }]);
		const details = await executeCwAction(
			"status",
			DEV_ALLOWED,
			"cw_dev",
			"u1",
			{},
			spawner,
			fakeCtx.cwd,
		);
		expect(details.ok).toBe(true);
		if (!details.ok || details.parsed) throw new Error("unreachable");
		expect(details.stdout).toBe("not a json");
	});

	it("空 stdout（cw 成功但无输出）→ ok:true + parsed:false", async () => {
		const { spawner } = fakeSpawner([{ stdout: "   ", stderr: "", exitCode: 0 }]);
		const details = await executeCwAction(
			"status",
			DEV_ALLOWED,
			"cw_dev",
			"u1",
			{},
			spawner,
			fakeCtx.cwd,
		);
		expect(details.ok).toBe(true);
	});
});

// ── 失败路径 ────────────────────────────────────────────────────

describe("失败路径", () => {
	it("非零退出码 → ok:false + 含 exit code + stderr", async () => {
		const { spawner } = fakeSpawner([
			{ stdout: "", stderr: "unit not found", exitCode: 1 },
		]);
		const details = await executeCwAction(
			"status",
			DEV_ALLOWED,
			"cw_dev",
			"missing",
			{},
			spawner,
			fakeCtx.cwd,
		);
		expect(details.ok).toBe(false);
		if (details.ok) throw new Error("unreachable");
		expect(details.error).toContain("exit code 1");
		expect(details.error).toContain("unit not found");
	});

	it("stderr 非空但 exitCode 0 → ok:true（S-2：按 exitCode 判定，stderr 不导致失败）", async () => {
		const { spawner } = fakeSpawner([
			{ stdout: "{}", stderr: "warning: something", exitCode: 0 },
		]);
		const details = await executeCwAction(
			"status",
			DEV_ALLOWED,
			"cw_dev",
			"u1",
			{},
			spawner,
			fakeCtx.cwd,
		);
		expect(details.ok).toBe(true);
	});

	it("spawner 抛异常 → ok:false + spawn 失败消息", async () => {
		const spawner: CwSpawner = vi.fn(async (_args, _input, _cwd, _signal): Promise<CwSpawnResult> => {
			throw new Error("ENOENT");
		});
		const details = await executeCwAction(
			"status",
			DEV_ALLOWED,
			"cw_dev",
			"u1",
			{},
			spawner,
			fakeCtx.cwd,
		);
		expect(details.ok).toBe(false);
		if (details.ok) throw new Error("unreachable");
		expect(details.error).toContain("ENOENT");
	});

	it("input 与 inputFile 同时给 → ok:false（互斥）", async () => {
		const spawner = forbiddenSpawner();
		const details = await executeCwAction(
			"design",
			PLANNING_ALLOWED,
			"cw_planning",
			"u1",
			{ input: "{}", inputFile: "/tmp/x.json" },
			spawner,
			fakeCtx.cwd,
		);
		expect(details.ok).toBe(false);
		if (details.ok) throw new Error("unreachable");
		expect(details.error).toContain("互斥");
		expect(spawner).not.toHaveBeenCalled();
	});

	it("spawn 超时（timeoutMs）→ ok:false 'cw 超时'", async () => {
		// spawner 模拟 cw 卡死：挂起直到 signal abort 才 resolve（默认实现行为）。
		const hangingSpawner: CwSpawner = vi.fn((_args, _input, _cwd, signal): Promise<CwSpawnResult> =>
			new Promise<CwSpawnResult>((resolve) => {
				signal?.addEventListener("abort", () =>
					resolve({ stdout: "", stderr: "", exitCode: null }),
				);
			}),
		);

		const details = await executeCwAction(
			"status",
			DEV_ALLOWED,
			"cw_dev",
			"u1",
			{},
			hangingSpawner,
			fakeCtx.cwd,
			undefined,
			50,
		);

		expect(details.ok).toBe(false);
		if (details.ok) throw new Error("unreachable");
		expect(details.error).toBe("cw 超时");
	});
});

// ── 参数构造 ────────────────────────────────────────────────────

describe("buildCwArgs", () => {
	it("无 input：仅 action + --unitId", () => {
		expect(buildCwArgs("status", "u1", {})).toEqual(["status", "--unitId", "u1"]);
	});

	it("input 内容 → --input - （经 stdin）", () => {
		expect(buildCwArgs("design", "u1", { input: '{"a":1}' })).toEqual([
			"design",
			"--unitId",
			"u1",
			"--input",
			"-",
		]);
	});

	it("inputFile 路径 → --input <path>", () => {
		expect(buildCwArgs("design", "u1", { inputFile: "/tmp/in.json" })).toEqual([
			"design",
			"--unitId",
			"u1",
			"--input",
			"/tmp/in.json",
		]);
	});

	it("commitHash → --commitHash", () => {
		expect(buildCwArgs("execute", "u1", { commitHash: "abc123" })).toEqual([
			"execute",
			"--unitId",
			"u1",
			"--commitHash",
			"abc123",
		]);
	});

	it("input + commitHash 同时", () => {
		expect(buildCwArgs("execute", "u1", { input: "{}", commitHash: "abc" })).toEqual([
			"execute",
			"--unitId",
			"u1",
			"--input",
			"-",
			"--commitHash",
			"abc",
		]);
	});

	it("workspace → 追加 --workspace <path>（位于 --commitHash 之后）", () => {
		expect(buildCwArgs("execute", "u1", { commitHash: "abc" }, "/tmp/repo-root")).toEqual([
			"execute",
			"--unitId",
			"u1",
			"--commitHash",
			"abc",
			"--workspace",
			"/tmp/repo-root",
		]);
	});

	it("workspace 不传 → 无 --workspace", () => {
		expect(buildCwArgs("status", "u1", {})).toEqual(["status", "--unitId", "u1"]);
	});

	it("unitId 为 undefined → 不加 --unitId（只读 action，S-5）", () => {
		expect(buildCwArgs("list", undefined, {})).toEqual(["list"]);
	});
});

// ── stdin 透传 ──────────────────────────────────────────────────

describe("stdin 透传", () => {
	it("input 内容写入 spawner 的 input 参数", async () => {
		const { spawner, calls } = fakeSpawner([{ stdout: "{}", stderr: "", exitCode: 0 }]);
		await executeCwAction(
			"design",
			PLANNING_ALLOWED,
			"cw_planning",
			"u1",
			{ input: '{"plan":"x"}' },
			spawner,
			fakeCtx.cwd,
		);
		expect(calls[0].input).toBe('{"plan":"x"}');
	});

	it("无 input → spawner input 为 undefined", async () => {
		const { spawner, calls } = fakeSpawner([{ stdout: "{}", stderr: "", exitCode: 0 }]);
		await executeCwAction(
			"status",
			PLANNING_ALLOWED,
			"cw_planning",
			"u1",
			{},
			spawner,
			fakeCtx.cwd,
		);
		expect(calls[0].input).toBeUndefined();
	});
});

// ── executeCwAction 接线：spawnSync 探测结果 → --workspace 附加 ─────

// 说明：本文件 mock 了 node:child_process（spawnSync 默认失败），此处验证接线逻辑；
// 真实 git 探测行为见 detect-repo-workspace.test.ts（真实 git repo + worktree）。
describe("executeCwAction 附加 --workspace（spawnSync mock）", () => {
	afterEach(() => {
		spawnSyncMock.mockReset();
		spawnSyncMock.mockImplementation((_cmd: string, _args: string[], _opts: object) => ({
			status: 128,
			stdout: "",
			stderr: "not a git repository",
		}));
	});

	it("cwd 在 git repo 内 → args 含 --workspace <repo 根>（--commitHash 之后）", async () => {
		spawnSyncMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: object) => ({
			status: 0,
			stdout: "/tmp/repo-root/.git\n",
			stderr: "",
		}));
		const { spawner, calls } = fakeSpawner([{ stdout: "{}", stderr: "", exitCode: 0 }]);
		await executeCwAction(
			"execute",
			DEV_ALLOWED,
			"cw_dev",
			"u1",
			{ commitHash: "abc123" },
			spawner,
			"/tmp/repo-root/worktrees/wt1",
		);
		expect(calls[0].args).toEqual([
			"execute",
			"--unitId",
			"u1",
			"--commitHash",
			"abc123",
			"--workspace",
			"/tmp/repo-root",
		]);
	});

	it("cwd 非 git（探测失败）→ write action 无 --workspace", async () => {
		const { spawner, calls } = fakeSpawner([{ stdout: "{}", stderr: "", exitCode: 0 }]);
		await executeCwAction(
			"execute",
			DEV_ALLOWED,
			"cw_dev",
			"u1",
			{},
			spawner,
			"/tmp/not-a-repo",
		);
		expect(calls[0].args).toEqual(["execute", "--unitId", "u1"]);
	});

	it("read-only action（status）即使在 git repo 内也不附加 --workspace（S-3）", async () => {
		spawnSyncMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: object) => ({
			status: 0,
			stdout: "/tmp/repo-root/.git\n",
			stderr: "",
		}));
		const { spawner, calls } = fakeSpawner([{ stdout: "{}", stderr: "", exitCode: 0 }]);
		await executeCwAction(
			"status",
			DEV_ALLOWED,
			"cw_dev",
			"u1",
			{},
			spawner,
			"/tmp/repo-root/worktrees/wt1",
		);
		expect(calls[0].args).not.toContain("--workspace");
	});
});

// ── unitId 运行时校验（S-5）────────────────────────────────────

describe("unitId 运行时校验（S-5）", () => {
	it("写 action 缺 unitId → ok:false + 清晰错误（含 action 名 + unitId），spawner 不被调用", async () => {
		const spawner = forbiddenSpawner();
		const details = await executeCwAction(
			"execute",
			DEV_ALLOWED,
			"cw_dev",
			undefined,
			{},
			spawner,
			fakeCtx.cwd,
		);
		expect(details.ok).toBe(false);
		if (details.ok) throw new Error("unreachable");
		expect(details.error).toContain("execute");
		expect(details.error).toContain("unitId");
		expect(spawner).not.toHaveBeenCalled();
	});

	it("只读 action 缺 unitId → ok:true，args 不含 --unitId", async () => {
		const { spawner, calls } = fakeSpawner([{ stdout: "{}", stderr: "", exitCode: 0 }]);
		const details = await executeCwAction(
			"status",
			DEV_ALLOWED,
			"cw_dev",
			undefined,
			{},
			spawner,
			fakeCtx.cwd,
		);
		expect(details.ok).toBe(true);
		expect(calls[0].args).not.toContain("--unitId");
	});

	it("只读 action 传 unitId 仍附加 --unitId（Optional 非禁止）", async () => {
		const { spawner, calls } = fakeSpawner([{ stdout: "{}", stderr: "", exitCode: 0 }]);
		await executeCwAction("list", PLANNING_ALLOWED, "cw_planning", "u1", {}, spawner, fakeCtx.cwd);
		expect(calls[0].args).toContain("--unitId");
		expect(calls[0].args).toContain("u1");
	});

	it("rejectMissingUnitId：写 action 缺 → 错误消息；只读 action 缺 → undefined", () => {
		expect(rejectMissingUnitId("execute", undefined)).toContain("unitId");
		expect(rejectMissingUnitId("design", undefined)).toContain("unitId");
		expect(rejectMissingUnitId("execute", "u1")).toBeUndefined();
		expect(rejectMissingUnitId("list", undefined)).toBeUndefined();
		expect(rejectMissingUnitId("status", undefined)).toBeUndefined();
		expect(rejectMissingUnitId("frontier", undefined)).toBeUndefined();
	});

	it("isReadonlyAction：READONLY_ACTIONS → true，写 action / 未知 action → false", () => {
		for (const ro of ["list", "tree", "status", "handoff", "frontier"]) {
			expect(isReadonlyAction(ro)).toBe(true);
		}
		expect(isReadonlyAction("execute")).toBe(false);
		expect(isReadonlyAction("design")).toBe(false);
		expect(isReadonlyAction("unknown-action")).toBe(false);
	});
});

// ── 工厂注册 + buildTool 集成 ───────────────────────────────────

describe("工厂与工具注册", () => {
	it("cwToolExtension(pi) 注册 4 个工具（cw_planning/cw_wave/cw_dev/cw_review）", async () => {
		const { default: cwToolExtension } = await import("../index.ts");
		const registered: Array<{ name: string; actionEnum: string[] }> = [];
		// 仅 mock registerTool（ExtensionAPI 其余成员测试不消费）；显式声明 tool 参数形状，
		// 让对 tool.name / parameters 的访问受类型检查；经 unknown 桥接到完整 ExtensionAPI。
		const fakePi = {
			registerTool(tool: { name: string; parameters: { properties?: Record<string, unknown> } }): void {
				const enumVal = (tool.parameters.properties?.action as { enum?: string[] })?.enum;
				registered.push({ name: tool.name, actionEnum: enumVal ?? [] });
			},
		} as unknown as ExtensionAPI;
		cwToolExtension(fakePi);

		const names = registered.map((r) => r.name);
		expect(names).toEqual(["cw_planning", "cw_wave", "cw_dev", "cw_review"]);
		// schema 的 action 枚举值与白名单数组逐项深相等（schema 即运行时第一道约束，
		// 与 executeCwAction 第二道 rejectDisallowedAction 同源）。
		const byName = Object.fromEntries(registered.map((r) => [r.name, r.actionEnum]));
		expect(byName.cw_planning).toEqual([...PLANNING_ALLOWED]);
		expect(byName.cw_wave).toEqual([...WAVE_ALLOWED]);
		expect(byName.cw_dev).toEqual([...DEV_ALLOWED]);
		expect(byName.cw_review).toEqual([...REVIEW_ALLOWED]);
	});

	it("buildTool execute 端到端：拒绝路径返回 ok:false（带工具名）", async () => {
		const tool = buildTool(REVIEW_ALLOWED, {
			name: "cw_review",
			label: "CW Review",
			description: "x",
			promptSnippet: "x",
		}, forbiddenSpawner());

		// execute 全签名：(_toolCallId, params, signal, onUpdate, ctx)
		// 故意传 review 工具不允许的 action "execute" 验证运行时拒绝；类型层须逃逸（Params 的 action 枚举不含 execute）。
		type Params = Parameters<(typeof tool)["execute"]>[1];
		const params = { action: "execute", unitId: "u1" } as unknown as Params;
		const result = await tool.execute("call-1", params, undefined, undefined, fakeCtx);

		const details = result.details as CwDetails;
		expect(details.ok).toBe(false);
		if (details.ok) throw new Error("unreachable");
		expect(details.error).toContain("execute");
		expect(details.error).toContain("cw_review");
	});

	it("buildTool execute 端到端：允许路径透传到 spawner", async () => {
		const { spawner, calls } = fakeSpawner([{ stdout: '{"ok":true}', stderr: "", exitCode: 0 }]);
		const tool = buildTool(REVIEW_ALLOWED, {
			name: "cw_review",
			label: "CW Review",
			description: "x",
			promptSnippet: "x",
		}, spawner);

		type Params = Parameters<(typeof tool)["execute"]>[1];
		const params: Params = { action: "design-review", unitId: "u9", input: '{"verdict":"pass"}' };
		const result = await tool.execute("call-2", params, undefined, undefined, fakeCtx);

		const details = result.details as CwDetails;
		expect(details.ok).toBe(true);
		expect(calls[0].args).toEqual(["design-review", "--unitId", "u9", "--input", "-"]);
		expect(calls[0].input).toBe('{"verdict":"pass"}');
	});

	it("buildTool execute：abort signal → ok:false aborted", async () => {
		const tool = buildTool(REVIEW_ALLOWED, {
			name: "cw_review",
			label: "CW Review",
			description: "x",
			promptSnippet: "x",
		}, forbiddenSpawner());

		const controller = new AbortController();
		controller.abort();
		type Params = Parameters<(typeof tool)["execute"]>[1];
		const params: Params = { action: "status", unitId: "u1" };
		const result = await tool.execute(
			"call-3",
			params,
			controller.signal,
			undefined,
			fakeCtx,
		);
		expect((result.details as CwDetails).ok).toBe(false);
	});

	it("schema：unitId 是 Optional（不在 required），action 是 required（S-5）", () => {
		const tool = buildTool(DEV_ALLOWED, {
			name: "cw_dev",
			label: "CW Dev",
			description: "x",
			promptSnippet: "x",
		}, forbiddenSpawner());
		const required = (tool.parameters as { required?: string[] }).required ?? [];
		expect(required).toContain("action");
		expect(required).not.toContain("unitId");
		// unitId 属性仍存在（Optional 不是删除）
		expect(tool.parameters.properties?.unitId).toBeDefined();
	});
});

// ── 白名单表格逐字一致性 ────────────────────────────────────────

describe("白名单与方案表格逐字一致", () => {
	it("cw_planning = design/execute/replan/retrospect/closeout + status/handoff/list/tree/frontier", () => {
		expect([...PLANNING_ALLOWED]).toEqual([
			"design", "execute", "replan", "retrospect", "closeout",
			"status", "handoff", "list", "tree", "frontier",
		]);
	});

	it("cw_wave = 同 planning 但无 execute（也无 test/design-review/exec-review）", () => {
		expect([...WAVE_ALLOWED]).toEqual([
			"design", "replan", "retrospect", "closeout",
			"status", "handoff", "list", "tree", "frontier",
		]);
		for (const forbidden of ["execute", "test", "design-review", "exec-review"]) {
			expect(WAVE_ALLOWED).not.toContain(forbidden);
		}
	});

	it("cw_dev = execute/test + status/handoff", () => {
		expect([...DEV_ALLOWED]).toEqual(["execute", "test", "status", "handoff"]);
	});

	it("cw_review = design-review/exec-review + status", () => {
		expect([...REVIEW_ALLOWED]).toEqual(["design-review", "exec-review", "status"]);
	});
});

// ── cw 路径无硬编码 + 子进程生命周期（defaultCwSpawner）────────

describe("cw 路径解析", () => {
	// 造一个满足 defaultCwSpawner 调用的假子进程（stdout/stderr 带 setEncoding，stdin write/end，可选 kill）。
	function makeFakeChild(): EventEmitter {
		const child = new EventEmitter();
		const stdio = (): EventEmitter => {
			const s = new EventEmitter();
			(s as unknown as { setEncoding: (_e: string) => void }).setEncoding = () => {};
			return s;
		};
		Object.assign(child, {
			stdout: stdio(),
			stderr: stdio(),
			stdin: { write() {}, end() {} },
		});
		return child;
	}

	afterEach(() => {
		spawnMock.mockReset();
	});

	it("defaultCwSpawner spawn 裸名 'cw'（经 PATH 解析，无硬编码绝对路径）", async () => {
		const child = makeFakeChild();
		spawnMock.mockImplementation(() => child as unknown as cp.ChildProcess);
		queueMicrotask(() => child.emit("close", 0));
		await defaultCwSpawner(["status", "--unitId", "u1"], undefined, "/tmp");
		expect(spawnMock).toHaveBeenCalledTimes(1);
		// 第一参是命令名：裸名 "cw"，不是任何绝对路径
		expect((spawnMock.mock.calls[0] as unknown[])[0]).toBe("cw");
	});

	it("abort signal 触发时 defaultCwSpawner kill 子进程（SIGTERM）", async () => {
		const child = makeFakeChild();
		// kill 模拟真实子进程收到信号后退出：调度 close 事件让 promise resolve
		const killed = vi.fn((_sig: string) => {
			queueMicrotask(() => child.emit("close", null));
		});
		(child as unknown as { kill: (s: string) => void }).kill = killed;
		spawnMock.mockImplementation(() => child as unknown as cp.ChildProcess);

		const controller = new AbortController();
		const pending = defaultCwSpawner(["status"], undefined, "/tmp", controller.signal);
		controller.abort();
		await pending;
		expect(killed).toHaveBeenCalledWith("SIGTERM");
	});

	it("spawn error（cw 不在 PATH / ENOENT）→ exitCode:-1 + stderr 含 [spawn error]", async () => {
		// 模拟 cw 不在 PATH（用户首要失败模式）：node 对失败的 spawn 触发 child 'error' 事件。
		// 若 defaultCwSpawner 的 error handler 被删，promise 永不 resolve（直到 5min 超时）→ 用例挂死暴露回归。
		const child = makeFakeChild();
		spawnMock.mockImplementation(() => child as unknown as cp.ChildProcess);
		const err = Object.assign(new Error("spawn cw ENOENT"), { code: "ENOENT" });
		queueMicrotask(() => child.emit("error", err));

		const result = await defaultCwSpawner(["status", "--unitId", "u1"], undefined, "/tmp");

		expect(result.exitCode).toBe(-1);
		expect(result.stderr).toContain("[spawn error]");
		expect(result.stderr).toContain("spawn cw ENOENT");
		expect(result.stdout).toBe("");
	});

	it("[worktree-reaper-fix] cwd 不存在 → 不 spawn，exitCode:-1 + 可操作错误（含 cwd 路径与恢复指引）", async () => {
		// worktree 被 orphan reaper 误删后，子进程 cwd 指向虚空。spawn 前检查必须拦截并返回
		// 含完整 cwd + 恢复指引的错误（否则 Node ENOENT 只报 command 名，误导诊断为"node 被卸载"）。
		const result = await defaultCwSpawner(
			["status", "--unitId", "u1"],
			undefined,
			"/nonexistent-cwd-for-reaper-test",
		);

		expect(result.exitCode).toBe(-1);
		expect(result.stderr).toContain("/nonexistent-cwd-for-reaper-test");
		expect(result.stderr).toContain("worktrees.json");
		// 前置检查拦截：不进入 spawn
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("[worktree-reaper-fix] spawn error ENOENT → stderr 拼 cwd 路径（TOCTOU 兜底）", async () => {
		// existsSync 检查通过后目录被删（TOCTOU）：error handler 必须兜底拼 cwd。
		const child = makeFakeChild();
		spawnMock.mockImplementation(() => child as unknown as cp.ChildProcess);
		const err = Object.assign(new Error("spawn cw ENOENT"), { code: "ENOENT" });
		queueMicrotask(() => child.emit("error", err));

		const result = await defaultCwSpawner(["status", "--unitId", "u1"], undefined, "/tmp");

		expect(result.exitCode).toBe(-1);
		expect(result.stderr).toContain("cwd: /tmp");
	});
});
