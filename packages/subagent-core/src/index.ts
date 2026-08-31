/**
 * @zhushanwen/subagent-core — 公共 API barrel（D5 定稿）
 *
 * 公共 API 面 = 本文件导出 + package.json exports 的语义子入口
 * （./engines/zcode/reader、./engines/zcode/constants、./engine/paths、./relay-env）
 * + ./workflows/* 资产子入口。exports 面即 semver 契约（D5）：收窄不放宽——
 * 新增导出走 minor，本文件刻意不使用 `export *`，逐名列出以使 diff 可审。
 * 内部实现细节（error-recovery / execute-agent-call / worker-script-builder 等
 * engine 编排件）不经 barrel 导出；host-surface 扩面（zsw 回接 U0，2026-08-30）
 * 后 port 的 Infra 实现与宿主组装件已列入公共面，仓内壳侧深路径消费
 * （`./*` -> src 通配）不受本文件约束。
 *
 * 设计权威源：docs/design/subagent-core-package-extraction.md §3.3 D5；
 * 宿主接入示例见包 README（§3.4 core_host_not_configured 恢复指引的落点）。
 */

// 0.3.0 = 0.2.0 同号不同物污染（npm 已有旧产物）后的跳号基线（2026-08-30 裁决：
// 0.3.0 永不单独发布，+ minor changeset 收口面落 0.4.0）；与 package.json version
// 的一致性由 src/__tests__/smoke.test.ts 动态守护，改版本须两处同步。
export const CORE_PACKAGE_VERSION = "0.3.0";

// ── 宿主端口接线面（core/）────────────────────────────────────
// HostServices：dataRoot / log / discoveryRoots 端口 + configureCore 注入；
// 未 configureCore 即消费 dataRoot 抛 core_host_not_configured（§3.4 错误规格，
// 恢复指引指向 README 接入示例）。DEFAULT_DATA_ROOT 显式导出供宿主选用——
// 消除「缺省静默漂目录」。
export {
  configureCore,
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
  AgentTaskSpec,
  EngineCapabilities,
  EngineHandle,
  EngineHandleData,
  InteractAction,
  InteractResult,
  PersonaSpec,
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

// ── 资源发现面（shared/resource-discovery，W2③）──────────────
// discoverResources：agent .md / workflow .js 的多源统一发现（ADR-031）——多源扫描
// + stem last-writer-wins 合并 + realpath 去重。宿主（zsw 回接）经 ScanConfig.hostRoots
// 注入发现根（source 标签即 ResourceSource 槽位键，含 project-host 项目级槽）；
// 深路径消费在 npm/vendored 发布形态不可达（exports 无深路径通配），故出 barrel。
export { discoverResources } from "./shared/resource-discovery.ts";
export type {
  DiscoveredResource,
  ResourceKind,
  ResourceSource,
  ScanConfig,
} from "./shared/resource-discovery.ts";
// 发现链辅助（C5b）：discoverResources 之外被发现消费方逐文件消费的三个原语——
// findWorkspaceRoot（project 源根定位）、getCachedParsed/getCachedFileContent
// （mtime 缓存读取）。发现链消费方（pi-sw injector 等宿主接线）逐条解析
// DiscoveredResource 的 frontmatter/meta 需要它们，深路径在 npm/vendored 发布
// 形态不可达，故随发现面出 barrel。
export {
  findWorkspaceRoot,
  getCachedFileContent,
  getCachedParsed,
} from "./shared/resource-discovery.ts";
// parseResourceMeta：.md frontmatter / workflow @pi-meta 的统一 meta 解析
// （fail-safe null）——发现链消费方从 DiscoveredResource 提取 name/description
// 的解析入口，与上面发现链辅助同属一个消费面，深路径同样不可达。
export { parseResourceMeta } from "./shared/meta-parser.ts";

// ── 注入渲染面（shared/injection-render + shared/xml-injection，W3）──
// 三段 XML（<available_subagents>/<available_workflows>/<available_provider_models>）
// 的 format 纯函数 + Entry 接口从 pi-sw 插件层下沉（D-3）：ModelEntry 并集口径
// （除 id/name 外全字段 optional，红线 5 守卫不抛不渲垃圾）、分段条目预算
// （码点序排 + 截尾 + 宿主注入兜底指引；models 段无预算永不截，红线 7）、
// guide 文案宿主注入（core 不内嵌平台文案）。summarizeDescription 随
// WorkflowEntry 链导出（zsw 侧同口径消费）。escapeXml/renderXmlSection 渲染
// 原语随面出 barrel——深路径消费在 npm/vendored 发布形态不可达。
export {
  formatAgentList,
  formatModelList,
  formatWorkflowList,
  sortByCodepoint,
  summarizeDescription,
} from "./shared/injection-render.ts";
export type {
  AgentEntry,
  ListFormatOptions,
  ModelEntry,
  ModelListFormatOptions,
  ModelReasoningInfo,
  WorkflowEntry,
} from "./shared/injection-render.ts";
export { escapeXml, renderXmlSection } from "./shared/xml-injection.ts";

// ── workflow 编排入口（orchestration）────────────────────────
// runWorkflow / abortRun：run 生命周期 free functions（D-12）——orchestration 的
// 最小宿主入口。以下 host-surface 扩面（zsw 回接 U0）出 Barrel：宿主壳组装
// LifecycleDeps 需要亲手构造三个 port 实现与消费细粒度编排函数，深路径消费
// 在 npm 形态不可达（发布面无 `./*` 通配）——宿主触点证据即 zsw 回接设计 D2。
export { abortRun, runWorkflow } from "./orchestration/lifecycle.ts";
export type { RunSpec } from "./orchestration/models/run-spec.ts";
export type { LifecycleDeps } from "./orchestration/models/ports.ts";

// lifecycle 细粒度编排：session 切换/关闭批量终止、done run 内存淘汰（窗口常量
// MAX_RETAINED_DONE_RUNS）、run 级墙钟预算计时器（宿主 rebuildRuntime 重排用）。
export {
  evictDoneRunsBeyondCap,
  MAX_RETAINED_DONE_RUNS,
  scheduleTimeBudget,
  terminateRunningRuns,
} from "./orchestration/lifecycle.ts";

// launcher 层：runAndWait（阻塞至 done）与 executeNestedWorkflow（嵌套 workflow()，
// 宿主 onWorkflowCall 注入的实现体）——宿主 tool/action 面的直接消费入口。
export { executeNestedWorkflow, runAndWait } from "./orchestration/launcher.ts";
export type { LauncherDeps, WorkflowRunResult } from "./orchestration/launcher.ts";

// WorkerHost port 的 Infra 实现（worker_threads 启动 worker 脚本）——宿主组装
// LifecycleDeps.workerHost 的默认实现；WorkerHandlers 是 start 的回调 bag 类型。
export { WorkerHostImpl } from "./orchestration/worker-host.ts";

// 脚本注册表 Infra 实现（config-loader 之上的 WorkflowScript 实体工厂）——
// launcher 层 registry 依赖的默认实现。
export { WorkflowScriptRegistryImpl } from "./orchestration/workflow-script-registry-impl.ts";

// lintScript：workflow 脚本静态检查（执行前 fail-fast，宿主 list/validate 面消费）。
export { lintScript } from "./orchestration/script-lint.ts";
export type { LintFinding, LintResult } from "./orchestration/script-lint.ts";

// ── workflow 创作闭环面（orchestration/script-generate + workflow-files，W4）──
// generateWorkflowScript：generate 校验管线（五道闸 + @pi-meta round-trip + tmp
// 写盘）从 pi-sw 插件层下沉（D-6）——纯函数返回结构化结果（不 throw，pi 的
// isError 契约转换由宿主负责），报错文案逐字对齐 pi 现版（CA2 前提）。
// saveWorkflow/deleteWorkflow 首次出 barrel：宿主（zsw）generate→save→delete
// 创作闭环的完整入口；目录经 WorkflowDirOptions 注入（缺省 pi 布局
// DEFAULT_WORKFLOW_TMP_DIR / DEFAULT_WORKFLOW_SAVED_DIR，向后兼容——pi 现深路径
// 调用形态行为不变，改接在 C5）。
export { generateWorkflowScript } from "./orchestration/script-generate.ts";
export type {
  GenerateWorkflowScriptOptions,
  GenerateWorkflowScriptResult,
} from "./orchestration/script-generate.ts";
export { deleteWorkflow, saveWorkflow } from "./orchestration/workflow-files.ts";
export type { WorkflowDirOptions } from "./orchestration/workflow-files.ts";
// 缺省目录常量随面导出：宿主显式注入 pi 缺省布局时引用常量，避免字面硬编码回流。
export {
  DEFAULT_WORKFLOW_SAVED_DIR,
  DEFAULT_WORKFLOW_TMP_DIR,
} from "./orchestration/workflow-files.ts";

// workflow 发现/加载（ADR-031 统一资源发现）：宿主 list 面与 registry 构造消费；
// invalidateCache 供宿主在写脚本后主动失效 mtime 缓存。
export {
  discoverWorkflows,
  getWorkflow,
  getWorkflowByPath,
  invalidateCache,
  loadWorkflows,
} from "./orchestration/config-loader.ts";
export type {
  CachedWorkflowMeta,
  WorkflowMeta,
  WorkflowScanConfig,
  WorkflowSource,
} from "./orchestration/config-loader.ts";

// FileRunStore：RunStore port 的宿主无关文件实现（D2 设计件）——落盘
// <dataRoot>/workflow-state/<runId>.jsonl，zsw 等无 pi session 设施的宿主装配
// LifecycleDeps.store 用；pi 壳继续用 session 锚定的 JsonlRunStore。
export { FileRunStore } from "./orchestration/file-run-store.ts";

// RunStore / AgentRunner / WorkerHost port 契约类型：宿主自写 Infra 实现
// （如 zsw 的 RunnerPort 桥接）需要契约面；WorkerHandlers 已随 WorkerHost 注释。
export type {
  AgentRunner,
  RunStore,
  WorkerHandlers,
  WorkerHost,
} from "./orchestration/models/ports.ts";

// ── zcode 引擎注册面（execution/engine）──────────────────────
// registerZcodeEngine：把 'zcode' 引擎登记进 registry（组合根职责，幂等）；
// createZcodeEngine：DI 工厂（测试/宿主注入 deps）。ZcodeEngineDeps 经
// registration.ts 的 re-export 导出（避免与 zcode-engine.ts 双源）。
export {
  createZcodeEngine,
  registerZcodeEngine,
} from "./execution/engine/engines/zcode/registration.ts";
export type { ZcodeEngineDeps } from "./execution/engine/engines/zcode/registration.ts";

// killAllSpawnedChildren：session 关闭时批量回收 agent 子进程（宿主 shutdown
// 钩子消费；子进程注册表在 session-runner 模块内）。
export { killAllSpawnedChildren } from "./execution/session-runner.ts";
