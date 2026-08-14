/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 只 override resolveModel + callLLM（callRenameLLM 的依赖）；保留 loadConfig/saveConfig 等
// 真实实现，pure.ts 顶层 import 不受影响。vi.mock 被提升到文件顶部执行。
vi.mock("@zhushanwen/pi-llm-shared", async (importActual) => {
	const actual = await importActual<typeof import("@zhushanwen/pi-llm-shared")>();
	return { ...actual, resolveModel: vi.fn(), callLLM: vi.fn() };
});

// 被测模块须在 vi.mock 之后 import
import { callLLM, resolveModel } from "@zhushanwen/pi-llm-shared";

import {
	RENAME_INSTRUCTION,
	RENAME_SYSTEM_PROMPT,
	buildMessages,
	callRenameLLM,
	isSubagentSession,
} from "../llm.js";
import { DEFAULT_RENAME_CONFIG, type RenameSessionConfig } from "../pure.js";

// ────────────────────────────────────────────────────
// buildMessages（保留，不变）
// ────────────────────────────────────────────────────

describe("buildMessages", () => {
	it("LTC1: 从 entries 构造前缀 + 追加 rename 指令", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
		];
		const result = buildMessages(entries, "生成标题");
		expect(result).toHaveLength(3);
		expect(result[0]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
		expect(result[2]).toEqual({
			role: "user",
			content: [{ type: "text", text: "生成标题" }],
			timestamp: expect.any(Number),
		});
	});

	it("LTC2: 过滤非 message entry", () => {
		const entries = [
			{ type: "thinkingLevelChange", data: {} },
			{ type: "message", message: { role: "user", content: [] } },
			{ type: "message", message: { role: "assistant", content: [] } },
			{ type: "modelChange", data: {} },
		];
		const result = buildMessages(entries, "生成标题");
		expect(result).toHaveLength(3);
	});

	it("LTC3: toolResult message 保留（kvcache 前缀完整性）", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: [] } },
			{ type: "message", message: { role: "assistant", content: [] } },
			{ type: "message", message: { role: "toolResult", content: [] } },
			{ type: "message", message: { role: "assistant", content: [] } },
		];
		const result = buildMessages(entries, "生成标题");
		expect(result).toHaveLength(5);
		expect((result[2] as { role: string }).role).toBe("toolResult");
	});
});

// ────────────────────────────────────────────────────
// isSubagentSession（保留，不变）
// ────────────────────────────────────────────────────

describe("isSubagentSession", () => {
	it("LTC4: subagents 路径返回 true", () => {
		expect(isSubagentSession("/home/u/.pi/agent/subagents/--proj--/sessions")).toBe(true);
	});

	it("LTC5: 主 session 路径返回 false", () => {
		expect(isSubagentSession("/home/u/.pi/agent/sessions")).toBe(false);
	});
});

// ────────────────────────────────────────────────────
// RENAME_SYSTEM_PROMPT 长度（验收标准：< 200 字符）
// ────────────────────────────────────────────────────

describe("RENAME_SYSTEM_PROMPT", () => {
	it("string.length < 200（精简 prompt，对比改造前 ctx.getSystemPrompt() > 2000）", () => {
		expect(RENAME_SYSTEM_PROMPT.length).toBeLessThan(200);
	});
});

// ────────────────────────────────────────────────────
// callRenameLLM（mock resolveModel + callLLM @ llm-shared 边界）
// ────────────────────────────────────────────────────

const STUB_MODEL = { id: "stub-model", provider: "stub" };

const BASE_CONFIG: RenameSessionConfig = {
	enabled: true,
	model: { type: "ref", ref: "stub/stub-model" },
	maxTitleLength: 50,
	thinkingLevel: "off",
};

function createCtx(): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => [
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			],
			getSessionId: () => "test-session-id",
		},
		signal: new AbortController().signal,
	} as unknown as ExtensionContext;
}

describe("callRenameLLM", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("resolveModel 返回 null（model 不可用）→ 返回 null，不调 callLLM（静默跳过）", async () => {
		vi.mocked(resolveModel).mockReturnValue(null);
		const result = await callRenameLLM(createCtx(), BASE_CONFIG);
		expect(result).toBeNull();
		expect(callLLM).not.toHaveBeenCalled();
	});

	it("callLLM 返回 {ok:false} → 返回 null（静默跳过，不抛错）", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
		vi.mocked(callLLM).mockResolvedValue({ ok: false, error: "boom", recoverable: true });
		const result = await callRenameLLM(createCtx(), BASE_CONFIG);
		expect(result).toBeNull();
	});

	it("callLLM 返回 {ok:true, content} → cleanTitle 后返回", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "  修复登录bug  " });
		const result = await callRenameLLM(createCtx(), BASE_CONFIG);
		expect(result).toBe("修复登录bug");
	});

	it("callLLM 返回空 content（cleanTitle 空串）→ 返回 null", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "   " });
		const result = await callRenameLLM(createCtx(), BASE_CONFIG);
		expect(result).toBeNull();
	});

	it("传给 callLLM 的 opts：model=resolveModel 结果 / systemPrompt=RENAME_SYSTEM_PROMPT(<200) / maxTokens=64 / signal / sessionId / 无 tools", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });
		await callRenameLLM(createCtx(), BASE_CONFIG);

		expect(callLLM).toHaveBeenCalledTimes(1);
		const callOpts = vi.mocked(callLLM).mock.calls[0][1] as {
			model: unknown;
			systemPrompt: string;
			messages: { role: string }[];
			maxTokens: number;
			signal: AbortSignal;
			sessionId: string;
			tools?: unknown;
		};
		expect(callOpts.model).toBe(STUB_MODEL);
		expect(callOpts.systemPrompt).toBe(RENAME_SYSTEM_PROMPT);
		expect(callOpts.systemPrompt.length).toBeLessThan(200);
		expect(callOpts.maxTokens).toBe(64);
		expect(callOpts.signal).toBeInstanceOf(AbortSignal);
		expect(callOpts.sessionId).toBe("test-session-id");
		// messages 含前缀（user hi）+ RENAME_INSTRUCTION 追加的 user message
		expect(callOpts.messages).toHaveLength(2);
		expect(callOpts.messages[1]).toMatchObject({ role: "user" });
		// tools 不在 opts（callLLM 内部显式传 tools:[]，调用方不传）
		expect(callOpts.tools).toBeUndefined();
	});

	it("maxTitleLength 截断生效（config.maxTitleLength 透传给 cleanTitle）", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
		const longTitle = "一二三四五六七八九十一二三四五六七八九十";
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: longTitle });
		const result = await callRenameLLM(createCtx(), { ...BASE_CONFIG, maxTitleLength: 5 });
		expect(Array.from(result as string).length).toBe(5);
	});

	it("resolveModel 收到 config.model（验证 selector 透传）", async () => {
		vi.mocked(resolveModel).mockReturnValue(null);
		const ctx = createCtx();
		await callRenameLLM(ctx, BASE_CONFIG);
		expect(resolveModel).toHaveBeenCalledWith(ctx, BASE_CONFIG.model);
	});

	it("thinkingLevel=off → 不传 reasoning（provider 默认，旧版本行为）", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });
		await callRenameLLM(createCtx(), { ...BASE_CONFIG, thinkingLevel: "off" });

		const callOpts = vi.mocked(callLLM).mock.calls[0][1] as { reasoning?: unknown };
		expect(callOpts.reasoning).toBeUndefined();
	});

	it("thinkingLevel=high → 透传 reasoning=high", async () => {
		vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
		vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "标题" });
		await callRenameLLM(createCtx(), { ...BASE_CONFIG, thinkingLevel: "high" });

		const callOpts = vi.mocked(callLLM).mock.calls[0][1] as { reasoning?: unknown };
		expect(callOpts.reasoning).toBe("high");
	});
});

// ────────────────────────────────────────────────────
// A1 日志（TC1-3：失败路径 + 成功路径可排查，契约 C1 文案锁定）
// ────────────────────────────────────────────────────

describe("callRenameLLM A1 日志", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("TC1: resolveModel null → console 输出 '[rename-session] model not available, skipping'，返回 null", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			vi.mocked(resolveModel).mockReturnValue(null);
			const result = await callRenameLLM(createCtx(), BASE_CONFIG);
			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith("[rename-session] model not available, skipping");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("TC2: callLLM {ok:false} → console 输出 '[rename-session] rename LLM call failed: <error>'，返回 null", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
			vi.mocked(callLLM).mockResolvedValue({ ok: false, error: "boom", recoverable: true });
			const result = await callRenameLLM(createCtx(), BASE_CONFIG);
			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith("[rename-session] rename LLM call failed: boom");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("TC2b: callLLM {ok:false} → 不输出 'rename with model' 成功日志（B2 位置修正：成功日志已移到 result.ok 分支后），但仍输出 failed 日志", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
			vi.mocked(callLLM).mockResolvedValue({ ok: false, error: "boom", recoverable: true });
			const result = await callRenameLLM(createCtx(), BASE_CONFIG);
			expect(result).toBeNull();
			// 失败分支仍输出 failed 日志
			expect(warnSpy).toHaveBeenCalledWith(
				"[rename-session] rename LLM call failed: boom",
			);
			// 失败分支不应输出成功日志（B2：成功日志移到 result.ok=true 之后）
			const successLogCalls = warnSpy.mock.calls.filter((c) =>
				String(c[0]).includes("rename with model"),
			);
			expect(successLogCalls).toHaveLength(0);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("TC3: callLLM 成功 → console 输出 '[rename-session] rename with model <provider>/<modelId>'（B3 带 provider 前缀），返回标题", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			vi.mocked(resolveModel).mockReturnValue(STUB_MODEL as never);
			vi.mocked(callLLM).mockResolvedValue({ ok: true, content: "修复登录bug" });
			const result = await callRenameLLM(createCtx(), BASE_CONFIG);
			expect(result).toBe("修复登录bug");
			expect(warnSpy).toHaveBeenCalledWith(
				"[rename-session] rename with model stub/stub-model",
			);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
