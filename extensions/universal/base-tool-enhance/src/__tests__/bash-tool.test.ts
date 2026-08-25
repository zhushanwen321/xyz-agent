// src/__tests__/bash-tool.test.ts —— M1 前台委托回归 + M2 background 分支接入
import { describe, expect, it, vi } from "vitest";

// mock pi 官方工厂：前台行为是委托（方案 B），测试断言「透传面」而非真实 spawn
// 行为——真实行为由 pi 上游保证 + 探针 P2 实测。
const { createBashToolDefinitionMock, officialExecuteMock } = vi.hoisted(() => ({
	createBashToolDefinitionMock: vi.fn(),
	officialExecuteMock: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: createBashToolDefinitionMock,
	getAgentDir: () => "/tmp/bte-fake-agent-dir",
}));

// mock spawn-background：background 分支的生命周期由 background-lifecycle.test.ts
// 真实测，这里只断言「分支路由正确 + 参数传递正确」。
const { spawnBackgroundTaskMock, resolveTimeoutMock, isSubagentMock } = vi.hoisted(() => ({
	spawnBackgroundTaskMock: vi.fn(),
	resolveTimeoutMock: vi.fn((sec: number | undefined) => sec),
	isSubagentMock: vi.fn(() => false),
}));
vi.mock("../background/spawn-background.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../background/spawn-background.ts")>();
	return {
		...orig,
		spawnBackgroundTask: spawnBackgroundTaskMock,
		resolveBackgroundTimeoutSec: resolveTimeoutMock,
	};
});
vi.mock("../background/subagent-guard.ts", () => ({
	isSubagentProcess: isSubagentMock,
}));

import { createBashOverrideToolDefinition } from "../bash-tool.ts";

function createOfficialFactoryResult(cwd: string) {
	return {
		name: "bash",
		label: "bash",
		description: `official description for ${cwd}`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: ["You can inspect PI_* environment variables for current model and session details."],
		parameters: { type: "object", properties: {} },
		execute: officialExecuteMock,
	};
}

function setupFactory() {
	createBashToolDefinitionMock.mockReset();
	officialExecuteMock.mockReset();
	spawnBackgroundTaskMock.mockReset();
	resolveTimeoutMock.mockClear();
	isSubagentMock.mockReset();
	isSubagentMock.mockReturnValue(false);
	resolveTimeoutMock.mockImplementation((sec: number | undefined) => sec);
	createBashToolDefinitionMock.mockImplementation((_cwd: string) => createOfficialFactoryResult(_cwd));
}

const CWD = "/tmp/bte-workdir";

function createCtx() {
	return { cwd: CWD, sessionManager: { getSessionId: () => "sess-1" } };
}

describe("createBashOverrideToolDefinition", () => {
	it("overrides the builtin bash tool by name and passes through official label", () => {
		setupFactory();
		const tool = createBashOverrideToolDefinition();
		expect(tool.name).toBe("bash");
		expect(tool.label).toBe("bash");
	});

	it("extends the official schema with optional background (command required, timeout/background optional)", () => {
		setupFactory();
		const tool = createBashOverrideToolDefinition();
		// typebox JSON Schema 形态：Optional 键不进 required
		expect(tool.parameters.type).toBe("object");
		const params = tool.parameters as unknown as {
			required: string[];
			properties: Record<string, { type: string }>;
		};
		expect(params.required).toEqual(["command"]);
		expect(params.properties.command?.type).toBe("string");
		expect(params.properties.timeout?.type).toBe("number");
		expect(params.properties.background?.type).toBe("boolean");
	});

	it("rewrites description to cover background usage (task_id / bash_output / bash_kill / whitelist / timeout)", () => {
		setupFactory();
		const tool = createBashOverrideToolDefinition();
		expect(tool.description).not.toContain("official description");
		expect(tool.description).toContain("background: true");
		expect(tool.description).toContain("task_id");
		expect(tool.description).toContain("bash_output");
		expect(tool.description).toContain("bash_kill");
		// 白名单自动转后台 + timeout 显式值被尊重（除白名单强转后台例外）
		expect(tool.description).toContain("whitelist");
		expect(tool.description).toContain("timeout in seconds");
	});

	it("passes through official promptSnippet/promptGuidelines (system-prompt parity)", () => {
		setupFactory();
		const tool = createBashOverrideToolDefinition();
		expect(tool.promptSnippet).toBe("Execute bash commands (ls, grep, find, etc.)");
		expect(tool.promptGuidelines).toEqual([
			"You can inspect PI_* environment variables for current model and session details.",
		]);
	});

	it("delegates execute to the official factory execute with recognized fields only (background stripped)", async () => {
		setupFactory();
		const expectedResult = { content: [{ type: "text" as const, text: "hi" }], details: undefined };
		officialExecuteMock.mockResolvedValue(expectedResult);

		const tool = createBashOverrideToolDefinition();
		const ctx = createCtx();
		const signal = new AbortController().signal;
		const onUpdate = vi.fn();

		const result = await tool.execute(
			"call-1",
			{ command: "echo hi", timeout: 30 },
			signal,
			onUpdate,
			ctx as never,
		);

		// 前台委托：全部参数透传，返回值透传；background 是本包增量字段，不进官方入参
		expect(officialExecuteMock).toHaveBeenCalledTimes(1);
		expect(officialExecuteMock).toHaveBeenCalledWith(
			"call-1",
			{ command: "echo hi", timeout: 30 },
			signal,
			onUpdate,
			ctx,
		);
		expect(result).toBe(expectedResult);
		expect(spawnBackgroundTaskMock).not.toHaveBeenCalled();
	});

	it("delegates without timeout when absent (undefined preserved)", async () => {
		setupFactory();
		officialExecuteMock.mockResolvedValue({ content: [], details: undefined });
		const tool = createBashOverrideToolDefinition();

		await tool.execute("call-2", { command: "ls" }, undefined, undefined, createCtx() as never);

		expect(officialExecuteMock).toHaveBeenCalledWith(
			"call-2",
			{ command: "ls", timeout: undefined },
			undefined,
			undefined,
			expect.anything(),
		);
	});

	it("builds the delegate with ctx.cwd (authoritative) and caches per cwd", async () => {
		setupFactory();
		officialExecuteMock.mockResolvedValue({ content: [], details: undefined });
		const tool = createBashOverrideToolDefinition();

		// load 时刻初始 delegate 用 process.cwd()
		expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(1);
		expect(createBashToolDefinitionMock).toHaveBeenCalledWith(process.cwd());

		// execute 的 ctx.cwd 与缓存不一致 → 以 ctx.cwd 重建
		await tool.execute("c1", { command: "ls" }, undefined, undefined, { cwd: "/tmp/alt" } as never);
		expect(createBashToolDefinitionMock).toHaveBeenCalledWith("/tmp/alt");
		expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(2);

		// 同 cwd 复用缓存（不再新建）
		await tool.execute("c2", { command: "ls" }, undefined, undefined, { cwd: "/tmp/alt" } as never);
		expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(2);

		// cwd 再变 → 重建
		await tool.execute("c3", { command: "ls" }, undefined, undefined, { cwd: "/tmp/alt2" } as never);
		expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(3);
	});
});

describe("background branch routing (M2)", () => {
	it("background:true routes to spawnBackgroundTask with ctx-derived paths and returns task_id message", async () => {
		setupFactory();
		spawnBackgroundTaskMock.mockReturnValue({
			ok: true,
			task: {
				taskId: "bt-1724589012-a3f7",
				pid: 12345,
				command: "sleep 5 && echo done",
				outputFile: "/tmp/bte-fake-agent-dir/base-tool-enhance/sess-1/bt-1724589012-a3f7.log",
				registryPath: "/tmp/registry.json",
				startedAt: 1,
				state: "running",
				ownerPiPid: process.pid,
				sessionId: "sess-1",
			},
		});

		const tool = createBashOverrideToolDefinition();
		const result = await tool.execute(
			"call-bg",
			{ command: "sleep 5 && echo done", background: true, timeout: 60 },
			new AbortController().signal,
			undefined,
			createCtx() as never,
		);

		// 不走前台委托
		expect(officialExecuteMock).not.toHaveBeenCalled();
		expect(spawnBackgroundTaskMock).toHaveBeenCalledWith({
			command: "sleep 5 && echo done",
			cwd: CWD,
			dataDir: "/tmp/bte-fake-agent-dir",
			sessionId: "sess-1",
			timeoutSec: 60,
		});

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("bt-1724589012-a3f7");
		expect(text).toContain("pid: 12345");
		expect(text).toContain("Output file:");
		expect(text).toContain('bash_output {task_id:"bt-1724589012-a3f7"}');
	});

	it("background spawn failure surfaces the error", async () => {
		setupFactory();
		spawnBackgroundTaskMock.mockReturnValue({
			ok: false,
			error: "Background task limit reached (max 8 concurrent).",
		});
		const tool = createBashOverrideToolDefinition();
		await expect(
			tool.execute("call-bg-err", { command: "x", background: true }, undefined, undefined, createCtx() as never),
		).rejects.toThrow(/limit reached/);
	});

	it("D14: subagent process ignores background and delegates to foreground", async () => {
		setupFactory();
		isSubagentMock.mockReturnValue(true);
		officialExecuteMock.mockResolvedValue({ content: [{ type: "text", text: "sync" }], details: undefined });

		const tool = createBashOverrideToolDefinition();
		const result = await tool.execute(
			"call-sub",
			{ command: "echo sync", background: true },
			undefined,
			undefined,
			createCtx() as never,
		);

		expect(spawnBackgroundTaskMock).not.toHaveBeenCalled();
		expect(officialExecuteMock).toHaveBeenCalledTimes(1);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toBe("sync");
	});
});
