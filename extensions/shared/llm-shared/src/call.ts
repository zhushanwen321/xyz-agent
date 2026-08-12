/**
 * LLM 调用封装：completeSimple + 凭证注入 + 文本提取 + 错误归一化。
 *
 * import 方式：顶层【静态】import completeSimple。
 * 探针①（2026-08-12，pi 0.84.0）实测：pi extension loader 加载含顶层
 * `import { completeSimple } from "@earendil-works/pi-ai/compat"` 的 extension 不 throw，
 * typeof completeSimple === "function"。compat.js 本身是真实模块（非 throwing stub），
 * rename-session/llm.ts 旧注释「加载阶段 compat 是 throwing stub」已过时（其代码用 import type +
 * 动态 import，从未真正测过顶层静态运行时 import）。故本库用静态 import，更简单且 tree-shake 友好。
 *
 * 凭证：getApiKeyAndHeaders 返回判别联合 ResolvedRequestAuth，必须 `if(!auth.ok) return` narrow
 * 后才能取 apiKey/headers/env（否则 TS 报错、运行时 auth.error 不存在）。
 */

// 顶层静态 import —— 探针①已验证加载阶段不 throw（见模块注释）
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Context as LlmContext, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ──────────────────────── 类型 ────────────────────────

/** callLLM 入参。tools 不在此 —— callLLM 内部显式传 tools:[] 给 Context（不塞工具，best-effort 语义）。 */
export interface CallLLMOptions {
	/** resolveModel 返回的 Model 对象（不是字符串）。 */
	model: Model<Api>;
	/** 独立 system prompt，调用方负责构造（不复用 ctx.getSystemPrompt）。 */
	systemPrompt: string;
	/** pi-ai Message[]（对话历史 + 当前指令）。 */
	messages: Message[];
	maxTokens?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** 透传给 SimpleStreamOptions.sessionId（provider 用于 session 缓存 / 路由）。review TF1 新增。 */
	sessionId?: string;
}

/**
 * callLLM 出参。
 * - ok:true → content 为提取并 trim 的文本
 * - ok:false → recoverable=true 表示网络/超时/auth 类瞬时错误，调用方可静默跳过或降级
 */
export type CallLLMResult =
	| { ok: true; content: string }
	| { ok: false; error: string; recoverable: boolean };

// ──────────────────────── 文本提取 ────────────────────────

/**
 * 从 AssistantMessage.content 提取所有 text block 拼接并 trim。
 *
 * 参数用结构类型（不直接依赖 AssistantMessage），便于测试 mock —— 调用方传 completeSimple 返回值即可。
 * 无 text block（如纯 ThinkingContent / ToolCall）→ 返回 ""。
 */
export function extractText(resp: {
	content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
	return resp.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join(" ")
		.trim();
}

// ──────────────────────── 调用 ────────────────────────

/**
 * 发起一次 LLM 调用（completeSimple），返回归一化结果。
 *
 * 流程：
 * 1. 凭证：getApiKeyAndHeaders(model) → narrow（auth.ok 判别联合）→ 失败返回 {ok:false, recoverable:true}
 * 2. 调用：completeSimple(model, {systemPrompt, messages, tools:[]}, {apiKey, headers?, env?, signal?, maxTokens?, timeoutMs?, sessionId?})
 * 3. 提取 text → {ok:true, content}
 * 4. throw（网络/超时/解析）→ catch → {ok:false, error:String(e), recoverable:true}
 *
 * tools 显式传 []（不塞工具）—— 本库用于标题生成等 best-effort 场景，不需要工具调用。
 */
export async function callLLM(
	ctx: ExtensionContext,
	opts: CallLLMOptions,
): Promise<CallLLMResult> {
	// 1. 凭证（判别联合必须 narrow）
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(opts.model);
	if (!auth.ok) {
		return { ok: false, error: auth.error, recoverable: true };
	}

	// 2. 调用 completeSimple（字段名经探针⑤对齐：Context{systemPrompt?,messages,tools?},
	//    SimpleStreamOptions extends StreamOptions{apiKey?,headers?,env?,signal?,maxTokens?,timeoutMs?,sessionId?}）
	try {
		const context: LlmContext = {
			systemPrompt: opts.systemPrompt,
			messages: opts.messages,
			tools: [],
		};
		// apiKey/headers/env 来自 auth（即使 undefined 也传，让 completeSimple 用默认）；
		// signal/maxTokens/timeoutMs/sessionId 条件 spread（不设置则不传，保留 completeSimple 默认）。
		const options: SimpleStreamOptions = {
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			...(opts.signal ? { signal: opts.signal } : {}),
			...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
			...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
			...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
		};
		const resp = await completeSimple(opts.model, context, options);
		return { ok: true, content: extractText(resp) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error), recoverable: true };
	}
}
