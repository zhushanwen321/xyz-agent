// zcode-session-db-pool-gc.test.ts —— 池 GC 守卫（验收场景 A9 / 设计 §3.3 不变量 6，
// 反向不变量：TTL 扫描枚举 session-db/ 伪池但绝不删隔离库）。
//
// 为什么必须有这条守卫（设计 D4）：隔离库不在池目录内，但 `cleanupExpiredPoolRefs`
// 把 `engines/<engineId>/` 下每个子目录都当池遍历——`session-db/` 因此被当「伪池」
// 枚举。对 `db.sqlite*` 不匹配任何删除条件（无 refs.json → hadRefs=false 早退；
// removeOrphanJournals 只匹配 journal-*.jsonl），但这是**隐式假设而非结构保证**
// ——一旦 changed=true 扫描还会向该目录写 refs.json。本测试经**公共 API**
// （acquirePool / releasePoolRef / cleanupExpiredPoolRefs，禁用模块私有的
// deletePoolNativeState）+ 注入 spy fs 的枚举断言把该假设钉死。
//
// 步骤（impl-plan §2.3 A9 可执行步骤）：dataDir=mkdtempSync → mkdirSync(父目录，
// recursive) → 写三件套 → (a) acquirePool + releasePoolRef 归零 →
// (b) cleanupExpiredPoolRefs(dataDir, 0, spyFs)。

import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquirePool,
  cleanupExpiredPoolRefs,
  releasePoolRef,
  REFS_JSON_FILENAME,
  type PoolFsDeps,
} from "../../../common/pool-manager.ts";
import { resolvePoolDir } from "../../../paths.ts";
import { ZCODE_SHARED_POOL_KEY } from "../constants.ts";
import { zcodeSessionDbPath } from "../db-path.ts";

const TASK_ID = "sa-pool-gc";

/** 真实 fs 包装 + readdirSync 调用路径记录（断言②「扫描真进入 session-db/」的数据源）。 */
function makeSpyFs(): { fs: PoolFsDeps; readdirCalls: string[] } {
  const readdirCalls: string[] = [];
  const spyFs: PoolFsDeps = {
    mkdirSync: (p, o) => fsSync.mkdirSync(p, o),
    readdirSync: (p) => {
      readdirCalls.push(p);
      return fsSync.readdirSync(p, { withFileTypes: true });
    },
    statSync: (p) => fsSync.statSync(p),
    existsSync: (p) => fsSync.existsSync(p),
    readFileSync: (p) => fsSync.readFileSync(p, "utf8"),
    writeFileSync: (p, d) => fsSync.writeFileSync(p, d, "utf8"),
    renameSync: (from, to) => fsSync.renameSync(from, to),
    rmSync: (p, o) => fsSync.rmSync(p, o),
    rmdirSync: (p) => fsSync.rmdirSync(p),
  };
  return { fs: spyFs, readdirCalls };
}

describe("池 GC 守卫（A9：TTL 扫描枚举 session-db/ 伪池但不删隔离库）", () => {
  let dataDir: string;
  let sessionDb: string;
  let sessionDbDir: string;
  /** 三件套路径 → 写入字节（断言①「字节不变」的前后比对基准）。 */
  let trio: Array<{ file: string; bytes: Buffer }>;

  beforeEach(() => {
    dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "zcode-pool-gc-"));
    sessionDb = zcodeSessionDbPath(dataDir);
    // A9 步骤明确：mkdirSync 入参是**父目录**，不是 dbPath 本身
    sessionDbDir = path.dirname(sessionDb);
    fsSync.mkdirSync(sessionDbDir, { recursive: true });
    trio = ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"].map((name, i) => {
      const file = path.join(sessionDbDir, name);
      const bytes = Buffer.from(`isolation-db-bytes-${i}`);
      fsSync.writeFileSync(file, bytes);
      return { file, bytes };
    });
  });

  afterEach(() => {
    fsSync.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("(a)+(b) 归零删除与 TTL 扫描后：三件套字节不变 + 扫描真进入 session-db/ + 池原生状态照常清理 + 隔离库在池目录外", () => {
    // ── (a) acquirePool + releasePoolRef 归零（公共 API）──
    acquirePool(dataDir, "zcode", ZCODE_SHARED_POOL_KEY, TASK_ID);
    releasePoolRef(dataDir, "zcode", ZCODE_SHARED_POOL_KEY, TASK_ID);

    // 断言③：池目录原生状态照常清理——refs.json 被删（refs 归零 →
    // deletePoolNativeState）；池目录本身不被 rmdir（目录内只剩 journal（含空）时
    // early-return，journal 生命周期跟随 record 的保留语义）
    const poolDir = resolvePoolDir(dataDir, "zcode", ZCODE_SHARED_POOL_KEY);
    expect(fsSync.existsSync(path.join(poolDir, REFS_JSON_FILENAME))).toBe(false);
    expect(fsSync.existsSync(poolDir)).toBe(true);

    // ── (b) TTL 扫描（TTL 归零 + 注入 spy fs）──
    const { fs: spyFs, readdirCalls } = makeSpyFs();
    cleanupExpiredPoolRefs(dataDir, 0, spyFs);

    // 断言①：三件套字节不变（不匹配任何删除条件——hadRefs 早退 + journal 名不匹配）
    for (const { file, bytes } of trio) {
      expect(fsSync.existsSync(file)).toBe(true);
      expect(fsSync.readFileSync(file).equals(bytes)).toBe(true);
    }
    // 强化（D4）：changed=false 时不向伪池写 refs.json——session-db/ 保持原生状态
    expect(fsSync.existsSync(path.join(sessionDbDir, REFS_JSON_FILENAME))).toBe(false);

    // 断言②：枚举断言——spy 的 readdirSync 调用序列命中 engines/zcode/session-db
    // （证明扫描真进入该目录逐条目判定，不是「没扫到」的假通过）
    expect(readdirCalls).toContain(sessionDbDir);

    // 断言③（续）：TTL 扫描后池目录原生状态结论不变（shared/ 无 refs、目录保留）
    expect(fsSync.existsSync(path.join(poolDir, REFS_JSON_FILENAME))).toBe(false);
    expect(fsSync.existsSync(poolDir)).toBe(true);

    // 断言④：隔离库不在池目录之下（结构性选址保证，与 (a)(b) 行为断言互补）
    const rel = path.relative(resolvePoolDir(dataDir, "zcode", ZCODE_SHARED_POOL_KEY), sessionDb);
    expect(rel.startsWith("..")).toBe(true);
  });
});
