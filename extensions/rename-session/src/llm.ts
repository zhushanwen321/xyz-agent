import path from "node:path";

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callLLM, resolveModel } from "@zhushanwen/pi-llm-shared";

import { type RenameSessionConfig, cleanTitle } from "./pure.js";

// ──────────────────────── prompt 常量 ────────────────────────

/**
 * rename 专属 systemPrompt（精简角色定义）。
 *
 * 收口自旧版 `ctx.getSystemPrompt()`（搭便车整个 agent prompt，含 AGENTS.md/技能/工具说明，> 2000 字符）。
 * 本常量 < 200 字符（实测 string.length=75），只为标题生成服务，省 input token 成本。
 */
export const RENAME_SYSTEM_PROMPT =
	"你是会话标题生成器。根据对话内容生成 3-8 词的简短标题，使用对话所用的语言。只输出标题文本，不要解释、emoji、引号或 markdown 标记。";

/**
 * 追加到对话末尾的 user 指令（与 RENAME_SYSTEM_PROMPT 配合，引导模型只输出标题）。
 * 保留旧版 CONFIG.renameInstruction 文案（已验证有效）。
 */
export const RENAME_INSTRUCTION =
	"根据以上对话，为这个会话生成一个简短标题（3-8 个词）。用对话所用的语言。只输出标题文本，不要解释，不要 emoji，不要引号或 markdown 标记。";

// ──────────────────────── 纯函数 ────────────────────────

/** sessionDir 路径含 subagents 段 → 是 subagent 子进程 session，跳过 rename。 */
export function isSubagentSession(sessionDir: string): boolean {
	return sessionDir.includes(path.sep + "subagents" + path.sep);
}

/** entry 的宽松类型（structural typing，兼容 pi 的 SessionEntry[] 但不依赖 pi 类型）。 */
interface EntryLike {
	type: string;
	message?: unknown;
}

/**
 * 从 session entries 构造 messages 前缀，末尾追加 rename 指令 user message。
 * 取 type==='message' 的 entry.message，按原顺序保留（前缀与主 turn 字节级一致，命中 kvcache）。
 *
 * 返回 pi-ai 的 Message[]（callLLM 的 messages 契约）。前缀来自 entry.message
 * （SessionMessageEntry.message 即 AgentMessage，是 Message 的超集），末尾的 rename 指令
 * 补齐 UserMessage 必填的 timestamp 字段。
 */
export function buildMessages(entries: ReadonlyArray<EntryLike>, instruction: string): Message[] {
	const prefix = entries
		.filter((e) => e.type === "message" && e.message !== undefined)
		.map((e) => e.message as Message);
	return [
		...prefix,
		{ role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() },
	];
}

// ──────────────────────── LLM 调用 ────────────────────────

/**
 * 发起 rename LLM 调用，返回提取+清洗后的标题（空串/异常返回 null 表示应跳过 rename）。
 *
 * 收口要点（对比旧版搭便车逻辑）：
 * - model：`resolveModel(ctx, config.model)` 独立选模（旧版 `ctx.model` 搭便车主 session 模型）
 * - systemPrompt：`RENAME_SYSTEM_PROMPT` 精简版（旧版 `ctx.getSystemPrompt()` 整个 agent prompt）
 * - tools：不传（callLLM 内部显式 tools:[]；旧版 `pi.getAllTools()` 塞全部工具，纯浪费 token）
 * - model 不可用（resolveModel 返回 null）→ 静默跳过返回 null，不报错不阻断
 * - signal：透传 ctx.signal（保留旧版随 session abort 取消的语义）
 *
 * 本函数是 async（内部 await callLLM，这是 callRenameLLM 自身流程）；
 * 调用方（turn_end handler）用 fire-and-forget 包裹（`void callRenameLLM(...).then(...).catch(...)`），
 * 禁止 await 本函数（会阻塞 handler，与现有 fire-and-forget 契约不符）。
 */
export async function callRenameLLM(
	ctx: ExtensionContext,
	config: RenameSessionConfig,
): Promise<string | null> {
	// 独立选模：config.model（默认 scoped）。不可用静默跳过。
	const model = resolveModel(ctx, config.model);
	if (!model) return null;

	const sessionId = ctx.sessionManager.getSessionId();
	const messages = buildMessages(
		ctx.sessionManager.getEntries() as ReadonlyArray<EntryLike>,
		RENAME_INSTRUCTION,
	);

	const result = await callLLM(ctx, {
		model,
		systemPrompt: RENAME_SYSTEM_PROMPT,
		messages,
		// 标题只需几个词，64 token 足够且省 quota
		maxTokens: 64,
		// 保留随 session abort 取消调用的语义（旧版 llm.ts 同样透传 ctx.signal）
		signal: ctx.signal,
		sessionId,
	});
	if (!result.ok) return null;

	const title = cleanTitle(result.content, config.maxTitleLength);
	return title || null;
}
