/**
 * Model List Injector
 *
 * 通过 before_agent_start 每 turn 注入 `<available_provider_models>` 段，列出
 * 当前 auth 可用的模型（provider/modelId + 能力 + contextWindow），与
 * `<available_subagents>` / `<available_workflows>` 对称——三者合起来让模型掌握
 * 派发所需的全部资源清单。
 *
 * 背景：模型列表的最大消费者是本包的 subagent/workflow `model` 参数（要求
 * "provider/modelId" 格式，非法值直接 throw）。注入后模型可直接按 id 派发，
 * 无需臆造模型名。
 *
 * 与另两个 injector 的差异：数据源不是文件发现而是 ModelRegistry.getAvailable()
 * （pi 权威的 auth 可用模型快照，纯内存同步调用），因此：
 * - 不需要 session_start 预热 / 渲染缓存 / session_shutdown 清理（无模块级
 *   状态——结构上规避了缓存生命周期问题）
 * - 每 turn 直接渲染；排序 (provider, id) 码点序保证输出字节稳定（turn 间
 *   systemPrompt 前缀稳定 = KV cache 友好；跨环境逐字节可复现，与另两个
 *   injector 的码点序契约对齐）。数据真实变化（用户中途配置了新 provider）
 *   时下一 turn 自然反映。
 *
 * 立场：本注入段只服务「派发时选模型」，明确告知模型不要在会话中切换主模型
 * （KV cache 不友好）；用户明确要求换模型时走 pi 原生 /model 命令（人手动触发）。
 */

import type {
	Api,
	Model,
} from "@earendil-works/pi-ai";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { escapeXml, renderXmlSection } from "@zhushanwen/subagent-core";

const logger = getLogger("injector");

/** 注入段的最小模型投影（从 Model<Api> 收窄，测试无需构造完整 Model） */
export interface ModelEntry {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
}

/** Model<Api> → ModelEntry 投影（只留注入段消费的字段；模块内唯一消费方 setupModelListInjector） */
function toModelEntry(model: Model<Api>): ModelEntry {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: model.contextWindow,
	};
}

/** 码点序比较（显式契约，禁 localeCompare——宿主 locale 差异会破坏跨环境字节一致）。 */
function compareByCodepoint(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** 能力标记：reasoning → "reasoning"，input 含 image → "vision"（空则省略 caps 段） */
function formatCaps(entry: ModelEntry): string {
	const caps: string[] = [];
	if (entry.reasoning) caps.push("reasoning");
	if (entry.input.includes("image")) caps.push("vision");
	return caps.join(",");
}

/**
 * 将模型列表格式化为 XML 注入段。
 *
 * 输入按 (provider, id) 码点序排序——registry 返回顺序不作保证，排序后同一
 * 数据集输出字节稳定。码点序是显式契约（禁 localeCompare——宿主 locale 差异
 * 会破坏跨环境字节一致，见 subagent-list-injector.ts sortByCodepoint 注释），
 * 保证注入段进每 turn system prompt 时跨环境逐字节可复现（cache-probe 前缀
 * 指纹归因 / 换机器 resume 场景依赖此性质）。空列表返回空串（不注入）。
 */
export function formatModelList(models: ModelEntry[]): string {
	if (models.length === 0) return "";

	const sorted = [...models].sort((a, b) =>
		a.provider === b.provider
			? compareByCodepoint(a.id, b.id)
			: compareByCodepoint(a.provider, b.provider),
	);

	const items = sorted.map((m) => {
		const caps = formatCaps(m);
		return (
			`  <model><id>${escapeXml(`${m.provider}/${m.id}`)}</id>`
				+ `<name>${escapeXml(m.name)}</name>`
				+ (caps ? `<caps>${caps}</caps>` : "")
				+ `<contextWindow>${m.contextWindow}</contextWindow></model>`
		);
	});
	return renderXmlSection({
		tag: "available_provider_models",
		guide: "The following models are available (auth-configured). Use these ids when delegating via the subagent/workflow `model` param (\"provider/modelId\" format) to match the task (e.g. vision models for screenshots, strong reasoners for architecture). Do NOT switch the main conversation model mid-session — per-call model override on delegates only (switching the main model is cache-hostile); use the /model command only when the user explicitly asks to change it.",
		items,
	});
}

/**
 * 注册 before_agent_start handler，注入 `<available_provider_models>` 段。
 *
 * 每 turn 从 ctx.modelRegistry.getAvailable() 同步取快照渲染注入；空列表不
 * 返回 systemPrompt；任何异常被吞掉（记日志），不阻断 agent turn。与 subagent/
 * workflow 注入 handler 链式（pi 串联多 handler 的 systemPrompt 返回值）。
 */
export function setupModelListInjector(pi: ExtensionAPI): void {
	pi.on(
		"before_agent_start",
		async (
			event: BeforeAgentStartEvent,
			ctx: ExtensionContext,
		): Promise<BeforeAgentStartEventResult | void> => {
			try {
				const injection = formatModelList(
					ctx.modelRegistry.getAvailable().map(toModelEntry),
				);
				if (!injection) return;
				return { systemPrompt: event.systemPrompt + injection };
			} catch (err) {
				logger.error("[model-list-injector] before_agent_start failed", {
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		},
	);
}
