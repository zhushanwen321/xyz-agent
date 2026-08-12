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
