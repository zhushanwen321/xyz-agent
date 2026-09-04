// src/index.ts — @zhushanwen/pi-plugin-bridge
// 插件系统桥（taiji 组，infrastructure）：runtime PluginService 的工具清单经
// select+BRIDGE_MARKER 通道同步进 pi（registerTool），工具 execute 与 pi 事件
// 经同一通道往返 runtime。协议 v2 形状 SSOT 在 @xyz-agent/extension-protocol 的
// plugin-bridge 协议模块（marker.ts + types.ts），本包是 pi 侧
// 序列化发送方；runtime 侧识别/回包在 bridge-handler（设计 bridge-rewrite-pi-0.84）。
//
// 三条硬约束（设计 §3.3，违反即回归）：
// 1. factory 禁止顶层 await —— pi loader 逐个 await factory（loader.js initializeExtension），
//    顶层挂起会阻塞整个 pi 会话就绪；启动 sync 一律 void 后台任务。
// 2. observe 类事件（bridge:event）转发必须 fire-and-forget —— pi runner 的通用
//    emit 对每个 handler 逐个 await，await runtime 往返会把每个 agent 事件都阻塞在
//    一次跨进程 RPC 上。仅 intercept（本就要等决策结果）允许 await。
// 3. select 不传 timeout（通道层零 timer）—— 超时权威在 runtime 侧 D1 取值链
//    （插件声明 timeoutMs / 30min 默认，超时后 runtime 主动回包），dialog 恒有终态；
//    只透传 signal 吃 abort 红利（用户中断 → pi 本地 resolve(undefined)）。

import type {
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	BRIDGE_MARKER,
	type BridgeErrorResponse,
	type BridgeSyncPayload,
	type BridgeToolExecuteResponse,
	type BridgeRequest,
	type BridgeInterceptResponse,
} from "@xyz-agent/extension-protocol";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";
import type { TSchema } from "typebox";

// 模块级 logger（factory 首行 setPiHandle 注入后自动走 appendEntry 持久化，
// 注入前/失败降级文件日志——见 extension-logger 三层通道设计）
const logger = getLogger("plugin-bridge");

// ── 同步参数（设计 §3.3-D4：对齐旧 bridge 参数——组合根 plugin-service 装配在秒级完成，
// 60s 窗口足够；重试到顶进 Degraded，本 session 无自愈，恢复 = 下个 session）──

const MAX_SYNC_ATTEMPTS = 30;
const SYNC_RETRY_MS = 2_000;
const MS_PER_SECOND = 1_000;

/** 日志/错误文本里回包预览的截断长度（防大 payload 刷屏；截断只影响留痕不影响协议） */
const RESPONSE_PREVIEW_LENGTH = 200;

// ── 运行时形状守卫（extensions 约定：断言必须有运行时 guard 兜底）──

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** runtime 错误闭环形状 {error, hint?}（设计 §3.3-D1：不裸 reject） */
function isBridgeErrorResponse(v: unknown): v is BridgeErrorResponse {
	return isRecord(v) && typeof v.error === "string";
}

function isBridgeToolExecuteResponse(v: unknown): v is BridgeToolExecuteResponse {
	return isRecord(v) && typeof v.content === "string" && (v.isError === undefined || typeof v.isError === "boolean");
}

function isBridgeSyncPayload(v: unknown): v is BridgeSyncPayload {
	return isRecord(v) && v.success === true && Array.isArray(v.tools);
}

function isBridgeInterceptResponse(v: unknown): v is BridgeInterceptResponse {
	return isRecord(v) && Array.isArray(v.injectedMessages);
}

/** sync 清单里的单个工具条目（parameters 顶层必须 type:'object'——OpenAI 兼容红线） */
function isSyncedTool(v: unknown): v is BridgeSyncPayload["tools"][number] {
	return (
		isRecord(v) &&
		typeof v.name === "string" &&
		typeof v.description === "string" &&
		isRecord(v.parameters) &&
		v.parameters.type === "object"
	);
}

/** 拦截注入消息的最小形状（旧 bridge 契约：{role, content}，content 任意类型） */
function isInjectedMessage(v: unknown): v is { content: unknown } {
	return isRecord(v) && "content" in v;
}

// ── pi 原生 Content 形态（@earendil-works/pi-ai TextContent/ImageContent 的结构形状；
// pi-coding-agent 主入口不 re-export 这两个类型，按 subagent-workflow 同款局部接口先例）──

/** TextContent 最小判定形状：textSignature 等可选字段守卫不检查、透传不丢失 */
interface InjectedTextContent {
	type: "text";
	text: string;
}

/** ImageContent 同构形状：{type:'image', data, mimeType} */
interface InjectedImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

function isTextContent(v: unknown): v is InjectedTextContent {
	return isRecord(v) && v.type === "text" && typeof v.text === "string";
}

function isImageContent(v: unknown): v is InjectedImageContent {
	return isRecord(v) && v.type === "image" && typeof v.data === "string" && typeof v.mimeType === "string";
}

/** 清单 miss 识别（设计 §3.4-E2）：错误闭环 {error:'Tool not found…'} 与工具结果
 * {content:'Tool not found…', isError:true}（runtime bridge-interop 实装形态）双覆盖 */
function isToolNotFound(raw: unknown): boolean {
	if (!isRecord(raw)) return false;
	if (typeof raw.error === "string") return raw.error.startsWith("Tool not found");
	return raw.isError === true && typeof raw.content === "string" && raw.content.startsWith("Tool not found");
}

// ── select 通道 ──

/** bridge 请求经 select 通道的统一出口：返回解析后的回包对象；失败路径统一折叠为 null
 * （cancelled / 通道异常 / 非 JSON 回包），由各调用方按语义折叠为 isError 或重试。 */
async function callBridge(
	ctx: ExtensionContext,
	request: BridgeRequest,
	opts?: { signal?: AbortSignal },
): Promise<unknown> {
	const payload = JSON.stringify(request);
	try {
		// signal 透传给 dialog：abort 后 pi 本地 resolve(undefined) 不 reject（rpc-mode
		// pendingExtensionRequests），用户中断秒级打断挂起等待（G2）。不传 timeout（零 timer 约束）。
		const value = await ctx.ui.select(BRIDGE_MARKER, [payload], { signal: opts?.signal });
		if (value === undefined || value === null) return null;
		try {
			return JSON.parse(value);
		} catch {
			// 回包非 JSON = 协议版本不匹配（E5/E7 类），必须留痕不静默
			logger.error(`[plugin-bridge] non-JSON response for ${request.method}`, {
				responseHead: value.slice(0, RESPONSE_PREVIEW_LENGTH),
			});
			return null;
		}
	} catch (err) {
		// select 通道异常（非用户取消/超时——那两类是 resolve undefined）：折叠 null 供
		// 调用方统一转 isError，但必须留痕（静默吞 = runtime 故障不可排查）
		logger.error(`[plugin-bridge] select channel threw for ${request.method}`, {
			reason: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/** sessionId 从 ctx 取（ReadonlySessionManager.getSessionId）；session 文件可能尚未
 * 落盘（pi 延迟写入），取失败不阻断转发——sessionId 缺省时 runtime 按 marker 请求自身路由 */
function getSessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

// ── 工具执行结果类型（session-manager 同款：details 供下游消费，错误必须 isError）──

interface PluginBridgeToolResult {
	content: Array<{ type: "text"; text: string }>;
	details:
		| { kind: "ok"; result: BridgeToolExecuteResponse }
		| { kind: "error"; error: BridgeErrorResponse | { error: string } }
		| { kind: "cancelled" }
		| { kind: "unexpected"; response: unknown };
	isError?: boolean;
}

function cancelledResult(toolName: string): PluginBridgeToolResult {
	return {
		isError: true,
		content: [{ type: "text" as const, text: `Plugin tool ${toolName}: cancelled.` }],
		details: { kind: "cancelled" },
	};
}

function errorResult(err: BridgeErrorResponse | { error: string }): PluginBridgeToolResult {
	const hint = "hint" in err && typeof err.hint === "string" ? err.hint : undefined;
	const text = hint ? `${err.error}\nhint: ${hint}` : err.error;
	return {
		isError: true,
		content: [{ type: "text" as const, text }],
		details: { kind: "error", error: err },
	};
}

function unexpectedResult(response: unknown): PluginBridgeToolResult {
	return {
		isError: true,
		content: [
			{
				type: "text" as const,
				// 非 stack 拼接（约定：堆栈不进 content），只回形状摘要供 LLM/用户排查
				text: `Plugin bridge: unexpected response shape from runtime (got ${JSON.stringify(response)?.slice(0, RESPONSE_PREVIEW_LENGTH) ?? "null"}). Bridge extension and runtime may be version-mismatched — redeploy same-version runtime + bridge.`,
			},
		],
		details: { kind: "unexpected", response },
	};
}

// ── 工厂 ──

export default function pluginBridgeExtension(pi: ExtensionAPI): void {
	// logger 持久化通道接入（appendEntry custom entry，不进 LLM 上下文）
	setPiHandle(pi);

	// 闭包状态（约定：禁模块级 let——同进程多 session 共享会串台）。
	// syncInFlight 兼作启动循环与 miss 重同步的防抖句柄（设计 §3.3-D4：
	// 同一时刻仅一个重同步 in flight）。
	let syncInFlight: Promise<void> | null = null;

	/** 注册 sync 清单中的全部工具。registerTool 是 Map 覆盖语义（loader.js），重复
	 * 注册幂等——miss 重同步/多 session 重同步安全；pi 无 unregisterTool，卸载插件的
	 * 工具滞留到 session 结束（调用收 runtime 侧 Tool not found，诚实报错，设计已登记）。 */
	function registerToolsFromPayload(payload: BridgeSyncPayload): number {
		let registered = 0;
		for (const tool of payload.tools) {
			if (!isSyncedTool(tool)) {
				// 单条畸形不拖垮整批（其余工具照常注册），但必须留痕
				logger.warn("[plugin-bridge] skip malformed tool entry in sync payload", {
					entry: JSON.stringify(tool).slice(0, RESPONSE_PREVIEW_LENGTH),
				});
				continue;
			}
			pi.registerTool({
				name: tool.name,
				label: tool.name,
				description: tool.description,
				// typebox TSchema 是空标记接口，runtime 下发的 JSON Schema 对象结构兼容、
				// 直接透传（旧 bridge 同款；顶层 type:'object' 已由 isSyncedTool 守卫）
				parameters: tool.parameters as TSchema,
				async execute(toolCallId, params, signal, _onUpdate, ctx) {
					return forwardToolExecute(ctx, tool.name, toolCallId, params, signal);
				},
			});
			registered++;
		}
		// commands 恒空忽略（设计 §3.3-D7：pi 侧命令发现另走 getCommands，死代码不复制）
		return registered;
	}

	/** 单次 sync：成功注册工具返回 ok；error 回包 / cancelled / 形状不符均视为可重试失败 */
	async function syncOnce(ctx: ExtensionContext): Promise<{ ok: true; tools: number } | { ok: false; reason: string }> {
		const raw = await callBridge(ctx, { method: "bridge:sync" });
		if (raw === null) return { ok: false, reason: "cancelled, channel error, or non-JSON response" };
		if (isBridgeErrorResponse(raw)) return { ok: false, reason: raw.error };
		if (!isBridgeSyncPayload(raw)) return { ok: false, reason: "unexpected sync payload shape" };
		return { ok: true, tools: registerToolsFromPayload(raw) };
	}

	/** 启动同步循环：立即一次，失败退避 2s 重试，上限 30 次；到顶进 Degraded（只 log，
	 * 本 session 无自愈——零工具注册 = execute 永不触发，恢复 = 下个 session 重新 sync）。 */
	async function runSyncLoop(ctx: ExtensionContext): Promise<void> {
		for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
			// 循环体整体兜底：syncOnce 正常路径已把通道错误折叠为 {ok:false}，这里防的是
			// registerTool 调用链等同步 throw——不捕获会让 session_start 的
			// `void ensureSynced(ctx)` 产生 unhandled rejection 逃逸（调用侧无法感知）；
			// catch 后按失败重试语义继续，与 {ok:false} 同路径
			try {
				const result = await syncOnce(ctx);
				if (result.ok) {
					logger.debug(`[plugin-bridge] synced ${result.tools} plugin tool(s)`);
					return;
				}
				logger.warn(`[plugin-bridge] sync attempt ${attempt}/${MAX_SYNC_ATTEMPTS} failed: ${result.reason}`);
			} catch (err) {
				logger.error(`[plugin-bridge] sync attempt ${attempt}/${MAX_SYNC_ATTEMPTS} threw`, {
					reason: err instanceof Error ? err.message : String(err),
				});
			}
			if (attempt < MAX_SYNC_ATTEMPTS) {
				await new Promise<void>((resolve) => setTimeout(resolve, SYNC_RETRY_MS));
			}
		}
		logger.error(
			`[plugin-bridge] Degraded: sync failed after ${MAX_SYNC_ATTEMPTS} attempts (~${(MAX_SYNC_ATTEMPTS * SYNC_RETRY_MS) / MS_PER_SECOND}s). ` +
				"No plugin tools are registered in this session; the runtime plugin service may be down — check runtime logs. A new session will retry sync automatically.",
		);
	}

	/** 防抖入口：启动 sync 与 miss 重同步共用——同一时刻仅一个循环 in flight，
	 * 并发触发者等待同一个 promise（设计 §3.3-D4）。 */
	function ensureSynced(ctx: ExtensionContext): Promise<void> {
		if (syncInFlight) return syncInFlight;
		syncInFlight = runSyncLoop(ctx).finally(() => {
			syncInFlight = null;
		});
		return syncInFlight;
	}

	/** 工具 execute 转发：BridgeRequest → select 通道 → 回包映射 AgentToolResult */
	async function forwardToolExecute(
		ctx: ExtensionContext,
		toolName: string,
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
	): Promise<PluginBridgeToolResult> {
		const args = isRecord(params) ? params : {};
		const raw = await callBridge(
			ctx,
			{
				method: "bridge:tool_execute",
				toolName,
				toolCallId,
				params: args,
				sessionId: getSessionId(ctx),
			},
			{ signal },
		);
		if (raw === null) return cancelledResult(toolName);
		// Tool not found = 清单 miss（曾注册后插件装卸）——触发一次重同步再返回错误，
		// 后续 turn 重试即命中新清单（设计 §3.3-D4 miss 重同步；防抖见 ensureSynced）。
		// 兼容两种形态：错误闭环 {error:'Tool not found…'} 与工具结果
		// {content:'Tool not found…', isError:true}（runtime bridge-interop 实装形态）
		if (isToolNotFound(raw)) {
			await ensureSynced(ctx);
		}
		if (isBridgeErrorResponse(raw)) {
			return errorResult(raw);
		}
		if (isBridgeToolExecuteResponse(raw)) {
			return {
				content: [{ type: "text", text: raw.content }],
				details: { kind: "ok", result: raw },
				isError: raw.isError === true ? true : undefined,
			};
		}
		return unexpectedResult(raw);
	}

	/** observe 事件转发（fire-and-forget）：回包恒为 cancelled（runtime 侧 fire-and-forget
	 * 语义），到达即丢弃。返回普通函数而非 async——调用侧 void 发起，绝不 await 回包。 */
	function observeHandler(
		eventName: string,
	): (data: unknown, ctx: ExtensionContext) => void {
		return (data, ctx) => {
			void callBridge(ctx, {
				method: "bridge:event",
				eventName,
				data,
				sessionId: getSessionId(ctx),
			});
		};
	}

	// ── 事件注册 ──

	// session_start 双职责：① 启动 sync 的 ctx 获取点——factory 阶段拿不到 ui（UI 方法
	// 在 ExtensionContext 上，只有事件 handler 与工具 execute 的 ctx 才带），session_start
	// 是 pi 启动序列里最早带 ctx 的钩子（rpc-mode bindExtensions → runner.emit，先于任何
	// prompt）；② 它本身也是要转发的 observe 事件（旧 bridge EVENTS 清单成员）。
	// 两个 void 均不 await——runner.emit 逐 handler await，挂起会阻塞整个启动序列。
	pi.on("session_start", (data, ctx) => {
		void ensureSynced(ctx);
		void callBridge(ctx, {
			method: "bridge:event",
			eventName: "session_start",
			data,
			sessionId: getSessionId(ctx),
		});
	});

	// 8 个纯 observe 事件逐个显式注册（字符串循环会让 pi.on 的字面量重载失效，
	// 显式字面量保住 handler 的事件类型推断，零 as 断言）
	pi.on("agent_start", observeHandler("agent_start"));
	pi.on("agent_end", observeHandler("agent_end"));
	pi.on("tool_call", observeHandler("tool_call"));
	pi.on("tool_result", observeHandler("tool_result"));
	pi.on("turn_end", observeHandler("turn_end"));
	pi.on("message_end", observeHandler("message_end"));
	pi.on("session_compact", observeHandler("session_compact"));
	pi.on("session_tree", observeHandler("session_tree"));

	// intercept：唯一允许 await 的转发（before_agent_start 本就是等待决策的语义）。
	// 多条注入收窄为单条 CustomMessage 的 content 数组（pi 0.84.4 result 机制只有单
	// message 槽位；类型零丢失——消息边界变化对 LLM 上下文等价，设计 §3.2 对比三 a 登记项）
	pi.on("before_agent_start", async (data, ctx) => {
		const raw = await callBridge(
			ctx,
			{
				method: "bridge:intercept",
				eventName: "before_agent_start",
				data,
				sessionId: getSessionId(ctx),
			},
			{ signal: ctx.signal },
		);
		// 回包失败（null）/形状不符：不注入、不拦截——转发失败不应吃掉本轮 prompt，
		// 留痕即可（runtime 侧 hook 日志另有记录）
		if (raw === null) return undefined;
		if (!isBridgeInterceptResponse(raw)) {
			logger.warn("[plugin-bridge] unexpected intercept response shape", {
				responseHead: JSON.stringify(raw)?.slice(0, RESPONSE_PREVIEW_LENGTH) ?? "null",
			});
			return undefined;
		}
		if (raw.blocked === true) {
			// pi 的 BeforeAgentStartEventResult 无 block 槽位（只有 message/systemPrompt），
			// blocked 决策无法表达——留痕供排查，注入路径照常评估
			logger.warn("[plugin-bridge] intercept returned blocked=true, unsupported by pi result contract", {
				reason: typeof raw.reason === "string" ? raw.reason : undefined,
			});
		}
		const messages = raw.injectedMessages.filter(isInjectedMessage).map((m) => m.content);
		if (messages.length === 0) return undefined;
		const result: BeforeAgentStartEventResult = {
			message: {
				customType: "plugin-inject",
				content: messages.map((content): InjectedTextContent | InjectedImageContent => {
					// 已是 pi 原生 Content 形态（TextContent/ImageContent）→ 原样透传：
					// CustomMessage.content 数组本就接受该形态（设计 §3.2「类型零丢失」
					// 承诺——如 image 段被 stringify 成 text 会丢失多模态语义）
					if (isTextContent(content) || isImageContent(content)) return content;
					// 其余未知形态（含 string）fallback 为 text 段：content 契约是
					// string | 结构化（旧 bridge 契约 {role, content}），非字符串序列化
					// 保信息；undefined/null 兜底 String() 防 text 破约（JSON.stringify
					// 对 undefined 返回 undefined 而非字符串）
					return {
						type: "text" as const,
						text: typeof content === "string" ? content : (JSON.stringify(content) ?? String(content)),
					};
				}),
				display: false,
				details: { count: messages.length },
			},
		};
		return result;
	});
}
