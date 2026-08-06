/**
 * cw-tool 测试。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 * 不真调 cw：通过 fake spawner 注入。白名单拦截在 spawn 之前，故拒绝用例断言 spawner 未被调用。
 */
import { EventEmitter } from "node:events";
import type * as cp from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

// node:child_process 是原生 CJS 模块，ESM 命名导出不可重定义（vi.spyOn 报 "not configurable"）。
// 改用 vi.mock + vi.hoisted：工厂替换整个模块，hoisted vi.fn 作为 spawn，测试内动态配置实现。
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
	buildCwArgs,
	type CwDetails,
	type CwSpawner,
	type CwSpawnResult,
	executeCwAction,
	rejectDisallowedAction,
} from "../cw-runner.ts";
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
		calls.push({ args, input, cwd });
		const r = responses[i] ?? { stdout: "", stderr: "", exitCode: 0 };
		i += 1;
		return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
	});
	return { spawner, calls };
}

/** 造一个「若被调用即失败」的 spawner（用于白名单拒绝用例，断言不该被调到）。 */
function forbiddenSpawner(): CwSpawner {
	return vi.fn(async (): Promise<CwSpawnResult> => {
		throw new Error("spawner must not be called for a rejected action");
	}) as unknown as CwSpawner;
}

const fakeCtx = { cwd: "/tmp/fake-workspace" } as { cwd: string };

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
		{ name: "cw_planning", allowed: PLANNING_ALLOWED, action: "plan" },
		{ name: "cw_planning", allowed: PLANNING_ALLOWED, action: "execute" },
		{ name: "cw_wave", allowed: WAVE_ALLOWED, action: "plan" },
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

	it("stderr 非空（即使 exit 0）→ ok:false", async () => {
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
		expect(details.ok).toBe(false);
	});

	it("spawner 抛异常 → ok:false + spawn 失败消息", async () => {
		const spawner: CwSpawner = vi.fn(async (): Promise<CwSpawnResult> => {
			throw new Error("ENOENT");
		}) as unknown as CwSpawner;
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
			"plan",
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
		const hangingSpawner: CwSpawner = vi.fn((_args, _input, _cwd, signal) =>
			new Promise<CwSpawnResult>((resolve) => {
				signal?.addEventListener("abort", () =>
					resolve({ stdout: "", stderr: "", exitCode: null }),
				);
			}),
		) as unknown as CwSpawner;

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
		expect(buildCwArgs("plan", "u1", { input: '{"a":1}' })).toEqual([
			"plan",
			"--unitId",
			"u1",
			"--input",
			"-",
		]);
	});

	it("inputFile 路径 → --input <path>", () => {
		expect(buildCwArgs("plan", "u1", { inputFile: "/tmp/in.json" })).toEqual([
			"plan",
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
});

// ── stdin 透传 ──────────────────────────────────────────────────

describe("stdin 透传", () => {
	it("input 内容写入 spawner 的 input 参数", async () => {
		const { spawner, calls } = fakeSpawner([{ stdout: "{}", stderr: "", exitCode: 0 }]);
		await executeCwAction(
			"plan",
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

// ── 工厂注册 + buildTool 集成 ───────────────────────────────────

describe("工厂与工具注册", () => {
	it("cwToolExtension(pi) 注册 4 个工具（cw_planning/cw_wave/cw_dev/cw_review）", async () => {
		const { default: cwToolExtension } = await import("../index.ts");
		const registered: Array<{ name: string; actionEnum: string[] }> = [];
		const fakePi = {
			registerTool(tool: { name: string; parameters: { properties?: Record<string, unknown> } }): void {
				const enumVal = (tool.parameters.properties?.action as { enum?: string[] })?.enum;
				registered.push({ name: tool.name, actionEnum: enumVal ?? [] });
			},
		};
		cwToolExtension(fakePi as never);

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
		const params = { action: "execute", unitId: "u1" } as { action: string; unitId: string };
		const result = await tool.execute("call-1", params as never, undefined, undefined, fakeCtx as never);

		const details = result.details as CwDetails;
		expect(details.ok).toBe(false);
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

		const params = { action: "design-review", unitId: "u9", input: '{"verdict":"pass"}' } as {
			action: string;
			unitId: string;
			input?: string;
		};
		const result = await tool.execute("call-2", params as never, undefined, undefined, fakeCtx as never);

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
		const params = { action: "status", unitId: "u1" } as { action: string; unitId: string };
		const result = await tool.execute(
			"call-3",
			params as never,
			controller.signal,
			undefined,
			fakeCtx as never,
		);
		expect((result.details as CwDetails).ok).toBe(false);
	});
});

// ── 白名单表格逐字一致性 ────────────────────────────────────────

describe("白名单与方案表格逐字一致", () => {
	it("cw_planning = clarify/plan/execute/replan/retrospect/closeout + status/handoff/list/tree/frontier", () => {
		expect([...PLANNING_ALLOWED]).toEqual([
			"clarify", "plan", "execute", "replan", "retrospect", "closeout",
			"status", "handoff", "list", "tree", "frontier",
		]);
	});

	it("cw_wave = 同 planning 但无 execute（也无 test/design-review/exec-review）", () => {
		expect([...WAVE_ALLOWED]).toEqual([
			"clarify", "plan", "replan", "retrospect", "closeout",
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
});
