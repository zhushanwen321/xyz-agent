// src/__tests__/bash-tool.test.ts
import { describe, expect, it, vi } from "vitest";

// mock pi 官方工厂：本模块的前台行为是委托（方案 B），测试断言「透传面」而非真实
// spawn 行为——真实行为由 pi 上游保证 + 探针 P2 实测。
const { createBashToolDefinitionMock, officialExecuteMock } = vi.hoisted(() => ({
	createBashToolDefinitionMock: vi.fn(),
	officialExecuteMock: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: createBashToolDefinitionMock,
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
	createBashToolDefinitionMock.mockImplementation((_cwd: string) =>
		createOfficialFactoryResult(_cwd),
	);
}

function createCtx(cwd: string): { cwd: string } {
	return { cwd };
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
		const expectedResult = { content: [{ type: "text" as const, text: "hi" }] };
		officialExecuteMock.mockResolvedValue(expectedResult);

		const tool = createBashOverrideToolDefinition();
		const ctx = createCtx(process.cwd());
		const signal = new AbortController().signal;
		const onUpdate = vi.fn();

		const result = await tool.execute(
			"call-1",
			{ command: "echo hi", timeout: 30, background: true },
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
	});

	it("delegates without timeout when absent (undefined preserved)", async () => {
		setupFactory();
		officialExecuteMock.mockResolvedValue({ content: [] });
		const tool = createBashOverrideToolDefinition();

		await tool.execute(
			"call-2",
			{ command: "ls" },
			undefined,
			undefined,
			createCtx(process.cwd()) as never,
		);

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
		officialExecuteMock.mockResolvedValue({ content: [] });
		const tool = createBashOverrideToolDefinition();

		// load 时刻初始 delegate 用 process.cwd()
		expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(1);
		expect(createBashToolDefinitionMock).toHaveBeenCalledWith(process.cwd());

		// execute 的 ctx.cwd 与缓存不一致 → 以 ctx.cwd 重建
		await tool.execute("c1", { command: "ls" }, undefined, undefined, createCtx("/tmp/alt") as never);
		expect(createBashToolDefinitionMock).toHaveBeenCalledWith("/tmp/alt");
		expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(2);

		// 同 cwd 复用缓存（不再新建）
		await tool.execute("c2", { command: "ls" }, undefined, undefined, createCtx("/tmp/alt") as never);
		expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(2);

		// cwd 再变 → 重建
		await tool.execute("c3", { command: "ls" }, undefined, undefined, createCtx("/tmp/alt2") as never);
		expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(3);
	});

	it("M1 parity: background:true still runs foreground (delegated, no task_id response path)", async () => {
		setupFactory();
		const foregroundResult = { content: [{ type: "text" as const, text: "stdout of echo hi" }] };
		officialExecuteMock.mockResolvedValue(foregroundResult);
		const tool = createBashOverrideToolDefinition();

		const result = await tool.execute(
			"call-bg",
			{ command: "echo hi", background: true },
			undefined,
			undefined,
			createCtx(process.cwd()) as never,
		);

		// background 核心是 M2 单元；M1 断言 = 返回官方前台结果（未进入未实现的 task_id 分支）
		expect(result).toBe(foregroundResult);
		const text = (result as { content: Array<{ text: string }> }).content[0]?.text;
		expect(text).not.toContain("task_id");
	});
});
