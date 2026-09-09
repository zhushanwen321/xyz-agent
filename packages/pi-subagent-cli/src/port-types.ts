// src/port-types.ts
//
// EnginePort / RunContext / EngineRunResult 的引擎包本地契约面（W7 迁移承接）。
//
// 为什么本地镜像而非 SDK 契约：EnginePort 是 core 侧编排契约（实现方与上层都在
// core/宿主进程），SDK 类型闭包只收「跨进程协议可序列化面」（AgentCallOpts 子集 /
// 事件 / handle / outcome——见 SDK contract-types.ts 字段裁决）。引擎进程内的
// PiEngine 实现本接口，由协议服务器（server.ts）映射到 10 正向方法——映射语义
// 与 core RemoteEngine（对端）互为镜像。字段与 core src/execution/engine/port.ts
// 逐字段等价；漂移面由 W10 conformance 套件覆盖（本包过渡期与 core 双轨，core 侧
// 原件未动）。

/**
 * 本地全量任务声明 = SDK AgentCallOpts 引擎面子集 + 协议 ctx 还原字段（model/cwd/
 * schemaEnv——SDK 契约把它们从 task 移到 run.params.ctx，进程内接口合回单对象；
 * server.ts 做 ctx→task 还原，与 core RemoteEngine.toSdkTaskSubset 镜像）。
 */
export type AgentCallOpts = SdkAgentCallOpts & {
  model?: string;
  cwd?: string;
  schemaEnv?: string;
};

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
} from "@zhushanwen/subagent-engine-sdk";

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

/** run 的运行期上下文（core RunContext 逐字段等价镜像，见文件头）。 */
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
  run(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult>;
  interact(handle: EngineHandle, action: InteractAction): Promise<InteractResult>;
  read(handle: EngineHandle): Promise<SessionView>;
  listModels?(): Array<{ id: string; name?: string }> | null;
  validateModel?(modelRef: string | undefined): { canonicalRef: string };
  dispose?(): Promise<void>;
}
