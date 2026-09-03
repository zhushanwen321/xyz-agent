// pool-manager.test.ts —— 池 acquire/release 引用计数（refs.json 文件形态）/
// 归零整池删除 / journal 保留与跟随 record 删除 / 重启恢复 / TTL 兜底 /
// 清理失败标记 / spawnedFiles 单次清理（D5 + §3.3.9 + D8 接线）。
//
// 三视角：①构建者——计数归零才删、删除边界三硬规则逐条；②使用者——release 幂等
// 安全（无引用 no-op）；③观察者——清理失败有 .pool-cleanup-failed 标记（可观测）。

import * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquirePool,
  cleanupExpiredPoolRefs,
  cleanupSpawnedFiles,
  POOL_CLEANUP_FAILED_MARKER,
  REFS_JSON_FILENAME,
  releasePoolRef,
} from "../../common/pool-manager.ts";
import { resolvePoolDir } from "../../paths.ts";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "engine-pool-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 读池 refs.json 的解析形态。 */
function readRefs(poolDir: string): { v: number; refs: Record<string, { taskId: string; ts: number }> } {
  return JSON.parse(readFileSync(join(poolDir, REFS_JSON_FILENAME), "utf8")) as {
    v: number;
    refs: Record<string, { taskId: string; ts: number }>;
  };
}

describe("acquirePool（refs.json 文件形态）", () => {
  it("mkdir -p 返回池目录（路径经 resolvePoolDir 派生），refs.json 登记 taskId", () => {
    const dir1 = acquirePool(tmpRoot, "zcode", "reviewer", "bg-1");
    const dir2 = acquirePool(tmpRoot, "zcode", "reviewer", "bg-1");
    expect(dir1).toBe(resolvePoolDir(tmpRoot, "zcode", "reviewer"));
    expect(dir1).toBe(dir2);
    expect(existsSync(dir1)).toBe(true);
    const refs = readRefs(dir1);
    expect(refs.v).toBe(1);
    expect(Object.keys(refs.refs)).toEqual(["bg-1"]);
    expect(refs.refs["bg-1"]!.taskId).toBe("bg-1");
    expect(typeof refs.refs["bg-1"]!.ts).toBe("number");
  });

  it("同 taskId 重复 acquire 幂等（刷新 ts 不加条目）；不同 taskId 独立登记", () => {
    const dir = acquirePool(tmpRoot, "zcode", "reviewer", "bg-1");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-1");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-2");
    expect(Object.keys(readRefs(dir).refs).sort()).toEqual(["bg-1", "bg-2"]);
  });

  it("poolKey 经 sanitizeSeg 归一（脏字符不进文件系统路径）", () => {
    const dir = acquirePool(tmpRoot, "zcode", "weird/key..name", "bg-1");
    expect(dir).toBe(resolvePoolDir(tmpRoot, "zcode", "weird-key-name"));
  });

  it("refs.json 损坏 → 空登记起步（重建语义，不 throw）", () => {
    const dir = acquirePool(tmpRoot, "zcode", "reviewer", "bg-1");
    writeFileSync(join(dir, REFS_JSON_FILENAME), "{ torn", "utf8");
    // 损坏后再次 acquire：从空 refs 起步，新 taskId 正常登记
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-9");
    expect(Object.keys(readRefs(dir).refs)).toEqual(["bg-9"]);
  });
});

describe("releasePoolRef 引用计数与整池删除", () => {
  it("双引用（不同 taskId）：release 一次池仍在（原生状态未删），归零才整池删除", () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-1");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-2");
    mkdirSync(join(poolDir, "home"), { recursive: true });
    writeFileSync(join(poolDir, "home", "config.json"), "{}");

    releasePoolRef(tmpRoot, "zcode", "reviewer", "bg-1");
    expect(existsSync(join(poolDir, "home"))).toBe(true); // 计数 1，不删
    expect(Object.keys(readRefs(poolDir).refs)).toEqual(["bg-2"]);

    releasePoolRef(tmpRoot, "zcode", "reviewer", "bg-2"); // 归零
    expect(existsSync(join(poolDir, "home"))).toBe(false); // 原生状态已删
  });

  it("release 删该 taskId 的 journal（生命周期跟随 record），其他 journal 保留", () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-1");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-2");
    writeFileSync(join(poolDir, "journal-bg-1.jsonl"), "{}\n");
    writeFileSync(join(poolDir, "journal-bg-2.jsonl"), "{}\n");
    mkdirSync(join(poolDir, "home"), { recursive: true });

    releasePoolRef(tmpRoot, "zcode", "reviewer", "bg-1");
    expect(existsSync(join(poolDir, "journal-bg-1.jsonl"))).toBe(false); // 自己的 journal 随 record 删
    expect(existsSync(join(poolDir, "journal-bg-2.jsonl"))).toBe(true); // 他人的 journal 不动
    expect(existsSync(join(poolDir, "home"))).toBe(true); // 计数 1，原生状态不删
  });

  it("归零删池时未 release 的 journal 不随池删（目录保留）", () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-1");
    // 孤儿 journal（无 refs 条目对应——refs 丢失场景的既有残留）
    writeFileSync(join(poolDir, "journal-bg-99.jsonl"), "{}\n");
    mkdirSync(join(poolDir, "home"), { recursive: true });

    releasePoolRef(tmpRoot, "zcode", "reviewer", "bg-1"); // 归零
    expect(existsSync(join(poolDir, "home"))).toBe(false); // 原生状态已删
    expect(existsSync(join(poolDir, "journal-bg-99.jsonl"))).toBe(true); // journal 不随池删
    // 只剩 journal：目录本体保留（journal 还在用）
    expect(existsSync(poolDir)).toBe(true);
    expect(readdirSync(poolDir)).toEqual(["journal-bg-99.jsonl"]);
  });

  it("无引用的 release（进程重启后 refs 丢失）→ journal 仍删（record 已死），但保守不删池", () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    mkdirSync(join(poolDir, "home"), { recursive: true });
    writeFileSync(join(poolDir, "journal-bg-1.jsonl"), "{}\n");
    releasePoolRef(tmpRoot, "zcode", "reviewer", "bg-1");
    expect(existsSync(join(poolDir, "home"))).toBe(true); // 无归零证据，不删池
    expect(existsSync(join(poolDir, "journal-bg-1.jsonl"))).toBe(false); // journal 跟随 record
  });

  it("refs.json 落盘即重启恢复：acquire 后不经内存态，release 一次即归零删池", () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-1");
    mkdirSync(join(poolDir, "home"), { recursive: true });
    writeFileSync(join(poolDir, "home", "config.json"), "{}");
    // 「重启」语义 = 计数只存在于 refs.json（无进程内缓存）——直接 release 即验证
    releasePoolRef(tmpRoot, "zcode", "reviewer", "bg-1");
    expect(existsSync(join(poolDir, "home"))).toBe(false); // 归零证据来自文件
  });

  it("池目录不存在时 release → 无原生状态可清，视为成功不抛", () => {
    acquirePool(tmpRoot, "zcode", "ghost", "bg-1");
    // 归零但目录已被外部删除
    rmSync(resolvePoolDir(tmpRoot, "zcode", "ghost"), { recursive: true, force: true });
    expect(() => releasePoolRef(tmpRoot, "zcode", "ghost", "bg-1")).not.toThrow();
  });

  it("删除失败置 .pool-cleanup-failed 标记文件（可观测不静默），不 throw", () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-1");
    mkdirSync(join(poolDir, "home"), { recursive: true });
    writeFileSync(join(poolDir, "journal-bg-2.jsonl"), "{}\n");

    // 注入失败 fs：rmSync 对 home 目录 throw（标记写入仍走真实 fs——失败要可观测）
    const fs = nodeFs;
    const injected = {
      mkdirSync: (p: string, o: { recursive: boolean }) => fs.mkdirSync(p, o),
      readdirSync: (p: string) => fs.readdirSync(p, { withFileTypes: true }),
      statSync: (p: string) => fs.statSync(p),
      existsSync: (p: string) => fs.existsSync(p),
      readFileSync: (p: string) => fs.readFileSync(p, "utf8"),
      writeFileSync: (p: string, d: string) => fs.writeFileSync(p, d, "utf8"),
      renameSync: (from: string, to: string) => fs.renameSync(from, to),
      rmSync: (p: string, o: { recursive: boolean; force: boolean }) => {
        if (p === join(poolDir, "home")) throw new Error("EACCES: permission denied");
        return fs.rmSync(p, o);
      },
      rmdirSync: (p: string) => fs.rmdirSync(p),
    };

    expect(() => releasePoolRef(tmpRoot, "zcode", "reviewer", "bg-1", injected)).not.toThrow();
    const markerPath = join(poolDir, POOL_CLEANUP_FAILED_MARKER);
    expect(existsSync(markerPath)).toBe(true);
    // 标记内容是失败清单 JSON（含失败条目与原因）
    const payload = JSON.parse(readFileSync(markerPath, "utf8")) as { failures: string[] };
    expect(payload.failures.length).toBe(1);
    expect(payload.failures[0]).toContain("home");
    expect(payload.failures[0]).toContain("EACCES");
  });

  it("refs.json 写失败（release 移除条目时）置 .pool-cleanup-failed 标记，不 throw", () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-1");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-2");

    const fs = nodeFs;
    const injected = {
      mkdirSync: (p: string, o: { recursive: boolean }) => fs.mkdirSync(p, o),
      readdirSync: (p: string) => fs.readdirSync(p, { withFileTypes: true }),
      statSync: (p: string) => fs.statSync(p),
      existsSync: (p: string) => fs.existsSync(p),
      readFileSync: (p: string) => fs.readFileSync(p, "utf8"),
      writeFileSync: (p: string, d: string) => {
        if (p.includes(REFS_JSON_FILENAME)) throw new Error("ENOSPC: no space left");
        return fs.writeFileSync(p, d, "utf8");
      },
      renameSync: (from: string, to: string) => fs.renameSync(from, to),
      rmSync: (p: string, o: { recursive: boolean; force: boolean }) => fs.rmSync(p, o),
      rmdirSync: (p: string) => fs.rmdirSync(p),
    };

    expect(() => releasePoolRef(tmpRoot, "zcode", "reviewer", "bg-1", injected)).not.toThrow();
    expect(existsSync(join(poolDir, POOL_CLEANUP_FAILED_MARKER))).toBe(true);
    // 池未被误删（写失败时无归零证据落盘）
    expect(existsSync(poolDir)).toBe(true);
  });
});

describe("cleanupExpiredPoolRefs（TTL 兜底）", () => {
  /** 30 天 TTL 常数（与 session-file-gc 同尺度）。 */
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;

  it("超龄 journal + refs 条目回收，归零删池内原生状态；未超龄不动", () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-old");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-new");
    mkdirSync(join(poolDir, "home"), { recursive: true });
    writeFileSync(join(poolDir, "journal-bg-old.jsonl"), "{}\n");
    writeFileSync(join(poolDir, "journal-bg-new.jsonl"), "{}\n");

    // mtime 推到 31 天前（仅 old 的 journal）
    const aged = Date.now() / 1000 - 31 * 86400;
    utimesSync(join(poolDir, "journal-bg-old.jsonl"), aged, aged);

    cleanupExpiredPoolRefs(tmpRoot, TTL_MS);

    expect(existsSync(join(poolDir, "journal-bg-old.jsonl"))).toBe(false); // 超龄回收
    expect(existsSync(join(poolDir, "journal-bg-new.jsonl"))).toBe(true); // 未超龄保留
    expect(Object.keys(readRefs(poolDir).refs)).toEqual(["bg-new"]); // 条目同步移除
    expect(existsSync(join(poolDir, "home"))).toBe(true); // 未归零，原生状态不删
  });

  it("全部条目超龄 → 归零删池原生状态 + refs.json；未超龄 journal 挡住目录删除", () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-old");
    mkdirSync(join(poolDir, "home"), { recursive: true });
    writeFileSync(join(poolDir, "journal-bg-old.jsonl"), "{}\n");
    // 无 refs 对应的未超龄孤儿 journal（refs 丢失场景）——目录应保留
    writeFileSync(join(poolDir, "journal-bg-live.jsonl"), "{}\n");

    const aged = Date.now() / 1000 - 31 * 86400;
    utimesSync(join(poolDir, "journal-bg-old.jsonl"), aged, aged);

    cleanupExpiredPoolRefs(tmpRoot, TTL_MS);

    expect(existsSync(join(poolDir, "journal-bg-old.jsonl"))).toBe(false);
    expect(existsSync(join(poolDir, "journal-bg-live.jsonl"))).toBe(true);
    expect(existsSync(join(poolDir, "home"))).toBe(false); // 原生状态删
    expect(existsSync(join(poolDir, REFS_JSON_FILENAME))).toBe(false); // 空池 refs.json 随归零清理
    expect(existsSync(poolDir)).toBe(true); // 剩未超龄 journal，目录保留
  });

  it("refs 条目 ts 超龄且 journal 不存在 → 孤儿条目移除（防 refs 永久留置）", () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    acquirePool(tmpRoot, "zcode", "reviewer", "bg-orphan");
    // journal 从未落盘（run 从未产出事件）；条目 ts 已超龄 → 移除 → 归零（池内仅
    // refs.json，随归零清理，目录随之移除）
    const refsPath = join(poolDir, REFS_JSON_FILENAME);
    const refs = JSON.parse(readFileSync(refsPath, "utf8")) as { refs: Record<string, { ts: number }> };
    refs.refs["bg-orphan"]!.ts = Date.now() - 31 * 86400 * 1000;
    writeFileSync(refsPath, JSON.stringify(refs));

    cleanupExpiredPoolRefs(tmpRoot, TTL_MS);
    // 归零路径：refs.json 清理（无幻影引用残留）；空目录本体保留——与「只剩 journal
    // 保留目录」同语义（防与并发 acquire 的 mkdir/写 refs 竞争，目录无害）
    expect(existsSync(refsPath)).toBe(false);
    expect(readdirSync(poolDir)).toEqual([]);
  });

  it("无主超龄 journal（refs 丢失）回收；engines 根不存在时 no-op", () => {
    const poolDir = resolvePoolDir(tmpRoot, "zcode", "reviewer");
    mkdirSync(poolDir, { recursive: true });
    writeFileSync(join(poolDir, "journal-bg-x.jsonl"), "{}\n");
    const aged = Date.now() / 1000 - 31 * 86400;
    utimesSync(join(poolDir, "journal-bg-x.jsonl"), aged, aged);

    cleanupExpiredPoolRefs(tmpRoot, TTL_MS);
    expect(existsSync(join(poolDir, "journal-bg-x.jsonl"))).toBe(false);

    expect(() => cleanupExpiredPoolRefs(join(tmpRoot, "absent"), TTL_MS)).not.toThrow();
  });
});

describe("cleanupSpawnedFiles（单次性产物）", () => {
  it("keepForResume=true → 全部保留（resume 续接原 session，不重写产物）", () => {
    const f = join(tmpRoot, "prompt.txt");
    writeFileSync(f, "x");
    cleanupSpawnedFiles([f], { keepForResume: true });
    expect(existsSync(f)).toBe(true);
  });

  it("keepForResume=false → 删除；目录产物递归删", () => {
    const file = join(tmpRoot, "prompt.txt");
    const dir = join(tmpRoot, "persona");
    writeFileSync(file, "x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "persona.md"), "y");
    cleanupSpawnedFiles([file, dir], { keepForResume: false });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("不存在的路径幂等（ENOENT 忽略）；单条失败不 throw 其余继续", () => {
    const good = join(tmpRoot, "good.txt");
    writeFileSync(good, "x");
    // 真实 fs 下很难制造 rm 失败——用「父路径为文件」制造 ENOTDIR 失败：
    // rm(recursive, force) 对 «file/child» 形态报 ENOTDIR（force 只豁免 ENOENT）
    const blocked = join(tmpRoot, "plain-file", "child");
    writeFileSync(join(tmpRoot, "plain-file"), "not a dir");
    expect(() => cleanupSpawnedFiles([blocked, good], { keepForResume: false })).not.toThrow();
    expect(existsSync(good)).toBe(false);
  });
});
