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
  _getActivateLockTailCountForTest,
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

describe("activateLockTails tail-identity 自清（release 后回收）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetLifecycleState();
  });

  afterEach(() => {
    _resetLifecycleState();
    vi.useRealTimers();
  });

  it("W3TC14: 无 waiter 时 release 后 Map 空 + release 后可再次 acquire", async () => {
    const release = await acquireActivateLock("sa-gc");
    // 自清新增的 test-only 观察点：acquire 后 Map 有 1 条链尾
    expect(_getActivateLockTailCountForTest()).toBe(1);

    release();
    // 自清经 queueMicrotask 异步执行——advanceTimersByTimeAsync(0) flush microtask
    await vi.advanceTimersByTimeAsync(0);
    // 无 waiter：Map 中链尾即本链尾，identity 匹配 → delete 回收
    expect(_getActivateLockTailCountForTest()).toBe(0);

    // release 后可再次 acquire：prev 回落 Promise.resolve()，立即 resolve 返回 release
    const release2 = await acquireActivateLock("sa-gc");
    expect(typeof release2).toBe("function");
    release2();
    await vi.advanceTimersByTimeAsync(0);
    expect(_getActivateLockTailCountForTest()).toBe(0);
  });

  it("W3TC15: 有 waiter 排队不删、最后释放者回收；不同 recordId 链独立", async () => {
    const release1 = await acquireActivateLock("sa-q");

    // 发起 acquire#2 同 recordId（不 await，.then 捕获 release2）
    let release2: (() => void) | null = null;
    const waiter = acquireActivateLock("sa-q").then((r) => {
      release2 = r;
    });
    // #2 进入等待链——此刻 Map 链尾已被 #2 覆盖
    await vi.advanceTimersByTimeAsync(0);

    release1();
    await vi.advanceTimersByTimeAsync(0);
    // ES7 核心：waiter 的链尾仍在——identity 不匹配不删
    expect(_getActivateLockTailCountForTest()).toBe(1);

    // acquire#2 在 release1 后正常 resolve（等待链不被 delete 破坏——waiter 持
    // acquire 时刻捕获的 prev Promise 引用而非 Map 查询）
    await waiter;
    expect(typeof release2).toBe("function");

    // 另一 recordId 独立链：同时持有时各自独立计数
    const releaseA = await acquireActivateLock("sa-a");
    expect(_getActivateLockTailCountForTest()).toBe(2); // sa-q + sa-a

    release2!();
    await vi.advanceTimersByTimeAsync(0);
    // 最后释放者回收：release2 的 identity 匹配 → sa-q 条目回收，sa-a 仍在
    expect(_getActivateLockTailCountForTest()).toBe(1);

    releaseA();
    await vi.advanceTimersByTimeAsync(0);
    expect(_getActivateLockTailCountForTest()).toBe(0);
  });
});
