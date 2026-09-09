// src/spawn-event-translator.ts
//
// SdkEvent → AgentEvent 翻译器（spawn-runner.ts 行为等价提取）——翻译 + reducer
// 累积的闭包工厂（core createSpawnEventHandlers 的协议化提取）。分派面按事件族
// 拆语义 handler（tool / message-update / agent 终态 / message_end），switch 只做
// 事件类型路由。

import {
  createReplayRecord,
  updateFromEvent as updateRecordFromEvent,
  type AgentEvent,
} from "@zhushanwen/subagent-engine-sdk";

import { mapAssistantMessageDelta, resolveToolEndArgs } from "./spawn-args.ts";
import type { SdkEvent } from "./spawn-event-adapter.ts";
import { createTurnLimiter } from "./turn-limiter.ts";

/** 默认 grace turns（soft limit 后宽限轮数，core 现状值）。 */
const DEFAULT_GRACE_TURNS = 2;

/** tool_call_id → 工具名/args 的 transient 寄存器（tool_end 缺 args 时回填）。 */
type PendingToolRegistry = Map<string, { toolName: string; args?: unknown }>;

/** agentEvent 统一出口签名（reducer + limiter + 协议通知）。 */
type AgentEventSink = (event: AgentEvent) => void;

/** createSdkEventTranslator 的装配参数。 */
export interface SdkTranslatorOpts {
  maxTurns?: number;
  graceTurns?: number;
  onEvent: (e: AgentEvent) => void;
  onDelta?: (d: string) => void;
  abort: () => void;
  /** agent_end（非 willRetry）到达：turn 已终态、pi rpc 常驻进程需外部终结。 */
  onAgentEnd?: () => void;
  /** [chatMode] agent_settled（真空闲）到达：run resolve 点 + idle 相位锚点。 */
  onAgentSettled?: () => void;
}

/** tool_execution_start → tool_start（toolCallId 在册时寄存 args 供 end 回填）。 */
function handleToolExecutionStart(
  raw: SdkEvent,
  pendingTools: PendingToolRegistry,
  agentEvent: AgentEventSink,
): void {
  const toolName = raw.toolName ?? "";
  if (raw.toolCallId) {
    pendingTools.set(raw.toolCallId, { toolName, args: raw.args });
  }
  agentEvent({ type: "tool_start", toolName, args: raw.args });
}

/** tool_execution_end → tool_end（args 缺失时按 toolCallId 回填）。 */
function handleToolExecutionEnd(
  raw: SdkEvent,
  pendingTools: PendingToolRegistry,
  agentEvent: AgentEventSink,
): void {
  agentEvent({
    type: "tool_end",
    toolName: raw.toolName ?? "",
    args: resolveToolEndArgs(raw, pendingTools),
    result: raw.result,
    isError: raw.isError,
  });
}

/** message_update → assistant delta 翻译（text/thinking delta；不可映射则丢弃）。 */
function handleAssistantMessageUpdate(raw: SdkEvent, agentEvent: AgentEventSink): void {
  const mapped = mapAssistantMessageDelta(raw.assistantMessageEvent ?? {});
  if (mapped) agentEvent(mapped);
}

/** agent_end → 终结语义分派（非 willRetry 才是轮终）。 */
function handleAgentEnd(raw: SdkEvent, opts: SdkTranslatorOpts): void {
  // [F1.2 根修，Gate B 2026-09-09] pi rpc 模式 turn 完成后进程常驻不退出；
  // 旧 core runSpawn 的 routeAgentEnd（agent_end → 非 willRetry → 终结子进程
  // → close → runSpawn resolve）在 W7 协议化提取时丢失，导致 run 永不终态
  // （事件流出齐全、outcome 悬挂）。此处恢复终结语义：message_end/turn_end
  // 已先于 agent_end 到达并累积进 record，kill 触发 close 后正常收尾。
  // 旧实现的 pending 后代 keep-alive 分支（session 文件 pending:register 差集
  // 判活 + no-progress timer + notifier steer 唤醒）未随迁移——本执行器口径是
  // workflow 域单次 run（见文件头），后台后代保活编排登记为协议化偏差。
  // [v1.x chatMode] 长驻形态分支：不 kill（轮收敛交 onChatRoundEnd 上报），
  // resolve 改挂 agent_settled（真空闲）——对齐 inproc chatMode。
  if (raw.willRetry !== true) opts.onAgentEnd?.();
}

/** agent_settled → 轮计数与 limiter 标志按轮重置 + run resolve 点回调。 */
function handleAgentSettled(
  record: ReturnType<typeof createReplayRecord>,
  limiter: ReturnType<typeof createTurnLimiter>,
  opts: SdkTranslatorOpts,
): void {
  // [v1.x chatMode] 真空闲边界（agent_end 之后、post-run 完成后才 emit——
  // pi agent-session _runAgentPrompt finally 块）。仅长驻形态消费：run 在此
  // resolve，turn 计数与 limiter 标志按轮重置（SP-9 对齐：续聊轮独立预算，
  // maxTurns 不跨轮累计）。一次性 run 不消费（agent_end 已 kill，进程不会
  // 活到 settled）。
  if (opts.onAgentSettled !== undefined) {
    record.turnCount = 0;
    limiter.reset();
    opts.onAgentSettled();
  }
}

/** message_end 累积（usage 折算 + stopReason error/aborted → error 事件）。 */
function accumulateMessageEnd(raw: SdkEvent, agentEvent: AgentEventSink): void {
  const msg = raw.message;
  if (msg?.usage) {
    const { cost: costObj } = msg.usage;
    const usage = {
      input: msg.usage.input ?? 0,
      output: msg.usage.output ?? 0,
      cacheRead: msg.usage.cacheRead ?? 0,
      cacheWrite: msg.usage.cacheWrite ?? 0,
      ...(costObj?.total !== undefined ? { cost: costObj.total } : {}),
    };
    agentEvent({ type: "message_end", usage });
  }
  const stopReason = msg?.stopReason;
  if (stopReason === "error" || stopReason === "aborted") {
    const errMsg = msg?.errorMessage ?? raw.reason ?? stopReason;
    agentEvent({ type: "error", message: errMsg });
  }
}

/**
 * SdkEvent → AgentEvent 翻译 + reducer 累积的闭包工厂（core
 * createSpawnEventHandlers 的协议化提取）。
 */
export function createSdkEventTranslator(
  record: ReturnType<typeof createReplayRecord>,
  opts: SdkTranslatorOpts,
): (raw: SdkEvent) => void {
  // a. transient 寄存器（tool_end 缺 args 时回填）
  const pendingTools: PendingToolRegistry = new Map();

  // b. turnLimiter（spawn 版：abort = kill 子进程；steer 未接通，靠 WRAP_UP_HINT 补偿）
  const limiter = createTurnLimiter({
    maxTurns: opts.maxTurns ?? 0,
    graceTurns: opts.graceTurns ?? DEFAULT_GRACE_TURNS,
    steer: () => {
      // no-op：rpc stdin steer 通道未接通；启动时已注入 WRAP_UP_HINT 让 agent 主动收尾。
    },
    abort: opts.abort,
  });

  // agentEvent 统一出口：reducer + limiter + 协议通知
  const agentEvent: AgentEventSink = (event: AgentEvent): void => {
    updateRecordFromEvent(record, event);
    if (event.type === "turn_end") limiter.onTurnEnd(record.turnCount);
    if (event.type === "text_delta") opts.onDelta?.(event.delta);
    opts.onEvent(event);
  };

  // 事件分派：switch 只做类型路由，翻译语义在各 handle* / accumulateMessageEnd
  return (raw: SdkEvent): void => {
    switch (raw.type) {
      case "tool_execution_start":
        handleToolExecutionStart(raw, pendingTools, agentEvent);
        return;
      case "tool_execution_end":
        handleToolExecutionEnd(raw, pendingTools, agentEvent);
        return;
      case "message_update":
        handleAssistantMessageUpdate(raw, agentEvent);
        return;
      case "turn_end":
        agentEvent({ type: "turn_end" });
        return;
      case "agent_end":
        handleAgentEnd(raw, opts);
        return;
      case "agent_settled":
        handleAgentSettled(record, limiter, opts);
        return;
      case "message_end":
        accumulateMessageEnd(raw, agentEvent);
        return;
      case "compaction_start":
        agentEvent({ type: "compaction" });
        return;
      default:
        return;
    }
  };
}
