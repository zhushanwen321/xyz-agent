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
 * 参数为 unknown（callRenameLLM 的 finalMessage 契约），非对象 / content 形态未知按无 text 处理。
 */
export function extractFinalText(message: unknown): string {
	if (!isRecord(message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block) => isRecord(block) && block.type === "text")
		.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
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
		// thinking 块保留分支，本合成条目 text-only 不经过）→ 单点 as Message（沿用项目既有注释惯例）。
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

// ──────────────────────── debug 证据链（D9）+ 超时（D7） ────────────────────────

/** rename LLM 超时（D7 固定值：输入 ≤8k token + 输出 64 token，30s 宽裕；超时归一 ok:false 静默跳过）。 */
const RENAME_TIMEOUT_MS = 30_000;

/** debug 开关 live 读（每次调用查 process.env，非模块加载时读——vi.stubEnv 可测 + 运行时可切换）。 */
function isRenameDebugEnabled(): boolean {
	return process.env.PI_RENAME_DEBUG === "1";
}

/**
 * llm.ts 侧 debug 日志（C3 契约）：[rename-session] + t=<ISO时间> + 文案。
 * 不含 turnIndex——该字段只在 handler 作用域可达，不为日志字段扩 callRenameLLM 签名。
 */
function debugLog(message: string): void {
	if (isRenameDebugEnabled()) {
		console.warn(`[rename-session] t=${new Date().toISOString()} ${message}`);
	}
}

/** preview 阈值（Unicode 码点数，D9 契约）：≤300 码点全文；>300 输出 head 200 码点 + 字面 … + tail 100 码点。 */
const PREVIEW_MAX_CODE_POINTS = 300;
const PREVIEW_HEAD_CODE_POINTS = 200;
const PREVIEW_TAIL_CODE_POINTS = 100;

/**
 * debug 日志的文本预览（D9）：≤300 码点直接全文；超长输出 head 200 码点 + 字面 … + tail 100 码点
 * （head/tail 双段支撑 E2E 对长 prompt 首尾片段的断言）。按码点截断（与 truncateForTitle 同单位，
 * Array.from 切分，代理对/emoji 不被劈开）；e2e/harness.mjs 的 rebuildPreview 是同构实现，两处必须同步改。
 */
function previewText(text: string): string {
	const chars = Array.from(text);
	if (chars.length <= PREVIEW_MAX_CODE_POINTS) return text;
	return (
		chars.slice(0, PREVIEW_HEAD_CODE_POINTS).join("") +
		"…" +
		chars.slice(-PREVIEW_TAIL_CODE_POINTS).join("")
	);
}

/** 取 message content 内 text blocks 的拼接文本（debug 内省用，与发给 LLM 的数据同源）。 */
function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join(" ");
}

// ──────────────────────── LLM 调用 ────────────────────────

/**
 * 发起 rename LLM 调用，返回提取+清洗后的标题（空串/异常返回 null 表示应跳过 rename）。
 *
 * finalMessage：触发 turn 的 event.message（D2——stopReason==='stop' 的 turn_end 自带最终
 * assistant message，final text 零遍历可得）。
 *
 * 收口要点（对比旧版搭便车逻辑）：
 * - model：`resolveModel(ctx, config.model)` 独立选模（旧版 `ctx.model` 搭便车主 session 模型）
 * - systemPrompt：`RENAME_SYSTEM_PROMPT` 精简版（旧版 `ctx.getSystemPrompt()` 整个 agent prompt）
 * - messages：两段信号 [user(prompt), assistant(finalText), user(instruction)]（D1/D2/D3，
 *   替换旧版全量前缀方案——过程数据稀释标题信号且 token 成本随工具数增长）
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
	finalMessage: unknown,
): Promise<string | null> {
	// 内部顺序不可调换（E2E 竞态断言依赖「内省日志在请求发起前打出」）：
	// resolveModel → extract prompt → extract finalText → truncate ×2 → build → debug 内省 → callLLM
	const model = resolveModel(ctx, config.model);
	if (!model) {
		// A1 日志：不可用不静默（可排查）
		console.warn("[rename-session] model not available, skipping");
		return null;
	}

	const userPrompt = extractUserPromptText(
		ctx.sessionManager.getEntries() as ReadonlyArray<EntryLike>,
	);
	if (userPrompt === null) {
		// 理论不发生（round 由 user message 触发），null = 连 user message 都没有
		debugLog("skip: no user prompt");
		return null;
	}
	const finalText = extractFinalText(finalMessage);

	// 两段输入信号各截断 4000 码点（D3：成本可控，标题语义足够）
	const messages = buildTitleMessages(
		truncateForTitle(userPrompt),
		truncateForTitle(finalText),
		RENAME_INSTRUCTION,
	);

	// debug 内省（D9）：日志与 callLLM 收到的是同一 messages 对象，日志内容即 LLM 收到的内容；
	// 必须在 callLLM 之前打出（E2E 轮询此日志在 rename 返回前抢入手动命名）
	if (isRenameDebugEnabled()) {
		const preview = messages.map((m) => ({ role: m.role, text: previewText(messageText(m)) }));
		debugLog(`LLM request messages: ${JSON.stringify(preview)}`);
	}

	const sessionId = ctx.sessionManager.getSessionId();
	const result = await callLLM(ctx, {
		model,
		systemPrompt: RENAME_SYSTEM_PROMPT,
		messages,
		// 标题只需几个词，64 token 足够且省 quota
		maxTokens: 64,
		// D7：固定 30s 超时（网络抖动归一为 ok:false 走静默跳过，不悬挂 fire-and-forget promise）
		timeoutMs: RENAME_TIMEOUT_MS,
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
	if (!title) {
		debugLog("skip: title empty");
		return null;
	}
	// 落库报捷日志由 index.ts handler 侧在 setSessionName 之后打出——此处只返回候选标题，
	// 防覆盖检查未过时并未落库，不能在 LLM 层提前报捷
	return title;
}
