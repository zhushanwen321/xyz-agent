/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// mock llm-shared：只 override resolveModel + callLLM（callRenameLLM 的依赖），
// loadConfig/saveConfig 等保留真实实现（pure.ts 顶层 import 不受影响）。
vi.mock("@zhushanwen/pi-llm-shared", async (importActual) => {
	const actual = await importActual<typeof import("@zhushanwen/pi-llm-shared")>();
	return { ...actual, resolveModel: vi.fn(), callLLM: vi.fn() };
});

// mock pure.js：只 override loadRenameConfig（开关控制）；countAssistantReplies/cleanTitle 保留真实。
vi.mock("../pure.js", async (importActual) => {
	const actual = await importActual<typeof import("../pure.js")>();
	return { ...actual, loadRenameConfig: vi.fn() };
});

// 被测模块须在 vi.mock 之后 import（vitest 提升 vi.mock）
import { callLLM, resolveModel } from "@zhushanwen/pi-llm-shared";

import renameSessionExtension from "../index";
import { type RenameSessionConfig, loadRenameConfig } from "../pure.js";

// ── Mock 工具 ───────────────────────────────────────

interface MockSetup {
	pi: ExtensionAPI;
	setSessionNameMock: ReturnType<typeof vi.fn>;
	turnEndHandler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
}

const STUB_MODEL = { id: "stub-model", provider: "stub" };

const ENABLED_CONFIG: RenameSessionConfig = {
	enabled: true,
	model: { type: "ref", ref: "stub/stub-model" },
	maxTitleLength: 50,
	thinkingLevel: "off",
};
const DISABLED_CONFIG: RenameSessionConfig = {
	enabled: false,
	model: { type: "scoped" },
	maxTitleLength: 50,
	thinkingLevel: "off",
};

function createMockPi(): MockSetup {
	const setSessionNameMock = vi.fn();
	let turnEndHandler!: MockSetup["turnEndHandler"];
	const pi = {
		on: vi.fn((event: string, handler: MockSetup["turnEndHandler"]) => {
			if (event === "turn_end") turnEndHandler = handler;
		}),
		registerCommand: vi.fn(),
		setSessionName: setSessionNameMock,
	} as unknown as ExtensionAPI;
	return {
		pi,
		setSessionNameMock,
		get turnEndHandler() {
			return turnEndHandler;
		},
	};
}

interface MockCtxOptions {
	entries?: unknown[];
	sessionDir?: string;
}

function createMockCtx(opts: MockCtxOptions = {}): ExtensionContext {
	const entries = opts.entries ?? ONE_ASSISTANT;
	const sessionDir = opts.sessionDir ?? "/home/u/.pi/agent/sessions";
	return {
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => "test-session-id",
			getSessionDir: () => sessionDir,
		},
		signal: new AbortController().signal,
	} as unknown as ExtensionContext;
}

const ONE_ASSISTANT = [
	{ type: "message", message: { role: "user" } },
	{ type: "message", message: { role: "assistant" } },
];

/** 触发 turn_end handler（事件载荷在测试中不被读取，固定即可）。 */
function fire(setup: MockSetup, ctx: ExtensionContext): Promise<void> {
	return setup.turnEndHandler(
		{ type: "turn_end", turnIndex: 0, message: null, toolResults: [] },
		ctx,
	) as Promise<void>;
}

// ────────────────────────────────────────────────────
// renameSessionExtension 工厂 + hook 注册
// ────────────────────────────────────────────────────

describe("renameSessionExtension", () => {
	let setup: MockSetup;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(loadRenameConfig).mockReset();
		vi.mocked(resolveModel).mockReset();
		vi.mocked(callLLM).mockReset();
		setup = createMockPi();
		renameSessionExtension(setup.pi);
	});

	it("TC13: 注册后 pi.on 以 'turn_end' 调用一次", () => {
		expect(setup.pi.on).toHaveBeenCalledTimes(1);
		expect(setup.pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
		expect(setup.turnEndHandler).toBeTypeOf("function");
	});

	it("TC14: config.enabled=false → handler 触发后不调 resolveModel/setSessionName", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(DISABLED_CONFIG);

		await fire(setup, createMockCtx());

		expect(loadRenameConfig).toHaveBeenCalled();
		expect(resolveModel).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("TC15: getEntries 抛错时 handler 不抛（catch console.error）", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const ctx = {
			sessionManager: {
				getEntries: () => {
					throw new Error("boom");
				},
				getSessionId: () => "test-session-id",
				getSessionDir: () => "/home/u/.pi/agent/sessions",
			},
			signal: new AbortController().signal,
		} as unknown as ExtensionContext;

		await expect(fire(setup, ctx)).resolves.toBeUndefined();

		expect(errorSpy).toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	// ────────────────────────────────────────────────────
	// callRenameLLM 集成覆盖（fire-and-forget 时序）
	// ────────────────────────────────────────────────────

	it("LTC7: subagents 子 session 路径 → isSubagentSession 早退，不调 resolveModel/setSessionName", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);

		await fire(
			setup,
			createMockCtx({ sessionDir: "/home/u/.pi/agent/subagents/--proj--/sessions" }),
		);

		expect(resolveModel).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC8: callLLM 返回 {ok:false} → callRenameLLM 返回 null，不调 setSessionName", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
		vi.mocked(callLLM).mockResolvedValue({ ok: false, error: "boom", recoverable: true });

		await fire(setup, createMockCtx());
		// handler 内 callRenameLLM 是 detached promise（fire-and-forget），等其 settle 后断言
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC9: resolveModel 返回 null（model 不可用）→ 不调 callLLM/setSessionName（静默跳过）", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(null);

		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(resolveModel).toHaveBeenCalledTimes(1));

		expect(callLLM).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC10: callLLM 返回 {ok:true,content} → cleanTitle 后 setSessionName 落库", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "  修复登录bug  " });

		await fire(setup, createMockCtx());
		// handler 内 callRenameLLM 是 detached promise（fire-and-forget），fire 立即 resolve；
		// 需等 detached promise settle 后再断言落库结果。
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("修复登录bug"));

		expect(callLLM).toHaveBeenCalledTimes(1);
	});

	it("LTC11: callLLM 返回空 content（cleanTitle 空串）→ 不调 setSessionName", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "   " });

		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC12: callLLM reject → handler 不抛，setSessionName 未调用（detached catch 兜底）", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
		vi.mocked(callLLM).mockRejectedValue(new Error("llm down"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(fire(setup, createMockCtx())).resolves.toBeUndefined();
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("LTC13: 首 turn 判定（assistant 回复数 !== 1）→ 不调 resolveModel", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		// 0 assistant
		await fire(setup, createMockCtx({ entries: [{ type: "message", message: { role: "user" } }] }));
		expect(resolveModel).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});
});
