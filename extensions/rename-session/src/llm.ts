import path from "node:path";

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callLLM, resolveModel } from "@zhushanwen/pi-llm-shared";

import { type RenameSessionConfig, cleanTitle } from "./pure.js";

// ──────────────────────── prompt 常量 ────────────────────────

/**
 * rename 专属 systemPrompt（slug 词组风格约束）。
 *
 * 收口自旧版 `ctx.getSystemPrompt()`（搭便车整个 agent prompt，含 AGENTS.md/技能/工具说明，> 2000 字符）。
 * 本常量 < 200 字符（llm.test.ts LTC16 断言），只为标题生成服务，省 input token 成本。
 * D4 重写：旧版只约束「3-8 词」，实测产出常是完整句子（如「我帮你修复了登录 bug」）；
 * 新版锚定 slug 词组形态（名词/动名词词组、非主谓宾、无句尾标点、英文 kebab-case 小写）。
 */
export const RENAME_SYSTEM_PROMPT =
	"你是会话标题生成器。根据对话生成 slug 式标题：名词或动名词词组，不要完整句子、不要主谓宾、不要代词或「已/完成了」这类时态表述、不要句尾标点。英文用小写 kebab-case。使用对话所用的语言，3-6 个词。只输出标题文本。";

/**
 * 追加到对话末尾的 user 指令（与 RENAME_SYSTEM_PROMPT 双处一致约束，D4）。
 * 含正例（「修复登录超时」「refactor-config-loader」）与反例（「我帮你修复了登录 bug」）
 * few-shot 锚定——正反例是最有效的风格锚定手段（被否方案：只在 instruction 加一句弱提示，遵从率低）。
 */
export const RENAME_INSTRUCTION =
	"根据以上对话，为这个会话生成一个 slug 式标题。要求：\n- 名词或动名词词组，例：「修复登录超时」「重构配置加载」「refactor-config-loader」\n- 反例（错误）：「我帮你修复了登录 bug」「This session is about fixing bugs」\n- 英文小写 kebab-case，中文直接用词组，不要句号\n使用对话所用的语言。只输出标题文本。";

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

// ──────────────────────── 标题输入构造（两段信号，D1/D2/D3） ────────────────────────

/** unknown → Record 的运行时守卫：extractUserPromptText 逐字段消费 session entries 的宽松数据，字段存在性与类型由守卫核实（不使用 as any）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 取 session entries 中首条 user message 的 prompt 文本（标题输入信号之一，设计 D1）。
 *
 * content 为 string 直接返回；为 blocks 数组时拼接 type==='text' 的 text（多 block 用
 * join(' ')，对齐 llm-shared extractText 惯例），跳过 ImageContent（标题模型可能不支持图片输入）。
 * 首条 user 前的 compaction 等非 message entry 自然跳过；无 user message 返回 null
 * （理论不发生：round 由 user message 触发，调用方 null 时跳过 rename 并记 debug 日志）。
 */
export function extractUserPromptText(entries: ReadonlyArray<EntryLike>): string | null {
	for (const entry of entries) {
		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			const texts: string[] = [];
			for (const block of message.content) {
				if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
					texts.push(block.text);
				}
			}
			return texts.join(" ");
		}
		// 找到首条 user 但 content 形态未知（异常数据）：按无文本处理返回空串，不继续扫后续 user
		return "";
	}
	return null;
}

/**
 * 从触发 turn 的 assistant message（turn_end 的 event.message）提取最终回复文本（设计 D2）。
 * 拼接 content 内 type==='text' 的 text（join(' ')，跳过 thinking/toolCall）；无 text 返回 ''。
 * 参数用结构类型（不直接依赖 AssistantMessage），便于测试 mock。
 */
export function extractFinalText(message: {
	content?: ReadonlyArray<{ type: string; text?: string }>;
}): string {
	return (message.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join(" ");
}

/** 输入段截断上限（Unicode 码点数，设计 D3：中文场景约 4k token/段，任何现代模型窗口都远超此值）。 */
const MAX_TITLE_INPUT_CODE_POINTS = 4000;

/**
 * 按 Unicode 码点截断标题输入段（设计 D3：两段信号各 4000 码点，中文场景约 4k token/段，成本可控）。
 * Array.from 按码点切分，星面字符（emoji 等，占 2 个 UTF-16 码元）不会被劈成半个代理对；
 * 超长才追加 '…' 后缀，≤ maxCodePoints（含恰好等于）原样返回。
 */
export function truncateForTitle(
	text: string,
	maxCodePoints = MAX_TITLE_INPUT_CODE_POINTS,
): string {
	const chars = Array.from(text);
	if (chars.length <= maxCodePoints) return text;
	return chars.slice(0, maxCodePoints).join("") + "…";
}

/**
 * 构造标题 LLM 的 messages：[user(prompt), assistant(finalText 仅非空时), user(instruction)]（设计 D1）。
 * 两段文本信号（任务意图 + 轮次结论）恰好与标题语义对齐，不含 toolCall/toolResult 等过程数据。
 * finalText 为空（纯工具结束的 round）时降级为两条——标题主信号本就是 prompt，不因此跳过 rename。
 */
export function buildTitleMessages(
	userPrompt: string,
	finalText: string,
	instruction: string,
): Message[] {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() },
	];
	if (finalText !== "") {
		// AssistantMessage 的 api/usage/stopReason 等是 pi 侧输出记账字段，输入路径不消费
		// （已核 anthropic-messages/google-shared/openai-completions 三家 convertMessages：
		// assistant 输入只读 role + content blocks；google 对 msg.provider/model 的读取仅在
		// thinking 块保留分支，本合成条目 text-only 不经过）→ 单点 as Message（同 buildMessages 既有模式）。
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: finalText }],
		} as Message);
	}
	messages.push({
		role: "user",
		content: [{ type: "text", text: instruction }],
		timestamp: Date.now(),
	});
	return messages;
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
	// 独立选模：config.model（默认 scoped）。不可用静默跳过（A1 日志：不静默，可排查）。
	const model = resolveModel(ctx, config.model);
	if (!model) {
		console.warn("[rename-session] model not available, skipping");
		return null;
	}

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
		// thinkingLevel:"off" → 不传 reasoning（provider 默认，与旧版本行为一致）；
		// "minimal"~"max" 透传 pi-ai SimpleStreamOptions.reasoning（provider 不支持时忽略）
		reasoning: config.thinkingLevel === "off" ? undefined : config.thinkingLevel,
		// 保留随 session abort 取消调用的语义（旧版 llm.ts 同样透传 ctx.signal）
		signal: ctx.signal,
		sessionId,
	});
	if (!result.ok) {
		// A1 失败路径日志：调用失败不静默（不抛错，靠日志留痕）。
		console.warn(`[rename-session] rename LLM call failed: ${result.error ?? "unknown error"}`);
		return null;
	}

	// A1 成功路径日志（B2+B3 修正）：
	// - B2 位置：原在 callLLM 调用前打出，失败时会误导（日志已落但 rename 未发生）；移到 result.ok 确认后
	// - B3 文案：补 provider 前缀，区分两个 provider 同名 model
	console.warn(`[rename-session] rename with model ${model.provider}/${model.id}`);

	const title = cleanTitle(result.content, config.maxTitleLength);
	return title || null;
}
