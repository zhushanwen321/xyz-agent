// src/port-contract.ts
//
// 引擎进程内契约面七符号 + parseCtxModel 单源（S4 簇 1 收编：pi/zcode 两包
// port-types.ts 的逐字等价本地镜像收编——两包原地改 re-export shim，18 个 import
// 点零改写；server.ts 的 parseCtxModel 模块级纯函数同批收编，实现以 pi 版为基线
// 逐字迁移）。
//
// 为什么现在能收（W5/W7 双轨沉淀后的收编，不翻「SDK 类型闭包只收跨进程协议面」
// 的原始裁决）：两包过渡期镜像经 W10 conformance 套件验证字段逐字等价、双轨已
// 稳定，收编即消除克隆而非改变边界语义。RunContext 含 AbortSignal/回调/EngineStream
// 等非序列化成员，跨进程面经各包 server.ts 帧映射——故收主 barrel，不进 protocol/
// 子入口（protocol/ 是 semver 收窄的跨进程可序列化面）。
//
// 命名：全量任务声明在 SDK 侧名 EngineAgentCallOpts（主 barrel 已有 protocol 的
// AgentCallOpts 引擎面子集——16 字段协议 run.params.task 形态，两者是子集/全量
// 关系，不可同名共存；两包 shim 转名 re-export 保本包消费面 AgentCallOpts 不变）。
//
// onChildSpawned 统一采窄载荷形态（host/childSpawned 载荷形态；ChildProcess 句柄
// 不跨协议面）——zcode 侧生产零调用（D6），形态统一无行为影响。
//
// 第三份镜像登记：core execution/engine/port.ts 的 RunContext 是宿主侧独立契约
// （onChildSpawned 全 ChildProcess 句柄，概念域 = 宿主进程内），不收编、不 import
// 本模块；漂移面由 W10 conformance 套件继续覆盖。

import type {
  AgentCallOpts as SdkAgentCallOpts,
  AgentEvent,
  AgentOutcome,
  EngineCapabilities,
  EngineHandleData,
  InteractAction,
  InteractResult,
  ProbeReport,
  ResumeAnchor,
  SessionView,
} from "./protocol/contract-types.ts";

/**
 * 引擎进程内全量任务声明 = SDK AgentCallOpts 引擎面子集 + 协议 ctx 还原字段（model/
 * cwd/schemaEnv——SDK 契约把它们从 task 移到 run.params.ctx，进程内接口合回单对象；
 * server.ts 做 ctx→task 还原，与 core RemoteEngine.toSdkTaskSubset 镜像）。
 */
export type EngineAgentCallOpts = SdkAgentCallOpts & {
  model?: string;
  cwd?: string;
  schemaEnv?: string;
};

/**
 * 引擎进程内的 ctxModel 形态（core ModelInfo 的结构等价镜像——仅 id/provider 被引擎
 * 消费，name/reasoning 等字段透传保留防测试/未来消费面漂移）。
 */
export interface EngineCtxModel {
  id: string;
  provider: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, unknown>;
  contextWindow?: number;
}

/** text_delta streaming 出口（协议 host/streamDelta 的本地承载）。 */
export interface EngineStream {
  onDelta(delta: string): void;
}

/** run 的运行期上下文（core RunContext 结构等价镜像；chat? = 会话形态参数，缺省一次性任务）。 */
export interface RunContext {
  taskId: string;
  poolKey: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  ctxModel?: EngineCtxModel;
  stream?: EngineStream;
  schemaEnv?: string;
  engineFallback?: { from: string; reason: string };
  onPoolResolved?: (poolKey: string) => void;
  onHandleReady?: (partial: Pick<EngineHandleData, "sessionRef" | "poolKey">) => void;
  /** 一次性子进程 pid 上报（host/childSpawned 载荷形态；ChildProcess 句柄不跨协议面）。 */
  onChildSpawned?: (child: { pid: number | undefined; killed: boolean }) => void;
  /**
   * [v1.x] chat 会话形态参数（协议 run.params.chat 的进程内还原；缺省 = 一次性任务
   * 形态）。recordId = chat 轮次关联键与 interact 定位键；resume 锚点存在 = 冷续
   * （--session 续写原文件），不存在 = 首轮新建。
   */
  chat?: { recordId: string; resume?: ResumeAnchor };
}

export interface EngineHandle {
  readonly data: EngineHandleData;
}

export interface EngineRunResult {
  handle: EngineHandle;
  outcome: AgentOutcome;
}

/** 引擎进程内的引擎契约点（core EnginePort 的结构等价镜像）。 */
export interface EnginePort {
  readonly id: string;
  capabilities(): EngineCapabilities;
  probe(opts?: { force?: boolean }): Promise<ProbeReport>;
  run(task: EngineAgentCallOpts, ctx: RunContext): Promise<EngineRunResult>;
  interact(handle: EngineHandle, action: InteractAction): Promise<InteractResult>;
  read(handle: EngineHandle): Promise<SessionView>;
  listModels?(): Array<{ id: string; name?: string }> | null;
  validateModel?(modelRef: string | undefined): { canonicalRef: string };
  dispose?(): Promise<void>;
}

/** ctx.ctxModel（"provider/id" canonical 词形）→ EngineCtxModel。 */
export function parseCtxModel(ref: string | undefined): EngineCtxModel | undefined {
  if (ref === undefined || ref.trim() === "") return undefined;
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}
