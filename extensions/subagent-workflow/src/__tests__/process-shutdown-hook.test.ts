/**
 * [V2 决策 7 防线 i] process 级 shutdown hook 测试。
 *
 * 验证 index.ts factory 注册 process.on SIGTERM/SIGINT/beforeExit，handler 触发时
 * 调 killAllSpawnedChildren 收割全部活子进程，且 idempotent（多信号叠加只收割一次）。
 *
 * mock 策略（对齐 wave0-package-structure.test.ts）：
 *   - session-runner.killAllSpawnedChildren → vi.fn（避免真实 kill + 可断言调用）
 *   - process.on → spy + mockImplementation 捕获 handler（不真实注册，防 listener 泄漏）
 *   - process.exit → spy mock（阻止 handler 内 exit(0) 终止测试进程）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// mock session-runner：index.ts factory 顶层唯一引用点是 killAllSpawnedChildren。
const killAllSpawnedChildrenMock = vi.fn();
vi.mock("../execution/session-runner.ts", () => ({
  killAllSpawnedChildren: killAllSpawnedChildrenMock,
}));

/** 最小 mock ExtensionAPI（对齐 wave0-package-structure.test.ts 的 createMockExtensionAPI）。 */
function createMockExtensionAPI(): ExtensionAPI {
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
    appendEntry: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  } as unknown as ExtensionAPI;
}

describe("[V2 决策 7 防线 i] process 级 shutdown hook", { timeout: 30000 }, () => {
  type Handler = (...args: unknown[]) => void;
  const registered: Partial<Record<string, Handler>> = {};
  let onSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let resetGuard: () => void;

  // hook 显式 timeout：describe 级 { timeout } 不传播给 hook（vitest 4 行为），
  // 动态 import("../index.ts") 大模块图在全量并行高负载下偶发超默认 10s
  beforeEach(async () => {
    killAllSpawnedChildrenMock.mockReset();
    for (const k of Object.keys(registered)) delete registered[k];

    // 捕获 process.on 注册的 handler（不真实注册到全局 process，避免 listener 跨用例泄漏）。
    onSpy = vi.spyOn(process, "on");
    onSpy.mockImplementation(((event: string, handler: Handler) => {
      registered[event] = handler;
      return process;
    }) as never);
    // 阻止 SIGTERM/SIGINT handler 内 process.exit(0) 真实终止测试 runner。
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    // 直接 import src/index.ts（而非 extension-root/index.ts re-export）——后者只
    // re-export default，拿不到 named export _resetProcessShutdownGuardForTest。
    const mod = await import("../index.ts");
    resetGuard = (
      mod as unknown as { _resetProcessShutdownGuardForTest: () => void }
    )._resetProcessShutdownGuardForTest;
    mod.default(createMockExtensionAPI());
  }, 30000);

  afterEach(() => {
    onSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("factory 注册 process.on SIGTERM / SIGINT / beforeExit 三个 hook", () => {
    expect(registered["SIGTERM"]).toBeDefined();
    expect(registered["SIGINT"]).toBeDefined();
    expect(registered["beforeExit"]).toBeDefined();
  });

  it("SIGTERM handler 触发时调 killAllSpawnedChildren(\"SIGTERM\") + process.exitCode = 0", () => {
    resetGuard();
    registered["SIGTERM"]!("SIGTERM");
    expect(killAllSpawnedChildrenMock).toHaveBeenCalledWith("SIGTERM");
    expect(process.exitCode).toBe(0);
  });

  it("SIGINT handler 触发时调 killAllSpawnedChildren + process.exitCode = 0", () => {
    resetGuard();
    registered["SIGINT"]!("SIGINT");
    expect(killAllSpawnedChildrenMock).toHaveBeenCalledWith("SIGTERM");
    expect(process.exitCode).toBe(0);
  });

  it("beforeExit handler 触发时调 killAllSpawnedChildren 但不 process.exit（自然退出）", () => {
    resetGuard();
    registered["beforeExit"]!();
    expect(killAllSpawnedChildrenMock).toHaveBeenCalledWith("SIGTERM");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("idempotent：多信号叠加（SIGTERM 后又 SIGINT/beforeExit）只收割一次", () => {
    resetGuard();
    registered["SIGTERM"]!("SIGTERM");
    registered["SIGINT"]!("SIGINT");
    registered["beforeExit"]!();
    expect(killAllSpawnedChildrenMock).toHaveBeenCalledTimes(1);
  });

  it("idempotent：session_shutdown 已收割后，process 级 handler 不重复 kill", () => {
    // 模拟 session_shutdown 先触发（resetGuard 后先收割一次），再 process 信号到达。
    resetGuard();
    registered["beforeExit"]!();
    expect(killAllSpawnedChildrenMock).toHaveBeenCalledTimes(1);
    registered["SIGTERM"]!("SIGTERM");
    expect(killAllSpawnedChildrenMock).toHaveBeenCalledTimes(1);
  });
});
