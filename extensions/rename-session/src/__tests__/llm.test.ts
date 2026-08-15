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
	buildTitleMessages,
	callRenameLLM,
	extractFinalText,
	extractUserPromptText,
	isSubagentSession,
	truncateForTitle,
} from "../llm.js";
import { DEFAULT_RENAME_CONFIG, type RenameSessionConfig } from "../pure.js";

// ────────────────────────────────────────────────────
// extractUserPromptText（D1：标题输入信号之一——首条 user prompt 提取）
// ────────────────────────────────────────────────────

describe("extractUserPromptText", () => {
	it("LTC6: content 为 string → 直接返回", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "帮我修复登录超时" } },
		];
		expect(extractUserPromptText(entries)).toBe("帮我修复登录超时");
	});

	it("LTC7: blocks 混合（text+image+text）→ image 跳过，多 text block join(' ')", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "帮我修复登录超时" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
						{ type: "text", text: "最好加单测" },
					],
				},
			},
		];
		expect(extractUserPromptText(entries)).toBe("帮我修复登录超时 最好加单测");
	});

	it("LTC8: 无 user message（compaction + assistant only）→ null", () => {
		const entries = [
			{ type: "compaction", data: {} },
			{ type: "message", message: { role: "assistant", content: [] } },
		];
		expect(extractUserPromptText(entries)).toBeNull();
	});

	it("LTC9: 首条 user 前有 compaction entry → 仍取首条 user（跳过非 message/非 user entry）", () => {
		const entries = [
			{ type: "compaction", data: {} },
			{ type: "message", message: { role: "user", content: "继续刚才的" } },
			{ type: "message", message: { role: "user", content: "第二条 user 不取" } },
		];
		expect(extractUserPromptText(entries)).toBe("继续刚才的");
	});
});

// ────────────────────────────────────────────────────
// extractFinalText（D2：final text = 触发 turn 的 assistant text blocks）
// ────────────────────────────────────────────────────

describe("extractFinalText", () => {
	it("LTC10: text/thinking/toolCall 三类 block 混合 → 只拼接 text block（join(' ')）", () => {
		const message = {
			content: [
				{ type: "thinking", thinking: "让我看看代码" },
				{ type: "text", text: "已修复" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
				{ type: "text", text: "并补了回归测试" },
			],
		};
		expect(extractFinalText(message)).toBe("已修复 并补了回归测试");
	});

	it("LTC11: 全空 content（空数组）→ ''", () => {
		expect(extractFinalText({ content: [] })).toBe("");
	});

	it("LTC11b: content 缺失或无 text block → ''", () => {
		expect(extractFinalText({})).toBe("");
		expect(extractFinalText({ content: [{ type: "thinking", thinking: "..." }] })).toBe("");
	});
});

// ────────────────────────────────────────────────────
// truncateForTitle（D3：输入段按码点截断保护，超长才加 '…'）
// ────────────────────────────────────────────────────

describe("truncateForTitle", () => {
	it("LTC12: 中文超长 → 截断到 4000 码点 + '…' 后缀，星面字符完整（无半个代理对）", () => {
		// 3999 个 BMP 字符 + 2 个星面字符（😀 U+1F600：2 个 UTF-16 码元 = 1 个码点）= 4001 码点
		const text = "修".repeat(3999) + "😀".repeat(2);
		const result = truncateForTitle(text);
		const chars = Array.from(result);
		expect(chars).toHaveLength(4001); // 4000 截断 + 1 个 …
		expect(chars[3999]).toBe("😀"); // 边界切在码点边界，emoji 不被劈成半个代理对
		expect(chars[4000]).toBe("…");
	});

	it("LTC12b: 不超长 → 原样返回（无 '…' 后缀）", () => {
		expect(truncateForTitle("你好")).toBe("你好");
		expect(truncateForTitle("")).toBe("");
	});

	it("LTC12c: 恰好 4000 码点 → 原样返回，不加后缀", () => {
		const text = "a".repeat(4000);
		const result = truncateForTitle(text);
		expect(result).toBe(text);
		expect(result.endsWith("…")).toBe(false);
	});
});

// ────────────────────────────────────────────────────
// buildTitleMessages（D1：两段信号 + 指令的三段式构造）
// ────────────────────────────────────────────────────

describe("buildTitleMessages", () => {
	it("LTC14: finalText 非空 → 3 条 [user(prompt), assistant(finalText), user(instruction)]，user 条目带 timestamp", () => {
		const result = buildTitleMessages("帮我修复登录超时", "已修复：调整了超时配置", "生成标题指令");
		expect(result).toHaveLength(3);

		const first = result[0] as {
			role: string;
			content: { type: string; text: string }[];
			timestamp?: number;
		};
		expect(first.role).toBe("user");
		expect(first.content[0].type).toBe("text");
		expect(first.content[0].text).toBe("帮我修复登录超时");
		expect(typeof first.timestamp).toBe("number");

		const second = result[1] as { role: string; content: { type: string; text: string }[] };
		expect(second.role).toBe("assistant");
		expect(second.content[0].type).toBe("text");
		expect(second.content[0].text).toBe("已修复：调整了超时配置");

		const third = result[2] as {
			role: string;
			content: { type: string; text: string }[];
			timestamp?: number;
		};
		expect(third.role).toBe("user");
		expect(third.content[0].text).toBe("生成标题指令");
		expect(typeof third.timestamp).toBe("number");
	});

	it("LTC15: finalText 为空 → 2 条（降级只发 prompt + instruction，无 assistant 条目）", () => {
		const result = buildTitleMessages("继续刚才的", "", "生成标题指令");
		expect(result).toHaveLength(2);
		expect(result.map((m) => m.role)).toEqual(["user", "user"]);
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
// RENAME_SYSTEM_PROMPT / RENAME_INSTRUCTION（D4 slug 风格约束 + few-shot 锚定）
// ────────────────────────────────────────────────────

describe("RENAME_SYSTEM_PROMPT / RENAME_INSTRUCTION", () => {
	it("LTC16: SYSTEM_PROMPT string.length < 200（精简 prompt，对比改造前 ctx.getSystemPrompt() > 2000）", () => {
		expect(RENAME_SYSTEM_PROMPT.length).toBeLessThan(200);
	});

	it("LTC17: INSTRUCTION 含正例锚定（「修复登录超时」+「refactor-config-loader」）", () => {
		expect(RENAME_INSTRUCTION).toContain("修复登录超时");
		expect(RENAME_INSTRUCTION).toContain("refactor-config-loader");
	});

	it("LTC18: INSTRUCTION 含反例锚定（「我帮你修复了登录 bug」——主谓宾句子是错误形态）", () => {
		expect(RENAME_INSTRUCTION).toContain("我帮你修复了登录 bug");
	});

	it("LTC19: 两常量均含 slug 风格约束词（kebab-case / 名词或动名词）", () => {
		for (const c of [RENAME_SYSTEM_PROMPT, RENAME_INSTRUCTION]) {
			expect(c.includes("kebab-case") || c.includes("名词或动名词")).toBe(true);
		}
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
