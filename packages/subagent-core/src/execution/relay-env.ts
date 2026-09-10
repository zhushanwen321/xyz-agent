// src/execution/relay-env.ts
//
// relay 通道 env 名与协议常量的 re-export shim——单源在
// @zhushanwen/subagent-engine-sdk（round1-reuse R9 跨进程契约副本收编；core → SDK
// 边界正向合法）。本文件保持路径不变以保住 package.json exports 的 ./relay-env
// 子入口（semver 面：runtime/extension 消费方 import specifier 不变）。
// 代理脚本 relay.mjs 仍为内嵌镜像（零依赖脚本不能 import workspace 包），
// 镜像一致性由 conformance relay 变体断言锁定。

export {
  RELAY_ENV_SOCKET,
  RELAY_ENV_NODE,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_RECORD_ID,
  RELAY_PROTOCOL_VERSION,
  RELAY_EXIT_CODES,
  isRelayActive,
  readRelayForwardEnv,
} from "@zhushanwen/subagent-engine-sdk";
