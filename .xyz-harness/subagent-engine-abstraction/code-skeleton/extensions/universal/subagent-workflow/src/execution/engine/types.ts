// execution/engine/types.ts
//
// 引擎中立类型层（L1）——字段规格唯一权威：设计文档 §3.3.5-§3.3.6，不在此重新设计。
// 本文件是 engine/ 目录的类型 SSOT：port/registry/routing/engines/degradation 全部
// import 本文件，本文件不 import engine/ 内任何其他模块（无环保证）。
//
// 对现有类型的接线（Level 1，经 tsconfig paths 回指真实源码）：
//   - AgentEvent/AgentUsage/AgentUsageTotal/ToolCall/ExecuteOptions/WorktreeHandle
//     → @real/execution/types.ts（AgentEvent 唯一权威定义处，AC-4：此处只 re-export）
//   - orchestration 版 AgentResult/AgentUsage/ToolCallEntry
//     → @real/orchestration/models/types.ts（AgentOutcome 的锚定对象，D2 消歧）

import type { ModelInfo } from "@real/execution/model-resolver.ts";
import type {
  AgentEvent,
  AgentUsage,
  AgentUsageTotal,
  ExecuteOptions,
  ToolCall,
  Turn,
  WorktreeHandle,
} from "@real/execution/types.ts";
import type {
  AgentResult as OrchestrationAgentResult,
  AgentUsage as OrchestrationAgentUsage,
  ToolCallEntry,
} from "@real/orchestration/models/types.ts";

// ============================================================
// Re-export（AC-4：AgentEvent 唯一权威在 execution/types.ts，引擎层只 re-export）
// ============================================================

export type {
  AgentEvent,
  AgentUsage,
  AgentUsageTotal,
  ToolCall,
  Turn,
  WorktreeHandle,
  ExecuteOptions,
};

// ============================================================
// 错误规格（设计文档 §3.3.3：11 错误码，每个配恢复指引）
// ============================================================

/** 引擎层错误码全集（§3.3.3 表逐条；engineFallback 不是错误——见 AgentOutcome.engineFallback）。 */
export const ENGINE_ERROR_CODES = [
  "engine_not_found",
  "engine_probe_failed",
  "engine_credential_missing",
  "model_not_available",
  "prompt_too_large",
  "nested_spawn_rejected",
  "engine_capability_unsupported",
  "engine_session_not_resumable",
  "schema_emulation_failed",
  "engine_run_failed",
  "engine_timeout",
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

/**
 * 结构化引擎错误（可操作错误闭环：code → recovery 恢复动作文案）。
 * ok=false 的 ProbeReport.error 与 InteractResult 错误形态共用本形状。
 */
export interface EngineErrorShape {
  code: EngineErrorCode;
  message: string;
  /** 恢复指引：具体命令/配置路径/下一步（§3.3.3 每行恢复指引列的载体）。 */
  recovery: string;
  /** engine_run_failed / engine_timeout 时携带 stdout 尾部（≤2000 字）。 */
  stdoutTail?: string;
}

// ============================================================
// AgentTaskSpec（= ExecuteOptions 泛化，设计文档 §3.3.5）
// ============================================================

/**
 * 中立任务声明。不变式：不得携带任何引擎专有枚举/flag 形态——pi 7 档 thinkingLevel
 * 已剥离为 effort；schema 是 native/emulated 硬分流依据（D4）；fork 由各引擎按
 * capabilities 在 prepare 期拒绝。运行期句柄（signal/ctxModel/onComplete）归 RunContext。
 */
export interface AgentTaskSpec {
  task: string;
  /** ≤35 字符（原样，ExecuteOptions.slug）。 */
  slug: string;
  /** agent ref（resolveIdentity 的 agent 名/路径原样）。 */
  agent?: string;
  /** 在引擎 provider 体系内解释（D9②：model 与 engine 正交，不隐式换引擎）。 */
  model?: string;
  /** 泛化：原 thinkingLevel（pi 7 档语义剥离，引擎各自映射或忽略）。 */
  effort?: string;
  /** 泛化：原 skillPath + appendSystemPrompt 收拢（D2）。 */
  persona?: PersonaSpec;
  /** native/emulated 分流依据（D4 硬分流）。 */
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
  /** pi 专属；其他引擎 prepare 期按 capabilities 拒绝。 */
  fork?: boolean;
  /** 公共层职责（worktree-manager），非引擎职责；引擎只消费 cwd。 */
  worktree?: boolean | WorktreeHandle;
  cwd?: string;
  /** interact 控制面的 task 标志（D1：chatMode idle 复用由 interact 面承载）。 */
  conversation?: boolean;
  idleTimeoutMs?: number;
  /** 新增：中立工具 denylist（六引擎附录 A 该行的载体，映射按引擎语法）。 */
  denyTools?: string[];
  /** 新增：中立权限模式（映射按 capabilities.permissionMode）。 */
  permissionMode?: string;
}

/** persona 声明（persona 路由三策略的输入，见 degradation/persona-router.ts）。 */
export interface PersonaSpec {
  /** agent 名/路径（capabilities.personaInjection 决定注入通道）。 */
  agentRef?: string;
  /** 原 ExecuteOptions.skillPath（file/flag/prompt 三策略分流，D4）。 */
  skillPath?: string;
  /** 追加系统提示（schema 仿真段由公共层拼装后放入）。 */
  appendSystemPrompt?: string[];
}

// ============================================================
// AgentOutcome（锚定 orchestration AgentResult，设计文档 §3.3.5）
// ============================================================

/**
 * 引擎层终态 DTO。消歧（D2）：orchestration 层 AgentResult（workflow 引擎消费）与
 * execution 层 AgentResult（record 内部投影，text/turns/sessionId/toolCalls）均保持
 * 原名不动——引擎层终态命名 AgentOutcome，三者不同名，「同名不同义」消除。
 *
 * 终态序唯一：run resolve 即终态。运行中失败不 reject——合成 error outcome + 正常
 * handle 返回（record 必须收尾）；exitCode=null = 被信号杀死（杀链/abort 判据）。
 */
export interface AgentOutcome {
  content: string;
  /** native 引擎直传 / 仿真层 ajv 产出（D4 硬分流，无第二校验权威）。 */
  parsedOutput?: unknown;
  /** orchestration 版 usage 形状（input/output/cacheRead/cacheWrite/cost/contextTokens/turns）。 */
  usage?: OrchestrationAgentUsage;
  durationMs?: number;
  /** 错误码前缀格式见 §3.3.3（含恢复指引文案）。 */
  error?: string;
  sessionId?: string;
  sessionFile?: string;
  /** 仅诊断（worktree 在 run 返回前通常已清理，不可作后续 cwd）。 */
  worktreePath?: string;
  toolCalls?: ToolCallEntry[];
  /** 新增：实际执行引擎（fallback 后可能 ≠ 请求值，D9①）。 */
  engineId: string;
  /** 新增：record 同步投影，GUI 警告条数据源（非错误留痕）。 */
  engineFallback?: { from: string; reason: string };
  /** 新增：null = 被信号杀死（杀链/abort 合成终态判据，D1）。 */
  exitCode?: number | null;
}

// ============================================================
// RunContext / EngineRunResult / InteractAction / InteractResult
// ============================================================

/** run 的运行期上下文（信号/事件出口/池定位——不属于任务声明的部分）。 */
export interface RunContext {
  /** = record.id（bg-N-xxx / run-N）——journal 文件名与池引用计数 key。 */
  taskId: string;
  /** D5 隔离池（宿主分配，见 degradation/pool-manager.ts computePoolKey）。 */
  poolKey: string;
  /** abort 分级入口（D1：原生中断 → 公共杀链）。 */
  signal?: AbortSignal;
  /** 事件流出口（host 消费后统一落 journal，D6 第②级数据源）。 */
  onEvent?: (event: AgentEvent) => void;
  /** model 解析第三层兼底（现有 D-008 语义不变）。 */
  ctxModel?: ModelInfo;
}

/** run 产出。handle 可持久化；失败终态（engine_run_failed/abort/timeout）也返回 handle 供 journal 定位。 */
export interface EngineRunResult {
  handle: EngineHandleData;
  outcome: AgentOutcome;
}

/** interact 面 action（设计文档 §3.3.5；pi chatMode 的 message/close/cancel 直通，BC-7）。 */
export type InteractAction =
  | { kind: "message"; payload: string }
  | { kind: "close"; payload?: { force: boolean } }
  | { kind: "cancel" };

export type InteractResult =
  | { ok: true; delivered: true }
  | { ok: false; code: EngineErrorCode; message: string };

// ============================================================
// ProbeReport（D7 探针产出）
// ============================================================

export interface ProbeReport {
  ok: boolean;
  /** 实测版本（handle.engineVersion 数据源；漂移排查锚点）。 */
  engineVersion: string;
  /** 二进制存在/版本解析/干跑回归逐项。 */
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  /** ok=false 时必非空（engine_probe_failed 的恢复指引，§3.3.3 终态四）。 */
  error?: { code: EngineErrorCode; recovery: string };
}

// ============================================================
// EngineCapabilities（D3 十维）
// ============================================================

/**
 * 引擎能力声明式描述。口径 = 本仓 subagent 链路实际接通能力，非引擎 RPC 理论能力
 * （pi RPC 有 steer 但 spawn 链路未接通，首期声明 unsupported——AC-9.3）。
 * 同步无副作用——调用前拒绝（engine_capability_unsupported）的唯一判据（D11）。
 */
export interface EngineCapabilities {
  schemaEnforcement: "native" | "emulated";
  steer: "native" | "emulated" | "unsupported";
  conversation: "native" | "unsupported";
  personaInjection: "file" | "flag" | "prompt";
  eventGranularity: "stream" | "coarse";
  sandbox: "native" | "emulated" | "none";
  sessionRead: "full" | "partial" | "outcome-only";
  resume: "native" | "cold" | "unsupported";
  interrupt: "native" | "kill-only";
  permissionMode: "native" | "fixed" | "ignored";
}

// ============================================================
// EngineHandleData（持久化形态，设计文档 §3.3.6）
// ============================================================

/**
 * handle 的持久化形态（record entry v2 内嵌 `engine.handle`）。
 * 不透明性三条（D1）：①上层不解构——仅 record 持久化层与 read 降级链可用其字段；
 * ②可持久化——主会话 reload 后 read 仍可用；③自描述——engineId + sessionRef +
 * poolKey + journalPath + adapterVersion。存量 v1 record 缺省按 pi 投影（零迁移）。
 */
export interface EngineHandleData {
  v: 1;
  engineId: string;
  /** 引擎自定义键值：pi = { sessionFile }；zcode = { sessionId, dbPath（相对池目录） }。 */
  sessionRef: Record<string, string>;
  /** 隔离池定位（§3.3.9；pi 无池化恒 "shared"，仅为路径形状统一）。 */
  poolKey: string;
  /** journal 绝对路径（read 第②级数据源；runtime 读前校验前缀白名单）。 */
  journalPath: string;
  /** probe 实测（漂移排查锚点）。 */
  engineVersion?: string;
  /** 适配器版本（golden 样本对齐排查）。 */
  adapterVersion: string;
}

// ============================================================
// SessionView（read 返回，D6 三级降级链统一投影）
// ============================================================

export interface SessionView {
  engineId: string;
  sessionId?: string;
  /** 派生数据（ReplayedTurn 无内部态：_status/startedTs 剥离，closed 恒 true）。 */
  turns: ReplayedTurn[];
  /** 各 turn usageDelta 聚合。 */
  usage?: AgentUsageTotal;
  /** GUI 降级标记数据源（D6/A8）。三级降级链任一级产出都标来源。 */
  source: "native" | "journal" | "outcome-only";
}

/** 与 Turn 同构但无内部态（toolCalls 是导出的纯净形状 ToolCall，非 InternalToolCall）。 */
export interface ReplayedTurn {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  closed: true;
}

// ============================================================
// 隔离池（§3.3.9）/ preparer 产出
// ============================================================

/** preparer 的池上下文（宿主 PoolManager 分配；§3.3.9 目录布局）。 */
export interface PoolContext {
  engineId: string;
  /** 净化后 agent 名（agent 未指定时 "default"；pi 恒 "shared"）。 */
  poolKey: string;
  /** 池绝对路径 = <dataDir>/engines/<engineId>/<poolKey>/（getDataDir() 动态推导，禁写死）。 */
  poolDir: string;
  /** engines 根（journal 路径推导用）。 */
  enginesRoot: string;
}

/** preparer 产出（spawn 前唯一副作用模块的产物，§3.3.7）。 */
export interface PreparedExecution {
  /** 隔离变量（HOME/CONFIG_DIR）+ NESTED 标记 + 身份标记。 */
  env: Record<string, string>;
  /** worktree 路径或 task.cwd。 */
  cwd: string;
  /** 隔离池绝对路径（§3.3.9）。 */
  poolDir: string;
  /** 单次性产物（临时 prompt/persona 文件）——任务结束即清理，resume 保留。 */
  spawnedFiles: string[];
  /** argv 总长估算（超限报 prompt_too_large 的判据）。 */
  argvEstimateBytes: number;
}

// ============================================================
// adapter 四件套接口（§3.3.7 引擎内部微接口，非全局 port）
// ============================================================

import type { Readable, Writable } from "node:stream";

/** launcher 产出的进程抽象（唯一持 spawn 权的模块产出；abort 是杀链执行体）。 */
export interface EngineProcess {
  readonly pid: number;
  /** argv-only 引擎为 null（stdin=/dev/null）。pi 的 RPC 协议归 stdin，由引擎内部驱动。 */
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** 杀链执行体（D1 abort 分级②：SIGTERM → grace → SIGKILL）。 */
  readonly abort: (graceMs: number) => Promise<void>;
  readonly exited: Promise<{ code: number | null; signal?: string }>;
}

/** launcher：spawn 命令组装 + 进程启动——唯一持 spawn 权的模块。 */
export interface EngineLauncher {
  /** 组装 argv（persona 注入/schema env/模型映射在此落成具体 flag）+ spawn 子进程。 */
  launch(prepared: PreparedExecution, task: AgentTaskSpec): Promise<EngineProcess>;
}

/**
 * parser：stdout → AgentEvent 流 + 终态——对外统一「事件先发、终态后返」。
 * reject 仅限 parser 自身实现错误；引擎输出异常不 reject——resolve 为含错误信息的
 * terminal 触发 engine_run_failed（宿主合成终态）。
 */
export interface EngineParser {
  /**
   * emit：事件增量回调（流式引擎逐条 emit；批量引擎进程退出后一次性 emit 合成事件）。
   * resolve：进程退出 + 解析完成后返回终态。
   */
  consume(
    proc: EngineProcess,
    emit: (ev: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<ParserTerminal>;
}

/** parser 终态（handle.sessionRef 数据源；stdoutTail 是错误规格的尾部载体）。 */
export interface ParserTerminal {
  exitCode: number | null;
  signal?: string;
  /** 从输出提取的 session 定位符。 */
  sessionRef?: Record<string, string>;
  /** 有界收集（头 4K + 尾 64K）。 */
  stdoutTail: string;
}

/** preparer：env/隔离目录/凭据生成——spawn 前唯一副作用模块。 */
export interface EnginePreparer {
  /** argv 超限/凭据缺失/模型不可解析在此报错（§3.3.3 前三行），一律先于进程创建。 */
  prepare(task: AgentTaskSpec, pool: PoolContext): Promise<PreparedExecution>;
}

/**
 * reader：session 历史读取——共享只读模块（双端复用，无状态纯函数，无进程依赖）。
 * D6：唯一允许被 xyz-agent runtime import 的引擎模块（engines/<id>/reader.ts 不 import
 * 同包 launcher/preparer/parser）。
 */
export interface EngineReader {
  /** 第①级原生读取。失败返回 undefined（不 throw）——降级链由宿主 read() 编排。 */
  readNative(handle: EngineHandleData): Promise<SessionView | undefined>;
}

// ============================================================
// event journal 格式（JSONL 中立 v1，设计文档 §3.3.6）
// ============================================================

/** journal 每行 schema。event 为 AgentEvent 原样（JSON.stringify 直接产物，无二次变换）。 */
export interface JournalEntry {
  v: 1;
  /** host 落盘时刻（Date.now()）。 */
  ts: number;
  taskId: string;
  engineId: string;
  /** host 侧单调递增——重放顺序权威（不依赖文件行序的隐式保证）。 */
  seq: number;
  event: AgentEvent;
}

/** journal 文件名（journal-<taskId>.jsonl，路径 <dataDir>/engines/<engineId>/<poolKey>/）。 */
export function journalFileName(taskId: string): string {
  return `journal-${taskId}.jsonl`;
}

// ============================================================
// refs.json（§3.3.9 池引用登记，v1）
// ============================================================

export interface PoolRefs {
  v: 1;
  refs: Record<string, { taskId: string; ts: number }>;
}

/** 统一 NESTED 标记（D8：唯一跨引擎可靠的 env 层防护手段）。前缀 XYZ_ 已在 ENV_WHITELIST_PREFIXES SSOT 覆盖。 */
export const NESTED_ENV_VAR = "XYZ_AGENT_SUBAGENT";

/** outcome-only 降级合成用的最小输入（第③级数据源 = record 内 outcome 投影）。 */
export interface OutcomeOnlySource {
  engineId: string;
  prompt: string;
  content: string;
  error?: string;
  usage?: AgentUsageTotal;
}
