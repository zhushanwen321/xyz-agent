// src/protocol/methods.ts
//
// 9 正向方法（core → 引擎）params/result 逐方法写死（v1）。设计权威源：
// 设计 §3.3 方法集表 + impl-plan §2.1「10 正向方法」。
//
// [v1.x 增量（chat-domain 设计 §3.2 D1-A）]：增量以可选参数形态落在 run.params.chat
// （会话形态参数 + 冷续 resume 锚点），major 不 bump。[H1] chat-run 统一后续聊 =
// 新 run + resume 锚点（docs/design/subagent-chat-run-unification.md §3.3 D5/D7），
// 既有 interact 方法已随 U5 删除，方法集收敛为 9 个。
//
// 应答面补充约定（设计 §3.3）：initialize 应答仅诊断（与 manifest 不一致 → warn 留痕，
// 不参与同步成员判据；唯一阻断面 = 被 gate 能力位多声明 → engine_capability_mismatch）；
// listModels / validateModel 为诊断面（宿主侧同步成员读 manifest，不经本方法）；
// dispose 幂等；ping 为健康检查（ADR-0047：静默 ≠ 卡死，不据此杀任务）。

import type {
  AgentCallOpts,
  EngineCapabilities,
  EngineHandleData,
  AgentOutcome,
  ModelCatalogEntry,
  ProbeReport,
  ResumeAnchor,
  SessionView,
} from "./contract-types.ts";

/**
 * 正向方法名联合（恰好 9 个；PROTOCOL_METHODS 常量数组与之同源互证）。
 * [H1] `interact` 成员已随 chat-run 统一退役（docs/design/subagent-chat-run-unification.md
 * §3.3 D5：续聊轮统一为「新 run + resume 锚点」，U5 删除）。
 */
export type ProtocolMethod =
  | "initialize"
  | "probe"
  | "run"
  | "cancel"
  | "read"
  | "listModels"
  | "validateModel"
  | "dispose"
  | "ping";

/** 方法名全集（运行时顺序化枚举；与 ProtocolMethod 的同源关系由测试断言）。 */
export const PROTOCOL_METHODS = [
  "initialize",
  "probe",
  "run",
  "cancel",
  "read",
  "listModels",
  "validateModel",
  "dispose",
  "ping",
] as const satisfies readonly ProtocolMethod[];

// ============================================================
// run 专用载荷
// ============================================================

/**
 * run 上下文（RunContext 字段映射的协议承载，设计 §3.3 RunContext 映射表）。
 */
export interface RunContextParams {
  /** 隔离池归属（journal 归属错 = 缺失后果）。 */
  poolKey: string;
  /** 任务工作目录（worktree 隔离时 = worktree 路径）。 */
  cwd: string;
  /** 请求模型 ref（未传 = 引擎缺省模型）。 */
  model?: string;
  /** 结构化输出 schema 的 env 注入形态（schemaEnv 降级通道）。 */
  schemaEnv?: string;
  /** 上下文模型 ref（与 run 模型分离的 ctx 模型）。 */
  ctxModel?: string;
  /** fallback 留痕（引擎回填 outcome.engineFallback 的种子）。 */
  engineFallback?: { from: string; reason: string };
  /** 事件粒度请求（引擎按 capabilities.eventGranularity 实际能力执行）。 */
  streamMode?: "stream" | "coarse";
  /**
   * [F6] 根 session id——pi 引擎 relay 归属键 SESSION_ID 的权威来源（生产三来源
   * ①本字段 ②宿主 env ③根进程 env 中，宿主派发恒走①）。additive 可选：旧引擎忽略
   * 未知字段，undefined 不上 wire。
   */
  sessionRootId?: string;
}

// ============================================================
// [v1.x] run 的 chat 会话形态参数（chat-domain 设计 §3.2 D1-A）
// ============================================================

/**
 * [v1.x] chat 会话形态参数——HostChatRoundTicket 五字段过协议映射中「record」的
 * 承载位（docs/design/chat-domain-v1x-liveness-governance.md §3.2 D1 五字段映射）：
 *   - recordId：core 预建 record 的关联键（引擎据此回填 handle.sessionRef、上报
 *     host/childSpawned|childStateChanged 的 record 键形态）；
 *   - resume：冷续锚点（重开已 idle 的 session 续聊；缺省 = 新 session）。对照
 *     core SpawnResumeOpts——sessionFile 经 anchor.sessionRef 携带，model/
 *     thinkingLevel 防漂移覆盖走既有 task/ctx 字段，不双写。
 * task.conversation === true 时必传（chat 路由前置 gate：manifest conversation 位
 * unsupported 的引擎同步拒 engine_capability_unsupported——见 error-codes.ts）。
 */
export interface RunChatParams {
  recordId: string;
  resume?: ResumeAnchor;
}

/**
 * [H1] run 的 resume 会话形态参数——RunChatParams 的泛化改名双键（设计
 * docs/design/subagent-chat-run-unification.md §3.3 D3 + §5 U1 行）：载荷同形
 * （recordId + resume 锚点，ResumeAnchor 不变），仅键名从「chat 会话形态」泛化为
 * 「resume 续聊」。与 `chat` 键并存（U1 只加键不改读端）：
 *   - U2-U5 过渡期：core 恒构造旧 `chat` 键，pi 引擎恒读 `ctx.chat`（现状不变）；
 *   - U6 单批切换：core 写端与 pi 读端同批改 `resume` 键并删除 `chat` 键——
 *     不存在「写新读旧」窗口（错配 = resume 静默失效、每轮新文件、sessionFile 被覆盖）。
 * 同形关系由类型层 AssertMutuallyAssignable + 载荷级 runSessionParamsSchema
 * （schema.ts，两键共用同一 schema）双重锁定。
 */
export interface RunResumeParams {
  recordId: string;
  resume?: ResumeAnchor;
}

// ============================================================
// params / result 逐方法映射（方法名 → 载荷）
// ============================================================

/** initialize 参数（engineConfig = L3 显式配置 engines.<id>.config 透传，不放凭据）。 */
export interface InitializeParams {
  protocolVersion: number;
  hostInfo: { name: string; version: string; dataRoot: string };
  engineConfig: Record<string, string>;
}

/** initialize 应答（仅诊断面：capabilities/models 与 manifest 不一致 → warn，不参与判据）。 */
export interface InitializeResult {
  protocolVersion: number;
  engineId: string;
  engineVersion: string;
  adapterVersion: string;
  capabilities: EngineCapabilities;
  /** 模型目录（诊断面；省略/null = 无枚举面语义）。 */
  models?: ModelCatalogEntry[] | null;
}

export interface ProbeParams {
  force?: boolean;
}

export interface RunParams {
  runId: string;
  task: AgentCallOpts;
  ctx: RunContextParams;
  /**
   * [v1.x 可选增量] chat 会话形态参数（task.conversation=true 的 chat 路由承载）。
   * 缺省 = 一次性任务形态，v1 引擎/宿主语义不变（向后兼容：旧引擎忽略未知字段，
   * 帧级 schema params 不做深校验）。
   * [H1] 退役倒计时：chat-run 统一后本键整体退役（U6 删除，读/写端同批切 `resume`）。
   */
  chat?: RunChatParams;
  /**
   * [H1 可选增量] resume 续聊参数——`chat` 键的泛化改名双键（载荷同形，见
   * RunResumeParams）。本单元（U1）只加键不改读端：pi 引擎继续消费 `ctx.chat`，
   * 本键在 U6 前 core 侧恒不构造；U6 单批切换后成为唯一键。additive 可选：旧引擎
   * 忽略未知字段，undefined 不上 wire。
   */
  resume?: RunResumeParams;
}

/** run 终态应答（期间事件经 event 通知；长运行方法，应答到达即终态）。 */
export interface RunResult {
  handle: EngineHandleData;
  outcome: AgentOutcome;
}

export interface CancelParams {
  runId: string;
  reason: string;
}

/**
 * cancel 应答（受理确认）。终态本体由该 run 的 run 终态应答承载（abort 合成终态经
 * event/终态应答到达）；引擎须 CANCEL_SETTLE_GRACE_MS（3s）内收敛，超时 core 走杀链。
 */
export interface CancelResult {
  ok: true;
}

export interface ReadParams {
  handle: EngineHandleData;
  /** 数据根必填：存量池时代引擎自算池/journal 相对 dbPath 的定位需要它（设计钉死）。 */
  dataDir: string;
}

export interface ListModelsParams {
  /** 占位空参（帧形状一致性；未来诊断参数在此扩展）。 */
  _placeholder?: never;
}

export interface ListModelsResult {
  /** 数组 = 有枚举面；null = 无枚举面（buildCoreAlignedHint 语义，与 manifest 省略对齐）。 */
  models: ModelCatalogEntry[] | null;
}

export interface ValidateModelParams {
  modelRef?: string;
}

export interface ValidateModelResult {
  canonicalRef: string;
}

export interface DisposeParams {
  /** 占位空参（帧形状一致性；幂等语义）。 */
  _placeholder?: never;
}

export interface DisposeResult {
  ok: true;
}

export interface PingParams {
  /** 占位空参（帧形状一致性）。 */
  _placeholder?: never;
}

export interface PingResult {
  pong: true;
}

/** 方法 → params 类型映射。 */
export interface ProtocolParamsMap {
  initialize: InitializeParams;
  probe: ProbeParams;
  run: RunParams;
  cancel: CancelParams;
  read: ReadParams;
  listModels: ListModelsParams;
  validateModel: ValidateModelParams;
  dispose: DisposeParams;
  ping: PingParams;
}

/** 方法 → result 类型映射。 */
export interface ProtocolResultMap {
  initialize: InitializeResult;
  probe: ProbeReport;
  run: RunResult;
  cancel: CancelResult;
  read: SessionView;
  listModels: ListModelsResult;
  validateModel: ValidateModelResult;
  dispose: DisposeResult;
  ping: PingResult;
}
