// src/shared/__tests__/resource-discovery-manifest-cache.test.ts
//
// manifestCache 专项测试（swf-perf-impl cleanup IF1/DM1/TC1）。
// readPackageManifestSync / async readPackageManifest 共享同一 Map：
// - 命中：同 mtime 二次调用不重读（readFileSync 计数不增）
// - 失效：package.json 重写（mtime 变）→ 重读
// - 坏 JSON：不缓存（mtime 未变时二次调用仍重新 read）、不驱逐已有好条目
//   （恢复原内容 + utimesSync 恢复原 mtime → 命中原条目，readFileSync 不增）
// - stat 失败（文件删除）→ undefined 且条目驱逐（重建同内容同 mtime → 必重读）
// - 双读者共享：sync 写入的条目被 async 命中（fs/promises readFile 零调用），反之亦然
//
// ESM 下 node:fs 命名空间不可直接 spyOn（resource-discovery.test.ts TC4a 注记），
// 计数走 vi.mock 工厂包装（透传 actual 实现 + vi.fn 计数，行为零变化）。
// mtime 控制用 utimesSync 定值（整数 ms），消除写入浮点 mtime 的精度/flake 面。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 隔离真实用户全局目录（homedir 推导 user-agents 源，同 resource-discovery.test.ts）
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/nonexistent-home-for-tests" };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(
      (...args: Parameters<typeof actual.readFileSync>) => actual.readFileSync(...args),
    ),
    statSync: vi.fn(
      (...args: Parameters<typeof actual.statSync>) => actual.statSync(...args),
    ),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(
      (...args: Parameters<typeof actual.readFile>) => actual.readFile(...args),
    ),
  };
});

import { clearFileCache, discoverResources, readPackageManifestSync } from "../resource-discovery.ts";

// ── helpers ──

function tmpPkgDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "manifest-cache-test-"));
}

function writePackageJson(pkgDir: string, pi: Record<string, unknown> | undefined): string {
  fs.mkdirSync(pkgDir, { recursive: true });
  const filePath = path.join(pkgDir, "package.json");
  fs.writeFileSync(filePath, JSON.stringify({ name: "test-pkg", pi }), "utf-8");
  return filePath;
}

/** 写原始（非 JSON）package.json 内容——坏 JSON 用例。 */
function writeRawPackageJson(pkgDir: string, content: string): string {
  fs.mkdirSync(pkgDir, { recursive: true });
  const filePath = path.join(pkgDir, "package.json");
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/** 定值 mtime（整数 ms，消除浮点 mtime 与 utimesSync 恢复的精度差）。 */
const T1 = new Date("2026-01-01T00:00:00Z");
const T2 = new Date("2026-01-01T00:00:10Z");

function setMtime(filePath: string, t: Date): void {
  fs.utimesSync(filePath, t, t);
}

function readCount(): number {
  return vi.mocked(fs.readFileSync).mock.calls.length;
}

/** node:fs/promises readFile 包装计数（异步读者）。 */
function asyncReadCount(): number {
  return vi.mocked(fsp.readFile).mock.calls.length;
}

// ============================================================
// manifestCache（IF1）
// ============================================================

describe("manifestCache（readPackageManifestSync）", () => {
  let pkgDir: string;
  let pkgJson: string;

  beforeEach(() => {
    clearFileCache();
    vi.mocked(fs.readFileSync).mockClear();
    pkgDir = tmpPkgDir();
  });
  afterEach(() => {
    fs.rmSync(pkgDir, { recursive: true, force: true });
  });

  it("命中：同 mtime 二次调用不重读（readFileSync 只调 1 次）", () => {
    pkgJson = writePackageJson(pkgDir, { agents: ["./a.md"] });
    setMtime(pkgJson, T1);
    const r1 = readPackageManifestSync(pkgDir, "agents");
    expect(r1).toEqual(["./a.md"]);
    expect(readCount()).toBe(1);
    const r2 = readPackageManifestSync(pkgDir, "agents");
    expect(r2).toEqual(["./a.md"]);
    // 命中缓存：statSync 每次（判 mtime）但 readFileSync 不增
    expect(readCount()).toBe(1);
  });

  it("kind 共享一次 parse：同 package.json 的 agents/workflows 两 kind 只读一次", () => {
    pkgJson = writePackageJson(pkgDir, { agents: ["./a.md"], workflows: ["./w.js"] });
    setMtime(pkgJson, T1);
    expect(readPackageManifestSync(pkgDir, "agents")).toEqual(["./a.md"]);
    expect(readPackageManifestSync(pkgDir, "workflows")).toEqual(["./w.js"]);
    expect(readCount()).toBe(1);
  });

  it("失效：package.json 重写（mtime 变）→ 重读新内容", () => {
    pkgJson = writePackageJson(pkgDir, { agents: ["./a.md"] });
    setMtime(pkgJson, T1);
    expect(readPackageManifestSync(pkgDir, "agents")).toEqual(["./a.md"]);
    writePackageJson(pkgDir, { agents: ["./b.md"] });
    // 不需显式设 mtime：新写入的 mtime 必 ≠ 定值 T1
    expect(readPackageManifestSync(pkgDir, "agents")).toEqual(["./b.md"]);
    expect(readCount()).toBe(2);
  });

  it("坏 JSON → undefined 且不缓存：mtime 未变时二次调用仍重新 read（计数递增）", () => {
    // 起点即坏 JSON（无缓存条目）——若坏结果被缓存，二次调用不会重新 readFile。
    // （good→bad 且 mtime 未变的场景由上一用例的命中路径覆盖：mtime 相等直接命中原好条目）
    pkgJson = writeRawPackageJson(pkgDir, "{ broken json");
    setMtime(pkgJson, T1);
    expect(readPackageManifestSync(pkgDir, "agents")).toBeUndefined();
    expect(readCount()).toBe(1);
    expect(readPackageManifestSync(pkgDir, "agents")).toBeUndefined();
    expect(readCount()).toBe(2); // 二次调用仍重新 read = 坏结果未入缓存（毒条目永不入缓存）
  });

  it("坏 JSON 不驱逐已有好条目：恢复原内容 + 恢复原 mtime → 命中原条目（readFileSync 不增）", () => {
    pkgJson = writePackageJson(pkgDir, { agents: ["./a.md"] });
    setMtime(pkgJson, T1);
    expect(readPackageManifestSync(pkgDir, "agents")).toEqual(["./a.md"]);
    expect(readCount()).toBe(1);
    // 改坏且 mtime 变（T2）→ undefined（read 失败路径，不驱逐 {T1, pi} 好条目）
    fs.writeFileSync(pkgJson, "{ broken", "utf-8");
    setMtime(pkgJson, T2);
    expect(readPackageManifestSync(pkgDir, "agents")).toBeUndefined();
    expect(readCount()).toBe(2);
    // 恢复原内容 + utimesSync 恢复原 mtime → 若好条目仍在则命中（不重 read）
    writePackageJson(pkgDir, { agents: ["./a.md"] });
    setMtime(pkgJson, T1);
    expect(readPackageManifestSync(pkgDir, "agents")).toEqual(["./a.md"]);
    expect(readCount()).toBe(2); // 无第 3 次 read = 命中保留的原条目
  });

  it("stat 失败（文件删除）→ undefined 且条目驱逐（重建同内容同 mtime → 必重读）", () => {
    pkgJson = writePackageJson(pkgDir, { agents: ["./a.md"] });
    setMtime(pkgJson, T1);
    expect(readPackageManifestSync(pkgDir, "agents")).toEqual(["./a.md"]);
    expect(readCount()).toBe(1);
    fs.rmSync(pkgJson);
    expect(readPackageManifestSync(pkgDir, "agents")).toBeUndefined();
    expect(readCount()).toBe(1); // stat 失败路径不触发 read
    // 重建同内容 + 恢复同 mtime：条目已被驱逐 → 必重 read（计数 +1）
    writePackageJson(pkgDir, { agents: ["./a.md"] });
    setMtime(pkgJson, T1);
    expect(readPackageManifestSync(pkgDir, "agents")).toEqual(["./a.md"]);
    expect(readCount()).toBe(2);
  });

  it("无 pi 字段（合法解析结果）也缓存：二次调用不重读", () => {
    pkgJson = writePackageJson(pkgDir, undefined);
    setMtime(pkgJson, T1);
    expect(readPackageManifestSync(pkgDir, "agents")).toBeUndefined();
    expect(readCount()).toBe(1);
    expect(readPackageManifestSync(pkgDir, "agents")).toBeUndefined();
    expect(readCount()).toBe(1);
  });

  // [review 修复] 非对象 JSON 结构守卫：JSON.parse 对 "42" / '"str"' / "null" 等
  // 合法 JSON 产出非对象值，旧 `as Record<string, unknown>` 盲断言下 .pi 访问
  // 「碰巧不抛」（primitive 装箱返 undefined / null 抛 TypeError 落 catch）——
  // 显式守卫后按「无 manifest」（undefined）处理，行为等价但不再依赖巧合。
  it("非对象 JSON（42 / null / string / pi 字段非对象或数组）→ undefined 不抛，按合法解析结果缓存", () => {
    const cases: Array<{ raw: string; label: string }> = [
      { raw: "42", label: "number" },
      { raw: "null", label: "null" },
      { raw: '"just-a-string"', label: "string" },
      { raw: '{"name":"p","pi":42}', label: "pi-field-not-object" },
      // [review 修复] 数组能骗过 typeof "object" 守卫（装箱对象）——非合法 pi 容器，
      // 显式归 undefined（语义上仍是「无 manifest」，与数组 entries 读出 undefined 一致）
      { raw: '{"name":"p","pi":[]}', label: "pi-field-array" },
    ];
    // 每 case 独立子目录（缓存 key = package.json 绝对路径），互不命中；
    // readCount 是跨 case 累积计数，断言用本 case 增量
    for (const { raw, label } of cases) {
      const before = readCount();
      const caseDir = path.join(pkgDir, label);
      pkgJson = writeRawPackageJson(caseDir, raw);
      setMtime(pkgJson, T1);
      expect(readPackageManifestSync(caseDir, "agents"), `case ${label}`).toBeUndefined();
      expect(readPackageManifestSync(caseDir, "workflows"), `case ${label}`).toBeUndefined();
      // 合法解析 + 无 manifest → 缓存 undefined 条目（同「无 pi 字段」语义，二次调用不重读）
      expect(readCount() - before, `case ${label}`).toBe(1);
    }
  });
});

// ============================================================
// 双读者共享（async readPackageManifest ↔ sync 共享同一 Map）
// ============================================================

describe("manifestCache 双读者共享（async ↔ sync）", () => {
  let ws: string;
  let pkgDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    clearFileCache();
    vi.mocked(fs.readFileSync).mockClear();
    vi.mocked(fsp.readFile).mockClear();
    ws = tmpPkgDir();
    pkgDir = path.join(ws, "my-ext");
    savedEnv = process.env.XYZ_EXTENSION_PATHS;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.XYZ_EXTENSION_PATHS;
    else process.env.XYZ_EXTENSION_PATHS = savedEnv;
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("sync 写入的条目被 async 命中：discoverResources 零 fs/promises readFile", async () => {
    const pkgJson = writePackageJson(pkgDir, { agents: ["./agents"] });
    fs.mkdirSync(path.join(pkgDir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "agents", "a.md"), "body", "utf-8");
    setMtime(pkgJson, T1);
    // sync 读者先填充缓存
    expect(readPackageManifestSync(pkgDir, "agents")).toEqual(["./agents"]);
    expect(readCount()).toBe(1);
    // async 读者（XYZ_EXTENSION_PATHS → processPackage → readPackageManifest）应命中共享条目
    process.env.XYZ_EXTENSION_PATHS = pkgDir;
    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      agentDir: path.join(ws, ".fake-agent"),
    });
    const ext = result.filter((r) => r.source === "user-extension-paths");
    expect(ext.map((r) => path.basename(r.path))).toEqual(["a.md"]);
    expect(asyncReadCount()).toBe(0); // async readFile 未被调用 = 命中共享缓存
    expect(readCount()).toBe(1); // sync 侧无新增 read
  });

  it("async 写入的条目被 sync 命中：async 读后 sync 不再 readFileSync", async () => {
    const pkgJson = writePackageJson(pkgDir, { agents: ["./agents"] });
    fs.mkdirSync(path.join(pkgDir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "agents", "a.md"), "body", "utf-8");
    setMtime(pkgJson, T1);
    process.env.XYZ_EXTENSION_PATHS = pkgDir;
    await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      agentDir: path.join(ws, ".fake-agent"),
    });
    expect(asyncReadCount()).toBe(1); // async 读者读了一次
    // sync 读者应命中 async 写入的条目（readFileSync 计数不变）
    expect(readPackageManifestSync(pkgDir, "agents")).toEqual(["./agents"]);
    expect(readCount()).toBe(0);
  });
});
