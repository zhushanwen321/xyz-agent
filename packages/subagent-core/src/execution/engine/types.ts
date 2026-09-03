// src/execution/engine/types.ts
//
// 引擎中立类型层（P1）。设计权威源：docs/architecture/subagent-engine-abstraction.md
// §3.3.5（EnginePort 与中立类型完整契约）+ §3.3.6（EngineHandle/journal/SessionView 格式）。
//
// 为什么单独一层：执行层现有四个核心类型（ExecuteOptions/AgentEvent/AgentResult/AgentRunner
// port）的中立是「碰巧的，不是设计的」——thinkingLevel 是 pi 7 档枚举、skillPath 假设引擎有
// --skill flag、conversation/idleTimeoutMs 是 pi chatMode 专属形态（设计 §2.1）。本文件把
// 「agent 调用」的引擎无关语义显式化为 AgentOutcome 等类型，EnginePort（port.ts）与其下
// 各引擎适配器都以本层为唯一契约点。
//
// [D6 任务形状合流] 原本层的任务声明类型 AgentTaskSpec/PersonaSpec 已并入
// orchestration/models/types.ts 的 AgentCallOpts（单一任务形状，SAR 直产、pi 边界一次
// 直出——docs/design/subagent-dual-track-convergence.md §3.3 D6）。本文件不再定义任务
// 声明；EnginePort.run 的入参即 AgentCallOpts（字段裁定与裁撤记录见其类型注释）。
//
// AgentResult 消歧（设计 §2.1/§3.3.5）：仓内有两个同名 AgentResult——
//   ① orchestration 层 workflow 消费的那份（orchestration/models/types.ts，主字段
//      content/parsedOutput/usage/error）——中立层锚定这份，AgentOutcome 的字段就是它的
//      超集（+ engineId/engineFallback/exitCode）；
//   ② execution 层的同名类型（execution/types.ts，主字段 text/turns/sessionId/toolCalls）
//      ——record 内部投影，保持原名不动。
// 引擎层终态命名 AgentOutcome，与两者不同名，消除「同名不同义」。

import type { AgentFailureKind, AgentUsage, ToolCallEntry } from "../../orchestration/models/types.ts";
import type { AgentUsageTotal, ToolCall } from "../types.ts";

// AgentEvent 8 种事件原样保留，唯一权威定义仍是 execution/types.ts——引擎层 re-export
// 不复制第二份（设计 §3.3.5）；经 shared/agent-event.ts 的既有出口转发，维持「shared/
// 是类型共享层」的架构约定。新增粗粒度约束（coarse 引擎至少合成一次 message_end +
// 一次 turn_end）由 conformance 套件断言（P4），不在类型层编码。
export type { AgentEvent } from "../../shared/agent-event.ts";

// ============================================================
// AgentOutcome（锚定 orchestration 层 AgentResult，§3.3.5）
// ============================================================

/**
 * 一次引擎执行的终态。锚定 orchestration/models/types.ts 的 AgentResult（workflow
 * 引擎消费的那份——content/parsedOutput/usage/error）并追加引擎层字段；见文件头消歧说明。
 */
export interface AgentOutcome {
  /** 原样（AgentResult.content）。 */
  content: string;
  /**
   * 原样（AgentResult.failureKind，D5-③ 失败分诊结构化标签）。产出侧唯一识别点 =
   * engines/pi/output-collector（collectResult 分类写入）；缺省 = unknown = 可重试
   * （消费侧 executeAgentCall 只读字段分诊，不扫 error 文案）。非 pi 引擎不产出，
   * 恒缺省（unknown 语义）。
   */
  failureKind?: AgentFailureKind;
  /**
   * 原样（AgentResult.parsedOutput）。native 引擎直传 / 仿真层 ajv 产出（D4 硬分流：
   * native 路径公共层不做二次校验、不改写其结果）。
   */
  parsedOutput?: unknown;
  /** 原样（AgentResult.usage，orchestration 版 AgentUsage：含 contextTokens/turns）。 */
  usage?: AgentUsage;
  /** 原样（AgentResult.durationMs）。 */
  durationMs?: number;
  /** 原样（AgentResult.error，错误码前缀格式见设计 §3.3.3 错误规格表）。 */
  error?: string;
  /** 原样（AgentResult.sessionId，引擎语义 session id）。 */
  sessionId?: string;
  /** 原样（AgentResult.sessionFile）。 */
  sessionFile?: string;
  /** 原样（AgentResult.worktreePath，仅诊断——目录可能已被 finalize 清理）。 */
  worktreePath?: string;
  /** 原样（AgentResult.toolCalls，ToolCallEntry[]）。 */
  toolCalls?: ToolCallEntry[];
  /** 新增：实际执行引擎（fallback 后可能 ≠ 请求值，D9①）。 */
  engineId: string;
  /** 新增：fallback 留痕（record 同步投影，GUI 警告条数据源）。P1 恒缺省（无 fallback 路由）。 */
  engineFallback?: { from: string; reason: string };
  /** 新增：null = 被信号杀死（杀链/abort 合成终态的判据）。P1 pi 链路不暴露 exit code，恒缺省。 */
  exitCode?: number | null;
}

// ============================================================
// EngineHandle（run/interact/read 三面的连接件，D1/§3.3.6）
// ============================================================

/**
 * EngineHandle 的持久化形态（设计 §3.3.6，JSON v1）。
 * 内存态 EngineHandle = 本数据 + 引擎运行时引用（各引擎自持）。
 */
export interface EngineHandleData {
  v: 1;
  /** 引擎 id（'pi' | 'zcode' | ...，registry key）。 */
  engineId: string;
  /**
   * 引擎自定义键值（定位符）。pi = { recordId?, sessionFile? }——recordId 是
   * interact 控制面的 key（subagent record id），sessionFile 是 read 第①级（JSONL
   * 直读）的定位符；zcode = { sessionId, dbPath }。
   */
  sessionRef: Record<string, string>;
  /** 隔离池定位（设计 §3.3.9）。pi 无池化（PI_CODING_AGENT_DIR 全局一份）恒 'shared'。 */
  poolKey: string;
  /**
   * journal 绝对路径（read 第②级数据源；runtime 读前校验前缀白名单）。
   * P2 event journal 落地后由宿主回填；P1 无 journal 写入者，缺省 undefined——
   * read 降级链第②级不可达，直接走 ①/③。
   */
  journalPath?: string;
  /** probe 实测版本（漂移排查锚点）。 */
  engineVersion?: string;
  /** 适配器版本（golden 样本对齐排查）。 */
  adapterVersion: string;
}

/**
 * 引擎会话句柄（run 返回、interact/read 入参）。
 *
 * 契约三条（D1）：不透明（上层不解构——唯一例外是 record 持久化层序列化 data 字段与
 * read 降级链）、可持久化（data 是纯 JSON，主会话 reload 后 read/interact 仍可用）、
 * 自描述（data 含 engineId + 引擎 session 定位符 + pool key + adapter 版本）。
 *
 * 对进程已死的 handle 调 interact 必须返回 engine_session_not_resumable（指向 cold
 * resume 路径），而非笼统失败——由各引擎 interact 实现保证。
 */
export interface EngineHandle {
  /** 持久化数据。上层不得解构其内部字段（见契约三条）。 */
  readonly data: EngineHandleData;
}

// ============================================================
// SessionView（read 返回，D6/§3.3.6）
// ============================================================

/**
 * read(handle) 的返回：turns[] 派生数据。与 Turn 同构但无内部态（_status/startedTs
 * 剥离，closed 恒 true）。
 */
export interface ReplayedTurn {
  text: string;
  thinking: string;
  /** 导出的纯净形状（execution 层 ToolCall，无 _status）。 */
  toolCalls: ToolCall[];
  closed: true;
}

/**
 * session 历史的引擎中立视图。降级链三级（D6）：①引擎原生读取（pi JSONL / zcode
 * sqlite）→ ②宿主 event journal 重放（P2）→ ③outcome-only。source 字段是 GUI 降级
 * 标记数据源（A8）。
 */
export interface SessionView {
  engineId: string;
  sessionId?: string;
  /** turns[] 派生数据（重放/重建产物）。 */
  turns: ReplayedTurn[];
  /** 各 turn usageDelta 聚合（execution 层 AgentUsageTotal）。 */
  usage?: AgentUsageTotal;
  source: "native" | "journal" | "outcome-only";
}

// ============================================================
// EngineCapabilities（D3，三级声明）
// ============================================================

/**
 * 引擎能力声明（设计 D3 原样落地）。三级：native / emulated / unsupported。
 *
 * 易错点（D3）：声明的是**本仓 subagent 链路实际接通的能力**，不是引擎 RPC 层的理论
 * 能力——pi 的 RPC 有 steer 但现有 spawn 链路未接通（session-runner steer no-op），
 * 故 PiEngine 声明 unsupported，接通后再升级。上层据声明选择策略（schema 为 emulated
 * 时自动走公共降级层；steer/conversation unsupported 时 UI 隐藏对应入口），而非
 * try-catch 运行时试错。
 */
export interface EngineCapabilities {
  /** native: --json-schema/--output-schema/env 注入（pi = PI_WORKFLOW_SCHEMA 链路）。 */
  schemaEnforcement: "native" | "emulated";
  /** 注意区分「引擎 RPC 层有此能力」与「subagent 链路已接通」。 */
  steer: "native" | "emulated" | "unsupported";
  /** interact 控制面（message/close/cancel + idle）。 */
  conversation: "native" | "unsupported";
  /** 决定 persona 路由策略（公共降级层按此选择 file/flag/prompt 通道）。 */
  personaInjection: "file" | "flag" | "prompt";
  /** 粗粒度引擎：GUI 显示降级为阶段态。 */
  eventGranularity: "stream" | "coarse";
  /** emulated = worktree 隔离（无 OS sandbox 的引擎用文件写维度隔离补齐）。 */
  sandbox: "native" | "emulated" | "none";
  /** 重建历史的能力（read 降级链第①级的保真度上限）。 */
  sessionRead: "full" | "partial" | "outcome-only";
  resume: "native" | "cold" | "unsupported";
  /** 优雅中断 or 只能杀进程（公共杀链兜底，见 D1 abort 分级）。 */
  interrupt: "native" | "kill-only";
  /** kimi headless 固定 auto = ignored；GUI 据此隐藏/提示。 */
  permissionMode: "native" | "fixed" | "ignored";
  /**
   * [D3-④ r3 裁定] maxTurns 轮数上限的执行能力位（pi = true：turn limiter + spawn
   * watchdog 估算兑现；zcode = false：无 turn_end 语义，静默丢弃会造成「传了上限却
   * 失控」假象）。调用前预检（common/capability-gate）按本位拦「声明不支持的能力」
   * ——pi 不拦 maxTurns（已支持能力，由 turn-limiter 执行）、zcode 同步拒绝。
   * 现状 11 个能力位无可承载 maxTurns 的语义位（fork 拦截可借 session 分叉通道族判，
   * maxTurns 无可借位），故扩位而非保留引擎内硬编码 shape 检查。
   */
  maxTurns: boolean;
}

// ============================================================
// probe（D7）与 interact（D1）的负载类型
// ============================================================

/** 引擎探针报告（probe() 返回）。探针在引擎 factory 初始化与版本变化检测时触发（P4 接线）。 */
export interface ProbeReport {
  ok: boolean;
  /** 实测版本（handle.engineVersion 数据源）。探测不到时为空串。 */
  engineVersion: string;
  /** 二进制存在/版本解析/干跑回归逐项。 */
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  /** engine_probe_failed 的恢复指引（设计 §3.3.3 终态四样例；ok=false 时必填）。 */
  error?: { code: string; recovery: string };
}

/**
 * interact 的 action（D1 交互控制面）。pi 首期原生实现（现有 chatMode 行为直通）；
 * 声明 conversation unsupported 的引擎调用前拒绝（engine_capability_unsupported）。
 */
export type InteractAction =
  /**
   * interrupt：true = steer（抢占）/ false|缺省 = followUp（排队）——pi streamingBehavior
   * 语义的中立承载（D1 §3.3.5「后续 wave 如需抢占语义再扩展 InteractAction」的兑现，
   * chat 域投递经 engine.interact 接通时落地；不支持抢占的引擎忽略）。
   */
  | { kind: "message"; payload: string; interrupt?: boolean }
  | { kind: "close"; payload?: { force: boolean } }
  | { kind: "cancel" };

/**
 * interact 的结果。失败码取自设计 §3.3.3：engine_session_not_resumable（死 handle）/
 * engine_capability_unsupported（能力声明拒绝）等。
 */
export type InteractResult =
  | { ok: true; delivered: true }
  | { ok: false; code: string; message: string };
