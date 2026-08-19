/**
 * switch_model tool（switchToModel）单元测试
 *
 * 覆盖 pi-assumption-remediation W1a（B-F1 critical 修复）：
 * 1. 切换必须真实调用 pi.setModel（曾只写 custom entry，模型从未切换）
 * 2. setModel 返回 false（provider 未配置 auth）时报错，不返回成功文案
 * 3. 不再 appendEntry("model_change") custom entry——pi host setModel 自写原生
 *    entry（agent-session.js:1204），custom 形态不参与 session 重载恢复（session-manager.js:146-160）
 *
 * 测试框架：vitest
 * 运行命令：npx vitest run tests/switch-model.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelPolicy } from "../src/types";

// ── Hoisted mocks ──────────────────────────────────────

const { mockLoadConfig, mockReadCache, mockMigrateLegacyConfig, mockGetAgentDir } = vi.hoisted(() => ({
	mockLoadConfig: vi.fn<() => ModelPolicy | null>(),
	mockReadCache: vi.fn(),
	mockMigrateLegacyConfig: vi.fn(),
	mockGetAgentDir: vi.fn(() => "/tmp/w1a-test-agent-dir"),
}));

vi.mock("../src/config", () => ({
	loadConfig: mockLoadConfig,
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

/** provider key ≠ plan 的真实形态配置（如 xiaomi-token-plan-cn / plan xiaomi） */
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
	execute: (toolCallId: string, params: unknown, signal: undefined, onUpdate: unknown, ctx: unknown) => Promise<{
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	}>;
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

	// 触发 session_start 以加载 config
	const startHandler = pi.on.mock.calls.find(([event]: [string]) => event === "session_start")?.[1] as
		| ((event: unknown, ctx: unknown) => Promise<unknown>)
		| undefined;
	if (!startHandler) throw new Error("session_start handler not registered");

	return { pi, tool: registered, startHandler };
}

function makeCtx(find: (provider: string, modelId: string) => unknown) {
	return {
		modelRegistry: { find },
		model: MIMO_LITE,
		sessionManager: { getBranch: () => [] },
	};
}

async function switchAction(tool: RegisteredTool, ctx: unknown, query: string) {
	return tool.execute("call-1", { action: "switch", query }, undefined, undefined, ctx);
}

// ── Tests ──────────────────────────────────────────────

describe("switch_model switch action", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls pi.setModel with the registry-resolved model and reports success", async () => {
		const { pi, tool, startHandler } = setupExtension(mockConfig);
		await startHandler({}, {});

		const ctx = makeCtx((provider, modelId) =>
			provider === "xiaomi-token-plan-cn" && modelId === "mimo-v2.5-pro" ? MIMO_PRO : undefined,
		);

		const result = await switchAction(tool, ctx, "mimo-pro");

		expect(pi.setModel).toHaveBeenCalledTimes(1);
		expect(pi.setModel).toHaveBeenCalledWith(MIMO_PRO);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("Switched to mimo-pro (xiaomi-token-plan-cn/mimo-v2.5-pro)");
	});

	it("does NOT append a custom model_change entry (pi host setModel writes the native one)", async () => {
		const { pi, tool, startHandler } = setupExtension(mockConfig);
		await startHandler({}, {});

		const ctx = makeCtx(() => MIMO_PRO);

		await switchAction(tool, ctx, "mimo-pro");

		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("returns an error when pi.setModel returns false (no auth for provider)", async () => {
		const { pi, tool, startHandler } = setupExtension(mockConfig);
		await startHandler({}, {});
		pi.setModel.mockResolvedValue(false);

		const ctx = makeCtx(() => MIMO_PRO);

		const result = await switchAction(tool, ctx, "mimo-pro");

		expect(pi.setModel).toHaveBeenCalledTimes(1);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("rejected");
		expect(result.content[0]?.text).toContain("xiaomi-token-plan-cn");
	});

	it("returns an error when the model is absent from the registry (setModel never called)", async () => {
		const { pi, tool, startHandler } = setupExtension(mockConfig);
		await startHandler({}, {});

		const ctx = makeCtx(() => undefined);

		const result = await switchAction(tool, ctx, "mimo-pro");

		expect(pi.setModel).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("not available");
	});

	it("resolves router-suffixed provider variants (config key without -router)", async () => {
		const { pi, tool, startHandler } = setupExtension(mockConfig);
		await startHandler({}, {});

		const routerModel = { provider: "xiaomi-token-plan-cn-router", id: "mimo-v2.5-pro" };
		const ctx = makeCtx((provider, modelId) =>
			provider === "xiaomi-token-plan-cn-router" && modelId === "mimo-v2.5-pro" ? routerModel : undefined,
		);

		const result = await switchAction(tool, ctx, "mimo-pro");

		expect(pi.setModel).toHaveBeenCalledWith(routerModel);
		expect(result.content[0]?.text).toContain("xiaomi-token-plan-cn-router/mimo-v2.5-pro");
	});

	it("surfaces setModel exceptions as tool errors", async () => {
		const { pi, tool, startHandler } = setupExtension(mockConfig);
		await startHandler({}, {});
		pi.setModel.mockRejectedValue(new Error("boom"));

		const ctx = makeCtx(() => MIMO_PRO);

		const result = await switchAction(tool, ctx, "mimo-pro");

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("boom");
	});

	it("reports unknown alias before touching the registry", async () => {
		const { pi, tool, startHandler } = setupExtension(mockConfig);
		await startHandler({}, {});

		const find = vi.fn();
		const result = await switchAction(tool, makeCtx(find), "nonexistent");

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("No model matching");
		expect(find).not.toHaveBeenCalled();
		expect(pi.setModel).not.toHaveBeenCalled();
	});
});
