// src/execution/engine/types.ts
//
// 引擎中立类型层（P1）。设计权威源：docs/architecture/subagent-engine-abstraction.md
// §3.3.5（EnginePort 与中立类型完整契约）+ §3.3.6（EngineHandle/journal/SessionView 格式）。
//
// 为什么单独一层：执行层现有四个核心类型（ExecuteOptions/AgentEvent/AgentResult/AgentRunner
// port）的中立是「碰巧的，不是设计的」——thinkingLevel 是 pi 7 档枚举、skillPath 假设引擎有
// --skill flag、conversation/idleTimeoutMs 是 pi chatMode 专属形态（设计 §2.1）。本文件把
// 「agent 调用」的引擎无关语义显式化为 AgentTaskSpec / AgentOutcome 等类型，EnginePort
// （port.ts）与其下各引擎适配器都以本层为唯一契约点。
//
// 泛化原则（D2）：从现有类型泛化，不另起炉灶——字段与 execution/types.ts 的
// ExecuteOptions、orchestration/models/types.ts 的 AgentResult 逐一锚定，标注「泛化」的
// 条目语义有变，标注「新增」为引擎层新引入。
//
// AgentResult 消歧（设计 §2.1/§3.3.5）：仓内有两个同名 AgentResult——
//   ① orchestration 层 workflow 消费的那份（orchestration/models/types.ts，主字段
//      content/parsedOutput/usage/error）——中立层锚定这份，AgentOutcome 的字段就是它的
//      超集（+ engineId/engineFallback/exitCode）；
//   ② execution 层的同名类型（execution/types.ts，主字段 text/turns/sessionId/toolCalls）
//      ——record 内部投影，保持原名不动。
// 引擎层终态命名 AgentOutcome，与两者不同名，消除「同名不同义」。

import type { AgentUsage, ToolCallEntry } from "../../orchestration/models/types.ts";
import type { AgentUsageTotal, ToolCall, WorktreeHandle } from "../types.ts";

// AgentEvent 8 种事件原样保留，唯一权威定义仍是 execution/types.ts——引擎层 re-export
// 不复制第二份（设计 §3.3.5）；经 shared/agent-event.ts 的既有出口转发，维持「shared/
// 是类型共享层」的架构约定。新增粗粒度约束（coarse 引擎至少合成一次 message_end +
// 一次 turn_end）由 conformance 套件断言（P4），不在类型层编码。
export type { AgentEvent } from "../../shared/agent-event.ts";

// ============================================================
// AgentTaskSpec（= 现有 ExecuteOptions 泛化，D2）
// ============================================================

/** 人设（persona）注入规格：原 skillPath + appendSystemPrompt 收拢进一个语义单元（D2）。 */
export interface PersonaSpec {
  /**
   * agent 名/路径。与 AgentTaskSpec.agent 的分工：agent 是 resolveIdentity 的身份解析
   * 键（模型/系统提示等身份语义）；agentRef 是 persona 注入通道的定位符——引擎按
   * capabilities.personaInjection 决定注入通道（file/flag/prompt）时用它定位人设。
   * pi 引擎不消费此字段（身份解析走 spec.agent），留给 flag/file 通道的引擎。
   */
  agentRef?: string;
  /**
   * 原 ExecuteOptions.skillPath。公共 persona 路由三策略（file/flag/prompt）的分流
   * 载体（D4）——超长 prompt 时优先 file/flag 通道分流的落点。
   */
  skillPath?: string;
  /** 追加系统提示内容数组（原样透传；schema 仿真段由公共降级层拼装后放入，P2）。 */
  appendSystemPrompt?: string[];
}

/**
 * 引擎无关的 agent 任务声明（= ExecuteOptions 泛化，字段逐条锚定设计 §3.3.5）。
 *
 * 与 ExecuteOptions 的差异（泛化点）：
 *   - thinkingLevel（pi 7 档枚举语义）→ effort?: string，各引擎自行映射或忽略；
 *   - skillPath + appendSystemPrompt → persona（PersonaSpec）；
 *   - conversation/idleTimeoutMs 保留原名透传——属 interact 交互控制面的 task 标志（D1），
 *     不是 pi 专有语义的泄漏，而是「任务声明里声明交互模式」的中立表达；
 *   - 删字段去向：signal/ctxModel/onComplete 是运行期句柄，移入 RunContext（port.ts）；
 *     schemaEnv 内化到 PiEngine（从 task.schema 派生，见 engines/pi/task-spec-mapper.ts）。
 *
 * 新增（为后续 wave 预留形状，P1 无生产写入方）：
 *   - denyTools：中立工具 denylist（附录 A 该行的载体）；
 *   - permissionMode：中立权限模式（映射按 capabilities.permissionMode）。
 */
export interface AgentTaskSpec {
  /** 原样（ExecuteOptions.task）。 */
  task: string;
  /** 原样（ExecuteOptions.slug，≤35 字符）。 */
  slug: string;
  /** 原样（ExecuteOptions.agent，resolveIdentity 的 agent ref）。 */
  agent?: string;
  /** 原样（ExecuteOptions.model；在引擎 provider 体系内解释，D9②）。 */
  model?: string;
  /**
   * 泛化：原 ExecuteOptions.thinkingLevel。引擎无关的推理投入档位字符串——
   * pi 引擎把它原值映射回 thinkingLevel 7 档；其他引擎自行映射（CC 5 档）或忽略
   * （kimi ❌）。不定义联合枚举：档位集合是引擎私有语义，中立层只透传字符串。
   */
  effort?: string;
  /** 泛化：原 skillPath + appendSystemPrompt 收拢（D2）。 */
  persona?: PersonaSpec;
  /**
   * 原样（ExecuteOptions.schema）。native/emulated 分流依据（D4 硬边界）：pi 的
   * PI_WORKFLOW_SCHEMA env 注入链路按 native 直传，公共仿真层只服务 emulated 引擎。
   */
  schema?: Record<string, unknown>;
  /**
   * 原样（ExecuteOptions.maxTurns）。pi 引擎专属（turn limiter + spawn watchdog
   * 估算依赖 pi 的 turn_end 事件流）；其他引擎 prepare 期显式拒绝（U4，同 fork 模式）。
   * 显式 0 压过 SPAWN_WATCHDOG_ENV 兑底（SP-6 参数 > env，U5）；undefined 未传才由
   * env 兑底。
   */
  maxTurns?: number;
  /** 原样（ExecuteOptions.graceTurns）。 */
  graceTurns?: number;
  /** 原样（ExecuteOptions.fork）。pi 专属；其他引擎 prepare 期按 capabilities 拒绝。 */
  fork?: boolean;
  /**
   * 原样（ExecuteOptions.worktree）。公共层职责（worktree-manager），非引擎职责——
   * 引擎只把它当 spawn cwd 的来源之一。
   */
  worktree?: boolean | WorktreeHandle;
  /** 原样（ExecuteOptions.cwd）。 */
  cwd?: string;
  /** 原样（ExecuteOptions.conversation，interact 控制面的 task 标志，D1）。 */
  conversation?: boolean;
  /** 原样（ExecuteOptions.idleTimeoutMs，同上）。 */
  idleTimeoutMs?: number;
  /** 新增：中立工具 denylist。各引擎做语法映射（附录 A「工具 denylist」行的载体）。 */
  denyTools?: string[];
  /** 新增：中立权限模式。映射按 capabilities.permissionMode（kimi fixed auto = ignored）。 */
  permissionMode?: string;
  /**
   * [P4 形状预留，D9① 守卫 b 的独立载体] 任务对引擎能力的显式依赖声明。
   * 首期无生产写入方：守卫 b 与守卫 a 合流（显式 engine 即能力依赖声明）——调用方
   * 按引擎 id 表达依赖。下钻时机（AgentTaskSpec 泛化成熟后）：调用方改按能力表达
   * （如 requires: { sandbox: 'native' }），路由层将本字段与各引擎 capabilities()
   * 对照，无引擎满足时报 engine_capability_unsupported（调用前拒绝，D11 处置三级）。
   */
  requires?: Partial<EngineCapabilities>;
}

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
