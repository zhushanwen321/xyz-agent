// src/execution/record-entry.ts
//
// W16 [D4]：subagent record 自描述持久化 entry 的形态权威。
//
// pi 文件（session JSONL）是扩展数据持久化权威：record 状态每次迁移都经
// pi.appendEntry 落一条自描述完整快照（字段即 SubagentRecord），读取方无需
// 逆向解析 toolCall/toolResult。内存 record-store 保持运行时权威，entry 是
// 重建源（两者不冲突）。
//
// customType 与既有 `subagent-identity`（session 文件首行身份 entry）同族命名
//（连字符风格）；写点见 record-store.ts 的状态迁移点（register/archive/
// reportRecordTransition），custom entry 由 pi 写进 session JSONL，不进 LLM context。

import type {
  AgentEventLogEntry,
  ClosedReason,
  DisplayItem,
  ExecutionMode,
  ExecutionStatus,
  SubagentRecord,
} from "./types.ts";

/** 自描述 record entry 的 customType。写点字面量与本常量的等值由
 *  __tests__/record-store.test.ts 断言钉住（消费方引用本常量，勿用裸字符串）。 */
export const SUBAGENT_RECORD_CUSTOM_TYPE = "subagent-record";

/**
 * `subagent-record` entry 的 data schema（v1）。
 *
 * = 完整 SubagentRecord 快照（GUI 侧列表/详情需要的全部持久化字段）+ 版本号。
 * 显式排除三个非持久化字段（与 SubagentRecord 的差集）：
 *   - currentActivity：running 时的瞬时流态，重开 session 无重建价值；
 *   - externalInstance：跨重启探活态（pid/startedAt），由 .alive sidecar 重建；
 *   - worktreeHandle：不可 JSON 序列化的运行时句柄（布尔投影 worktree 保留）。
 *
 * undefined 字段经 JSON.stringify 自然缺省（与 SubagentRecord 重建侧语义一致）。
 */
export interface SubagentRecordEntryData {
  /** schema 版本（W16 起 v1）。消费方按 v 判别解析，不认识的版本跳过而非猜测。 */
  v: 1;
  id: string;
  agent: string;
  /** 任务提示词（详情面板置顶展示）。 */
  task: string;
  /** 短标签（≤35 字符）。 */
  slug: string;
  status: ExecutionStatus;
  /** L2 关闭原因（仅 status="closed" 时有意义）。 */
  closedReason?: ClosedReason;
  mode: ExecutionMode;
  startedAt: number;
  /** 根 Pi session ID（session 隔离过滤用）。 */
  rootSessionId: string | undefined;
  /** 直接父 subagent record ID（层级树构建用）。顶层为 undefined。 */
  parentRecordId: string | undefined;
  /** subagent 递归深度。顶层 = 0。 */
  depth: number;
  endedAt: number | undefined;
  /** turn 计数。 */
  turns: number;
  totalTokens: number;
  model: string;
  thinkingLevel: string | undefined;
  /** 详情事件日志（/subagents 详情面板）。 */
  eventLog: AgentEventLogEntry[];
  /** 从 turns[] 派生的展示项。 */
  displayItems: DisplayItem[];
  result?: string;
  error?: string;
  sessionFile?: string;
  /** [MF#3] worktree 模式改动 patch 文件路径。 */
  patchFile?: string;
  /** 创建时是否启用 worktree 隔离。 */
  worktree?: boolean;
  /** 对话轮次计数（仅 chatMode 有意义；round+1 由轮终迁移写点携带）。 */
  round?: number;
  /**
   * 对话模式标志（residual-fixes）：chat 与否——GUI 侧 done/waiting 细分判据
   * （one-shot 轮终 chatMode=false + result 有值 → 完成态）。register 起写入显式值
   * （one-shot 为显式 false）；v1 前存量 entry 缺省，消费端按保守方向处理。
   */
  chatMode?: boolean;
  /** 执行态信号（residual-fixes）：true = 无活进程驱动的 running（轮终/孤儿兜底）。 */
  resumable?: boolean;
  /**
   * 实际执行引擎 id（P4 路由留痕，D9①）。缺省（存量 entry）= pi 投影，消费方零迁移。
   */
  engine?: string;
  /** 引擎 fallback 留痕（probe 失败路由回默认引擎）。GUI 警告条数据源。 */
  engineFallback?: { from: string; reason: string };
  /**
   * 引擎自描述定位符（U1：read 降级链①②级数据源）。引擎无关——sessionRef 整体
   * 透传不枚举内部键（zcode = { sessionId, dbPath }）；缺省 = pi（存量 entry 零迁移）。
   */
  engineHandle?: { sessionRef: Record<string, string>; journalPath?: string; poolKey: string };
}

/** SubagentRecord → 自描述 entry data（快照投影，不 mutate 源）。 */
export function toSubagentRecordEntry(record: SubagentRecord): SubagentRecordEntryData {
  return {
    v: 1,
    id: record.id,
    agent: record.agent,
    task: record.task,
    slug: record.slug,
    status: record.status,
    closedReason: record.closedReason,
    mode: record.mode,
    startedAt: record.startedAt,
    rootSessionId: record.rootSessionId,
    parentRecordId: record.parentRecordId,
    depth: record.depth,
    endedAt: record.endedAt,
    turns: record.turns,
    totalTokens: record.totalTokens,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    eventLog: record.eventLog,
    displayItems: record.displayItems,
    result: record.result,
    error: record.error,
    sessionFile: record.sessionFile,
    patchFile: record.patchFile,
    worktree: record.worktree,
    round: record.round,
    chatMode: record.chatMode,
    resumable: record.resumable,
    engine: record.engine,
    engineFallback: record.engineFallback,
    engineHandle: record.engineHandle,
  };
}
