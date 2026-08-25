/**
 * plan/compact.ts — successCriteria string[] 适配测试
 *
 * W1：buildPlanSuccessCriteria 返回 string[]（而非 string），
 * tryGoalInit 传给 __goalInit 的 successCriteria 为 string[]。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { handlePlanComplete } from "../compact.js";

const fsMock = vi.mocked(await import("node:fs"));

function makePi() {
  return {
    on: vi.fn(),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
  };
}

function makeCtx() {
  const onCompleteFns: Array<() => void> = [];
  const onErrorFns: Array<(e: Error) => void> = [];

  return {
    sessionManager: { getSessionId: () => "test-session", getEntries: () => [] as unknown[] },
    ui: { notify: vi.fn() },
    compact: vi.fn((opts: { onComplete?: () => void; onError?: (e: Error) => void }) => {
      if (opts.onComplete) onCompleteFns.push(opts.onComplete);
      if (opts.onError) onErrorFns.push(opts.onError);
    }),
    _onCompleteFns: onCompleteFns,
    _onErrorFns: onErrorFns,
  };
}

function makeActiveState() {
  return {
    isActive: true,
    phase: "complete" as const,
    planFilePath: "/tmp/plan.md",
    requirement: "Add login page",
    templateName: "default",
  };
}

describe("plan/compact — successCriteria 传 string[] 给 __goalInit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("compact isolation: __goalInit 收到 string[] 类型的 successCriteria", () => {
    const pi = makePi();
    const ctx = makeCtx();
    (pi as unknown as Record<string, unknown>).__goalInit = vi.fn().mockReturnValue(true);

    fsMock.readFileSync.mockReturnValue("## 实现步骤\n1. Step one\n2. Step two\n3. Step three");

    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "compact");

    ctx._onCompleteFns[0]();

    const goalInitMock = (pi as unknown as Record<string, unknown>).__goalInit as ReturnType<typeof vi.fn>;
    expect(goalInitMock).toHaveBeenCalled();

    // successCriteria 参数应为 string[] 而非 string
    const successCriteriaArg = goalInitMock.mock.calls[0][4];
    expect(Array.isArray(successCriteriaArg)).toBe(true);
    expect(successCriteriaArg).toEqual([
      "Step one",
      "Step two",
      "Step three",
    ]);
  });

  it("direct isolation: __goalInit 收到 string[] 类型的 successCriteria", () => {
    const pi = makePi();
    const ctx = makeCtx();
    (pi as unknown as Record<string, unknown>).__goalInit = vi.fn().mockReturnValue(true);

    fsMock.readFileSync.mockReturnValue("## 实现步骤\n1. Step A\n2. Step B");

    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct");

    const goalInitMock = (pi as unknown as Record<string, unknown>).__goalInit as ReturnType<typeof vi.fn>;
    const successCriteriaArg = goalInitMock.mock.calls[0][4];
    expect(Array.isArray(successCriteriaArg)).toBe(true);
    expect(successCriteriaArg).toEqual(["Step A", "Step B"]);
  });

  it("步骤超过上限 → 截断", () => {
    const pi = makePi();
    const ctx = makeCtx();
    (pi as unknown as Record<string, unknown>).__goalInit = vi.fn().mockReturnValue(true);

    const steps = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}`);
    fsMock.readFileSync.mockReturnValue(`## 实现步骤\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);

    handlePlanComplete(pi as never, ctx as never, makeActiveState(), "direct");

    const goalInitMock = (pi as unknown as Record<string, unknown>).__goalInit as ReturnType<typeof vi.fn>;
    const successCriteriaArg = goalInitMock.mock.calls[0][4];
    expect(Array.isArray(successCriteriaArg)).toBe(true);
    // 应截断到最多 8 条（schema 上限）
    expect(successCriteriaArg.length).toBeLessThanOrEqual(8);
  });
});
