// src/protocol/reverse-channels.ts
//
// 9 反向通道（引擎 → core，帧④，必须应答）载荷与超时二分。设计权威源：
// 设计 §3.3 方法集表 host/* 行 + impl-plan §2.1「8 反向通道」与「反向请求超时二分」
// + chat 域 v1.x 增量（docs/design/chat-domain-v1x-liveness-governance.md §3.2 D1-A：
// 第 9 通道 host/roundLifecycle 承载轮次终态事件与 record 回写）。
//
// 应答约定：数据面类回 {ok:true}（REVERSE_REQUEST_TIMEOUT_MS=10s 未答 = 引擎故障 →
// 杀进程 + 在途 run 失败）；人机交互类走 ack 两阶段——先回 {ack:true}，结果异步到达
// （R9-2：已 ack 的等待不计入任何 in-flight 超时；ADR-0047 静默 ≠ 卡死）；
// 未实现的交互能力回 {unsupported:true}（引擎自行降级，不重试）。

import type { ReverseRequestTimeoutClass } from "./engine-protocol.ts";
import type { UiRequest, UiResponse } from "../ui-types.ts";
import type { AgentUsage, ResumeAnchor } from "./contract-types.ts";
import type { ProtocolError } from "./frames.ts";

/** 反向通道名联合（恰好 9 个；REVERSE_CHANNELS 常量数组与之同源互证）。 */
export type ReverseChannel =
  | "host/log"
  | "host/askUser"
  | "host/permission"
  | "host/streamDelta"
  | "host/poolResolved"
  | "host/handleReady"
  | "host/childSpawned"
  | "host/childStateChanged"
  | "host/roundLifecycle";

export const REVERSE_CHANNELS = [
  "host/log",
  "host/askUser",
  "host/permission",
  "host/streamDelta",
  "host/poolResolved",
  "host/handleReady",
  "host/childSpawned",
  "host/childStateChanged",
  "host/roundLifecycle",
] as const satisfies readonly ReverseChannel[];

/**
 * 超时二分归属（10s 数据面 / 不设统一超时的人机交互面）。实现归 W2 EngineClient；
 * 引擎侧自灭计时（W12）复用同表——已 ack 的 askUser 等待不计入 in-flight（R9-2）。
 * host/roundLifecycle 属数据面（终态回执语义：宿主必须确认收到，10s 未答 = 引擎故障）。
 */
export const REVERSE_CHANNEL_TIMEOUT_CLASS: Record<ReverseChannel, ReverseRequestTimeoutClass> = {
  "host/log": "data-plane",
  "host/streamDelta": "data-plane",
  "host/poolResolved": "data-plane",
  "host/handleReady": "data-plane",
  "host/childSpawned": "data-plane",
  "host/childStateChanged": "data-plane",
  "host/roundLifecycle": "data-plane",
  "host/askUser": "interaction",
  "host/permission": "interaction",
};

// ============================================================
// 通道载荷（params）
// ============================================================

/** host/log：引擎日志落宿主日志（对齐 core HostServices.log 调用面）。 */
export interface HostLogParams {
  level: "debug" | "warn" | "error";
  component: string;
  message: string;
  data?: unknown;
}

/** host/askUser：UI 请求经反向通道送达宿主（core 壳侧 uiRequestHandler 应答）。 */
export interface HostAskUserParams {
  runId: string;
  /** Pi extension_ui_request 平铺形态（类型 SSOT = SDK ui-types.ts，core 反向 re-export）。 */
  request: UiRequest;
}

/** host/askUser 的最终结果（ack 两阶段第二阶段，异步应答帧②的 result）。 */
export type HostAskUserResult = UiResponse;

/**
 * host/permission：权限询问（引擎请求宿主裁决工具执行）。
 * v1 骨架字段（设计未钉死载荷细节，细化归各引擎提取设计；W2 实装 core 应答端时
 * 若需扩展走 additive 演进）。
 */
export interface HostPermissionParams {
  runId: string;
  toolName: string;
  args?: unknown;
  /** 请求方向引擎给出的原因/说明（展示用）。 */
  reason?: string;
}

/** host/permission 两阶段结果。 */
export type HostPermissionResult = { approved: boolean } | { unsupported: true };

/**
 * host/streamDelta：UI 实时通道（双通道之一；与 event 通知并行的渲染加速面）。
 *
 * [v1.x 关联键扩展——D1-A 裁定，W1 落地不再临场选择]：
 *   - run 域轮（含 run 会话形态首轮）：runId 关联（v1 现状不变，runId 由 core 在
 *     run 帧分配）；
 *   - interact 发起的续聊轮：**recordId** 关联（续聊轮无独立 runId——InteractParams/
 *     InteractResult 均不含，recordId 经 handle.sessionRef 送达引擎）。
 * 两键互斥（undefined 孪生位防双填），消费侧经 isHostStreamDeltaParams 收窄。
 */
export type HostStreamDeltaParams =
  | { runId: string; recordId?: undefined; delta: string }
  | { recordId: string; runId?: undefined; delta: string };

/** streamDelta 载荷结构判定（关联键互斥 + delta 形状；消费侧共用，防双侧各写一份）。 */
export function isHostStreamDeltaParams(value: unknown): value is HostStreamDeltaParams {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const hasRunId = typeof v.runId === "string";
  const hasRecordId = typeof v.recordId === "string";
  // 恰一键：无键 / 双键 / 键非 string 都拒
  if (hasRunId === hasRecordId) return false;
  return typeof v.delta === "string";
}

/**
 * host/poolResolved：journal 落盘路径单一权威（契约：必须在首个事件 emit 前调用——
 * 否则 journal 归属错）。载荷 = core onPoolResolved(poolKey) 的 runId 关联形态。
 */
export interface HostPoolResolvedParams {
  runId: string;
  poolKey: string;
}

/**
 * host/handleReady：运行中句柄回填（core onHandleReady 语义：session/create 应答后、
 * 早于 run resolve；AGENTS.md 关键规则 9「重开 session 仍可见」的前提）。
 */
export interface HostHandleReadyParams {
  runId: string;
  sessionRef: Record<string, string>;
  poolKey: string;
}

/**
 * host/childSpawned：引擎内一次性子进程 pid 上报。
 * 用途 = isResumable 镜像谓词 + 诊断留痕；**不供杀链/收割**（v6 已删按 pid 补杀，
 * 收割只靠进程组）；常驻进程不报（归 dispose）。
 */
export interface HostChildSpawnedParams {
  pid: number;
  recordId: string;
}

/**
 * host/childStateChanged：childSpawned 的状态面（core 侧镜像数据源，
 * hasLiveProcessHandle/isResumable 同步读镜像，不跨进程查询）。
 * **killed 必含**（判据 `child !== undefined && !child.killed`）——类型层 required。
 */
export interface HostChildStateChangedParams {
  pid: number;
  recordId: string;
  state: "running" | "exited";
  /** 必含：true = 已被杀/已终止（镜像置死判据）。 */
  killed: boolean;
  exitCode?: number;
  signal?: string;
}

// ============================================================
// [v1.x] host/roundLifecycle：轮次生命周期载荷（chat 域 v1.x 唯一新通道）
// ============================================================

/**
 * 轮次关联键（D1-A 裁定的类型面）：run 域轮 = runId（v1 现状）；interact 续聊轮 =
 * recordId（经 handle.sessionRef）。undefined 孪生位保证两键互斥。
 */
export interface RoundKeyedByRun {
  runId: string;
  recordId?: undefined;
}

export interface RoundKeyedByRecord {
  recordId: string;
  runId?: undefined;
}

/**
 * 轮次终态相位 + 轮内心跳（事件即 record 回写载体——chat 域 record 处置由相位
 * 一一映射，设计 D2 裁决表 conversation 行：settled/idle 轮收口不终态、failed 标
 * failed）：
 *   - settled：轮收敛（输出完整）。消费点 = settled-watchdog disarm + D3 abort
 *     收敛判据（cancel 受理后等本事件，超 CANCEL_SETTLE_GRACE_MS 走杀链）；
 *   - idle：轮收口 + 会话进 idle 稳态（core 侧 doFinalizeRoundToIdle + idle 定时器
 *     锚点）。settled 与 idle 是两个锚点：watchdog 在 settled 即解除，idle 管置闲；
 *   - failed：轮异常终止（引擎自知失败，如 EPIPE 兜底耗尽）——error 如实上报，
 *     record 标 failed（与 run 域 AgentOutcome.error 的「失败收口」语义对齐）；
 *   - active：轮内心跳（F3，非终态——见 RoundActivePhase，只刷守护不处置 record）。
 * usage 为本轮 message_end 增量（interact 续聊轮无 event 通知通道，用量经本帧回填）。
 * 不设 seq：stdio NDJSON 单连接有序 + 数据面应答确认，无重排/重放面（与 event
 * 通知的 seq 对照——后者镜像进程内事件流基线，本帧无基线可镜像）。
 */
export interface RoundSettledPhase {
  phase: "settled";
  usage?: AgentUsage;
}

export interface RoundIdlePhase {
  phase: "idle";
  usage?: AgentUsage;
  /** 冷续锚点回填（session 滚动/compaction 后锚点可能变化，宿主按帧刷新）。 */
  anchor?: ResumeAnchor;
}

export interface RoundFailedPhase {
  phase: "failed";
  /** 失败原因（结构对齐协议 error 帧——code/message/recovery 可操作闭环）。 */
  error: ProtocolError;
  anchor?: ResumeAnchor;
}

/**
 * 轮内心跳相位（F3 清账——chat 续聊轮工具执行期活性失明修复）：无载荷（无文本、
 * 无 usage），仅承诺「轮进行中引擎仍活跃」。发射面 = 续聊轮的 `activity` 事件
 * （translator 已 1s 节流，到达本相位天然 ≤1/s）；消费面 = 宿主中段无进展守护刷新
 * （refreshFromProtocolEvent）——**非轮终相位**，不得 resolve 任何轮终等待体
 * （引擎侧 cancel 的收敛判据 = settled/idle/failed 三终态，见 pi chat-session
 * emitPhase；active 必须经独立发射函数旁路等待体 resolve）。首轮不需要本相位
 * （runId 键 ctx.onEvent 事件行已是刷新面）。
 */
export interface RoundActivePhase {
  phase: "active";
}

/** 相位联合（消费侧 switch(phase) 判别用；active = 轮内心跳，非终态）。 */
export type RoundLifecyclePhase = RoundSettledPhase | RoundIdlePhase | RoundFailedPhase | RoundActivePhase;

/** host/roundLifecycle 载荷：关联键（run|record）× 相位（settled|idle|failed|active）。 */
export type HostRoundLifecycleParams =
  | (RoundKeyedByRun & RoundSettledPhase)
  | (RoundKeyedByRun & RoundIdlePhase)
  | (RoundKeyedByRun & RoundFailedPhase)
  | (RoundKeyedByRun & RoundActivePhase)
  | (RoundKeyedByRecord & RoundSettledPhase)
  | (RoundKeyedByRecord & RoundIdlePhase)
  | (RoundKeyedByRecord & RoundFailedPhase)
  | (RoundKeyedByRecord & RoundActivePhase);

/**
 * roundLifecycle 载荷结构判定：关联键互斥 + phase 词表 + 各相位专属形状
 * （failed 必含 error.code/message）。引擎侧发帧前自检与 core 侧消费共用，
 * 防两侧各写一份判别（与 isHostStreamDeltaParams 同理）。
 */
export function isHostRoundLifecycleParams(value: unknown): value is HostRoundLifecycleParams {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const hasRunId = typeof v.runId === "string";
  const hasRecordId = typeof v.recordId === "string";
  if (hasRunId === hasRecordId) return false;
  // active = 轮内心跳，无载荷（无专属形状可校验）
  if (v.phase === "settled" || v.phase === "idle" || v.phase === "active") return true;
  if (v.phase !== "failed") return false;
  const err = v.error;
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as Record<string, unknown>).code === "string" &&
    typeof (err as Record<string, unknown>).message === "string"
  );
}

/** 通道 → 载荷类型映射。 */
export interface ReverseChannelParamsMap {
  "host/log": HostLogParams;
  "host/askUser": HostAskUserParams;
  "host/permission": HostPermissionParams;
  "host/streamDelta": HostStreamDeltaParams;
  "host/poolResolved": HostPoolResolvedParams;
  "host/handleReady": HostHandleReadyParams;
  "host/childSpawned": HostChildSpawnedParams;
  "host/childStateChanged": HostChildStateChangedParams;
  "host/roundLifecycle": HostRoundLifecycleParams;
}

/** 通道 → 异步/同步结果类型映射（ack 两阶段通道的第二阶段 result）。 */
export interface ReverseChannelResultMap {
  "host/log": { ok: true };
  "host/askUser": HostAskUserResult;
  "host/permission": HostPermissionResult;
  "host/streamDelta": { ok: true };
  "host/poolResolved": { ok: true };
  "host/handleReady": { ok: true };
  "host/childSpawned": { ok: true };
  "host/childStateChanged": { ok: true };
  "host/roundLifecycle": { ok: true };
}
