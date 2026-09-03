/**
 * @zhushanwen/subagent-core — 公共 API barrel（D5 定稿 + post-convergence B-2 扩面）
 *
 * 公共 API 面 = 本文件导出 + package.json exports 的语义子入口
 * （./engines/zcode/reader、./engines/zcode/constants、./engine/paths、./relay-env）
 * + ./workflows/* 资产子入口。exports 面即 semver 契约（D5）：收窄不放宽——
 * 新增导出走 minor，本文件刻意不使用 `export *`，逐名列出以使 diff 可审。
 *
 * 扩面判定标准（post-convergence D3）：壳非测试代码实际消费 ≥1 处即进 barrel——
 * 契约面 = 壳的实际消费面，core 内部移动/重命名文件不再是对壳的隐性 breaking。
 * 未进 barrel 的内部实现细节仍不经此导出；`./*` -> src 开发态通配的删除与
 * 深路径归一由消费侧单元（u-2b/u-2c）收口。
 *
 * 设计权威源：docs/design/subagent-core-package-extraction.md §3.3 D5；
 * docs/design/subagent-post-convergence-architecture.md §3.2 B-2 / §3.6 D3/D8/D9；
 * 宿主接入示例见包 README（§3.4 core_host_not_configured 恢复指引的落点）。
 */

export const CORE_PACKAGE_VERSION = "0.3.0";

// ── 宿主端口接线面（core/）────────────────────────────────────
// HostServices：dataRoot / log / discoveryRoots 端口 + configureCore 注入；
// 未 configureCore 即消费 dataRoot 抛 core_host_not_configured（§3.4 错误规格，
// 恢复指引指向 README 接入示例）。DEFAULT_DATA_ROOT 显式导出供宿主选用——
// 消除「缺省静默漂目录」。getHostServices：core 内统一取用点，宿主 injector
// 消费（resource-list-injector）。
export {
  configureCore,
  getHostServices,
  DEFAULT_DATA_ROOT,
  type DiscoveryRoot,
  type HostServices,
} from "./core/host-services.ts";

// getLogger：facade 代理 logger——每次 log 调用时动态解析当前宿主实现，
// 模块顶层缓存惯例（`const logger = getLogger(...)`）下 configureCore 前后透明切换。
// LogLevel 是 HostServices.log 契约的成员类型（宿主实现必读）。
export { getLogger, type CoreLogger, type LogLevel } from "./core/logger.ts";

// NotifyDomainPorts：通知域窄端口（投递内核工厂 + pending 活跃计数），
// 两成员可选，缺席降级（投递直发 / pending 计零）。
export {
  configureNotifyDomain,
  type NotifyDomainPorts,
} from "./core/notify-ports.ts";

// ── 引擎契约面（execution/engine）────────────────────────────
// EnginePort：subagent 执行引擎的唯一契约点（run / interact / read / probe 四能力面）。
// types.ts：引擎中立类型（宿主与引擎适配器共同消费，宿主不感知具体引擎）。
export type {
  EnginePort,
  EngineRunResult,
  RunContext,
} from "./execution/engine/port.ts";
export type {
  AgentEvent,
  AgentOutcome,
  EngineCapabilities,
  EngineHandle,
  EngineHandleData,
  InteractAction,
  InteractResult,
  ProbeReport,
  ReplayedTurn,
  SessionView,
} from "./execution/engine/types.ts";
// RunContext 的成员类型（ctxModel / stream）——类型闭包随 EnginePort 必然公开，
// 显式导出免宿主深路径兜圈；type-only（SubagentStream 是 execution 内部实现，禁 new）。
export type { ModelInfo } from "./execution/model-resolver.ts";
export type { SubagentStream } from "./execution/stream-sink.ts";

// routeEngine：三层路由（调用参数 > frontmatter > 全局默认）+ probe fallback 编排
// 的单一权威点（engine-abstraction D9/D7）。宿主按 error.code（engine_* 错误族）
// 判别失败形态，无需导入错误类。
export {
  routeEngine,
  type EngineRouteOptions,
  type EngineRouteResult,
  type EngineRouting,
  type EngineRoutingInput,
  type EngineRoutingSource,
} from "./execution/engine/routing.ts";

// 引擎注册 / 发现与进程面：组合根 index.ts 接线消费（registerXxx 引擎注册、
// syncEnginesFile engines 文件同步、killAllSpawnedChildren session 派生进程兜底清理）。
export { syncEnginesFile } from "./execution/engine/engine-discovery.ts";
export { registerPiEngine } from "./execution/engine/engines/pi/registration.ts";
export { killAllSpawnedChildren } from "./execution/engine/engines/pi/session-runner.ts";
export { registerZcodeEngine } from "./execution/engine/engines/zcode/registration.ts";

// 引擎注册表原语 + 引擎感知提示面：engine-awareness injector 消费。
export {
  DEFAULT_ENGINE_ID,
  normalizeEngineId,
} from "./execution/engine/registry.ts";
export {
  buildEngineModelsPromptAppend,
  buildSubagentEngineSection,
} from "./execution/engine/model-prompt.ts";

// session-view 归一符号（post-convergence D3）：runtime 读取侧 2 处深路径
// （subagent-extractor / subagent-engine-history）归一 barrel 的前置——不新增
// 子入口（D9：每条子入口 bundle 多一份 host-services 副本）。
export { parseEngineHandle } from "./execution/engine/common/session-view-types.ts";
export { readSubagentHistoryMessages } from "./execution/engine/common/session-view-service.ts";

// ── 执行域（execution/）──────────────────────────────────────
// types.ts 领域类型族：record / 响应 / 列表项等 subagent 域公共契约（壳消费最高频面，
// tool 面 / interface 渲染层 / bg-notify 共同消费）。CLOSED_REASONS / DEFAULT_AGENT_NAME
// 为值常量，ResurrectDeniedError 为错误类（值 + 类型双形态）。
export {
  CLOSED_REASONS,
  DEFAULT_AGENT_NAME,
  ResurrectDeniedError,
} from "./execution/types.ts";
export type {
  AgentEventLogEntry,
  BgResponse,
  CancelResponse,
  CloseResponse,
  ClosedReason,
  DisplayItem,
  ExecutionMode,
  ExecutionOutcome,
  ExecutionRecord,
  ExecutionStatus,
  ExternalState,
  ForkFromResponse,
  ListResponse,
  MessageResponse,
  SubagentListItem,
  SubagentRecord,
  SubagentToolResult,
} from "./execution/types.ts";

// execution-record 投影函数族：record → 渲染态投影（outcome / elapsed / tool calls /
// live progress），interface 渲染层唯一消费入口。
export {
  computeElapsedSeconds,
  countAllToolCalls,
  deriveOutcome,
  getAllToolCalls,
  projectLiveProgress,
  projectOutcome,
} from "./execution/execution-record.ts";

// SubagentService 聚合面 + 进程单例访问器（post-convergence D8）：访问器经
// globalThis[Symbol.for] slot 防 jiti 多实例分裂，/resume /fork 复用既有实例
// （SR-3/SR-4 语义）。
export {
  SubagentService,
  getSubagentService,
  setSubagentService,
} from "./execution/subagent-service.ts";

// ModelConfigService 聚合面 + 单例访问器四件中的 model 侧两件（D8）。
export {
  ModelConfigService,
  getModelConfigService,
  setModelConfigService,
} from "./execution/model-config-service.ts";

// notify ledger：宿主通知账本端口（bind / getBound）——组合根装配 + workflow 域消费。
export {
  bindNotifyLedgerHost,
  getBoundNotifyLedger,
  type NotifyLedgerHost,
} from "./execution/notify-ledger.ts";

// identity 重建常量与类型：session_start identity custom entry 的写入侧契约。
export {
  IDENTITY_CUSTOM_TYPE,
  type SubagentIdentityData,
} from "./execution/session-reconstructor.ts";

// 执行域外围件（组合根 / interface 层直接消费的独立单点件）。
export { bestEffort } from "./execution/best-effort.ts";
export { getOrCreateChannelRegistry } from "./execution/channel-registry-access.ts";
export { DialogGlobalQueue } from "./execution/dialog-queue.ts";
export {
  readGlobalConfig,
  type GlobalConfigReadResult,
} from "./execution/config.ts";
export { isResumable } from "./execution/lifecycle-predicates.ts";
export { maybeCleanupExpiredSessionFiles } from "./execution/session-file-gc.ts";
export { createUiRequestHandlerForMode } from "./execution/ui-request-handler-factory.ts";
export { WorktreeManager } from "./execution/worktree-manager.ts";
export { SubprocessAgentRunner } from "./execution/subprocess-agent-runner.ts";

// record 存储面：RecordStore 类 + 索引文件名常量（bench 扫描基准消费）。
export { RecordStore } from "./execution/record-store.ts";
export { INDEX_FILENAME } from "./execution/sessions-index.ts";

// ── workflow 编排入口（orchestration）────────────────────────
// runWorkflow / abortRun：run 生命周期 free functions（D-12）。更细粒度编排
// （terminateRunningRuns / evictDoneRunsBeyondCap / scheduleTimeBudget / 上限常量）
// 为组合根实际消费面，随 B-2 扩面进 barrel（D3 判定标准首次执行）。
export { abortRun, runWorkflow } from "./orchestration/lifecycle.ts";
export {
  terminateRunningRuns,
  evictDoneRunsBeyondCap,
  scheduleTimeBudget,
  MAX_RETAINED_DONE_RUNS,
} from "./orchestration/lifecycle.ts";

// launcher 层：runAndWait / executeNestedWorkflow（workflow 域嵌套编排入口）
// + deps / 结果类型。
export {
  runAndWait,
  executeNestedWorkflow,
  type LauncherDeps,
  type WorkflowRunResult,
} from "./orchestration/launcher.ts";

// workflow 领域模型族：run / call / trace / budget / 状态与规格（壳 store 与
// interface 渲染层共同消费）。
export type { RunSpec } from "./orchestration/models/run-spec.ts";
export type { LifecycleDeps } from "./orchestration/models/ports.ts";
export type { RunStore } from "./orchestration/models/ports.ts";
export type { RunState } from "./orchestration/models/run-state.ts";
export { Trace } from "./orchestration/models/trace.ts";
export { AgentCall } from "./orchestration/models/agent-call.ts";
export { Budget } from "./orchestration/models/budget.ts";
export { WorkflowRun, type WorkflowRunMeta } from "./orchestration/models/workflow-run.ts";
export type {
  AgentCallOpts,
  AgentResult,
  DoneReason,
  ExecutionTraceNode,
  RunStatus,
  ToolCallEntry,
  WorkerLogEntry,
} from "./orchestration/models/types.ts";
export { SLUG_MAX_LENGTH } from "./orchestration/models/types.ts";

// workflow 脚本资产面：registry 契约 + 实现 / 脚本 lint / 文件落盘（save / delete）
// + skill 路径缓存清理——组合根装配与 workflow 工具面消费。
export type { WorkflowScriptRegistry } from "./orchestration/models/workflow-script-registry.ts";
export { WorkflowScriptRegistryImpl } from "./orchestration/workflow-script-registry-impl.ts";
export { lintScript } from "./orchestration/script-lint.ts";
export { saveWorkflow, deleteWorkflow } from "./orchestration/workflow-files.ts";
export { clearSkillPathCache } from "./orchestration/skill-discovery.ts";
export { WorkerHostImpl } from "./orchestration/worker-host.ts";

// ── 共享原语（shared/）───────────────────────────────────────
// agent 展示名归一（渲染层 7 处消费的 SSOT）+ meta 解析 / XML 注入 / 资源发现 /
// thinking 档位序（THINKING_ORDER 定义源 shared/model-ref，model-resolver 为转发）。
export { displayAgentName } from "./shared/agent-ref.ts";
export {
  parseResourceMeta,
  parseResourceMetaDetailed,
} from "./shared/meta-parser.ts";
export { THINKING_ORDER } from "./shared/model-ref.ts";
export {
  discoverResources,
  findWorkspaceRoot,
  getCachedFileContent,
  getCachedParsed,
} from "./shared/resource-discovery.ts";
export { escapeXml, renderXmlSection } from "./shared/xml-injection.ts";
