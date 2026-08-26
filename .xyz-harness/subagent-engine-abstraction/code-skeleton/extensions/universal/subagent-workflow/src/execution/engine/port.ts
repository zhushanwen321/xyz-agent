// execution/engine/port.ts
//
// EnginePort——引擎可插拔的唯一契约点（L2，五面：run/interact/read/probe/capabilities）。
// 签名唯一权威：设计文档 §3.3.5，不在此重新设计。上层消费方（subagent 工具面 /
// workflow 引擎 / GUI）只认本接口与中立类型；引擎差异全部止步于此。

import type {
  AgentTaskSpec,
  EngineCapabilities,
  EngineHandleData,
  EngineRunResult,
  InteractAction,
  InteractResult,
  ProbeReport,
  RunContext,
  SessionView,
} from "./types.ts";

// ============================================================
// EnginePort（五面）
// ============================================================

export interface EnginePort {
  /** 注册表 key（"pi" | "zcode" | ...）。 */
  readonly id: string;

  /** D3 能力声明（同步无副作用——调用前拒绝的判据）。 */
  capabilities(): EngineCapabilities;

  /** D7 探针（factory 初始化 + 版本变化检测触发；不调 LLM）。 */
  probe(opts?: { force?: boolean }): Promise<ProbeReport>;

  /** D1 主语义：一次性任务 fire-to-completion。
   *
   * 错误语义三条（§3.3.5）：
   * ① prepare 期错误（credential_missing / model_not_available / prompt_too_large）
   *    在进程创建前 reject，不产生 handle；
   * ② 运行中失败不 reject——合成 error outcome + 正常 handle 返回（record 必须收尾）；
   * ③ abort 走完杀链后同②（exitCode=null + error 含杀链标记）。 */
  run(task: AgentTaskSpec, ctx: RunContext): Promise<EngineRunResult>;

  /** D1 可选面：交互控制面（message/close/cancel）。zcode 首期 unsupported（调用前拒绝）。
   * 进程已死的 handle → engine_session_not_resumable（不笼统失败）。 */
  interact(handle: EngineHandle, action: InteractAction): Promise<InteractResult>;

  /** D6 三级降级链：①引擎原生 → ②宿主 journal 重放 → ③outcome-only，三级都不 throw。 */
  read(handle: EngineHandle): Promise<SessionView>;
}

// ============================================================
// EngineHandle（内存态）
// ============================================================

/**
 * handle 的内存态 = 反序列化物（data）+ 引擎运行时引用（engine）。
 * 持久化时只落 data（record entry v2 的 engine.handle 字段）；主会话 reload 后按
 * data.engineId 经 registry 重新解析 engine 引用（interact 对死进程必返
 * engine_session_not_resumable，BC-7 / A13）。
 */
export interface EngineHandle {
  readonly data: EngineHandleData;
  readonly engine: EnginePort;
}

// ============================================================
// EngineFactory（registry 的登记物）
// ============================================================

import type { PoolManager } from "./degradation/pool-manager.ts";

/** 引擎工厂入参（宿主编排层注入公共设施；引擎不自建池）。 */
export interface EngineDeps {
  /** 隔离目录池管理（§3.3.9；宿主唯一写者）。 */
  poolManager: PoolManager;
  /** journal 落盘工厂（host 统一写；run 内 onEvent 出口的落盘载体）。 */
  createJournalWriter: (engineId: string, poolKey: string, taskId: string) => import("./degradation/journal.ts").EventJournalWriter;
}

/** engine id → 工厂（registry.ts 登记形态）。 */
export type EngineFactory = (deps: EngineDeps) => EnginePort;
