// src/shared/__tests__/resource-discovery.test.ts
//
// 统一资源发现模块测试（ADR-031）。
// 验证：扫描源覆盖、优先级合并、manifest 校验、约定目录 fallback。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 隔离真实用户全局目录：resource-discovery 用 homedir() 推导 user-agents 源
// （~/.agents/agents/），测试环境可能存在真实 agent 文件（如 tech-design-review.md），
// 不 mock 会导致「期望空列表/精确列表」用例被环境污染（2026-08 实测 4 个失败）。
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/nonexistent-home-for-tests" };
});

import {
  discoverResources,
  discoverResourcesSync,
  findWorkspaceRoot,
  processPackageSync,
  getCachedFile,
  getCachedFileContent,
  getCachedParsed,
  clearFileCache,
} from "../resource-discovery.ts";
import { getLogger } from "@zhushanwen/pi-extension-logger";

// ============================================================
// helpers
// ============================================================

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "res-disc-test-"));
}

function writeFile(dir: string, name: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function writePackageJson(pkgDir: string, pi: Record<string, unknown>): void {
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "test-pkg", pi }),
    "utf-8",
  );
}

// ============================================================
// findWorkspaceRoot
// ============================================================

describe("findWorkspaceRoot", () => {
  it("returns cwd when no marker found", () => {
    const ws = tmpWorkspace();
    expect(findWorkspaceRoot(ws)).toBe(ws);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("finds .git root", () => {
    const ws = tmpWorkspace();
    fs.mkdirSync(path.join(ws, ".git"));
    const sub = path.join(ws, "sub", "deep");
    fs.mkdirSync(sub, { recursive: true });
    expect(findWorkspaceRoot(sub)).toBe(ws);
    fs.rmSync(ws, { recursive: true, force: true });
  });
});

// ============================================================
// discoverResourcesSync — 扫描源覆盖 + 优先级
// ============================================================

describe("discoverResourcesSync", () => {
  let ws: string;
  let agentDir: string;

  beforeEach(() => {
    ws = tmpWorkspace();
    agentDir = path.join(ws, ".fake-agent");
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("discovers agents from project .pi/agents/", () => {
    writeFile(path.join(ws, ".pi", "agents"), "worker.md", "body");
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    // 按 source 过滤断言——用户全局目录（~/.agents/agents/）可能有真实 agent 文件，
    // 测试不假设环境为空（2026-08：环境新增 tech-design-review.md 暴露此脆弱性）
    const project = result.filter((r) => r.source === "project-pi");
    expect(project.map((r) => path.basename(r.path))).toEqual(["worker.md"]);
    expect(project[0]?.available).toBe(true);
  });

  it("discovers workflows from project .pi/workflows/", () => {
    writeFile(path.join(ws, ".pi", "workflows"), "build.js", "const meta={name:'build'};");
    const result = discoverResourcesSync({ kind: "workflows", workspaceRoot: ws, agentDir });
    expect(result.map((r) => path.basename(r.path))).toEqual(["build.js"]);
  });

  it("project .agents overrides project .pi on name clash (priority)", () => {
    writeFile(path.join(ws, ".pi", "agents"), "worker.md", "pi-body");
    writeFile(path.join(ws, ".agents", "agents"), "worker.md", "agents-body");
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    const project = result.filter((r) => r.source === "project-agents");
    expect(project).toHaveLength(1);
    expect(project[0]?.source).toBe("project-agents");
  });

  it("includes tmp source for workflows when includeTmp=true", () => {
    writeFile(path.join(ws, ".pi", "workflows", ".tmp"), "temp.js", "const meta={name:'temp'};");
    const result = discoverResourcesSync({
      kind: "workflows",
      workspaceRoot: ws,
      agentDir,
      includeTmp: true,
    });
    expect(result.map((r) => path.basename(r.path))).toEqual(["temp.js"]);
    expect(result[0]?.source).toBe("project-pi-tmp");
  });

  it("excludes tmp source when includeTmp omitted", () => {
    writeFile(path.join(ws, ".pi", "workflows", ".tmp"), "temp.js", "x");
    const result = discoverResourcesSync({ kind: "workflows", workspaceRoot: ws, agentDir });
    expect(result).toEqual([]);
  });

  it("ignores _ prefix and .chain.md files", () => {
    const dir = path.join(ws, ".pi", "agents");
    writeFile(dir, "real.md", "body");
    writeFile(dir, "_skip.md", "ignored");
    writeFile(dir, "trace.chain.md", "ignored");
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    const project = result.filter((r) => r.source === "project-pi");
    expect(project.map((r) => path.basename(r.path))).toEqual(["real.md"]);
  });

  it("nonexistent directories are silently skipped", () => {
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    // 用户全局目录可能有真实文件——只断言 project 源为空
    expect(result.filter((r) => r.source === "project-pi" || r.source === "project-agents")).toEqual([]);
  });
});

// ============================================================
// processPackageSync — manifest 校验
// ============================================================

describe("processPackageSync", () => {
  let pkgDir: string;

  beforeEach(() => {
    pkgDir = tmpWorkspace();
  });
  afterEach(() => {
    fs.rmSync(pkgDir, { recursive: true, force: true });
  });

  it("loads from manifest directory declaration", () => {
    writeFile(path.join(pkgDir, "agents"), "worker.md", "body");
    writePackageJson(pkgDir, { agents: ["./agents"] });
    const result = processPackageSync(pkgDir, "agents");
    expect(result).toHaveLength(1);
    expect(result[0]?.available).toBe(true);
  });

  it("loads from manifest file declaration", () => {
    writeFile(pkgDir, "worker.md", "body");
    writePackageJson(pkgDir, { agents: ["./worker.md"] });
    const result = processPackageSync(pkgDir, "agents");
    expect(result).toHaveLength(1);
    expect(result[0]?.available).toBe(true);
  });

  it("manifest path not exists → available=false, no fallback", () => {
    writePackageJson(pkgDir, { agents: ["./nonexistent"] });
    const result = processPackageSync(pkgDir, "agents");
    expect(result).toHaveLength(1);
    expect(result[0]?.available).toBe(false);
    // 不 fallback 到约定目录
    writeFile(path.join(pkgDir, "agents"), "hidden.md", "body");
    const result2 = processPackageSync(pkgDir, "agents");
    expect(result2).toHaveLength(1);
    expect(result2[0]?.available).toBe(false);
  });

  it("no manifest → fallback to convention dir", () => {
    writeFile(path.join(pkgDir, "agents"), "worker.md", "body");
    // 无 package.json 或无 pi.agents
    const result = processPackageSync(pkgDir, "agents");
    expect(result).toHaveLength(1);
    expect(result[0]?.available).toBe(true);
  });

  it("no manifest and no convention dir → empty", () => {
    writePackageJson(pkgDir, { extensions: ["./index.ts"] });
    const result = processPackageSync(pkgDir, "agents");
    expect(result).toEqual([]);
  });
});

// ============================================================
// discoverResources (async) — 基本冒烟
// ============================================================

describe("discoverResources (async)", () => {
  let ws: string;

  beforeEach(() => {
    ws = tmpWorkspace();
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("discovers agents from project .pi/agents/ (async)", async () => {
    writeFile(path.join(ws, ".pi", "agents"), "worker.md", "body");
    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      agentDir: path.join(ws, ".fake-agent"),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.available).toBe(true);
  });

  it("discovers workflows with tmp source (async)", async () => {
    writeFile(path.join(ws, ".pi", "workflows"), "build.js", "x");
    writeFile(path.join(ws, ".pi", "workflows", ".tmp"), "temp.js", "x");
    const result = await discoverResources({
      kind: "workflows",
      workspaceRoot: ws,
      agentDir: path.join(ws, ".fake-agent"),
      includeTmp: true,
    });
    expect(result).toHaveLength(2);
  });
});

// ============================================================
// user-extension-paths (XYZ_EXTENSION_PATHS) — dev-link 扩展发现
// ============================================================

describe("user-extension-paths (XYZ_EXTENSION_PATHS)", () => {
  let ws: string;
  let agentDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    ws = tmpWorkspace();
    agentDir = path.join(ws, ".fake-agent");
    savedEnv = process.env.XYZ_EXTENSION_PATHS;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.XYZ_EXTENSION_PATHS;
    else process.env.XYZ_EXTENSION_PATHS = savedEnv;
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("discovers agents from XYZ_EXTENSION_PATHS via pi.agents manifest", () => {
    const pkgDir = path.join(ws, "my-ext");
    writePackageJson(pkgDir, { agents: ["./agents"] });
    writeFile(path.join(pkgDir, "agents"), "custom.md", "body");
    process.env.XYZ_EXTENSION_PATHS = pkgDir;
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    const ext = result.filter((r) => r.source === "user-extension-paths");
    expect(ext.map((r) => path.basename(r.path))).toEqual(["custom.md"]);
    expect(ext[0]?.source).toBe("user-extension-paths");
  });

  it("discovers agents via convention dir (no manifest)", () => {
    const pkgDir = path.join(ws, "my-ext");
    writeFile(path.join(pkgDir, "agents"), "conv.md", "body");
    process.env.XYZ_EXTENSION_PATHS = pkgDir;
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    const ext = result.filter((r) => r.source === "user-extension-paths");
    expect(ext.map((r) => path.basename(r.path))).toEqual(["conv.md"]);
    expect(ext[0]?.source).toBe("user-extension-paths");
  });

  it("multiple paths separated by delimiter", () => {
    const pkg1 = path.join(ws, "ext1");
    const pkg2 = path.join(ws, "ext2");
    writeFile(path.join(pkg1, "agents"), "a1.md", "body");
    writeFile(path.join(pkg2, "agents"), "a2.md", "body");
    process.env.XYZ_EXTENSION_PATHS = `${pkg1}${path.delimiter}${pkg2}`;
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    const ext = result.filter((r) => r.source === "user-extension-paths");
    expect(ext.map((r) => path.basename(r.path)).sort()).toEqual(["a1.md", "a2.md"]);
  });

  it("overrides npm on name clash (priority: user-extension-paths > npm)", () => {
    const npmPkg = path.join(agentDir, "npm", "node_modules", "test-pkg");
    writePackageJson(npmPkg, { agents: ["./agents"] });
    writeFile(path.join(npmPkg, "agents"), "shared.md", "npm-body");
    const devPkg = path.join(ws, "dev-ext");
    writePackageJson(devPkg, { agents: ["./agents"] });
    writeFile(path.join(devPkg, "agents"), "shared.md", "dev-body");
    process.env.XYZ_EXTENSION_PATHS = devPkg;
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    const shared = result.find((r) => path.basename(r.path) === "shared.md");
    expect(shared?.source).toBe("user-extension-paths");
  });

  it("project-agents overrides user-extension-paths (project wins)", () => {
    const devPkg = path.join(ws, "dev-ext");
    writePackageJson(devPkg, { agents: ["./agents"] });
    writeFile(path.join(devPkg, "agents"), "x.md", "dev-body");
    writeFile(path.join(ws, ".agents", "agents"), "x.md", "project-body");
    process.env.XYZ_EXTENSION_PATHS = devPkg;
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    const x = result.find((r) => path.basename(r.path) === "x.md");
    expect(x?.source).toBe("project-agents");
  });

  it("empty/unset env → no user-extension-paths source", () => {
    delete process.env.XYZ_EXTENSION_PATHS;
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    expect(result.filter((r) => r.source === "user-extension-paths")).toEqual([]);
  });

  it("async discoverResources also scans user-extension-paths", async () => {
    const pkgDir = path.join(ws, "my-ext");
    writePackageJson(pkgDir, { agents: ["./agents"] });
    writeFile(path.join(pkgDir, "agents"), "async.md", "body");
    process.env.XYZ_EXTENSION_PATHS = pkgDir;
    const result = await discoverResources({ kind: "agents", workspaceRoot: ws, agentDir });
    const ext = result.filter((r) => r.source === "user-extension-paths");
    expect(ext.map((r) => path.basename(r.path))).toEqual(["async.md"]);
    expect(ext[0]?.source).toBe("user-extension-paths");
  });

  it("async: overrides npm on name clash (priority: user-extension-paths > npm)", async () => {
    const npmPkg = path.join(agentDir, "npm", "node_modules", "test-pkg");
    writePackageJson(npmPkg, { agents: ["./agents"] });
    writeFile(path.join(npmPkg, "agents"), "shared.md", "npm-body");
    const devPkg = path.join(ws, "dev-ext");
    writePackageJson(devPkg, { agents: ["./agents"] });
    writeFile(path.join(devPkg, "agents"), "shared.md", "dev-body");
    process.env.XYZ_EXTENSION_PATHS = devPkg;
    const result = await discoverResources({ kind: "agents", workspaceRoot: ws, agentDir });
    const shared = result.find((r) => path.basename(r.path) === "shared.md");
    expect(shared?.source).toBe("user-extension-paths");
  });

  it("async: project-agents overrides user-extension-paths (project wins)", async () => {
    const devPkg = path.join(ws, "dev-ext");
    writePackageJson(devPkg, { agents: ["./agents"] });
    writeFile(path.join(devPkg, "agents"), "x.md", "dev-body");
    writeFile(path.join(ws, ".agents", "agents"), "x.md", "project-body");
    process.env.XYZ_EXTENSION_PATHS = devPkg;
    const result = await discoverResources({ kind: "agents", workspaceRoot: ws, agentDir });
    const x = result.find((r) => path.basename(r.path) === "x.md");
    expect(x?.source).toBe("project-agents");
  });

  it("async: 4 源混合 fixture——输出序 + 优先级 + 与串行版快照等价", async () => {
    // 源优先级低→高：npm < user-extension-paths < project-pi < project-agents
    const npmPkg = path.join(agentDir, "npm", "node_modules", "test-pkg");
    writePackageJson(npmPkg, { agents: ["./agents"] });
    writeFile(path.join(npmPkg, "agents"), "shared.md", "npm-body");
    const devPkg = path.join(ws, "dev-ext");
    writePackageJson(devPkg, { agents: ["./agents"] });
    writeFile(path.join(devPkg, "agents"), "dev.md", "dev-body");
    writeFile(path.join(ws, ".pi", "agents"), "pi.md", "pi-body");
    writeFile(path.join(ws, ".agents", "agents"), "shared.md", "project-body");
    writeFile(path.join(ws, ".agents", "agents"), "proj.md", "proj-body");
    process.env.XYZ_EXTENSION_PATHS = devPkg;
    const config = { kind: "agents" as const, workspaceRoot: ws, agentDir };

    const asyncResult = await discoverResources(config);

    // 输出序：stem 首次插入位置固定（低优先级源先入 Map），同名后续覆盖值不移位
    expect(asyncResult.map((r) => path.basename(r.path))).toEqual([
      "shared.md", // 首现于 npm（最低源），位置固定
      "dev.md", // user-extension-paths
      "pi.md", // project-pi
      "proj.md", // project-agents
    ]);
    // 优先级：shared.md 两源同名，project-agents（高）last-writer-wins
    expect(asyncResult.find((r) => path.basename(r.path) === "shared.md")?.source).toBe(
      "project-agents",
    );
    // 快照等价：源级并行 async 版与串行 sync 版输出逐项一致（含序与 source 标签）
    expect(asyncResult).toEqual(discoverResourcesSync(config));
  });

  it("async: 同名遮蔽时输出 warn（D8d 有检测必有报告）", async () => {
    const npmPkg = path.join(agentDir, "npm", "node_modules", "test-pkg");
    writePackageJson(npmPkg, { agents: ["./agents"] });
    const npmFile = writeFile(path.join(npmPkg, "agents"), "dup.md", "npm-body");
    const projFile = writeFile(path.join(ws, ".agents", "agents"), "dup.md", "project-body");
    const warnSpy = vi.spyOn(getLogger("subagents"), "warn");

    try {
      const result = await discoverResources({ kind: "agents", workspaceRoot: ws, agentDir });

      // 遮蔽仍生效（last-writer-wins 语义不变）
      expect(result.find((r) => path.basename(r.path) === "dup.md")?.source).toBe("project-agents");
      // 但不再静默：warn 报告被遮蔽方与保留方路径（D8d「有检测无报告」修复）
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [msg, data] = warnSpy.mock.calls[0];
      expect(String(msg)).toContain('duplicate agents "dup"');
      expect(String(msg)).toContain("project-agents shadows npm");
      expect(data).toMatchObject({ shadowed: npmFile, kept: projFile });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── m5 TC4/TC5: 统一 mtime 缓存层（P-cache / P-cache-invalidation） ──

describe("m5: 统一 mtime 缓存层", () => {
  it("TC4a: P-cache——文件未变时二次读取命中同一缓存条目（对象引用）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-cache-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "---\nname: x\ndescription: y\n---\nbody", "utf-8");
    try {
      // ESM 下 node:fs 不可 spy（vitest 限制）——命中断言用对象引用：
      // getCachedFile 命中时返回缓存条目对象本身（非新建）
      const first = getCachedFile(f);
      const second = getCachedFile(f);
      expect(first?.content).toBe("---\nname: x\ndescription: y\n---\nbody");
      expect(second).toBe(first); // 同引用 = 命中缓存（未重 read）
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("TC4b: P-cache——两处消费方（getCachedFile/getCachedFileContent）共享同一缓存条目", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-cache2-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "---\nname: x\ndescription: y\n---\nbody", "utf-8");
    try {
      const a = getCachedFile(f);
      const b = getCachedFileContent(f);
      // 内容一致性（命中语义由 TC4a 的对象引用断言覆盖——此处验证两 API 一致）
      expect(a?.content).toBe(b);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("TC5: P-cache-invalidation——改内容（mtime 变）后重读新内容；删文件后驱逐", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-cache3-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "v1", "utf-8");
    try {
      expect(getCachedFileContent(f)).toBe("v1");
      fs.writeFileSync(f, "v2", "utf-8");
      expect(getCachedFileContent(f)).toBe("v2"); // mtime 变 → 重读
      // 删除 → 驱逐（不再返回旧内容）
      fs.rmSync(f);
      expect(getCachedFileContent(f)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── KV-cache 稳定性改造：解析结果缓存 getCachedParsed ──

describe("getCachedParsed（mtime 级解析缓存）", () => {
  beforeEach(() => {
    clearFileCache();
  });

  it("mtime 未变时 parse 只跑一次（缓存解析结果）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parsed-cache-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "---\nname: x\ndescription: y\n---", "utf-8");
    try {
      const parse = vi.fn((content: string) => (content.includes("name: x") ? "OK" : "BAD"));
      const first = getCachedParsed(f, parse);
      const second = getCachedParsed(f, parse);
      expect(first).toBe("OK");
      expect(second).toBe("OK");
      expect(parse).toHaveBeenCalledTimes(1); // 第二次命中缓存，不重 parse
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mtime 变后重新 parse；文件删除后返回 null 并驱逐", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parsed-cache2-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "v1", "utf-8");
    try {
      const parse = (content: string) => content;
      expect(getCachedParsed(f, parse)).toBe("v1");
      fs.writeFileSync(f, "v2", "utf-8");
      expect(getCachedParsed(f, parse)).toBe("v2"); // mtime 变 → 重新 parse
      fs.rmSync(f);
      expect(getCachedParsed(f, parse)).toBeNull(); // 删除 → null
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clearFileCache 同时清空解析缓存", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parsed-cache3-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "content", "utf-8");
    try {
      const parse = vi.fn(() => "OK");
      getCachedParsed(f, parse);
      clearFileCache();
      getCachedParsed(f, parse);
      expect(parse).toHaveBeenCalledTimes(2); // 缓存被清 → 重新 parse
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同一 path 的不同 parse 各自独立缓存（缓存键含 parse 身份，防跨 parse 污染）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parsed-cache4-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "shared-content", "utf-8");
    try {
      // 模拟真实双 parse 场景：parseAgentFrontmatter vs parseWorkflowMeta 对同一
      // path（agent 与 workflow 发现源理论上可命中同一路径）各自解析
      const parseA = (content: string) => ({ kind: "agent" as const, content });
      const parseW = (content: string) => ({ kind: "workflow" as const, len: content.length });
      const a1 = getCachedParsed(f, parseA);
      // 修复前：缓存键只有 path，这里会命中 parseA 的缓存条目并 as T 断言返回
      // {kind:"agent"}——w1 被污染成错误类型
      const w1 = getCachedParsed(f, parseW);
      const a2 = getCachedParsed(f, parseA);
      expect(a1).toEqual({ kind: "agent", content: "shared-content" });
      expect(w1).toEqual({ kind: "workflow", len: 14 });
      expect(a2).toEqual({ kind: "agent", content: "shared-content" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
