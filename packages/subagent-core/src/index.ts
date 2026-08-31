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

// ═══════════════════════════════════════════════════════════════════
// sink 下沉收口扩面（docs/design/subagent-core-sink-design.md，2026-08-31）
//
// D2 裁决：本分隔线以下全部为纯新增导出——上方既有导出符号与路径零变更
//（pi 24 处深路径 import 与 zsw vendor sha256 manifest 双不受波及）。
// 按域分组逐名列出（不使用 `export *`，沿用本文件既有纪律使 diff 可审）。
//
// semver 分档：运行时面一组标注 @experimental（一个 minor 周期内允许签名
// 微调，D6）；其余各组为常规 semver 稳定面。
// ═══════════════════════════════════════════════════════════════════

// ── agent-ref 面（契约原语，U1）────────────────────────────────
// agent 引用规范化（normalizeRef 含 `..` 段拒绝——G4 声明的唯一行为收紧，
// ⛔2 样本集验证）+ 引用扩展名常量 + 显示名投影 + 报错文案工厂 +
// slug 长度上限 + 进程活性探针（watchdog/孤儿判定共用）。
export {
  AGENT_REF_EXT,
  displayAgentName,
  invalidAgentRefMessage,
  normalizeRef,
  type InvalidAgentRefMessageOptions,
  WORKFLOW_REF_EXT,
} from "./shared/agent-ref.ts";
export { SLUG_MAX_LENGTH } from "./execution/execute-options-mapper.ts";
export { isProcessAlive } from "./execution/alive-store.ts";

// ── workflow 契约面（U1）──────────────────────────────────────
// workflow 引用规范化（名/路径二分 + 保留字裁决，knownNames 宿主注入——
// 内置 workflow 名不 core 硬编码）+ WorkflowScript 实体与按路径加载工厂
//（第三宿主零复刻脚本加载，G3/S5）。
export {
  normalizeWorkflowRef,
  WORKFLOW_REF_RESERVED_NAMES,
  type NormalizeWorkflowRefOptions,
  type NormalizedWorkflowRef,
  type WorkflowRefInvalidReason,
} from "./shared/agent-ref.ts";
export {
  loadWorkflowScriptByPath,
  WorkflowScript,
} from "./orchestration/workflow-script-registry-impl.ts";

// ── 执行预算原语（U3/U4 / D7）─────────────────────────────────
// maxTurns→watchdog 毫秒换算（floor 语义文档化——两宿主预算一致性 S2 的函数级
// 锚点）+ 并发池工厂（queuePolicy 缺省 priority 保 pi 行为，zsw 消费 strict-fifo
// ——策略差异显式化而非双实现）。
export { maxTurnsToWatchdogMs } from "./execution/session-runner.ts";
export {
  createConcurrencyPool,
  type ConcurrencyPool,
  type CreateConcurrencyPoolOptions,
  type QueuePolicy,
} from "./execution/concurrency-pool.ts";

// ── 模型引用切分原语（U1 契约面批件）─────────────────────────
// provider/model 引用切分与缺省值（两宿主 maxTurns/model 换算同源）；
// 实现体内聚 zcode preparer/constants 不挪文件，barrel re-export（§5.3）。
export {
  DEFAULT_PROVIDER_ID,
  hasApiKey,
  splitZcodeModelRef,
} from "./execution/engine/engines/zcode/preparer.ts";
export { ZCODE_FALLBACK_DEFAULT_MODEL } from "./execution/engine/engines/zcode/constants.ts";

// ── worktree git 内核（U5 / D5）───────────────────────────────
// git 语义纯函数单源：保真读（gitRun）、SafeId 校验、dirty 谓词、
// collectWorktreePatch（统一 add+diff 基线机制，返回结构即 patchIncomplete
// 留痕载体）、三步容错清理、listWorktreePorcelain（原始输出供宿主 realpath
// 对账）。锚点缺失/损坏与 add 失败两条降级路径 warn + 留痕（⛔3）。
//
// GitRunError 同名双类裁决（u-core-exec-export 交接）：worktree-manager.ts 与
// worktree-git-ops.ts 各有一个 GitRunError（文案同但类独立）——barrel 只导出
// 本组 worktree-git-ops 版（git 语义新单源）；worktree-manager 版不进 barrel，
// 将来 manager 收缩到 git-ops 内核时随之消除。
export {
  assertSafeId,
  cleanupWorktree,
  collectWorktreePatch,
  GitRunError,
  gitRun,
  isSafeId,
  isTreeDirty,
  listWorktreePorcelain,
  SAFE_ID_RE,
  type CleanupWorktreeOptions,
  type CollectWorktreePatchOptions,
  type ListWorktreePorcelainOptions,
  type PatchBaselineAnchor,
  type WorktreePatchResult,
} from "./execution/worktree-git-ops.ts";

// ── 运行时面（@experimental，U10 / D6）────────────────────────
// SubagentService 构造依赖参数注入（modelService 等，无全局查找）+
// record 状态查询面（RecordStore 按状态枚举/按 id；lookupRecordAnyState
// 全态查询）+ record 落盘 entry 契约 + agent-registry 执行消费面
//（loadByPath 直接加载）+ 动作层领域内核（六 handler 的校验/守卫链/
// 归属判定/终态映射，产出领域对象，宿主 adapter 负责包装渲染）+
// 错误类型族（instanceof 分流用）。
//
// @experimental：本组全部导出在一个 minor 周期内允许签名微调，稳定后转
// 常规 semver 承诺（D6 语义，各源文件符号注释同款声明）。
//
// SubagentServiceSessionInit 刻意不出 barrel：pi session_start 注入专属
//（引用未导出的 PiLike 签面），第三宿主不经该流程。
export {
  createSubagentService,
  SubagentService,
  type SubagentServiceInit,
} from "./execution/subagent-service.ts";
export {
  RecordStore,
  type ChangeListener,
  type RecordStorePi,
  type StatusFilter,
} from "./execution/record-store.ts";
export {
  SUBAGENT_RECORD_CUSTOM_TYPE,
  toSubagentRecordEntry,
  type SubagentRecordEntryData,
} from "./execution/record-entry.ts";
export { AgentRegistry } from "./execution/agent-registry.ts";
// 错误类型族（error-recovery.ts 计划路径实测不存在，实测散布于下列源文件）：
// resurrect/fork-depth/dirty-worktree 为动作层守卫抛出点（types.ts），
// GitRunError 见 worktree 内核组裁决。
export {
  DirtyWorktreeError,
  ForkDepthExceededError,
  ResurrectDeniedError,
} from "./execution/types.ts";
export {
  BG_MESSAGE,
  cancelHandler,
  closeHandler,
  DEFAULT_LIST_LIMIT,
  endedMessageGuard,
  FORK_FROM_DEFAULT_PROMPT,
  forkFromHandler,
  listHandler,
  mapExternalState,
  MAX_LIST_LIMIT,
  messageHandler,
  NOTIFY_CONTRACT,
  recordToListItem,
  startHandler,
  wrapForkFromPrompt,
  type CancelHandlerInput,
  type CancelHandlerResult,
  type CloseHandlerInput,
  type CloseHandlerResult,
  type ForkFromHandlerInput,
  type ForkFromHandlerResult,
  type ListHandlerInput,
  type ListHandlerResult,
  type MessageHandlerInput,
  type MessageHandlerResult,
  type StartHandlerInput,
  type StartHandlerResult,
} from "./execution/subagent-actions-core.ts";
// 运行时面类型闭包（先例同 ModelInfo/SubagentStream：签名直接引用的具名类型
// 显式导出，免宿主深路径兜圈；二阶成员类型不强制——结构化类型下实例可用）。
export type {
  BgResponse,
  CancelResponse,
  CloseResponse,
  ExecutionRecord,
  ExecutionStatus,
  ExternalState,
  ForkFromResponse,
  ListResponse,
  MessageResponse,
  SubagentListItem,
  SubagentRecord,
} from "./execution/types.ts";

// ── 快照 codec（U8 / D4）──────────────────────────────────────
// WorkflowRun ↔ 落盘快照的单一投影：版本常量沿用 pi "wf-run-v2"（存量逐字节
// 可读）、live 字段 strip、更高版本跳过（宿主侧 warn 可见性自决）。
export {
  fromRunSnapshot,
  SNAPSHOT_VERSION,
  toRunSnapshot,
  type RunSnapshot,
} from "./orchestration/run-snapshot.ts";

// ── 原语（U6a）────────────────────────────────────────────────
// atomic-write：tmp+rename 原子写单一实现（统一 tmp 命名 `.tmp.<pid>.<seq>-<rand>`、
// 失败清理、崩溃残留扫描/清理入口）——core 内部全部写点已收敛于此（U6b）；
// sync/async 两档耐久语义见模块头。bounded-serialize：预算内 JSON 序列化
//（自 pi-sw helpers 平移，输出逐字节一致）。
export {
  atomicTmpPathFor,
  cleanupStaleTmpFiles,
  listStaleTmpFiles,
  parseAtomicTmpPath,
  writeAtomicFile,
  writeAtomicFileSync,
  type AtomicTmpRef,
  type AtomicWriteFileOptions,
  type AtomicWriteOptions,
  type CleanupStaleTmpOptions,
  type CleanupStaleTmpResult,
} from "./shared/atomic-write.ts";
export { boundedPrettySerialize } from "./shared/bounded-serialize.ts";

// ── 组装层（U2 装配 + U7 生命周期 / D8）───────────────────────
// discoverAgents：发现→宽容解析→去重→码点序（workflow 侧 discoverWorkflows
// 对称面，第三宿主「列 agents」入口）；recoverCrashedRuns：崩溃恢复四步装配
//（宿主事件经 hooks 外置）；runSummary/isScriptRunning：以 core WorkflowRun
// 为准的投影（runSummary 双投影分叉收口）；WorkflowRun 聚合根随闭包出 barrel。
export { discoverAgents } from "./execution/agents-assembly.ts";
export {
  recoverCrashedRuns,
  type RecoverCrashedRunsHooks,
} from "./orchestration/lifecycle.ts";
export {
  isScriptRunning,
  runSummary,
  type WorkflowRunSummary,
} from "./orchestration/workflow-run-summary.ts";
export {
  WorkflowRun,
  type WorkflowRunMeta,
} from "./orchestration/models/workflow-run.ts";
export type { DoneReason, RunStatus } from "./orchestration/models/types.ts";

// ── schema 助手（U9 / D9）─────────────────────────────────────
// workflow 资产 @pi-meta parameters 的 schema→已知键集、平铺参数检测与
// 归一化（pi tool-workflow 消费面下沉；宿主白名单退役入口）。
export {
  argKeysFromMeta,
  findFlattenedArgKeys,
  normalizeArgsByMeta,
  type ArgKeySet,
  type ArgMetaOptions,
  type ArgMetaWarning,
  type NormalizedArgs,
} from "./orchestration/args-meta.ts";

// ── 解析面（U2 / D3）──────────────────────────────────────────
// parseAgentProfile：宽容解析（无 frontmatter 不拒、name 缺省 stem、返回
// body 与执行字段全量）——执行消费面单点；与严格注入投影（parseResourceMeta）
// 双轨分离的执行侧统一入口。
export {
  parseAgentProfile,
  type AgentProfile,
} from "./execution/agent-registry.ts";
