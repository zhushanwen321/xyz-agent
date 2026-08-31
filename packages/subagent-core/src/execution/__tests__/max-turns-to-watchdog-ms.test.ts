// src/execution/__tests__/max-turns-to-watchdog-ms.test.ts
//
// U3（subagent-core-sink-design）：computeWatchdogMs 语义化更名 maxTurnsToWatchdogMs
// + floor 语义文档化。本文件锚定换算纯函数语义：
//   - floor 断言（设计 §4 S2）：maxTurnsToWatchdogMs(2) >= 1_800_000——zsw 曾自实现
//     无 floor 版本致 maxTurns=2 被 10min 误杀（设计 §2.1 例 1），floor 是两宿主
//     预算一致性的锚点（G1）。
//   - 边界：0.5 轮 / 缺省（不挂 watchdog）/ 极大值。
//
// 纯函数换算，无 timer 参与，无需 fake timers。
import { describe, expect, it, vi } from "vitest";

import {
  maxTurnsToWatchdogMs,
  resolveSpawnWatchdogMs,
  SPAWN_WATCHDOG_ENV,
} from "../session-runner.ts";

const MIN_MS = 60_000;
/** watchdog floor（session-runner WATCHDOG_FLOOR_MINUTES=30 的毫秒值）。 */
const FLOOR_MS = 30 * MIN_MS;
/** Node setTimeout delay 安全域上界（>2^31-1 被置 1ms 立即触发，assertSafeTimerDelay 拦截域）。 */
const TIMER_SAFE_MAX = 2 ** 31 - 1;

describe("maxTurnsToWatchdogMs（U3 watchdog 换算，floor 语义）", () => {
  it("floor 断言（S2）：maxTurns=2 → >= 1_800_000（floor 生效，非 2×5=10min）", () => {
    expect(maxTurnsToWatchdogMs(2)).toBeGreaterThanOrEqual(1_800_000);
    // 精确值锚定：floor 是 max 不是「至少再加余量」
    expect(maxTurnsToWatchdogMs(2)).toBe(FLOOR_MS);
  });

  it("0.5 轮（小数）→ floor 30min（不出现 2.5min 的短 watchdog）", () => {
    expect(maxTurnsToWatchdogMs(0.5)).toBe(FLOOR_MS);
  });

  it("maxTurns=6 → 恰为 floor 临界（max(30min, 30min)）", () => {
    expect(maxTurnsToWatchdogMs(6)).toBe(FLOOR_MS);
  });

  it("线性段：maxTurns=20 → 100min；maxTurns=100 → 500min（M-1 长任务不被 30min 误杀）", () => {
    expect(maxTurnsToWatchdogMs(20)).toBe(100 * MIN_MS);
    expect(maxTurnsToWatchdogMs(100)).toBe(500 * MIN_MS);
  });

  it("极大值 → 保持纯算术结果（> 2^31-1 溢出域；挂载前由 assertSafeTimerDelay fail-fast 拦截）", () => {
    expect(maxTurnsToWatchdogMs(Number.MAX_SAFE_INTEGER)).toBeGreaterThan(TIMER_SAFE_MAX);
    expect(maxTurnsToWatchdogMs(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it("上层防线：换算链路入口对极大值 fail-fast（resolveSpawnWatchdogMs(Infinity) 抛出）", () => {
    expect(() => resolveSpawnWatchdogMs(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("缺省（maxTurns 未传/null 且 env 未设）→ resolveSpawnWatchdogMs 返回 undefined（不挂 watchdog）", () => {
    // 空串与未设同义（getEnvSpawnWatchdogMs 对 falsy raw 返回 undefined）；
    // 显式 stub 防御宿主 shell export 污染（vitest.setup.ts 已在模块加载前净化）。
    vi.stubEnv(SPAWN_WATCHDOG_ENV, "");
    try {
      expect(resolveSpawnWatchdogMs(undefined)).toBeUndefined();
      expect(resolveSpawnWatchdogMs(null)).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
