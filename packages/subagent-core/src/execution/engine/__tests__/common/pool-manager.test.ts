// pool-manager.test.ts —— 池 acquire/release 引用计数 / 归零整池删除 / journal 保留
// / 清理失败标记 / spawnedFiles 单次清理（D5 + §3.3.9）。
//
// 三视角：①构建者——计数归零才删、删除边界三硬规则逐条；②使用者——release 幂等
// 安全（无引用 no-op）；③观察者——清理失败有 .pool-cleanup-failed 标记（可观测）。

import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquirePool,
  cleanupSpawnedFiles,
  POOL_CLEANUP_FAILED_MARKER,
  releasePoolRef,
  resetPoolRegistryForTests,
} from "../../common/pool-manager.ts";
import { resolvePoolDir } from "../../paths.ts";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "engine-pool-test-"));
  resetPoolRegistryForTests();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("acquirePool", () => {
  it("mkdir -p 返回池目录（路径经 resolvePoolDir 派生），重复 acquire 幂等", async () => {
    const dir1 = await acquirePool(tmpRoot, "zcode", "reviewer");
    const dir2 = await acquirePool(tmpRoot, "zcode", "reviewer");
    expect(dir1).toBe(resolvePoolDir(tmpRoot, "zcode", "reviewer"));
    expect(dir1).toBe(dir2);
    expect(existsSync(dir1)).toBe(true);
  });

  it("poolKey 经 sanitizeSeg 归一（脏字符不进文件系统路径）", async () => {
    const dir = await acquirePool(tmpRoot, "zcode", "weird/key..name");
    expect(dir).toBe(resolvePoolDir(tmpRoot, "zcode", "weird-key-name"));
  });
});

describe("releasePoolRef 引用计数与整池删除", () => {
  it("双引用：release 一次池仍在（原生状态未删），归零才整池删除", async () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    await acquirePool(tmpRoot, "zcode", "reviewer");
    await acquirePool(tmpRoot, "zcode", "reviewer");
    mkdirSync(join(poolDir, "home"), { recursive: true });
    writeFileSync(join(poolDir, "home", "config.json"), "{}");

    await releasePoolRef(tmpRoot, "zcode", "reviewer");
    expect(existsSync(join(poolDir, "home"))).toBe(true); // 计数 1，不删

    await releasePoolRef(tmpRoot, "zcode", "reviewer"); // 归零
    expect(existsSync(join(poolDir, "home"))).toBe(false); // 原生状态已删
  });

  it("journal-*.jsonl 不随池删（生命周期跟随 record），目录保留", async () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    await acquirePool(tmpRoot, "zcode", "reviewer");
    writeFileSync(join(poolDir, "journal-bg-1.jsonl"), "{}\n");
    mkdirSync(join(poolDir, "home"), { recursive: true });

    await releasePoolRef(tmpRoot, "zcode", "reviewer");
    expect(existsSync(join(poolDir, "journal-bg-1.jsonl"))).toBe(true);
    expect(existsSync(join(poolDir, "home"))).toBe(false);
    // 只剩 journal：目录本体保留（journal 还在用）
    expect(existsSync(poolDir)).toBe(true);
    expect(readdirSync(poolDir)).toEqual(["journal-bg-1.jsonl"]);
  });

  it("无引用的 release（进程重启后 GC）→ 保守 no-op 不删池", async () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    mkdirSync(join(poolDir, "home"), { recursive: true });
    await releasePoolRef(tmpRoot, "zcode", "reviewer");
    expect(existsSync(join(poolDir, "home"))).toBe(true);
  });

  it("池目录不存在时 release 归零 → 无原生状态可清，视为成功不抛", async () => {
    await acquirePool(tmpRoot, "zcode", "ghost");
    // 归零但目录已被外部删除
    rmSync(resolvePoolDir(tmpRoot, "zcode", "ghost"), { recursive: true, force: true });
    await expect(releasePoolRef(tmpRoot, "zcode", "ghost")).resolves.toBeUndefined();
  });

  it("删除失败置 .pool-cleanup-failed 标记文件（可观测不静默），不 throw", async () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    await acquirePool(tmpRoot, "zcode", "reviewer");
    mkdirSync(join(poolDir, "home"), { recursive: true });
    writeFileSync(join(poolDir, "journal-bg-1.jsonl"), "{}\n");

    // 注入失败 fs：rm 对 home 目录 reject（标记写入仍走真实 fs——失败要可观测）
    const realFs = await import("node:fs/promises");
    const injected = {
      mkdir: (p: string, o: { recursive: boolean }) => realFs.mkdir(p, o),
      readdir: (p: string) => realFs.readdir(p, { withFileTypes: true }),
      rm: async (p: string, o: { recursive: boolean; force: boolean }) => {
        if (p === join(poolDir, "home")) throw new Error("EACCES: permission denied");
        return realFs.rm(p, o);
      },
      rmdir: (p: string) => realFs.rmdir(p),
      writeFile: (p: string, d: string) => realFs.writeFile(p, d, "utf8"),
    };

    await expect(releasePoolRef(tmpRoot, "zcode", "reviewer", injected)).resolves.toBeUndefined();
    const markerPath = join(poolDir, POOL_CLEANUP_FAILED_MARKER);
    expect(existsSync(markerPath)).toBe(true);
    // 标记内容是失败清单 JSON（含失败条目与原因）
    const payload = JSON.parse(
      (await import("node:fs")).readFileSync(markerPath, "utf8"),
    ) as { failures: string[] };
    expect(payload.failures.length).toBe(1);
    expect(payload.failures[0]).toContain("home");
    expect(payload.failures[0]).toContain("EACCES");
  });
});

describe("cleanupSpawnedFiles（单次性产物）", () => {
  it("keepForResume=true → 全部保留（resume 续接原 session，不重写产物）", async () => {
    const f = join(tmpRoot, "prompt.txt");
    writeFileSync(f, "x");
    await cleanupSpawnedFiles([f], { keepForResume: true });
    expect(existsSync(f)).toBe(true);
  });

  it("keepForResume=false → 删除；目录产物递归删", async () => {
    const file = join(tmpRoot, "prompt.txt");
    const dir = join(tmpRoot, "persona");
    writeFileSync(file, "x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "persona.md"), "y");
    await cleanupSpawnedFiles([file, dir], { keepForResume: false });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("不存在的路径幂等（ENOENT 忽略）；单条失败不 throw 其余继续", async () => {
    const good = join(tmpRoot, "good.txt");
    writeFileSync(good, "x");
    // 真实 fs 下很难制造 rm 失败——用「父路径为文件」制造 ENOTDIR 失败：
    // rm(recursive, force) 对 «file/child» 形态报 ENOTDIR（force 只豁免 ENOENT）
    const blocked = join(tmpRoot, "plain-file", "child");
    writeFileSync(join(tmpRoot, "plain-file"), "not a dir");
    await expect(
      cleanupSpawnedFiles([blocked, good], { keepForResume: false }),
    ).resolves.toBeUndefined();
    expect(existsSync(good)).toBe(false);
  });
});
