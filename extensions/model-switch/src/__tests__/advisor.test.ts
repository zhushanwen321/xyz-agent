/**
 * advisor.ts 核心决策函数单元测试
 *
 * 测试 computeQuotaSnapshot / computeStickiness / computePeakRecommend。
 * resolveModelForScene 的测试在 tests/resolveModelForScene.test.ts。
 *
 * 测试框架：vitest
 * 运行命令：npx vitest run src/__tests__/advisor.test.ts
 */

import { describe, expect, it } from "vitest";

import type { CacheData } from "@zhushanwen/pi-quota-providers";

import type { ModelPolicy, QuotaSnapshot } from "../types.js";

// Mock config (not used by the functions under test, but needed for typing)
import { computeQuotaSnapshot, computeStickiness, computePeakRecommend } from "../advisor.js";

// ── Fixtures ───────────────────────────────────────────

const mockConfig: ModelPolicy = {
  version: 2,
  models: {
    zhipu: {
      plan: "zhipu",
      models: { "glm-5.1": { modelId: "glm-5.1", capabilities: ["text"] } },
    },
    "opencode-go": {
      plan: "opencode-go",
      models: { "ds-flash": { modelId: "ds-flash", capabilities: ["text"] } },
    },
  },
  scenes: { coding: ["glm-5.1", "ds-flash"] },
  plans: {
    zhipu: { priority: 1, peak: { start: 14, end: 18, multiplier: 3 } },
    "opencode-go": { priority: 2 },
  },
  stickiness: { minTurns: 3, minInputTokens: 20_000 },
};

// ── computeQuotaSnapshot ──────────────────────────────

describe("computeQuotaSnapshot", () => {
  it("returns empty plans when cache has no matching keys", () => {
    const cache = { updatedAt: Date.now() } as unknown as CacheData;
    const result = computeQuotaSnapshot(cache, mockConfig);
    expect(result.plans).toEqual({});
  });

  it("extracts zhipu-style quota (tokensPct + resetTime)", () => {
    const cache = {
      updatedAt: Date.now(),
      zhipu: { tokensPct: 45, resetTime: "2h30m" },
    } as unknown as CacheData;
    const result = computeQuotaSnapshot(cache, mockConfig);

    expect(result.plans.zhipu).toBeDefined();
    expect(result.plans.zhipu!.pct).toBe(45);
    expect(result.plans.zhipu!.resetSec).toBe(2 * 3600 + 30 * 60);
    expect(result.plans.zhipu!.label).toBe("zhipu");
  });

  it("extracts opencode-go-style quota (rolling.usagePercent + rolling.resetInSec)", () => {
    const cache = {
      updatedAt: Date.now(),
      "opencode-go": { rolling: { usagePercent: 72, resetInSec: 3600 } },
    } as unknown as CacheData;
    const result = computeQuotaSnapshot(cache, mockConfig);

    expect(result.plans["opencode-go"]).toBeDefined();
    expect(result.plans["opencode-go"]!.pct).toBe(72);
    expect(result.plans["opencode-go"]!.resetSec).toBe(3600);
  });

  it("extracts kimi-style quota (rollingWindow.usedPct + ISO resetTime)", () => {
    const configWithKimi: ModelPolicy = {
      ...mockConfig,
      plans: {
        ...mockConfig.plans,
        "kimi-coding": { priority: 3 },
      },
    };
    const futureTime = new Date(Date.now() + 7200_000).toISOString();
    const cache = {
      updatedAt: Date.now(),
      "kimi-coding": { rollingWindow: { usedPct: 30, resetTime: futureTime } },
    } as unknown as CacheData;
    const result = computeQuotaSnapshot(cache, configWithKimi);

    expect(result.plans["kimi-coding"]).toBeDefined();
    expect(result.plans["kimi-coding"]!.pct).toBe(30);
    expect(result.plans["kimi-coding"]!.resetSec).toBeGreaterThan(0);
  });

  it("returns null for unrecognized cache format", () => {
    const cache = {
      updatedAt: Date.now(),
      zhipu: { unknownField: 42 },
    } as unknown as CacheData;
    const result = computeQuotaSnapshot(cache, mockConfig);

    // zhipu key is in plans but cache value doesn't match any pattern
    expect(result.plans.zhipu).toBeUndefined();
  });
});

// ── computeStickiness ──────────────────────────────────

describe("computeStickiness", () => {
  it("returns zero turns for empty entries", () => {
    const result = computeStickiness([]);
    expect(result.turns).toBe(0);
    expect(result.inputTokens).toBe(0);
    expect(result.justCompacted).toBe(false);
  });

  it("counts assistant turns after last model_change", () => {
    const entries = [
      { type: "model_change" },
      { type: "message", message: { role: "assistant", usage: { input: 1000 } } },
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant", usage: { input: 2000 } } },
    ] as Array<{ type: string; [key: string]: unknown }>;

    const result = computeStickiness(entries);

    expect(result.turns).toBe(2);
    expect(result.inputTokens).toBe(3000);
    expect(result.justCompacted).toBe(false);
  });

  it("returns justCompacted=true when <=1 turn after compaction", () => {
    const entries = [
      { type: "compaction" },
      { type: "message", message: { role: "assistant", usage: { input: 500 } } },
    ] as Array<{ type: string; [key: string]: unknown }>;

    const result = computeStickiness(entries);

    expect(result.justCompacted).toBe(true);
    expect(result.turns).toBe(0);
    expect(result.inputTokens).toBe(0);
  });

  it("resets turn count after compaction even with model_change before", () => {
    const entries = [
      { type: "model_change" },
      { type: "message", message: { role: "assistant", usage: { input: 1000 } } },
      { type: "message", message: { role: "assistant", usage: { input: 1000 } } },
      { type: "compaction" },
      // After compaction, only 1 turn → justCompacted
      { type: "message", message: { role: "assistant", usage: { input: 500 } } },
    ] as Array<{ type: string; [key: string]: unknown }>;

    const result = computeStickiness(entries);

    expect(result.justCompacted).toBe(true);
  });

  it("counts turns after compaction when >1 assistant messages", () => {
    const entries = [
      { type: "compaction" },
      { type: "message", message: { role: "assistant", usage: { input: 100 } } },
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant", usage: { input: 200 } } },
      { type: "message", message: { role: "assistant", usage: { input: 300 } } },
    ] as Array<{ type: string; [key: string]: unknown }>;

    const result = computeStickiness(entries);

    // 3 assistant turns after compaction → not justCompacted
    expect(result.justCompacted).toBe(false);
    expect(result.turns).toBe(3);
    expect(result.inputTokens).toBe(600);
  });

  it("ignores non-message entry types", () => {
    const entries = [
      { type: "model_change" },
      { type: "system_event" },
      { type: "message", message: { role: "assistant", usage: { input: 100 } } },
    ] as Array<{ type: string; [key: string]: unknown }>;

    const result = computeStickiness(entries);

    expect(result.turns).toBe(1);
    expect(result.inputTokens).toBe(100);
  });
});

// ── computePeakRecommend ───────────────────────────────

describe("computePeakRecommend", () => {
  it("returns ok when no plan has peak config", () => {
    const noPeakConfig: ModelPolicy = {
      ...mockConfig,
      plans: {
        zhipu: { priority: 1 }, // no peak
        "opencode-go": { priority: 2 },
      },
    };
    const snapshot: QuotaSnapshot = { plans: {} };

    const result = computePeakRecommend(new Date(), noPeakConfig, snapshot);

    expect(result.result).toBe("ok");
    expect(result.reason).toContain("Off-peak");
  });

  it("returns ok when current hour is outside peak window", () => {
    // zhipu peak is 14-18; hour 10 is off-peak
    const now = new Date(2026, 0, 1, 10, 0);
    const snapshot: QuotaSnapshot = {
      plans: {
        zhipu: { pct: 80, resetSec: 3600, label: "zhipu" },
      },
    };

    const result = computePeakRecommend(now, mockConfig, snapshot);

    expect(result.result).toBe("ok");
    expect(result.reason).toContain("Off-peak");
  });

  it("returns avoid when peak + usage > 95% (safety valve)", () => {
    const now = new Date(2026, 0, 1, 15, 0); // in peak (14-18)
    const snapshot: QuotaSnapshot = {
      plans: {
        zhipu: { pct: 96, resetSec: 3600, label: "zhipu" },
      },
    };

    const result = computePeakRecommend(now, mockConfig, snapshot);

    expect(result.result).toBe("avoid");
    expect(result.reason).toContain("near limit");
  });

  it("returns avoid when peak + no quota data", () => {
    const now = new Date(2026, 0, 1, 15, 0);
    const snapshot: QuotaSnapshot = { plans: {} };

    const result = computePeakRecommend(now, mockConfig, snapshot);

    expect(result.result).toBe("avoid");
    expect(result.reason).toContain("no quota data");
  });

  it("returns avoid when peak + window first half overlap + usage > 50%", () => {
    // Set up a scenario where peak overlaps the first half of the rolling window.
    // Window: 5h. resetSec=3600 means 1h remaining → 4h elapsed.
    // windowStart = now - 4h = 11:00, windowMid = 11:00 + 2.5h = 13:30
    // peakStart=14:00, peakEnd=18:00.
    // peakInFirstHalf: peakStart(14:00) < windowMid(13:30)? No, 14:00 > 13:30.
    // So peak is in second half → ok.
    // Let me adjust: resetSec=14400 (4h remaining) → elapsed=1h → windowStart=14:00, windowMid=15:30
    // peakStart=14:00, peakEnd=18:00. peakInFirstHalf: 14:00 < 15:30 && 18:00 > 14:00 → true
    const now = new Date(2026, 0, 1, 15, 0);
    const snapshot: QuotaSnapshot = {
      plans: {
        zhipu: { pct: 60, resetSec: 14400, label: "zhipu" },
      },
    };

    const result = computePeakRecommend(now, mockConfig, snapshot);

    expect(result.result).toBe("avoid");
    expect(result.reason).toContain("peak overlaps early window");
  });

  it("returns ok when peak + window second half overlap", () => {
    // resetSec=3600 (1h remaining) → elapsed=4h → windowStart=11:00, windowMid=13:30
    // peakStart=14:00. peakInFirstHalf: 14:00 < 13:30? No → peakInFirstHalf=false → ok
    const now = new Date(2026, 0, 1, 15, 0);
    const snapshot: QuotaSnapshot = {
      plans: {
        zhipu: { pct: 80, resetSec: 3600, label: "zhipu" },
      },
    };

    const result = computePeakRecommend(now, mockConfig, snapshot);

    expect(result.result).toBe("ok");
    expect(result.reason).toContain("peak overlaps late window");
  });

  it("returns ok when peak + first half overlap + usage <= 50%", () => {
    const now = new Date(2026, 0, 1, 15, 0);
    const snapshot: QuotaSnapshot = {
      plans: {
        zhipu: { pct: 30, resetSec: 14400, label: "zhipu" },
      },
    };

    const result = computePeakRecommend(now, mockConfig, snapshot);

    expect(result.result).toBe("ok");
    expect(result.reason).toContain("within budget");
  });

  it("handles peak + null pct (conservative avoid)", () => {
    const now = new Date(2026, 0, 1, 15, 0);
    const snapshot: QuotaSnapshot = {
      plans: {
        zhipu: { pct: null, resetSec: null, label: "zhipu" },
      },
    };

    const result = computePeakRecommend(now, mockConfig, snapshot);

    expect(result.result).toBe("avoid");
  });
});
