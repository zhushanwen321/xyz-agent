/**
 * vision-model.ts 单元测试
 *
 * 测试框架：vitest
 * 运行命令：npx vitest run src/__tests__/vision-model.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────

const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
}));

// Import AFTER mocks
import {
  createVisionModelApi,
  VISION_MODELS_PATH,
  VISION_ALLOWED_TOOLS,
  VISION_SYSTEM_PROMPT,
  FORK_PREAMBLE,
} from "../vision-model.js";

// ── Tests ──────────────────────────────────────────────

describe("constants", () => {
  it("VISION_ALLOWED_TOOLS is a non-empty string", () => {
    expect(VISION_ALLOWED_TOOLS).toBeTruthy();
    expect(VISION_ALLOWED_TOOLS).toContain("read");
  });

  it("VISION_SYSTEM_PROMPT contains analysis instructions", () => {
    expect(VISION_SYSTEM_PROMPT).toContain("image analysis");
  });

  it("FORK_PREAMBLE contains fork context instructions", () => {
    expect(FORK_PREAMBLE).toContain("fork");
  });
});

describe("createVisionModelApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when config file does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const api = createVisionModelApi();
    const result = api.loadVisionModels();

    expect(result).toBeNull();
  });

  it("returns null when config file contains invalid JSON", () => {
    mockReadFileSync.mockReturnValue("not valid json {{{");

    const api = createVisionModelApi();
    const result = api.loadVisionModels();

    expect(result).toBeNull();
  });

  it("returns parsed config when file is valid", () => {
    const config = {
      models: [
        { id: "glm-5.1", provider: "zhipu", order: 1 },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    const api = createVisionModelApi();
    const result = api.loadVisionModels();

    expect(result).toEqual(config);
    expect(mockReadFileSync).toHaveBeenCalledWith(VISION_MODELS_PATH, "utf-8");
  });

  it("warns when model entry has no provider", () => {
    const config = {
      models: [
        { id: "test-model", order: 1 },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const api = createVisionModelApi();
    api.loadVisionModels();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no provider"),
    );
    warnSpy.mockRestore();
  });

  it("caches config within TTL (60 seconds)", () => {
    const config = { models: [{ id: "m", provider: "p", order: 1 }] };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    const api = createVisionModelApi();
    api.loadVisionModels();
    api.loadVisionModels();

    // readFileSync should only be called once due to caching
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("re-reads config after TTL expires", () => {
    const config = { models: [{ id: "m", provider: "p", order: 1 }] };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    const api = createVisionModelApi();
    api.loadVisionModels();

    // Advance time past the 60s TTL
    vi.advanceTimersByTime(61_000);

    api.loadVisionModels();

    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it("different instances have independent caches", () => {
    const config1 = { models: [{ id: "m1", provider: "p1", order: 1 }] };
    const config2 = { models: [{ id: "m2", provider: "p2", order: 1 }] };

    mockReadFileSync.mockReturnValueOnce(JSON.stringify(config1));
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(config2));

    const api1 = createVisionModelApi();
    const api2 = createVisionModelApi();

    expect(api1.loadVisionModels()).toEqual(config1);
    expect(api2.loadVisionModels()).toEqual(config2);
  });
});

describe("resolveVisionModelsSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty array when config is null", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const api = createVisionModelApi();
    expect(api.resolveVisionModelsSync()).toEqual([]);
  });

  it("returns empty array when models array is empty", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ models: [] }));

    const api = createVisionModelApi();
    expect(api.resolveVisionModelsSync()).toEqual([]);
  });

  it("sorts by order field ascending", () => {
    const config = {
      models: [
        { id: "b", provider: "p", order: 2 },
        { id: "a", provider: "p", order: 1 },
        { id: "c", provider: "p", order: 3 },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    const api = createVisionModelApi();
    const result = api.resolveVisionModelsSync();

    expect(result.map((r) => r.ref)).toEqual(["p/a", "p/b", "p/c"]);
  });

  it("filters out entries without provider", () => {
    const config = {
      models: [
        { id: "valid", provider: "p", order: 1 },
        { id: "noprovider", order: 2 },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const api = createVisionModelApi();
    const result = api.resolveVisionModelsSync();

    expect(result).toHaveLength(1);
    expect(result[0]!.ref).toBe("p/valid");
  });

  it("formats ref as provider/id", () => {
    const config = {
      models: [
        { id: "glm-5.1", provider: "zhipu", order: 1 },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    const api = createVisionModelApi();
    const result = api.resolveVisionModelsSync();

    expect(result[0]!.ref).toBe("zhipu/glm-5.1");
  });

  it("preserves thinkingLevel from config", () => {
    const config = {
      models: [
        { id: "m", provider: "p", order: 1, thinkingLevel: "max" },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    const api = createVisionModelApi();
    const result = api.resolveVisionModelsSync();

    expect(result[0]!.thinkingLevel).toBe("max");
  });

  it("returns undefined thinkingLevel when not set", () => {
    const config = {
      models: [
        { id: "m", provider: "p", order: 1 },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    const api = createVisionModelApi();
    const result = api.resolveVisionModelsSync();

    expect(result[0]!.thinkingLevel).toBeUndefined();
  });

  it("handles fallback chain order correctly", () => {
    // The fallback chain is determined by order field
    const config = {
      models: [
        { id: "fallback2", provider: "p2", order: 3 },
        { id: "primary", provider: "p1", order: 1 },
        { id: "fallback1", provider: "p2", order: 2 },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    const api = createVisionModelApi();
    const result = api.resolveVisionModelsSync();

    expect(result.map((r) => r.ref)).toEqual([
      "p1/primary",
      "p2/fallback1",
      "p2/fallback2",
    ]);
  });
});

// ── VISION_MODELS_PATH 推导（TC1 + TC4）──────────────────────────────
// vision-model.ts 改用 getAgentDir() 后，VISION_MODELS_PATH 是模块顶层常量
// （加载时求值）。不 vi.mock getAgentDir（mock 工厂跨 resetModules 持久，
// 与验证真实 env 读取冲突），改用 stubEnv + resetModules + dynamic import
// 让模块在隔离 env 下重新求值。
describe("VISION_MODELS_PATH derivation (getAgentDir)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("TC1: derives config/vision-ext-config.json from PI_CODING_AGENT_DIR", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/home/test/.pi/agent");
    const mod = await import("../vision-model.js");
    expect(mod.VISION_MODELS_PATH).toBe(
      "/home/test/.pi/agent/config/vision-ext-config.json",
    );
  });

  it("TC4: isolates to custom PI_CODING_AGENT_DIR", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/test-agent-dir");
    const mod = await import("../vision-model.js");
    expect(mod.VISION_MODELS_PATH.startsWith("/tmp/test-agent-dir")).toBe(true);
  });
});
