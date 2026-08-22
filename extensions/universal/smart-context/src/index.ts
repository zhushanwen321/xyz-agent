/**
 * @zhushanwen/pi-smart-context 入口：事件接线 + 门控。
 *
 * 设计文档：docs/extensions/smart-context/design.md
 * - session_start：session 级闭包状态重建（规范 Session 隔离：fired 档位/熔断计数不跨 session）
 * - subagent 进程（R6）：不注册工具、不提醒（宁缺勿污）
 * - session_before_compact：双模式接管（compact-handler）
 * - session_compact：重置提醒 fired（D3）
 * - agent_settled：越档检查 + followUp 投递一次性提醒（D3/D4）
 * - model_select：跨界通知 + downshift 提醒（D5）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setPiHandle } from "@zhushanwen/pi-extension-logger";

import {
	createBeforeCompactHandler,
	createTakeoverState,
	debugLog,
	type BeforeCompactLikeEvent,
	type TakeoverState,
} from "./compact-handler.js";
import { buildDownshiftNotice, buildSwitchNotice, buildThresholdReminder } from "./reminder.js";
import { registerCompactContextTool } from "./tool.js";
import {
	countCompactions,
	findCrossedThresholds,
	getCurrentModelId,
	isGatingActive,
	isSubagentProcess,
	loadSmartContextConfig,
	type EntryLike,
} from "./pure.js";

/** agent_settled 事件形状（无 payload）。 */
interface AgentSettledLikeEvent {
	type: "agent_settled";
}

/** model_select 事件形状。 */
interface ModelSelectLikeEvent {
	type: "model_select";
	model: { provider?: string; id?: string; contextWindow?: number } | undefined;
	previousModel: { provider?: string; id?: string; contextWindow?: number } | undefined;
	source: string;
}

/** session_compact 事件形状（compactionEntry 只消费 type；interface 无隐式 index signature，
 * 禁用 `& Record<string, unknown>` 交叉目标——会破坏 on() 重载的参数逆变匹配）。 */
interface SessionCompactLikeEvent {
	type: "session_compact";
	compactionEntry: { type: string };
	fromExtension: boolean;
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
}

/** session 级闭包状态（规范：模块级仅工厂函数，状态在 session_start 重建）。 */
interface SessionState {
	takeover: TakeoverState;
	/** 已提醒档位（token 值为键；session_compact 清空，D3）。 */
	firedThresholds: Set<number>;
}

/** session 级状态唯一构造点（初始态与 session_start 重建同源，新增字段不落两处）。 */
function createSessionState(): SessionState {
	return { takeover: createTakeoverState(), firedThresholds: new Set() };
}

/**
 * pi-smart-context extension 工厂函数。
 *
 * agent 自决上下文压缩：compact_context 工具 + 双模式接管生成（same-model kv-cache /
 * cross-model 廉价模型）+ 3 档阈值提醒 + 排除模型门控与切换通知。
 */
export default function smartContextExtension(pi: ExtensionAPI): void {
	// 日志通道注入（extension-logger 两阶段初始化：工厂拿 pi → setPiHandle）
	setPiHandle(pi);

	// R6：subagent 子进程不注册工具、不提醒（PI_SUBAGENT_ROOT_SESSION_ID 标记）
	if (isSubagentProcess()) {
		debugLog("subagent process detected, staying inert");
		return;
	}

	// session 级状态（session_start 重建闭包；模块级引用仅指向当前 session 的容器）
	let state: SessionState = createSessionState();

	pi.on("session_start", (_event: unknown, _ctx: ExtensionContext) => {
		state = createSessionState();
	});

	// ── 压缩生成接管（D1/D12）──
	const beforeCompact = createBeforeCompactHandler(
		pi,
		() => state.takeover,
		loadSmartContextConfig,
	);
	pi.on("session_before_compact", (event: BeforeCompactLikeEvent, ctx: ExtensionContext) =>
		beforeCompact(event, ctx));

	// ── 压缩完成：重置提醒档位（D3）──
	pi.on("session_compact", (_event: SessionCompactLikeEvent, _ctx: ExtensionContext) => {
		state.firedThresholds.clear();
	});

	// ── 工具注册（常驻，不可用态由 execute 运行时校验拒绝，D5）──
	registerCompactContextTool(pi);

	// ── 阈值提醒（D3/D4）：agent_settled 越档检查 + followUp 一次性投递 ──
	pi.on("agent_settled", (_event: AgentSettledLikeEvent, ctx: ExtensionContext) => {
		const config = loadSmartContextConfig();
		const modelId = getCurrentModelId(ctx.model);
		if (!isGatingActive(config, modelId)) return;

		const usage = ctx.getContextUsage();
		if (!usage) return; // R7：tokens 可能 null（压缩后首响应前）——findCrossedThresholds 容错
		const crossed = findCrossedThresholds(config.reminderThresholds, usage.tokens, state.firedThresholds);
		if (crossed.length === 0) return;

		for (const t of crossed) state.firedThresholds.add(t);
		const compactionCount = countCompactions(ctx.sessionManager.getEntries() as ReadonlyArray<EntryLike>);
		const message = buildThresholdReminder(crossed, usage.tokens ?? 0, usage.contextWindow, compactionCount);
		debugLog(`reminder fired: tiers=${crossed.join(",")} tokens=${usage.tokens}`);
		// D4：followUp（agent 空闲后投递并触发一个 turn，可立即决定压缩）；
		// 防循环：crossed 全部已标记 fired，提醒触发的 settled 不会重复发
		pi.sendUserMessage(message, { deliverAs: "followUp" });
	});

	// ── 模型切换：跨界通知 + downshift 提醒（D5，仅跨界时注入一次）──
	pi.on("model_select", (event: ModelSelectLikeEvent, ctx: ExtensionContext) => {
		const config = loadSmartContextConfig();
		const modelId = getCurrentModelId(event.model);
		const previousModelId = getCurrentModelId(event.previousModel);
		if (modelId === "" || modelId === previousModelId) return;

		const nowExcluded = config.excludedModels.includes(modelId);
		const wasExcluded = config.excludedModels.includes(previousModelId);

		// 跨越排除边界：注入一条可用性变化通知（同边界内切换静默）
		if (config.enabled && nowExcluded !== wasExcluded) {
			const notice = buildSwitchNotice(nowExcluded ? "unavailable" : "available", modelId);
			debugLog(`switch notice: ${nowExcluded ? "unavailable" : "available"} (${modelId})`);
			pi.sendUserMessage(notice, { deliverAs: "steer" });
			return;
		}

		// downshift 检测：切到更小窗口模型且将触线 → 建议先压缩（不阻止切换）
		const usage = ctx.getContextUsage();
		const downshift = buildDownshiftNotice(
			usage?.tokens ?? null,
			event.previousModel?.contextWindow,
			event.model?.contextWindow,
		);
		if (downshift && isGatingActive(config, modelId)) {
			debugLog("downshift notice fired");
			pi.sendUserMessage(downshift, { deliverAs: "steer" });
		}
	});
}
