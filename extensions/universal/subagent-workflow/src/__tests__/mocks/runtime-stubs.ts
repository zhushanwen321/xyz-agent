// src/__tests__/mocks/runtime-stubs.ts
//
// 共享测试桩（u-5a / 设计 §2.2 C6 / §4 A-V5）：壳测试里逐字重复的手写 mock
// 收敛到本 module——桩更新一处生效，消费方不再各自手写。
//
// 消费方式（vi.mock 提升约束）：vi.mock 工厂被提升到文件顶部，工厂体内禁止
// 引用普通顶层变量，引用本 module 一律经 async 工厂 + 动态 import：
//
//   vi.mock("@earendil-works/pi-coding-agent", async () => {
//     const { piCodingAgentStub } = await import("./mocks/runtime-stubs.ts");
//     return piCodingAgentStub();
//   });
//
// getLogger 桩需每文件独立实例供断言：4 个 vi.fn 的创建必须留在 vi.hoisted
// 体内（hoisted 同步执行，不能动态 import 本 module），再经 async 工厂组装
// module stub。
//
// 使用纪律（A-V5）：同文件同模块 vi.mock 只注册一次；禁止在测试文件内重新
// 手写以下四类桩——桩形变更改本 module，全量消费方同步生效。

import { vi, type Mock } from "vitest";

// ── 桩 1：pi-coding-agent getAgentDir ──

/** getAgentDir 桩固定返回值（与全部既有手写桩及包根 mocks/pi-coding-agent.ts alias stub 逐字一致） */
export const STUB_AGENT_DIR = "/home/user/.pi/agent";

export function piCodingAgentStub(): { getAgentDir: () => string } {
  return { getAgentDir: () => STUB_AGENT_DIR };
}

// ── 桩 2：pi-ai StringEnum ──

export function piAiStringEnumStub(): {
  StringEnum: (values: string[]) => { type: "string"; enum: string[] };
} {
  return {
    StringEnum: (values: string[]) => ({ type: "string", enum: values }),
  };
}

// ── 桩 3：typebox Type ──
// 与包根 mocks/typebox.ts（vitest alias stub）形态不等价：alias 的 Record 丢弃
// key/value、Union 返回 items 字段名；本桩保留 additionalProperties/key/members
// （测试断言依赖手写桩形态）。消费方的 vi.mock 覆盖不可省——删掉即回落到
// alias stub 的弱形态。

export const typeboxStub = {
  Type: {
    Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
    Optional: (schema: unknown) => ({ ...(schema as object), optional: true }),
    String: () => ({ type: "string" }),
    Boolean: () => ({ type: "boolean" }),
    Number: () => ({ type: "number" }),
    Array: (items: unknown) => ({ type: "array", items }),
    Record: (key: unknown, value: unknown) => ({ type: "object", additionalProperties: value, key }),
    Unknown: () => ({ type: "unknown" }),
    Union: (members: unknown[]) => ({ type: "union", members }),
    Literal: (value: unknown) => ({ type: "literal", value }),
  },
};

// ── 桩 4：getLogger（core facade / pi-extension-logger 双源）──

export interface LoggerMock {
  debug: Mock;
  warn: Mock;
  error: Mock;
  info: Mock;
}

/** 每文件独立 logger mock 实例（断言隔离）；在 vi.hoisted 体内创建后传入 stub 工厂 */
export function createLoggerMock(): LoggerMock {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
}

/** @zhushanwen/subagent-core/core/logger.ts module stub */
export function coreLoggerModuleStub(loggerMock: LoggerMock): { getLogger: () => LoggerMock } {
  return { getLogger: () => loggerMock };
}

/**
 * @zhushanwen/pi-extension-logger module stub（getLogger + setPiHandle 变体）。
 * 消费面现状仅 parent-child-matrix（core facade 与 extension-logger 双 mock）；
 * 多数被测真实链路已切 core facade（见 chatmode-round-notify-real-chain.test.ts 注释）。
 */
export function extensionLoggerModuleStub(loggerMock: LoggerMock): {
  getLogger: () => LoggerMock;
  setPiHandle: Mock;
} {
  return { getLogger: () => loggerMock, setPiHandle: vi.fn() };
}
