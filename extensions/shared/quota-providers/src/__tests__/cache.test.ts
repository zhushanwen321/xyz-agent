/**
 * cache.ts 单元测试
 *
 * 测试框架：vitest
 * 运行命令：npx vitest run src/__tests__/cache.test.ts
 *
 * 注意：cache.ts 有模块级可变状态（updating / lastUpdateAt），
 * triggerUpdate 测试用 vi.resetModules() + 动态 import 来隔离状态。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────

const {
  mockReadFileSync,
  mockWriteFileSync,
  mockRenameSync,
  mockMkdirSync,
  mockExistsSync,
  mockUnlinkSync,
  mockBuildRuntimeProviders,
  mockAvgSpeed,
} = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockBuildRuntimeProviders: vi.fn(),
  mockAvgSpeed: vi.fn().mockReturnValue(0),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
  renameSync: mockRenameSync,
  unlinkSync: mockUnlinkSync,
  writeFileSync: mockWriteFileSync,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/agent",
}));

vi.mock("../paths.js", () => ({
  getCachePath: () => "/tmp/test-cache.json",
  getSpeedDir: () => "/tmp/agent/token-stats",
}));

vi.mock("../registry.js", () => ({
  buildRuntimeProviders: mockBuildRuntimeProviders,
}));

vi.mock("../speed.js", () => ({
  avgSpeed: mockAvgSpeed,
}));

vi.mock("../time.js", () => ({
  MS_PER_SEC: 1000,
  SEC_PER_MIN: 60,
  MIN_PER_HOUR: 60,
  SEC_PER_DAY: 86400,
}));

// Static import for tests that do not need module isolation
import {
  readCache,
  trackSpeed,
  trackCacheRatio,
} from "../cache.js";

// ── Tests ──────────────────────────────────────────────

/** 旧路径常量（getAgentDir mock 为 /tmp/agent）。 */
const LEGACY_CACHE_PATH = "/tmp/agent/statusline_cache.json";
const NEW_CACHE_PATH = "/tmp/test-cache.json";

describe("legacy cache migration", () => {
  // 迁移用模块级 cacheMigrated 标志，需 resetModules + 动态 import 隔离
  async function importFresh() {
    vi.resetModules();
    return import("../cache.js");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // 迁移测试设置 fs mock 实现（existsSync 按路径判定等），
  // 防止实现泄漏到后续 describe（clearAllMocks 不清实现，只清调用记录）
  afterEach(() => {
    mockExistsSync.mockReset();
    mockMkdirSync.mockReset();
    mockRenameSync.mockReset();
    mockUnlinkSync.mockReset();
    mockReadFileSync.mockReset();
    vi.restoreAllMocks();
  });

  it("moves legacy cache file to config/quota-cache.json on first load", async () => {
    mockExistsSync.mockImplementation((p: unknown) => p === LEGACY_CACHE_PATH);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { readCache } = await importFresh();
    readCache();

    expect(mockRenameSync).toHaveBeenCalledWith(LEGACY_CACHE_PATH, NEW_CACHE_PATH);
    // 写前确保新路径所在目录存在（mock 的 getCachePath 是平铺 /tmp/test-cache.json → dirname=/tmp）
    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true });
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("does not overwrite new cache when both exist, removes legacy file", async () => {
    mockExistsSync.mockImplementation(
      (p: unknown) => p === LEGACY_CACHE_PATH || p === NEW_CACHE_PATH,
    );
    mockReadFileSync.mockReturnValue(JSON.stringify({ updatedAt: Date.now() }));

    const { readCache } = await importFresh();
    readCache();

    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).toHaveBeenCalledWith(LEGACY_CACHE_PATH);
  });

  it("is a noop when legacy cache file does not exist", async () => {
    mockExistsSync.mockImplementation(() => false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { readCache } = await importFresh();
    readCache();

    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it("migrates only once per process", async () => {
    mockExistsSync.mockImplementation(
      (p: unknown) => p === LEGACY_CACHE_PATH || p === NEW_CACHE_PATH,
    );
    mockReadFileSync.mockReturnValue(JSON.stringify({ updatedAt: Date.now() }));

    const { readCache } = await importFresh();
    readCache();
    // 第二次读不再触碰旧文件（标志已置位）
    readCache();

    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy file and continues when migration fails", async () => {
    mockExistsSync.mockImplementation((p: unknown) => p === LEGACY_CACHE_PATH);
    mockMkdirSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { readCache } = await importFresh();
    expect(() => readCache()).not.toThrow();
    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });
});

describe("readCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty cache when file does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockBuildRuntimeProviders.mockReturnValue([]);

    const result = readCache();

    expect(result.updatedAt).toBe(0);
  });

  it("returns parsed cache from disk", () => {
    const cached = { updatedAt: Date.now(), zhipu: { tokensPct: 30 } };
    mockReadFileSync.mockReturnValue(JSON.stringify(cached));

    const result = readCache();

    expect(result.zhipu).toEqual({ tokensPct: 30 });
  });

  it("returns stale data when cache is expired (update is fire-and-forget)", () => {
    vi.advanceTimersByTime(180_000);
    // Use a non-zero updatedAt so readCacheSync doesn't replace it with Date.now()
    const cached = { updatedAt: 1, zhipu: { tokensPct: 42 } };
    mockReadFileSync.mockReturnValue(JSON.stringify(cached));
    mockBuildRuntimeProviders.mockReturnValue([]);
    mockMkdirSync.mockImplementation(() => undefined);
    mockWriteFileSync.mockImplementation(() => undefined);
    mockRenameSync.mockImplementation(() => undefined);

    const result = readCache();

    // readCache returns the stale data immediately (update is fire-and-forget)
    expect(result.zhipu).toEqual({ tokensPct: 42 });
    expect(result.updatedAt).toBe(1);
  });

  it("does not trigger update when cache is fresh", () => {
    const freshTime = Date.now() - 30_000;
    const cached = { updatedAt: freshTime };
    mockReadFileSync.mockReturnValue(JSON.stringify(cached));

    readCache();

    expect(mockBuildRuntimeProviders).not.toHaveBeenCalled();
  });
});

describe("triggerUpdate", () => {
  // triggerUpdate depends on module-level `updating` / `lastUpdateAt`,
  // so each test gets a fresh module via resetModules + dynamic import.
  async function importFresh() {
    vi.resetModules();
    return import("../cache.js");
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockMkdirSync.mockImplementation(() => undefined);
    mockWriteFileSync.mockImplementation(() => undefined);
    mockRenameSync.mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches from all providers and writes cache atomically", async () => {
    const provider1 = { id: "zhipu", fetch: vi.fn().mockResolvedValue({ tokensPct: 50 }) };
    const provider2 = { id: "opencode", fetch: vi.fn().mockResolvedValue({ usage: 30 }) };
    mockBuildRuntimeProviders.mockReturnValue([provider1, provider2]);
    mockReadFileSync.mockReturnValue(JSON.stringify({ updatedAt: 0 }));

    const { triggerUpdate } = await importFresh();
    triggerUpdate();
    await vi.advanceTimersByTimeAsync(0);

    expect(provider1.fetch).toHaveBeenCalled();
    expect(provider2.fetch).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
      expect.any(String),
      "utf-8",
    );
    expect(mockRenameSync).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
      "/tmp/test-cache.json",
    );
  });

  it("preserves old data when provider fetch fails", async () => {
    const provider = {
      id: "zhipu",
      fetch: vi.fn().mockRejectedValue(new Error("network error")),
    };
    mockBuildRuntimeProviders.mockReturnValue([provider]);
    const oldCache = { updatedAt: 100, zhipu: { tokensPct: 20 } };
    mockReadFileSync.mockReturnValue(JSON.stringify(oldCache));

    const { triggerUpdate } = await importFresh();
    triggerUpdate();
    await vi.advanceTimersByTimeAsync(0);

    const writtenArg = mockWriteFileSync.mock.calls.find(
      (c: unknown[]) => typeof c[1] === "string" && (c[1] as string).includes("updatedAt"),
    );
    expect(writtenArg).toBeDefined();
    const written = JSON.parse(writtenArg![1] as string);
    expect(written.zhipu).toEqual({ tokensPct: 20 });
  });

  it("does not start concurrent updates", async () => {
    const provider = { id: "p", fetch: vi.fn().mockResolvedValue(null) };
    mockBuildRuntimeProviders.mockReturnValue([provider]);
    mockReadFileSync.mockReturnValue(JSON.stringify({ updatedAt: 0 }));

    const { triggerUpdate } = await importFresh();
    triggerUpdate();
    triggerUpdate(); // Second call should be no-op (updating flag)

    await vi.advanceTimersByTimeAsync(0);

    expect(mockBuildRuntimeProviders).toHaveBeenCalledTimes(1);
  });

  it("handles disk write failure gracefully", async () => {
    const provider = { id: "p", fetch: vi.fn().mockResolvedValue({ data: 1 }) };
    mockBuildRuntimeProviders.mockReturnValue([provider]);
    mockReadFileSync.mockReturnValue(JSON.stringify({ updatedAt: 0 }));
    mockWriteFileSync.mockImplementation(() => {
      throw new Error("ENOSPC");
    });

    const { triggerUpdate } = await importFresh();

    // Should not throw
    triggerUpdate();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it("skips update if called within TTL of last update", async () => {
    mockBuildRuntimeProviders.mockReturnValue([]);
    mockReadFileSync.mockReturnValue(JSON.stringify({ updatedAt: 0 }));

    const { triggerUpdate } = await importFresh();
    triggerUpdate();
    await vi.advanceTimersByTimeAsync(0);

    mockBuildRuntimeProviders.mockClear();

    // Call again within TTL — should be skipped
    triggerUpdate();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockBuildRuntimeProviders).not.toHaveBeenCalled();
  });
});

describe("trackSpeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockAvgSpeed.mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns early (no file write) when model is empty", () => {
    const result = trackSpeed(1000, 1000, "");
    expect(result.current).toBe(1000);
    expect(result.day).toBe(0);
    expect(result.d7).toBe(0);
    expect(result.d30).toBe(0);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("returns zero speeds when current speed is zero", () => {
    const result = trackSpeed(0, 1000, "test-model");
    expect(result.current).toBe(0);
  });

  it("calculates current speed as tokens per second", () => {
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockImplementation(() => undefined);
    mockWriteFileSync.mockImplementation(() => undefined);

    const result = trackSpeed(2000, 1000, "test-model");

    expect(result.current).toBe(2000);
  });

  it("sanitizes model name for file path", () => {
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockImplementation(() => undefined);
    mockWriteFileSync.mockImplementation(() => undefined);

    trackSpeed(1000, 1000, "provider/model:v2");

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("provider_model_v2.json"),
      expect.any(String),
    );
  });

  it("returns zero current when duration is zero", () => {
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockImplementation(() => undefined);
    mockWriteFileSync.mockImplementation(() => undefined);

    const result = trackSpeed(1000, 0, "model");
    expect(result.current).toBe(0);
  });
});

describe("trackCacheRatio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null values when promptTotal is zero", () => {
    const result = trackCacheRatio({ input: 0, cacheRead: 0, cacheWrite: 0 }, "model");
    expect(result).toEqual({ current: null, day: null });
  });

  it("calculates current ratio as percentage", () => {
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockImplementation(() => undefined);
    mockWriteFileSync.mockImplementation(() => undefined);

    const result = trackCacheRatio(
      { input: 100, cacheRead: 50, cacheWrite: 50 },
      "model",
    );

    expect(result.current).toBe(25);
  });

  it("returns null day when model is empty", () => {
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockImplementation(() => undefined);
    mockWriteFileSync.mockImplementation(() => undefined);

    const result = trackCacheRatio(
      { input: 100, cacheRead: 50, cacheWrite: 0 },
      "",
    );

    expect(result.current).toBe(33);
    expect(result.day).toBeNull();
  });
});
