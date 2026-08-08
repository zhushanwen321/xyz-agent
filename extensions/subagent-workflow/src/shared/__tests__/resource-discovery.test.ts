// src/shared/__tests__/resource-discovery.test.ts
//
// 统一资源发现模块测试（ADR-031）。
// 验证：扫描源覆盖、优先级合并、manifest 校验、约定目录 fallback。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discoverResources,
  discoverResourcesSync,
  findWorkspaceRoot,
  processPackageSync,
} from "../resource-discovery.ts";

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
    expect(result.map((r) => path.basename(r.path))).toEqual(["worker.md"]);
    expect(result[0]?.available).toBe(true);
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
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("project-agents");
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
    expect(result.map((r) => path.basename(r.path))).toEqual(["real.md"]);
  });

  it("nonexistent directories are silently skipped", () => {
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    expect(result).toEqual([]);
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
    expect(result.map((r) => path.basename(r.path))).toEqual(["custom.md"]);
    expect(result[0]?.source).toBe("user-extension-paths");
  });

  it("discovers agents via convention dir (no manifest)", () => {
    const pkgDir = path.join(ws, "my-ext");
    writeFile(path.join(pkgDir, "agents"), "conv.md", "body");
    process.env.XYZ_EXTENSION_PATHS = pkgDir;
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    expect(result.map((r) => path.basename(r.path))).toEqual(["conv.md"]);
    expect(result[0]?.source).toBe("user-extension-paths");
  });

  it("multiple paths separated by delimiter", () => {
    const pkg1 = path.join(ws, "ext1");
    const pkg2 = path.join(ws, "ext2");
    writeFile(path.join(pkg1, "agents"), "a1.md", "body");
    writeFile(path.join(pkg2, "agents"), "a2.md", "body");
    process.env.XYZ_EXTENSION_PATHS = `${pkg1}${path.delimiter}${pkg2}`;
    const result = discoverResourcesSync({ kind: "agents", workspaceRoot: ws, agentDir });
    expect(result.map((r) => path.basename(r.path)).sort()).toEqual(["a1.md", "a2.md"]);
    expect(result.every((r) => r.source === "user-extension-paths")).toBe(true);
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
    expect(result.map((r) => path.basename(r.path))).toEqual(["async.md"]);
    expect(result[0]?.source).toBe("user-extension-paths");
  });
});
