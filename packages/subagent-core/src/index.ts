/**
 * @zhushanwen/subagent-core — 入口 barrel（最小公共面）
 *
 * u1-move 阶段保持最小：宿主端口接线面（core/ 三件）+ 包版本常量。
 * 完整公共 API 面（EnginePort / routeEngine / runWorkflow / 语义子入口 / exports
 * conditions 定稿）归 u1-api-surface 按设计 D5 收口——
 * docs/design/subagent-core-package-extraction.md §3.3 D5。
 */

export const CORE_PACKAGE_VERSION = "0.1.0";

// ── 宿主端口接线面（core/）────────────────────────────────────
// HostServices：dataRoot / log / discoveryRoots 端口 + configureCore 注入；
// 未 configureCore 即消费 dataRoot 抛 core_host_not_configured（§3.4 错误规格）。
export {
  configureCore,
  DEFAULT_DATA_ROOT,
  type HostServices,
} from "./core/host-services.ts";

// getLogger：facade 代理 logger——每次 log 调用时动态解析当前宿主实现，
// 模块顶层缓存惯例（`const logger = getLogger(...)`）下 configureCore 前后透明切换。
export { getLogger } from "./core/logger.ts";

// NotifyDomainPorts：通知域窄端口（投递内核工厂 + pending 活跃计数），
// 两成员可选，缺席降级（投递直发 / pending 计零）。
export {
  configureNotifyDomain,
  type NotifyDomainPorts,
} from "./core/notify-ports.ts";
