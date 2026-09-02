/**
 * @zhushanwen/subagent-core — 公共 API barrel（D5 定稿）
 *
 * 公共 API 面 = 本文件导出 + package.json exports 的语义子入口
 * （./engines/zcode/reader、./engines/zcode/constants、./engine/paths、./relay-env）
 * + ./workflows/* 资产子入口。exports 面即 semver 契约（D5）：收窄不放宽——
 * 新增导出走 minor，本文件刻意不使用 `export *`，逐名列出以使 diff 可审。
 * 内部实现细节（registry / worker-message-pump / execution 编排件等）不经 barrel 导出，
 * 仓内壳侧深路径消费（`./*` -> src 通配）不受本文件约束。
 *
 * 设计权威源：docs/design/subagent-core-package-extraction.md §3.3 D5；
 * 宿主接入示例见包 README（§3.4 core_host_not_configured 恢复指引的落点）。
 */

export const CORE_PACKAGE_VERSION = "0.2.0";

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

// ── workflow 编排入口（orchestration）────────────────────────
// runWorkflow / abortRun：run 生命周期 free functions（D-12）——orchestration 的
// 最小宿主入口。更细粒度编排（terminateRunningRuns / evictDoneRunsBeyondCap /
// scheduleTimeBudget）与 launcher 层（runAndWait 等）暂不进 barrel：
// 无宿主触点证据前不放宽（端口演进纪律②）；壳侧现经深路径消费，不受影响。
export { abortRun, runWorkflow } from "./orchestration/lifecycle.ts";
export type { RunSpec } from "./orchestration/models/run-spec.ts";
export type { LifecycleDeps } from "./orchestration/models/ports.ts";
