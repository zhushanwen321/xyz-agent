import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callLLM, extractText } from "../call.ts";

// mock completeSimple —— call.ts 顶层静态 import 会拿到此 mock（探针①已验证静态 import 机制可行，
// 此处验证 callLLM 逻辑：凭证 narrow / options 构造 / 文本提取 / 错误归一化）。
vi.mock("@earendil-works/pi-ai/compat", () => ({
	completeSimple: vi.fn(),
}));

const mockComplete = vi.mocked(completeSimple);

function makeModel(): Model<Api> {
	return { id: "m", provider: "p", name: "m", api: "anthropic" as Api, baseUrl: "", reasoning: false } as unknown as Model<Api>;
}

function makeCtx(authResult: unknown): ExtensionContext {
	return {
		modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => authResult) },
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	mockComplete.mockReset();
});

describe("callLLM", () => {
	it("TC11 成功：提取 text（trim）+ tools 传 []", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "  hello  " }] });

		const result = await callLLM(ctx, {
			model: makeModel(),
			systemPrompt: "s",
			messages: [],
			sessionId: "sess-1",
		});

		expect(result).toEqual({ ok: true, content: "hello" });
		// 验证 completeSimple 被调用，第二参数 context 含 tools:[]，第三参数 options 含 apiKey + sessionId 透传
		expect(mockComplete).toHaveBeenCalledTimes(1);
		const [, contextArg, optionsArg] = mockComplete.mock.calls[0];
		expect(contextArg).toMatchObject({ systemPrompt: "s", messages: [], tools: [] });
		expect(optionsArg).toMatchObject({ apiKey: "k", sessionId: "sess-1" });
	});

	it("TC12 auth-fail → {ok:false, recoverable:true}，不调 completeSimple（narrow 不取 apiKey）", async () => {
		const ctx = makeCtx({ ok: false, error: "no key" });

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result).toEqual({ ok: false, error: "no key", recoverable: true });
		expect(mockComplete).not.toHaveBeenCalled();
	});

	it("TC13 completeSimple throw → {ok:false, recoverable:true, error 含错误信息}", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockRejectedValue(new Error("network timeout"));

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ recoverable: true, error: expect.stringContaining("network") });
	});

	it("TC1 stopReason=error → {ok:false, error, recoverable:true, stopReason:'error'}（不再 ok:true 返回错误文本）", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		// completeSimple 对错误也 resolve（带 stopReason），content 是错误文本
		mockComplete.mockResolvedValue({ stopReason: "error", content: [{ type: "text", text: "API error: 429 rate limited" }] });

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result).toEqual({ ok: false, error: "API error: 429 rate limited", recoverable: true, stopReason: "error" });
	});

	it("TC2 stopReason=aborted → {ok:false, error, recoverable:true, stopReason:'aborted'}", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ stopReason: "aborted", content: [{ type: "text", text: "user aborted" }] });

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result).toEqual({ ok: false, error: "user aborted", recoverable: true, stopReason: "aborted" });
	});

	it("TC3 stopReason=stop（正常）→ 不受 stopReason 检查影响，ok:true 提取文本", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "  hello  " }] });

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result).toEqual({ ok: true, content: "hello" });
	});

	it("stopReason=error 且 content 无 text → error 回落 'unknown error'", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ stopReason: "error", content: [] });

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result).toEqual({ ok: false, error: "unknown error", recoverable: true, stopReason: "error" });
	});

	it("TC13 catch 路径不设 stopReason（错误原因不可知）", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockRejectedValue(new Error("boom"));

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.stopReason).toBeUndefined();
		}
	});

	it("review TF1: sessionId 透传到 options 第三参数", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [], sessionId: "abc-123" });

		const optionsArg = mockComplete.mock.calls[0][2];
		expect(optionsArg).toMatchObject({ sessionId: "abc-123" });
	});

	it("review TF1: 无 sessionId 时 options 不含 sessionId 字段（条件 spread 不传）", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		const optionsArg = mockComplete.mock.calls[0][2] as Record<string, unknown>;
		expect("sessionId" in optionsArg).toBe(false);
	});

	it("B5: getApiKeyAndHeaders reject（抛异常）→ {ok:false, recoverable:true}（归一入 catch，不向上抛）", async () => {
		const getApiKeyAndHeaders = vi.fn().mockRejectedValueOnce(new Error("registry exploded"));
		const ctx = { modelRegistry: { getApiKeyAndHeaders } } as unknown as ExtensionContext;

		const result = await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		expect(result).toEqual({ ok: false, error: "registry exploded", recoverable: true });
		// 凭证阶段就 reject，completeSimple 未被调用
		expect(mockComplete).not.toHaveBeenCalled();
	});

	it("review C2: signal 透传到 options 第三参数", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });
		const ac = new AbortController();

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [], signal: ac.signal });

		const optionsArg = mockComplete.mock.calls[0][2];
		expect(optionsArg).toMatchObject({ signal: ac.signal });
	});

	it("review C2: maxTokens 透传到 options 第三参数", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [], maxTokens: 1024 });

		const optionsArg = mockComplete.mock.calls[0][2];
		expect(optionsArg).toMatchObject({ maxTokens: 1024 });
	});

	it("review C2: timeoutMs 透传到 options 第三参数", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [], timeoutMs: 5000 });

		const optionsArg = mockComplete.mock.calls[0][2];
		expect(optionsArg).toMatchObject({ timeoutMs: 5000 });
	});

	it("review C2: 不传 signal/maxTokens/timeoutMs 时 options 不含这些字段（条件 spread）", async () => {
		const ctx = makeCtx({ ok: true, apiKey: "k" });
		mockComplete.mockResolvedValue({ content: [{ type: "text", text: "x" }] });

		await callLLM(ctx, { model: makeModel(), systemPrompt: "s", messages: [] });

		const optionsArg = mockComplete.mock.calls[0][2] as Record<string, unknown>;
		expect("signal" in optionsArg).toBe(false);
		expect("maxTokens" in optionsArg).toBe(false);
		expect("timeoutMs" in optionsArg).toBe(false);
	});
});

describe("extractText", () => {
	it("TC11 单个 text block 提取 + trim", () => {
		expect(extractText({ content: [{ type: "text", text: "  hello  " }] })).toBe("hello");
	});

	it("review: 多个 text block 拼接 + trim", () => {
		expect(extractText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a b");
	});

	it("review: 无 text block（纯 ThinkingContent / ToolCall）→ ''", () => {
		expect(extractText({ content: [{ type: "thinking", text: "..." }, { type: "tool_call" }] })).toBe("");
	});

	it("review: 空 content → ''", () => {
		expect(extractText({ content: [] })).toBe("");
	});
});
