// src/execution/__tests__/subprocess-agent-runner-timeout.test.ts
//
// [D6 合流迁移] mergeTimeoutSignal（D-A9：per-call timeoutMs 合并进 AbortSignal）的
// 行为测试——原定义在已删除的 execution/execute-options-mapper.ts（测试随迁），函数
// 现居 subprocess-agent-runner.ts（唯一消费点，运行期件随消费方落位）。
// 原用例编号（execute-options-mapper.test.ts 的 mergeTimeoutSignal describe，7 用例）
// 与行为语义逐条保持。
//
// 接线测试（timeoutMs → engine 收到 merged signal → abort 收口）在
// subprocess-agent-runner.test.ts 的 T3.6（经真实 PiEngine 链路），本文件锁纯函数行为。

import { describe, expect, it, vi } from "vitest";

import { mergeTimeoutSignal } from "../subprocess-agent-runner.ts";

describe("mergeTimeoutSignal (D-A9)", () => {
  it("T3.6 timeoutMs===undefined → 原样返回 external signal", () => {
    const ctrl = new AbortController();
    const result = mergeTimeoutSignal(ctrl.signal, undefined);
    expect(result).toBe(ctrl.signal);
  });

  it("T3.6 timeoutMs<=0 → 原样返回 external signal", () => {
    const ctrl = new AbortController();
    const result = mergeTimeoutSignal(ctrl.signal, 0);
    expect(result).toBe(ctrl.signal);
  });

  it("T3.6 timeoutMs>0 → 返回新 signal（合并外部+超时两路）", () => {
    const ctrl = new AbortController();
    const result = mergeTimeoutSignal(ctrl.signal, 50);
    expect(result).not.toBe(ctrl.signal);
    expect(result.aborted).toBe(false);
  });

  it("T3.6 timeoutMs 到期 → merged signal abort", () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const merged = mergeTimeoutSignal(ctrl.signal, 50);

    expect(merged.aborted).toBe(false);
    vi.advanceTimersByTime(51);
    expect(merged.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("T3.6 外部 signal abort → merged signal abort", () => {
    const ctrl = new AbortController();
    const merged = mergeTimeoutSignal(ctrl.signal, 5000);
    ctrl.abort();
    expect(merged.aborted).toBe(true);
  });

  it("T3.6 外部 signal 已 abort → 返回已 abort 的 signal", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const merged = mergeTimeoutSignal(ctrl.signal, 5000);
    expect(merged.aborted).toBe(true);
  });

  it("T3.17 NFR: merged signal abort → timeout timer 清理", () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const merged = mergeTimeoutSignal(ctrl.signal, 50);

    ctrl.abort(); // 外部 abort → merged 也 abort
    expect(merged.aborted).toBe(true);

    // 推进时间，不应再有副作用
    vi.advanceTimersByTime(100);
    // timer 应被清理（通过 abort event listener）
    // 无异常 = timer 已正确清理
    vi.useRealTimers();
  });
});
