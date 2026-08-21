/**
 * switch_model tool 非 switch action（list / search / recommend / setup）单元测试。
 *
 * 补增量覆盖率缺口（execute 分发 + 各 action 未覆盖分支）：
 * - unknown action throw（W4：pi 只对 execute throw 置 isError:true）
 * - list：scenes 链尾格式化（sceneInfo）
 * - search：无配置 early return / 无 query throw / 命中与未命中文案
 * - switch：findModelMatch fuzzy 分支（alias 子串命中）
 * - recommend：computeSnapshotAndRecommend 抛错时包装 throw
 * - setup 子命令：delete 失败/成功、list 失败/成功、edit 失败/成功
 *
 * setup.ts 的文件系统操作（deletePolicyConfig / readPolicyConfigContent）全部 mock，
 * 不触真实磁盘。测试框架：vitest。
 * 运行命令：cd extensions/model-switch && npx vitest run tests/switch-model-actions.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelPolicy } from "../src/types";

// ── Hoisted mocks ──────────────────────────────────────

const {
	mockLoadConfig,
	mockReadCache,
	mockMigrateLegacyConfig,
	mockGetAgentDir,
	mockDeletePolicyConfig,
	mockReadPolicyConfigContent,
	mockGeneratePolicyConfig,
	mockGetConfigPath,
	mockReadEnabledModels,
} = vi.hoisted(() => ({
	mockLoadConfig: vi.fn<() => ModelPolicy | null>(),
	mockReadCache: vi.fn(),
	mockMigrateLegacyConfig: vi.fn(),
	mockGetAgentDir: vi.fn(() => "/tmp/actions-test-agent-dir"),
	mockDeletePolicyConfig: vi.fn(),
	mockReadPolicyConfigContent: vi.fn(),
	mockGeneratePolicyConfig: vi.fn(),
	mockGetConfigPath: vi.fn(() => "/tmp/actions-test-agent-dir/config/model-switch-ext-config.json"),
	mockReadEnabledModels: vi.fn(() => []),
}));

vi.mock("../src/config", () => ({
	loadConfig: mockLoadConfig,
}));

vi.mock("../src/setup", () => ({
	deletePolicyConfig: mockDeletePolicyConfig,
	readPolicyConfigContent: mockReadPolicyConfigContent,
	generatePolicyConfig: mockGeneratePolicyConfig,
	getConfigPath: mockGetConfigPath,
	readEnabledModels: mockReadEnabledModels,
}));

vi.mock("@zhushanwen/pi-quota-providers", () => ({
	readCache: mockReadCache,
}));

vi.mock("@zhushanwen/pi-llm-shared", () => ({
	migrateLegacyConfig: mockMigrateLegacyConfig,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: mockGetAgentDir,
}));

// Import AFTER mocks
import modelSwitchExtension from "../src/index";

// ── Fixtures ───────────────────────────────────────────

const mockConfig: ModelPolicy = {
	version: 2,
	models: {
		"xiaomi-token-plan-cn": {
			plan: "xiaomi",
			models: {
				"mimo-lite": { modelId: "mimo-v2.5", capabilities: ["text"] },
				"mimo-pro": { modelId: "mimo-v2.5-pro", capabilities: ["text", "reasoning"] },
			},
		},
	},
	scenes: { coding: ["mimo-pro"] },
	plans: { xiaomi: { priority: 1 } },
	stickiness: { minTurns: 3, minInputTokens: 1000 },
};

const MIMO_LITE = { provider: "xiaomi-token-plan-cn", id: "mimo-v2.5" };
const MIMO_PRO = { provider: "xiaomi-token-plan-cn", id: "mimo-v2.5-pro" };

interface RegisteredTool {
	name: string;
	execute: (
		toolCallId: string,
		params: { action: string; query?: string },
		signal: undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function setupExtension(config: ModelPolicy | null) {
	mockLoadConfig.mockReturnValue(config);

	const pi = {
		on: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		setModel: vi.fn().mockResolvedValue(true),
		appendEntry: vi.fn(),
	};

	modelSwitchExtension(pi as never);

	const registered = pi.registerTool.mock.calls[0]?.[0] as RegisteredTool | undefined;
	if (!registered) throw new Error("switch_model tool not registered");

	const startHandler = pi.on.mock.calls.find(([event]: [string]) => event === "session_start")?.[1] as
		| ((event: unknown, ctx: unknown) => Promise<unknown>)
		| undefined;
	if (!startHandler) throw new Error("session_start handler not registered");

	return { pi, tool: registered, startHandler };
}

/** 加载 config 并返回可直接调用的 execute（ctx 形状对齐 switch-model.test.ts 的 makeCtx） */
async function setupTool(config: ModelPolicy | null) {
	const { pi, tool, startHandler } = setupExtension(config);
	await startHandler({}, {});
	const ctx = {
		modelRegistry: { find: vi.fn(() => MIMO_PRO) },
		model: MIMO_LITE,
		sessionManager: { getBranch: () => [] },
	};
	const execute = (params: { action: string; query?: string }) => tool.execute("call-1", params, undefined, undefined, ctx);
	return { pi, execute };
}

// ── Tests ──────────────────────────────────────────────

beforeEach(() => {
	vi.clearAllMocks();
	mockGetConfigPath.mockReturnValue("/tmp/actions-test-agent-dir/config/model-switch-ext-config.json");
	mockReadEnabledModels.mockReturnValue([]);
});

describe("execute 分发", () => {
	it("unknown action throw 完整支持列表文案（W4：throw 才被 pi 置 isError）", async () => {
		const { execute } = await setupTool(mockConfig);

		await expect(execute({ action: "teleport" })).rejects.toThrow(
			"Unknown action: teleport. Supported: list, search, switch, recommend, setup.",
		);
	});
});

describe("list action", () => {
	it("格式化 provider/plan/alias 行与 scenes 链尾", async () => {
		const { execute } = await setupTool(mockConfig);

		const result = await execute({ action: "list" });
		const text = result.content[0]?.text ?? "";

		expect(text).toContain("Configured models:");
		// provider 行携带 plan 标注
		expect(text).toContain("xiaomi-token-plan-cn (plan: xiaomi):");
		// alias → plan/modelId 行 + capabilities
		expect(text).toContain("mimo-lite → xiaomi/mimo-v2.5 [text]");
		expect(text).toContain("mimo-pro → xiaomi/mimo-v2.5-pro [text, reasoning]");
		// scenes 链尾：scene 名 + 逗号连接的 alias
		expect(text).toContain("Scenes:\n  coding: mimo-pro");
	});

	it("无 config 时返回 setup 指引文案", async () => {
		const { execute } = await setupTool(null);

		const result = await execute({ action: "list" });
		expect(result.content[0]?.text).toBe("No model policy configured. Run /setup-model-policy to generate one.");
	});
});

describe("search action", () => {
	it("无 config 时返回提示（不 throw）", async () => {
		const { execute } = await setupTool(null);

		const result = await execute({ action: "search", query: "mimo" });
		expect(result.content[0]?.text).toBe("No model policy configured.");
	});

	it("有 config 但 query 空白时 throw（trim 后为空）", async () => {
		const { execute } = await setupTool(mockConfig);

		await expect(execute({ action: "search", query: "   " })).rejects.toThrow(
			"Please provide a search query.",
		);
	});

	it("命中时输出 alias (provider) → modelId [capabilities] 行与计数", async () => {
		const { execute } = await setupTool(mockConfig);

		const result = await execute({ action: "search", query: "MIMO" });
		const text = result.content[0]?.text ?? "";

		// query 在 execute 内 toLowerCase，大写输入仍命中两个模型
		expect(text).toContain('Models matching "mimo" (2):');
		expect(text).toContain("mimo-lite (xiaomi-token-plan-cn) → mimo-v2.5 [text]");
		expect(text).toContain("mimo-pro (xiaomi-token-plan-cn) → mimo-v2.5-pro [text, reasoning]");
	});

	it("未命中时输出原 query 的未命中文案", async () => {
		const { execute } = await setupTool(mockConfig);

		const result = await execute({ action: "search", query: "gpt" });
		expect(result.content[0]?.text).toBe('No models matching "gpt".');
	});
});

describe("switch action fuzzy match", () => {
	it("alias 子串（非精确）经 fuzzy 分支命中并真实调用 setModel", async () => {
		const { pi, execute } = await setupTool(mockConfig);

		// "pro" 不是任何 alias/modelId 的精确值 → 走 fuzzy include 命中 mimo-pro
		const result = await execute({ action: "switch", query: "pro" });

		expect(pi.setModel).toHaveBeenCalledTimes(1);
		expect(pi.setModel).toHaveBeenCalledWith(MIMO_PRO);
		expect(result.content[0]?.text).toContain("Switched to mimo-pro (xiaomi-token-plan-cn/mimo-v2.5-pro)");
	});
});

describe("recommend action", () => {
	it("quota cache 读取失败时包装为 Failed to compute context throw", async () => {
		const { execute } = await setupTool(mockConfig);
		mockReadCache.mockImplementation(() => {
			throw new Error("quota cache unavailable");
		});

		await expect(execute({ action: "recommend" })).rejects.toThrow(
			"Failed to compute context: quota cache unavailable",
		);
	});
});

describe("setup action 子命令", () => {
	it("delete 失败（文件不存在）时 throw 原始 error 文案", async () => {
		const { execute } = await setupTool(mockConfig);
		mockDeletePolicyConfig.mockReturnValue({ ok: false, error: "No config file at /tmp/none.json." });

		await expect(execute({ action: "setup", query: "delete" })).rejects.toThrow(
			"No config file at /tmp/none.json.",
		);
	});

	it("delete 成功返回路径文案，并清空内存态 config（后续 list 变为未配置）", async () => {
		const { execute } = await setupTool(mockConfig);
		mockDeletePolicyConfig.mockReturnValue({ ok: true, path: "/tmp/deleted.json" });

		const result = await execute({ action: "setup", query: "delete" });
		expect(result.content[0]?.text).toContain("Config deleted: /tmp/deleted.json");
		expect(result.content[0]?.text).toContain("Run /setup-model-policy to regenerate.");

		// 行为断言：delete 应把 state.config 置 null，同 session 后续 list 不再列出模型
		const afterDelete = await execute({ action: "list" });
		expect(afterDelete.content[0]?.text).toBe(
			"No model policy configured. Run /setup-model-policy to generate one.",
		);
	});

	it("list 子命令读取失败时 throw 原始 error 文案", async () => {
		const { execute } = await setupTool(mockConfig);
		mockReadPolicyConfigContent.mockReturnValue({ ok: false, error: "No config file at /tmp/none.json. Run /setup-model-policy to generate one." });

		await expect(execute({ action: "setup", query: "list" })).rejects.toThrow(
			"No config file at /tmp/none.json. Run /setup-model-policy to generate one.",
		);
	});

	it("list 子命令成功时输出路径 + json 代码块内容", async () => {
		const { execute } = await setupTool(mockConfig);
		mockReadPolicyConfigContent.mockReturnValue({
			ok: true,
			content: '{\n  "version": 2\n}',
			path: "/tmp/cfg.json",
		});

		const result = await execute({ action: "setup", query: "list" });
		const text = result.content[0]?.text ?? "";

		expect(text).toContain("Current config/model-switch-ext-config.json (/tmp/cfg.json):");
		expect(text).toContain('```json');
		expect(text).toContain('"version": 2');
	});

	it("edit 子命令读取失败时 throw 原始 error 文案", async () => {
		const { execute } = await setupTool(mockConfig);
		mockReadPolicyConfigContent.mockReturnValue({ ok: false, error: "No config file at /tmp/none.json." });

		await expect(execute({ action: "setup", query: "edit" })).rejects.toThrow(
			"No config file at /tmp/none.json.",
		);
	});

	it("edit 子命令成功时输出当前配置与编辑引导语", async () => {
		const { execute } = await setupTool(mockConfig);
		mockReadPolicyConfigContent.mockReturnValue({
			ok: true,
			content: '{\n  "version": 2\n}',
			path: "/tmp/cfg.json",
		});

		const result = await execute({ action: "setup", query: "edit" });
		const text = result.content[0]?.text ?? "";

		expect(text).toContain("Current config/model-switch-ext-config.json for editing:");
		expect(text).toContain('"version": 2');
		expect(text).toContain("Tell me what you want to change.");
		expect(text).toContain("Say 'save' when ready.");
	});
});
