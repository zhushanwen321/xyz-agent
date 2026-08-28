// lifecycle-manager 单测 —— V2 §5.2 模块 1（进程生命周期管理）五项职责。
//
// 测试策略：
//   - idle timer / ceiling LRU 用 vi.useFakeTimers() + advanceTimersByTime（同时 mock
//     Date.now()，让 lastTouched 时间戳可控）。
//   - activate 互斥锁是纯 Promise 链（无 timer），用 advanceTimersByTimeAsync(0)
//     flush microtask 验证串行化。
//   - 每个用例 beforeEach 调 _resetLifecycleState() 隔离模块级单例状态。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_ALIVE_PROCESSES,
  _resetLifecycleState,
  acquireActivateLock,
  armIdleTimer,
  disarmIdleTimer,
  evictIfOverCeiling,
  getActiveProcessCount,
  hasIdleTimer,
  reapAllAliveProcesses,
  registerActiveProcess,
  scanOrphanProcesses,
  touchActiveProcess,
  unregisterActiveProcess,
} from "../lifecycle-manager.ts";

describe("lifecycle-manager — V2 §5.2 模块 1", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetLifecycleState();
  });

  afterEach(() => {
    _resetLifecycleState();
    vi.useRealTimers();
  });

  // ============================================================
  // 职责 1：idle timer
  // ============================================================
  describe("职责1 idle timer", () => {
    it("arm 后到 timeoutMs 触发 onTimeout（边界：差 1ms 不触发）", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-1", onTimeout, 1000);

      expect(hasIdleTimer("sa-1")).toBe(true);
      vi.advanceTimersByTime(999);
      expect(onTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      // 触发后自动从 Map 移除（不残留失效 entry）
      expect(hasIdleTimer("sa-1")).toBe(false);
    });

    it("disarm 后不再触发 onTimeout", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-1", onTimeout, 1000);
      disarmIdleTimer("sa-1");

      expect(hasIdleTimer("sa-1")).toBe(false);
      vi.advanceTimersByTime(5000);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("disarm 不存在的 record 为 no-op（不抛错）", () => {
      expect(() => disarmIdleTimer("never-armed")).not.toThrow();
    });

    it("重复 arm 刷新 timer：旧 timer 作废、重新计时", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-1", onTimeout, 1000);
      vi.advanceTimersByTime(500); // 过了 500ms

      armIdleTimer("sa-1", onTimeout, 1000); // 刷新：重新计 1000ms
      vi.advanceTimersByTime(999);
      expect(onTimeout).not.toHaveBeenCalled(); // 旧 timer 已作废，新的还没到

      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it("默认超时 = DEFAULT_IDLE_TIMEOUT_MS", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-1", onTimeout); // 不传 timeoutMs

      vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS - 1);
      expect(onTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it("显式禁用值（0/负数）→ 不挂 timer（预算语义对齐：idle GC 可显式关闭；旧实现 0 落成 setTimeout(0) 立即 kill）", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-disable-0", onTimeout, 0);
      expect(hasIdleTimer("sa-disable-0")).toBe(false);
      armIdleTimer("sa-disable-neg", onTimeout, -1);
      expect(hasIdleTimer("sa-disable-neg")).toBe(false);

      vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS * 2);
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it("显式禁用值顺带 disarm 已有 armed timer（禁用不形同虚设）", () => {
      const onTimeout = vi.fn();
      armIdleTimer("sa-disable-late", onTimeout, 1000);
      expect(hasIdleTimer("sa-disable-late")).toBe(true);
      armIdleTimer("sa-disable-late", onTimeout, 0);
      expect(hasIdleTimer("sa-disable-late")).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(onTimeout).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 职责 2：全局 ceiling（LRU 挤出）
  // ============================================================
  describe("职责2 全局 ceiling", () => {
    it("register 超过上限时 evictIfOverCeiling 挤出最久空闲", () => {
      registerActiveProcess("sa-1"); // 最早
      vi.advanceTimersByTime(10);
      registerActiveProcess("sa-2");
      vi.advanceTimersByTime(10);
      registerActiveProcess("sa-3"); // 超限（size=3 > ceiling=2）
      expect(getActiveProcessCount()).toBe(3);

      const evicted: string[] = [];
      evictIfOverCeiling((id) => evicted.push(id), 2);

      expect(evicted).toEqual(["sa-1"]); // lastTouched 最老的被挤出
      expect(getActiveProcessCount()).toBe(2);
    });

    it("不超过上限时 evictIfOverCeiling 不挤出", () => {
      registerActiveProcess("sa-1");
      registerActiveProcess("sa-2");

      const evicted: string[] = [];
      evictIfOverCeiling((id) => evicted.push(id), 5);

      expect(evicted).toEqual([]);
      expect(getActiveProcessCount()).toBe(2);
    });

    it("touch 更新 LRU：被 touch 的不再是挤出候选", () => {
      registerActiveProcess("sa-1");
      vi.advanceTimersByTime(10);
      registerActiveProcess("sa-2");
      vi.advanceTimersByTime(10);
      touchActiveProcess("sa-1"); // sa-1 变最新 → sa-2 变最老

      const evicted: string[] = [];
      evictIfOverCeiling((id) => evicted.push(id), 1);

      expect(evicted).toEqual(["sa-2"]); // sa-2 最久未 touch，被挤出
    });

    it("touch 不存在的 record 为 no-op（不隐式创建）", () => {
      expect(() => touchActiveProcess("never-registered")).not.toThrow();
      expect(getActiveProcessCount()).toBe(0);
    });

    it("unregister 清理活进程集合", () => {
      registerActiveProcess("sa-1");
      registerActiveProcess("sa-2");
      unregisterActiveProcess("sa-1");
      expect(getActiveProcessCount()).toBe(1);
    });

    it("挤出时连带 disarm 被挤 record 的 idle timer", () => {
      registerActiveProcess("sa-1");
      armIdleTimer("sa-1", vi.fn(), 1000);
      registerActiveProcess("sa-2");
      vi.advanceTimersByTime(10);
      registerActiveProcess("sa-3"); // sa-1 最老，将被挤出

      evictIfOverCeiling(() => {
        /* kill */
      }, 2);

      expect(hasIdleTimer("sa-1")).toBe(false); // 挤出 cascade disarm
    });

    it("unregister 连带 disarm idle timer（进程终态 timer 不残留）", () => {
      registerActiveProcess("sa-1");
      armIdleTimer("sa-1", vi.fn(), 1000);
      unregisterActiveProcess("sa-1");
      expect(hasIdleTimer("sa-1")).toBe(false);
    });

    it("默认上限 = DEFAULT_MAX_ALIVE_PROCESSES（不传 maxAlive）", () => {
      for (let i = 0; i < DEFAULT_MAX_ALIVE_PROCESSES; i++) {
        registerActiveProcess(`sa-${i}`);
        vi.advanceTimersByTime(1); // 保证 lastTouched 严格递增
      }
      registerActiveProcess("sa-over"); // 超限
      const evicted: string[] = [];
      evictIfOverCeiling((id) => evicted.push(id)); // 用默认上限

      expect(evicted).toEqual(["sa-0"]); // 默认上限下挤出最早
      expect(getActiveProcessCount()).toBe(DEFAULT_MAX_ALIVE_PROCESSES);
    });

    it("大幅超限时 while 循环挤出多个直到 ≤ ceiling", () => {
      for (let i = 0; i < 5; i++) {
        registerActiveProcess(`sa-${i}`);
        vi.advanceTimersByTime(1);
      }
      const evicted: string[] = [];
      evictIfOverCeiling((id) => evicted.push(id), 2);

      expect(evicted).toEqual(["sa-0", "sa-1", "sa-2"]); // 挤出 3 个（5-2），按 LRU
    });
  });

  // ============================================================
  // 职责 3：shutdown 收割
  // ============================================================
  describe("职责3 shutdown 收割", () => {
    it("reapAllAliveProcesses 遍历活进程调 killFn 并返回列表", () => {
      registerActiveProcess("sa-1");
      registerActiveProcess("sa-2");

      const killed: string[] = [];
      const reaped = reapAllAliveProcesses((id) => killed.push(id));

      expect(killed).toHaveLength(2);
      expect(killed).toEqual(expect.arrayContaining(["sa-1", "sa-2"]));
      expect(reaped).toEqual(expect.arrayContaining(["sa-1", "sa-2"]));
      expect(getActiveProcessCount()).toBe(0);
    });

    it("reap 后 idle timer 已 disarm（advance 不再触发）", () => {
      registerActiveProcess("sa-1");
      const onTimeout = vi.fn();
      armIdleTimer("sa-1", onTimeout, 1000);

      reapAllAliveProcesses(() => {
        /* kill */
      });
      vi.advanceTimersByTime(10000);

      expect(onTimeout).not.toHaveBeenCalled(); // timer 已被 reap 清理
    });

    it("无活进程时 reapAll 返回空列表", () => {
      const reaped = reapAllAliveProcesses(() => {
        /* kill */
      });
      expect(reaped).toEqual([]);
    });
  });

  // ============================================================
  // 职责 4：孤儿扫描
  // ============================================================
  describe("职责4 孤儿扫描", () => {
    it("pid 存活 + 不在活进程集合 = 孤儿", () => {
      registerActiveProcess("sa-active"); // 在集合内
      const records = [
        { id: "sa-active", pid: 100 },
        { id: "sa-orphan", pid: 200 }, // pid 活但不在集合 → 孤儿
        { id: "sa-dead", pid: 300 }, // pid 不活 → 非孤儿
        { id: "sa-nopid" }, // 无 pid → 非孤儿
      ];

      const orphans = scanOrphanProcesses(records, (pid) => pid === 100 || pid === 200);

      expect(orphans).toEqual(["sa-orphan"]);
    });

    it("pid 不存活 = 非孤儿", () => {
      const records = [{ id: "sa-1", pid: 999 }];
      const orphans = scanOrphanProcesses(records, () => false); // 全不活
      expect(orphans).toEqual([]);
    });

    it("在活进程集合内 = 非孤儿（即使 pid 活）", () => {
      registerActiveProcess("sa-1");
      const records = [{ id: "sa-1", pid: 100 }];
      const orphans = scanOrphanProcesses(records, () => true);
      expect(orphans).toEqual([]);
    });

    it("无 pid 的 record 不视为孤儿", () => {
      const records = [
        { id: "sa-1" },
        { id: "sa-2", sessionFile: "/x.jsonl" },
      ];
      const orphans = scanOrphanProcesses(records, () => true);
      expect(orphans).toEqual([]);
    });

    it("扫描是只读（不改活进程集合）", () => {
      registerActiveProcess("sa-1");
      scanOrphanProcesses([{ id: "sa-2", pid: 200 }], () => true);
      expect(getActiveProcessCount()).toBe(1); // 集合不变
    });
  });

  // ============================================================
  // 职责 5：activate 互斥锁
  // ============================================================
  describe("职责5 activate 互斥锁", () => {
    it("首次 acquire 立即 resolve 返回 release 函数", async () => {
      const release = await acquireActivateLock("sa-1");
      expect(typeof release).toBe("function");
      release();
    });

    it("并发 acquire 同一 recordId 串行化：第二次等首次 release", async () => {
      const release1 = await acquireActivateLock("sa-1");

      let secondResolved = false;
      const secondPromise = acquireActivateLock("sa-1").then((r) => {
        secondResolved = true;
        return r;
      });

      await vi.advanceTimersByTimeAsync(0); // flush microtask
      expect(secondResolved).toBe(false); // 还在等首次 release

      release1();
      await vi.advanceTimersByTimeAsync(0); // flush microtask
      expect(secondResolved).toBe(true);

      const release2 = await secondPromise;
      release2();
    });

    it("不同 recordId 不互斥（各自独立链）", async () => {
      const release1 = await acquireActivateLock("sa-1");

      let secondResolved = false;
      acquireActivateLock("sa-2").then((r) => {
        secondResolved = true;
        r();
      });

      await vi.advanceTimersByTimeAsync(0); // flush microtask
      expect(secondResolved).toBe(true); // sa-2 不被 sa-1 阻塞

      release1();
    });

    it("release 后同 recordId 可再次 acquire", async () => {
      const r1 = await acquireActivateLock("sa-1");
      r1();

      const r2 = await acquireActivateLock("sa-1");
      expect(typeof r2).toBe("function");
      r2();
    });
  });
});
