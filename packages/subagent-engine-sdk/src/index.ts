// src/index.ts
//
// @zhushanwen/subagent-engine-sdk 主 barrel。
// u-foundation 契约根（impl-plan §2 W1 行）：协议面（帧型/方法/错误码/版本协商/
// JSON Schema/契约类型）+ 引擎侧原语（7 模块）+ UI 请求契约类型。
// 不变量（设计 §3.10.1）：本包禁止 import @zhushanwen/subagent-core——守卫
// .githooks/check-engine-sdk-boundary.mjs（SDK 源码 + dist 双侧扫描）。

// ── 协议面（契约类型 SSOT + 帧型 + 方法 + 反向通道 + 错误码 + 版本协商 + schema）──
export * from "./protocol/index.ts";

// ── 引擎侧原语（7 模块，impl-plan §2.1 原语迁移处置表）──
export * from "./schema-emulation.ts";
export * from "./nesting-guard.ts";
export * from "./logger.ts";
export * from "./kill-chain.ts";
export * from "./journal-replay.ts";
export * from "./data-dir.ts";
export * from "./paths.ts";

// ── UI 请求契约类型（host/askUser 反向通道载荷；core 反向 re-export 保消费面）──
export * from "./ui-types.ts";

// W12 落地（impl-plan §2.12）：env/spawn 原语（三层 env 契约 + 引擎子进程唯一 spawn
// 入口 + 宿主死亡自灭守卫）。
export * from "./env.ts";
export * from "./spawn.ts";
