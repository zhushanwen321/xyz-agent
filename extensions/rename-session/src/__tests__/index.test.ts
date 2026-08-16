/* eslint-disable taste/no-unsafe-cast */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock llm-shared：只 override resolveModel + callLLM（callRenameLLM 的依赖），
// loadConfig/saveConfig 等保留真实实现（pure.ts 顶层 import 不受影响）。
// 竞态/编排用例在此 mock callLLM 为 deferred promise 制造 LLM 调用窗口（mock 架构方案 B：
// 不 mock llm.js——LTC8-12 走真实 callRenameLLM 全链路）。
vi.mock("@zhushanwen/pi-llm-shared", async (importActual) => {
	const actual = await importActual<typeof import("@zhushanwen/pi-llm-shared")>();
	return { ...actual, resolveModel: vi.fn(), callLLM: vi.fn() };
});

// mock pure.js：只 override loadRenameConfig（开关控制）；
// countSuccessfulAssistantReplies/cleanTitle 保留真实（触发判定接线由此覆盖）。
vi.mock("../pure.js", async (importActual) => {
	const actual = await importActual<typeof import("../pure.js")>();
	return { ...actual, loadRenameConfig: vi.fn() };
});

// 被测模块须在 vi.mock 之后 import（vitest 提升 vi.mock）
import { callLLM, resolveModel } from "@zhushanwen/pi-llm-shared";

import renameSessionExtension from "../index";
import { type RenameSessionConfig, loadRenameConfig } from "../pure.js";

// 每用例收尾统一还原：console spy 恢复 + stub 的 XYZ_AGENT_DEBUG 还原，
// 防泄漏到后续用例（debug 开关 live 读 process.env，依赖 stubEnv/unstubAllEnvs 成对）
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// ── Mock 工具 ───────────────────────────────────────

interface MockSetup {
	pi: ExtensionAPI;
	setSessionNameMock: ReturnType<typeof vi.fn>;
	/** 防覆盖检查读 pi.getSessionName()（D5），非 ctx——默认未命名（undefined）。 */
	getSessionNameMock: ReturnType<typeof vi.fn>;
	turnEndHandler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
}

/** resolveModel 的合法 Model<Api> 常量（pi-ai Model 接口全字段，消除 unsafe-cast 强断言）。 */
const STUB_MODEL: Model<Api> = {
	id: "stub-model",
	name: "Stub Model",
	api: "anthropic-messages",
	provider: "stub",
	baseUrl: "https://stub.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const ENABLED_CONFIG: RenameSessionConfig = {
	enabled: true,
	model: { type: "ref", ref: "stub/stub-model" },
	maxTitleLength: 50,
	thinkingLevel: "off",
};
const DISABLED_CONFIG: RenameSessionConfig = {
	enabled: false,
	model: { type: "ref", ref: "" },
	maxTitleLength: 50,
	thinkingLevel: "off",
};

function createMockPi(): MockSetup {
	const setSessionNameMock = vi.fn();
	const getSessionNameMock = vi.fn((): string | undefined => undefined);
	let turnEndHandler!: MockSetup["turnEndHandler"];
	const pi = {
		on: vi.fn((event: string, handler: MockSetup["turnEndHandler"]) => {
			if (event === "turn_end") turnEndHandler = handler;
		}),
		registerCommand: vi.fn(),
		getSessionName: getSessionNameMock,
		setSessionName: setSessionNameMock,
	} as unknown as ExtensionAPI;
	return {
		pi,
		setSessionNameMock,
		getSessionNameMock,
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

// 触发态夹具（D6 新判定）：stopReason==='stop' 的 assistant 恰 1 条 → 成功计数 1
const ONE_ASSISTANT = [
	{ type: "message", message: { role: "user", content: "帮我修复登录超时" } },
	{ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } },
];

/** fire 的事件 turnIndex（handler 侧 debug 日志含 turnIndex=<n>，断言锁定该值）。 */
const FIRE_TURN_INDEX = 3;

/**
 * 触发 turn_end handler。message 默认为 stop 轮的 assistant message（触发态，D2），
 * 跳过类用例显式传非 stop 的 message。
 */
function fire(setup: MockSetup, ctx: ExtensionContext, message?: unknown): Promise<void> {
	return setup.turnEndHandler(
		{
			type: "turn_end",
			turnIndex: FIRE_TURN_INDEX,
			message: message ?? { stopReason: "stop", content: [{ type: "text", text: "已完成修复" }] },
			toolResults: [],
		},
		ctx,
	) as Promise<void>;
}

/** 开 debug 开关 + 静音 warn，返回 spy 供日志断言（还原由顶层 afterEach 统一负责）。 */
function debugWarnSpy(): ReturnType<typeof vi.spyOn> {
	vi.stubEnv("XYZ_AGENT_DEBUG", "1");
	return vi.spyOn(console, "warn").mockImplementation(() => {});
}

/** warn spy 的全部调用文本行（debug 日志断言用）。 */
function warnLines(warnSpy: ReturnType<typeof vi.spyOn>): string[] {
	return warnSpy.mock.calls.map((c) => String(c[0]));
}

/** 拼接 warn spy 的全部调用为单行文本（debug 日志断言用）。 */
function warnText(warnSpy: ReturnType<typeof vi.spyOn>): string {
	return warnLines(warnSpy).join("\n");
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
	// TC1 stopReason 快速路径（D2：非 stop 的 turn 不触发）
	// ────────────────────────────────────────────────────

	it("TC1: 五种非 stop stopReason（toolUse/error/aborted/length/缺失）→ 不触发 rename，debug 输出 skip: stopReason=<r>", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);

		// stopReason 缺失（undefined）也走快速路径——只认显式 stop，防误触发
		for (const r of ["toolUse", "error", "aborted", "length", undefined]) {
			warnSpy.mockClear();
			await fire(setup, createMockCtx(), { stopReason: r, content: [] });

			// C3 契约：[rename-session] + t=<ISO> + turnIndex=<n> + skip 文案
			const expected = `turnIndex=${FIRE_TURN_INDEX} skip: stopReason=${String(r)}`;
			expect(warnText(warnSpy)).toContain(expected);
			const line = warnLines(warnSpy).find((l) => l.includes(`skip: stopReason=${String(r)}`));
			expect(line).toMatch(/^\[rename-session\] t=\d{4}-\d{2}-\d{2}T/);
		}

		expect(resolveModel).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	// ────────────────────────────────────────────────────
	// TC2 成功计数触发判定（D6：countSuccessfulAssistantReplies 接线）
	// ────────────────────────────────────────────────────

	it("TC2: 四组混合 entries——[user,toolUse,stop] 触发 / [user,error,stop] 触发 / 纯 error 不触发 / 2 stop 不触发", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		// ok:false 即可满足断言需要（callLLM 被调 + 不落库），聚焦触发判定本身
		vi.mocked(callLLM).mockResolvedValue({ ok: false, error: "by-design", recoverable: true });

		const FINAL_TEXT = "最终回复：已修复登录超时";
		const stopMessage = { stopReason: "stop", content: [{ type: "text", text: FINAL_TEXT }] };

		// 组1（区分性数据）：旧 countAssistantReplies=2 不触发 vs 新成功计数=1 触发——
		// index 若仍用旧计数函数（忘接线 wave-1 纯函数），本组红（接线回归防护）
		const toolUseRound = [
			{ type: "message", message: { role: "user", content: "帮我修复登录超时" } },
			{ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [] } },
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } },
		];
		await fire(setup, createMockCtx({ entries: toolUseRound }), stopMessage);
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		// 第三参接线：event.message 作为 finalMessage → 其 text 进入 callLLM messages 的 assistant 条目
		const opts1 = vi.mocked(callLLM).mock.calls[0][1] as {
			messages: { role: string; content: { type: string; text: string }[] }[];
		};
		const assistantMsg = opts1.messages.find((m) => m.role === "assistant");
		expect(assistantMsg?.content[0]).toMatchObject({ type: "text", text: FINAL_TEXT });

		// 组2：error 轮后的下一成功轮（error 不计数）→ 触发
		const afterErrorRound = [
			{ type: "message", message: { role: "user", content: "继续修复" } },
			{ type: "message", message: { role: "assistant", stopReason: "error", content: [] } },
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } },
		];
		await fire(setup, createMockCtx({ entries: afterErrorRound }), stopMessage);
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(2));

		// 组3：纯 error 轮（stop entry 未落库的异常防御——真实时序 stop turn_end 时 count>=1 恒成立）
		// → 不触发 + skip: count=0
		const errorOnly = [
			{ type: "message", message: { role: "user", content: "继续修复" } },
			{ type: "message", message: { role: "assistant", stopReason: "error", content: [] } },
		];
		await fire(setup, createMockCtx({ entries: errorOnly }), stopMessage);

		// 组4：2 个 stop（resume 后的新 round）→ 不触发 + skip: count=2
		const twoStops = [
			{ type: "message", message: { role: "user", content: "第一轮" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } },
			{ type: "message", message: { role: "user", content: "第二轮" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } },
		];
		await fire(setup, createMockCtx({ entries: twoStops }), stopMessage);

		// 组3/组4 是同步 return 路径：fire resolve 即判定完成，callLLM 计数停在 2
		expect(callLLM).toHaveBeenCalledTimes(2);
		const log = warnText(warnSpy);
		expect(log).toContain(`turnIndex=${FIRE_TURN_INDEX} skip: count=0`);
		expect(log).toContain(`turnIndex=${FIRE_TURN_INDEX} skip: count=2`);
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
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
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
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
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "  修复登录bug  " });

		await fire(setup, createMockCtx());
		// handler 内 callRenameLLM 是 detached promise（fire-and-forget），fire 立即 resolve；
		// 需等 detached promise settle 后再断言落库结果。
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("修复登录bug"));

		expect(callLLM).toHaveBeenCalledTimes(1);
	});

	it("LTC11: callLLM 返回空 content（cleanTitle 空串）→ 不调 setSessionName", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "   " });

		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC12: callLLM reject → handler 不抛，setSessionName 未调用（detached catch 兜底）", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockRejectedValue(new Error("llm down"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(fire(setup, createMockCtx())).resolves.toBeUndefined();
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("LTC13: 首 turn 判定（成功 assistant 回复数 !== 1）→ 不调 resolveModel", async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		// 0 个成功 assistant
		await fire(setup, createMockCtx({ entries: [{ type: "message", message: { role: "user" } }] }));
		expect(resolveModel).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	// ────────────────────────────────────────────────────
	// TC3 防覆盖：落库前重查（D5，含 LLM 调用窗口竞态）
	// ────────────────────────────────────────────────────

	it("TC3: LLM 调用窗口内手动命名 → 落库前重查命中，不调 setSessionName（skip: name exists）", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		// deferred promise 打开 LLM 调用窗口（不 mock llm.js，在 pi-llm-shared 的 callLLM 边界拦截）
		let resolveLLM!: (value: { ok: true; content: string }) => void;
		vi.mocked(callLLM).mockImplementation(
			() =>
				new Promise((res) => {
					resolveLLM = res;
				}),
		);

		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));

		// 竞态窗口内：用户手动 /name 命名（落库前重查必须看到它）
		setup.getSessionNameMock.mockReturnValue("我的手动名字");

		resolveLLM({ ok: true, content: "自动生成的标题" });
		await vi.waitFor(() => expect(warnText(warnSpy)).toContain("skip: name exists"));

		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
		// 移位契约：renamed to 在 setSessionName 之后才打——竞态命中（未落库）时该日志不出现
		expect(warnText(warnSpy)).not.toContain("renamed to");
	});

	it("TC3 对照组: getSessionName 始终 undefined → 正常落库 + renamed to 日志（setSessionName 之后、handler 侧带 turnIndex）", async () => {
		const warnSpy = debugWarnSpy();
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "自动生成的标题" });

		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("自动生成的标题"));

		const renamedIdx = warnLines(warnSpy).findIndex((l) => l.includes('renamed to "自动生成的标题"'));
		expect(renamedIdx).toBeGreaterThanOrEqual(0);
		// handler 侧日志契约（C3）：[rename-session] + t=<ISO> + turnIndex=<n> + renamed to "<title>"
		expect(String(warnSpy.mock.calls[renamedIdx][0])).toMatch(
			new RegExp(`^\\[rename-session\\] t=\\d{4}-\\d{2}-\\d{2}T.* turnIndex=${FIRE_TURN_INDEX} renamed to "自动生成的标题"$`),
		);
		// 移位契约（时序）：日志调用序晚于 setSessionName——先落库后报捷
		expect(warnSpy.mock.invocationCallOrder[renamedIdx]).toBeGreaterThan(
			setup.setSessionNameMock.mock.invocationCallOrder[0],
		);
	});

	// ────────────────────────────────────────────────────
	// TC9 debug 关闭态零输出（默认生产环境零噪音，D9）
	// ────────────────────────────────────────────────────

	it("TC9: XYZ_AGENT_DEBUG 未设 → 全流程 7 条 debug 契约文案零输出（既有 A1 日志除外）", async () => {
		// 显式清除（防宿主环境泄漏 XYZ_AGENT_DEBUG 影响判定）
		vi.stubEnv("XYZ_AGENT_DEBUG", undefined);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL);

		// 组1：有内容 → 全流程落库
		vi.mocked(callLLM).mockResolvedValueOnce({ ok: true, content: "标题一" });
		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("标题一"));

		// 组2：空内容 → cleanTitle 空 → 返回 null 不落库
		vi.mocked(callLLM).mockResolvedValueOnce({ ok: true, content: "   " });
		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(2));
		// flush 微任务链（detached promise 的 .then 收尾）后再断言日志终态
		await new Promise((r) => setTimeout(r, 0));

		// 7 条 debug 契约文案（C3）逐条确认零输出
		const debugLiterals = [
			"skip: stopReason=",
			"skip: count=",
			"skip: no user prompt",
			"skip: name exists",
			"skip: title empty",
			"renamed to",
			"LLM request messages:",
		];
		for (const lit of debugLiterals) {
			expect(warnText(warnSpy)).not.toContain(lit);
		}
		// 「零调用」的精确口径：剔除既有 A1 日志（model not available / call failed，
		// 非本轮 debug 契约、本用例数据 ok:true 不触发这两类）后，其余 warn 调用必须为 0。
		// 成功路径的 rename with model 已改为 debug-only，debug 关闭时同样不得出现。
		const nonA1Calls = warnLines(warnSpy).filter(
			(l) =>
				!l.includes("model not available") &&
				!l.includes("rename LLM call failed"),
		);
		expect(nonA1Calls).toHaveLength(0);
	});
});
