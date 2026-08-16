/**
 * skill-discovery — resolveSkillPath 结果缓存（IF8/#14）+ 搜索序测试。
 *
 * 现状该文件此前零测试，本文件为首个测试（design IF8 契约）：
 * - hit 不再 existsSync（计数 wrapper 观察，spyOn ESM namespace 不可配置的既有教训）
 * - 未命中 undefined 也缓存（不存在的名字二次调用零 stat）
 * - clearSkillPathCache 后重扫
 * - project 优先于 user/npm 的搜索序
 *
 * 隔离：node:fs 的 existsSync 用 vi.mock 包一层计数（委托真实实现）；
 * getAgentDir 用 vi.mock 覆盖为临时 home（vitest alias 指向 mocks/pi-coding-agent.ts
 * 的硬编码桩 "/home/user/.pi/agent"，桩不读 os.homedir——mock node:os 无法影响它）；
 * process.cwd 用 spyOn。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { existsSyncCalls, osHome } = vi.hoisted(() => ({
  existsSyncCalls: { count: 0 },
  osHome: { dir: "/nonexistent-home-skill-tests" },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realExistsSync = actual.existsSync;
  // 计数 wrapper（委托真实实现）——vi.spyOn(fs, "existsSync") 在 ESM 模块
  // 命名空间不可配置（record-store-index.test.ts:419 同款教训），改用 mock 工厂。
  const countingExistsSync = ((p: string) => {
    existsSyncCalls.count++;
    return realExistsSync(p);
  }) as typeof actual.existsSync;
  return { ...actual, existsSync: countingExistsSync };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  const { join } = await import("node:path");
  // 桩不读 os.homedir，必须在此把 agentDir 指向 hoisted 临时 home（beforeEach 注入 homeRoot）
  return { ...actual, getAgentDir: () => join(osHome.dir, ".pi", "agent") };
});

import { clearSkillPathCache, resolveSkillPath } from "../skill-discovery.ts";

// ── 临时目录工具 ──────────────────────────────────────────────

let projRoot: string;
let homeRoot: string;

beforeEach(() => {
  clearSkillPathCache();
  existsSyncCalls.count = 0;
  projRoot = mkdtempSync(join(tmpdir(), "skill-proj-"));
  homeRoot = mkdtempSync(join(tmpdir(), "skill-home-"));
  osHome.dir = homeRoot;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projRoot, { recursive: true, force: true });
  rmSync(homeRoot, { recursive: true, force: true });
});

/** mkdir -p（目录存在即 resolveSkillPath 命中——检查的是目录而非 SKILL.md）。 */
function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

describe("resolveSkillPath — 搜索序（project > user > npm）", () => {
  it("project 优先：同名 skill 同时存在于 project/user/npm 时返回 project 路径", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const name = "dup-skill";
    mkdirp(join(projRoot, ".agents/skills", name));
    mkdirp(join(homeRoot, ".pi/agent/skills", name));
    mkdirp(join(homeRoot, ".pi/agent/npm/node_modules/some-pkg/skills", name));

    const resolved = resolveSkillPath(name);

    expect(resolved).toBe(join(projRoot, ".agents/skills", name));
    expect(cwdSpy).toHaveBeenCalled();
  });

  it("user 次之：仅 user/npm 存在时返回 user 路径", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const name = "user-skill";
    mkdirp(join(homeRoot, ".pi/agent/skills", name));
    mkdirp(join(homeRoot, ".pi/agent/npm/node_modules/some-pkg/skills", name));

    expect(resolveSkillPath(name)).toBe(join(homeRoot, ".pi/agent/skills", name));
  });

  it("npm 兜底：仅 npm 包内存在时返回包内 skills 路径", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const name = "npm-skill";
    mkdirp(join(homeRoot, ".pi/agent/npm/node_modules/some-pkg/skills", name));

    expect(resolveSkillPath(name)).toBe(
      join(homeRoot, ".pi/agent/npm/node_modules/some-pkg/skills", name),
    );
  });
});

describe("resolveSkillPath — 结果缓存（IF8/DM3）", () => {
  it("hit 不再 existsSync：二次调用零 stat", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const name = "cache-hit";
    const expected = join(projRoot, ".agents/skills", name);
    mkdirp(expected);

    const first = resolveSkillPath(name);
    const callsAfterFirst = existsSyncCalls.count;
    expect(first).toBe(expected);
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = resolveSkillPath(name);
    expect(second).toBe(expected);
    expect(existsSyncCalls.count).toBe(callsAfterFirst); // 零增量
  });

  it("未命中 undefined 也缓存：不存在的名字二次调用零 stat", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const name = "no-such-skill-xyz";

    const first = resolveSkillPath(name);
    expect(first).toBeUndefined();
    const callsAfterFirst = existsSyncCalls.count;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = resolveSkillPath(name);
    expect(second).toBeUndefined();
    expect(existsSyncCalls.count).toBe(callsAfterFirst); // 零增量（未命中也缓存）
  });

  it("clearSkillPathCache 后重扫：计数恢复增长且结果一致", () => {
    vi.spyOn(process, "cwd").mockReturnValue(projRoot);
    const name = "cache-clear";
    const expected = join(projRoot, ".agents/skills", name);
    mkdirp(expected);

    expect(resolveSkillPath(name)).toBe(expected);
    const callsAfterFirst = existsSyncCalls.count;
    expect(callsAfterFirst).toBeGreaterThan(0);

    clearSkillPathCache();
    expect(resolveSkillPath(name)).toBe(expected);
    expect(existsSyncCalls.count).toBeGreaterThan(callsAfterFirst); // 重扫发生
  });
});
