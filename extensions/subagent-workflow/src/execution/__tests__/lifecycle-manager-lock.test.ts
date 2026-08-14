// acquireActivateLock 30s 超时兜底单测 —— v4-lifecycle-convergence.md §3.3 A-2。
//
// 验证：前序 holder 持锁不 release（崩溃/死锁模拟）时，waiter
//   - 等待 29999ms 仍 pending（未误伤正常排队）
//   - 到 30001ms 抛含恢复指引的超时错误（'activation timed out' + 'retry action: message'）
//
// 测试策略：纯 Promise 链 + setTimeout 超时，用 vi.useFakeTimers() 控时，
// advanceTimersByTimeAsync 同时推进 fake timer 与 microtask flush。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetLifecycleState,
  acquireActivateLock,
} from "../lifecycle-manager.ts";

describe("acquireActivateLock 30s 超时兜底 (v4 A-2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetLifecycleState();
  });

  afterEach(() => {
    _resetLifecycleState();
    vi.useRealTimers();
  });

  it("waiter 等待 29999ms 仍 pending；到 30001ms 抛含恢复指引的超时错误", async () => {
    // 第一个 holder 持锁后不 release（模拟崩溃/死锁）
    await acquireActivateLock("sa-stuck");

    // 第二个 waiter 必然排队（前序未 release）
    let errMsg: string | null = null;
    let gotRelease: (() => void) | null = null;
    const waiter = acquireActivateLock("sa-stuck")
      .then((release) => {
        gotRelease = release;
      })
      .catch((err: unknown) => {
        errMsg = err instanceof Error ? err.message : String(err);
      });

    // flush microtask：waiter 进入 prev.then 等待链
    await vi.advanceTimersByTimeAsync(0);
    expect(gotRelease).toBe(null); // 尚未拿到锁
    expect(errMsg).toBe(null);

    // 29999ms：未满 30s，waiter 仍 pending
    await vi.advanceTimersByTimeAsync(29999);
    expect(gotRelease).toBe(null);
    expect(errMsg).toBe(null);

    // 再推进 2ms（累计 30001ms）：超时 timer 触发 → reject
    await vi.advanceTimersByTimeAsync(2);
    await waiter;

    // 超时：未拿到锁，抛含恢复指引的错误
    expect(gotRelease).toBe(null);
    expect(errMsg).not.toBe(null);
    expect(errMsg).toContain("activation timed out");
    expect(errMsg).toContain("retry action: message");
    expect(errMsg).toContain("sa-stuck");
  });

  it("首次 acquire（无前序 holder）立即返回 release，不触发超时", async () => {
    // 首次 acquire：prev=Promise.resolve()，立即 resolve，timer 被 clearTimeout 取消
    const release = await acquireActivateLock("sa-fresh");
    expect(typeof release).toBe("function");

    // 推进远超 30s，不应有任何未捕获的超时 reject（timer 已清除）
    await vi.advanceTimersByTimeAsync(60000);
    release();
  });
});
