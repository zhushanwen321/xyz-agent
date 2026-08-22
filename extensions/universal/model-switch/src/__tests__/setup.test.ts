/**
 * setup.ts 单元测试
 *
 * 测试 generatePolicyConfig 的核心逻辑：
 * 空模型列表、provider 分组、PLAN_PRIORITY 排序、场景推断、文件操作。
 *
 * 测试框架：vitest
 * 运行命令：npx vitest run src/__tests__/setup.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────

const { mockExistsSync, mockReadFileSync, mockUnlinkSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  unlinkSync: mockUnlinkSync,
}));

// Import AFTER mocks
import {
  generatePolicyConfig,
  deletePolicyConfig,
  readPolicyConfigContent,
  readEnabledModels,
} from "../setup.js";

// ── Helpers ────────────────────────────────────────────

function makeRegistry(models: Array<{
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: readonly string[];
}>) {
  return {
    getAvailable: () => models,
  };
}

// ── generatePolicyConfig ───────────────────────────────

describe("generatePolicyConfig", () => {
  it("returns valid JSON and summary for empty model list", () => {
    const registry = makeRegistry([]);
    const result = generatePolicyConfig(registry);

    const config = JSON.parse(result.json);
    expect(config.version).toBe(2);
    expect(config.models).toEqual({});
    // coding and chat scenes are always present (even when empty)
    expect(config.scenes.coding).toEqual([]);
    expect(config.scenes.chat).toEqual([]);
    expect(config.plans).toEqual({});
    expect(result.summary).toContain("Model Policy");
  });

  it("groups models by provider", () => {
    const registry = makeRegistry([
      { provider: "zhipu-coding-plan", id: "glm-5.1", name: "GLM 5.1" },
      { provider: "zhipu-coding-plan", id: "glm-turbo", name: "GLM Turbo" },
      { provider: "opencode-go", id: "ds-flash", name: "DS Flash" },
    ]);

    const result = generatePolicyConfig(registry);
    const config = JSON.parse(result.json);

    // zhipu-coding-plan → providerKey "zhipu-coding-plan"
    expect(config.models["zhipu-coding-plan"]).toBeDefined();
    expect(config.models["zhipu-coding-plan"].plan).toBe("zhipu");
    expect(Object.keys(config.models["zhipu-coding-plan"].models)).toHaveLength(2);

    expect(config.models["opencode-go"]).toBeDefined();
    expect(config.models["opencode-go"].plan).toBe("opencode-go");
  });

  it("filters by enabledModels when provided", () => {
    const registry = makeRegistry([
      { provider: "zhipu-coding-plan", id: "glm-5.1" },
      { provider: "opencode-go", id: "ds-flash" },
    ]);

    const result = generatePolicyConfig(registry, ["zhipu-coding-plan/glm-5.1"]);
    const config = JSON.parse(result.json);

    expect(config.models["zhipu-coding-plan"]).toBeDefined();
    expect(config.models["opencode-go"]).toBeUndefined();
  });

  it("assigns PLAN_PRIORITY to plans", () => {
    const registry = makeRegistry([
      { provider: "zhipu-coding-plan", id: "glm-5.1" },
      { provider: "opencode-go", id: "ds-flash" },
      { provider: "kimi-coding-plan", id: "kimi-latest" },
      { provider: "minimax-token-plan", id: "m3" },
    ]);

    const result = generatePolicyConfig(registry);
    const config = JSON.parse(result.json);

    expect(config.plans.zhipu.priority).toBe(1);
    expect(config.plans["opencode-go"].priority).toBe(2);
    expect(config.plans["kimi-coding"].priority).toBe(3);
    expect(config.plans.minimax.priority).toBe(4);
  });

  it("adds peak config for zhipu plan", () => {
    const registry = makeRegistry([
      { provider: "zhipu-coding-plan", id: "glm-5.1" },
    ]);

    const result = generatePolicyConfig(registry);
    const config = JSON.parse(result.json);

    expect(config.plans.zhipu.peak).toEqual({ start: 14, end: 18, multiplier: 3 });
  });

  it("does not add peak config for non-zhipu plans", () => {
    const registry = makeRegistry([
      { provider: "opencode-go", id: "ds-flash" },
    ]);

    const result = generatePolicyConfig(registry);
    const config = JSON.parse(result.json);

    expect(config.plans["opencode-go"].peak).toBeUndefined();
  });

  it("infers vision scene for models with image input", () => {
    const registry = makeRegistry([
      { provider: "zhipu-coding-plan", id: "glm-5.1", input: ["text", "image"] },
      { provider: "opencode-go", id: "ds-flash", input: ["text"] },
    ]);

    const result = generatePolicyConfig(registry);
    const config = JSON.parse(result.json);

    expect(config.scenes.vision).toBeDefined();
    expect(config.scenes.vision).toContain("glm-5.1");
    expect(config.scenes.vision).not.toContain("ds-flash");
  });

  it("infers planning scene for reasoning models", () => {
    const registry = makeRegistry([
      { provider: "opencode-go", id: "ds-pro", reasoning: true },
    ]);

    const result = generatePolicyConfig(registry);
    const config = JSON.parse(result.json);

    expect(config.scenes.planning).toBeDefined();
    expect(config.scenes.planning).toContain("ds-pro");
  });

  it("always includes coding and chat scenes", () => {
    const registry = makeRegistry([
      { provider: "opencode-go", id: "ds-flash" },
    ]);

    const result = generatePolicyConfig(registry);
    const config = JSON.parse(result.json);

    expect(config.scenes.coding).toBeDefined();
    expect(config.scenes.chat).toBeDefined();
  });

  it("skips unknown providers (not in PROVIDER_TO_PLAN)", () => {
    const registry = makeRegistry([
      { provider: "unknown-provider", id: "model-x" },
    ]);

    const result = generatePolicyConfig(registry);
    const config = JSON.parse(result.json);

    expect(Object.keys(config.models)).toHaveLength(0);
  });

  it("strips -router suffix from provider key", () => {
    const registry = makeRegistry([
      { provider: "zhipu-coding-plan-router", id: "glm-5.1" },
    ]);

    const result = generatePolicyConfig(registry);
    const config = JSON.parse(result.json);

    // Provider key should be "zhipu-coding-plan" (without -router)
    expect(config.models["zhipu-coding-plan"]).toBeDefined();
    expect(config.models["zhipu-coding-plan-router"]).toBeUndefined();
  });

  it("includes stickiness defaults", () => {
    const registry = makeRegistry([]);

    const result = generatePolicyConfig(registry);
    const config = JSON.parse(result.json);

    expect(config.stickiness).toEqual({ minTurns: 3, minInputTokens: 20_000 });
  });

  it("summary contains provider and plan info", () => {
    const registry = makeRegistry([
      { provider: "zhipu-coding-plan", id: "glm-5.1", name: "GLM 5.1" },
    ]);

    const result = generatePolicyConfig(registry);

    expect(result.summary).toContain("zhipu-coding-plan");
    expect(result.summary).toContain("zhipu");
    expect(result.summary).toContain("glm-5.1");
  });

  it("case-insensitive enabledModels matching", () => {
    const registry = makeRegistry([
      { provider: "zhipu-coding-plan", id: "GLM-5.1" },
    ]);

    const result = generatePolicyConfig(registry, ["zhipu-coding-plan/glm-5.1"]);
    const config = JSON.parse(result.json);

    expect(config.models["zhipu-coding-plan"]).toBeDefined();
  });
});

// ── deletePolicyConfig ─────────────────────────────────

describe("deletePolicyConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when config file does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    const result = deletePolicyConfig();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No config file");
  });

  it("deletes file and returns ok when config exists", () => {
    mockExistsSync.mockReturnValue(true);
    mockUnlinkSync.mockImplementation(() => undefined);

    const result = deletePolicyConfig();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBeDefined();
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it("returns error when unlink fails", () => {
    mockExistsSync.mockReturnValue(true);
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("EPERM");
    });

    const result = deletePolicyConfig();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("EPERM");
  });
});

// ── readPolicyConfigContent ────────────────────────────

describe("readPolicyConfigContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when config file does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    const result = readPolicyConfigContent();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No config file");
  });

  it("returns content when config is valid JSON", () => {
    mockExistsSync.mockReturnValue(true);
    const json = JSON.stringify({ version: 2 });
    mockReadFileSync.mockReturnValue(json);

    const result = readPolicyConfigContent();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe(json);
  });

  it("returns error when config is invalid JSON", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not json");

    const result = readPolicyConfigContent();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Failed to read");
  });
});

// ── readEnabledModels ──────────────────────────────────

describe("readEnabledModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined when settings.json does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    const result = readEnabledModels();

    expect(result).toBeUndefined();
  });

  it("returns enabledModels array from settings.json", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      enabledModels: ["provider/model-a", "provider/model-b"],
    }));

    const result = readEnabledModels();

    expect(result).toEqual(["provider/model-a", "provider/model-b"]);
  });

  it("returns undefined when enabledModels is empty", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ enabledModels: [] }));

    const result = readEnabledModels();

    expect(result).toBeUndefined();
  });

  it("returns undefined when settings.json is invalid JSON", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not json");

    const result = readEnabledModels();

    expect(result).toBeUndefined();
  });
});
