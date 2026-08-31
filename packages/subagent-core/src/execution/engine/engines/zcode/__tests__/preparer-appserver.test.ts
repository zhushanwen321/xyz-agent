// preparer-appserver.test.ts —— [R4] D7 全量语义测试：常驻 HOME 锚定不变量 /
// allProviders 引导 / 凭据内容 hash 刷新 / 目录锁（O_EXCL 互斥、pid 活即持有、心跳
// 不参与否决、双接管者竞争闭环、派生后缀）/ pidfile 孤儿自愈三重判据（D6③）。
// 进程形态用真实短命 node 子进程（活 pid / 死 pid / 命令行形态匹配全真实验证，
// macOS 本机 ps 可用——CI 同构）。

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveJournalPath, resolvePoolDir } from "../../../paths.ts";
import {
  ZCODE_APPSERVER_LOCKFILE_NAME,
  ZCODE_APPSERVER_PIDFILE_NAME,
  ZCODE_APPSERVER_POOL_KEY,
  ZCODE_POOL_CONFIG_SUFFIX,
  ZCODE_POOL_DB_RELATIVE_PATH,
} from "../constants.ts";
import {
  acquireAppServerHome,
  acquireAppServerHomeLock,
  bootstrapAppServerConfig,
  hashPoolConfigProviders,
  hashProviderRegistry,
  isPidAlive,
  isLockHeldByUs,
  probePidLstart,
  reapOrphanAppServer,
  writeAppServerPidFile,
} from "../appserver-home.ts";

const PROVIDER_A = "prov-a";
const PROVIDER_B = "prov-b";

let tmpRoot: string;
let dataDir: string;
let v2Path: string;
/** 每用例启动的活子进程（afterAll 统一收割防泄漏）。 */
const liveChildren: ChildProcess[] = [];

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

function baseV2(): Record<string, unknown> {
  return {
    provider: {
      [PROVIDER_A]: { options: { apiKey: "key-a", baseURL: "https://a.example" }, models: { m1: {} } },
      [PROVIDER_B]: { options: { apiKey: "key-b" }, models: { m2: {} } },
      "no-key": { options: {}, models: { m3: {} } },
    },
  };
}

/** 活着的真实子进程（挂 30s——pid 活性/锁判定用）。 */
function liveChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  liveChildren.push(child);
  return child;
}

/** 命令行含 app-server 形态的活子进程（三重判据全过分支用）。 */
function appServerLikeChild(): ChildProcess {
  const child = spawn(
    process.execPath,
    ["-e", "/*app-server*/ setTimeout(() => {}, 30000)"],
    { stdio: "ignore" },
  );
  liveChildren.push(child);
  return child;
}

/** 已退出的子进程 pid（等退出完成——死 pid 判定用）。 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", (c) => resolve(c));
    child.once("error", () => resolve(-1));
  });
  expect(code).toBe(0);
  return child.pid ?? -1;
}

function writeLock(dir: string, pid: number, opts: { mtime?: Date } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, ZCODE_APPSERVER_LOCKFILE_NAME);
  fs.writeFileSync(lockPath, JSON.stringify({ pid, acquiredAt: Date.now() }));
  if (opts.mtime !== undefined) fs.utimesSync(lockPath, opts.mtime, opts.mtime);
  return lockPath;
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-prep-appserver-"));
  dataDir = path.join(tmpRoot, "data");
  v2Path = path.join(tmpRoot, "v2.json");
  writeJson(v2Path, baseV2());
});

afterEach(() => {
  for (const child of liveChildren.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出——无妨
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================
// 锚定不变量与 allProviders 引导（D7①）
// ============================================================

describe("常驻 HOME 锚定不变量 + allProviders 引导", () => {
  it("poolDir == HOME == db 所在目录：HOME=resolvePoolDir(...,'home-appserver')，dbPath 相对锚 HOME，journal 同落该池", async () => {
    const home = await acquireAppServerHome({ engineDataDir: dataDir, modelRef: `${PROVIDER_A}/m1`, sources: { v2ConfigPath: v2Path } });
    expect(home.poolKey).toBe(ZCODE_APPSERVER_POOL_KEY);
    const poolDir = resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY);
    expect(home.homeDir).toBe(poolDir);
    // db 锚定：dbPath 相对路径 join 池目录后即 SQLite 落点
    expect(path.join(home.homeDir, ZCODE_POOL_DB_RELATIVE_PATH)).toBe(
      path.join(poolDir, ".zcode", "cli", "db", "db.sqlite"),
    );
    // journal 同池（record id 文件名——任务间无冲突）
    expect(resolveJournalPath(dataDir, "zcode", home.poolKey, "bg-1")).toBe(
      path.join(poolDir, "journal-bg-1.jsonl"),
    );
    // 锁文件落 HOME 内
    expect(home.lockPath).toBe(path.join(poolDir, ZCODE_APPSERVER_LOCKFILE_NAME));
    expect(fs.existsSync(home.lockPath)).toBe(true);
  });

  it("config 写入全部带 apiKey 的 provider（无 apiKey 条目不写）；无 plugins 块；model.main 落任务模型", async () => {
    const home = await acquireAppServerHome({ engineDataDir: dataDir, modelRef: `${PROVIDER_B}/m2`, sources: { v2ConfigPath: v2Path } });
    expect(home.wroteConfig).toBe(true);
    expect(home.providerIds.sort()).toEqual([PROVIDER_A, PROVIDER_B]);
    const configPath = path.join(home.homeDir, ...ZCODE_POOL_CONFIG_SUFFIX);
    const written = readJson(configPath);
    const provider = written["provider"] as Record<string, unknown>;
    expect(Object.keys(provider).sort()).toEqual([PROVIDER_A, PROVIDER_B]);
    expect(written["model"]).toEqual({ main: `${PROVIDER_B}/m2` });
    expect("plugins" in written).toBe(false);
  });

  it("二次获取（同内容源）不重写 config（内容 hash 命中——mtime 免重写的常驻形态等价物）", async () => {
    const first = await acquireAppServerHome({ engineDataDir: dataDir, modelRef: `${PROVIDER_A}/m1`, sources: { v2ConfigPath: v2Path } });
    // 换模型（model.main 变化）+ 内容不变：hash 只覆盖 provider 段——不重写
    fs.utimesSync(v2Path, new Date(), new Date());
    const configPath = path.join(first.homeDir, ...ZCODE_POOL_CONFIG_SUFFIX);
    const before = fs.statSync(configPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    const second = await bootstrapAppServerConfig({ homeDir: first.homeDir, modelRef: `${PROVIDER_B}/m2`, sources: { v2ConfigPath: v2Path } });
    expect(second.wroteConfig).toBe(false);
    expect(fs.statSync(configPath).mtimeMs).toBe(before);
  });

  it("凭据变更（provider 内容变化）→ 内容 hash 不一致 → 重写", async () => {
    const first = await acquireAppServerHome({ engineDataDir: dataDir, modelRef: `${PROVIDER_A}/m1`, sources: { v2ConfigPath: v2Path } });
    const configPath = path.join(first.homeDir, ...ZCODE_POOL_CONFIG_SUFFIX);
    // hash 单点：池内现状 hash === 引导 hash
    expect(hashPoolConfigProviders(configPath)).toBe(first.providerHash);
    // 变更 apiKey
    const mutated = baseV2() as { provider: Record<string, { options: { apiKey: string } }> };
    mutated.provider[PROVIDER_A]!.options.apiKey = "key-a-v2";
    writeJson(v2Path, mutated);
    const second = await bootstrapAppServerConfig({ homeDir: first.homeDir, modelRef: `${PROVIDER_A}/m1`, sources: { v2ConfigPath: v2Path } });
    expect(second.wroteConfig).toBe(true);
    expect(hashPoolConfigProviders(configPath)).toBe(second.providerHash);
    const written = readJson(configPath)["provider"] as Record<string, { options: { apiKey: string } }>;
    expect(written[PROVIDER_A]!.options.apiKey).toBe("key-a-v2");
  });

  it("池内 config 损坏 → hash 判 undefined → 恒重写（torn write 防线）", async () => {
    const first = await acquireAppServerHome({ engineDataDir: dataDir, modelRef: `${PROVIDER_A}/m1`, sources: { v2ConfigPath: v2Path } });
    const configPath = path.join(first.homeDir, ...ZCODE_POOL_CONFIG_SUFFIX);
    fs.writeFileSync(configPath, "{torn", "utf8");
    expect(hashPoolConfigProviders(configPath)).toBeUndefined();
    const second = await bootstrapAppServerConfig({ homeDir: first.homeDir, modelRef: `${PROVIDER_A}/m1`, sources: { v2ConfigPath: v2Path } });
    expect(second.wroteConfig).toBe(true);
  });

  it("provider 全无 apiKey → 引导报 engine_credential_missing", async () => {
    writeJson(v2Path, { provider: { [PROVIDER_A]: { options: {} } } });
    await expect(
      acquireAppServerHome({ engineDataDir: dataDir, modelRef: `${PROVIDER_A}/m1`, sources: { v2ConfigPath: v2Path } }),
    ).rejects.toThrow(/engine_credential_missing/);
  });

  it("hashProviderRegistry：provider 键序变化不产生假差异；内容变化必差异", () => {
    const a = new Map([[PROVIDER_A, { options: { apiKey: "k" } }], [PROVIDER_B, { options: { apiKey: "k2" } }]]);
    const reordered = new Map([[PROVIDER_B, { options: { apiKey: "k2" } }], [PROVIDER_A, { options: { apiKey: "k" } }]]);
    expect(hashProviderRegistry(a)).toBe(hashProviderRegistry(reordered));
    const changed = new Map([[PROVIDER_A, { options: { apiKey: "k" } }], [PROVIDER_B, { options: { apiKey: "k3" } }]]);
    expect(hashProviderRegistry(a)).not.toBe(hashProviderRegistry(changed));
  });
});

// ============================================================
// 目录锁（D7 所有权隔离）
// ============================================================

describe("目录锁（O_EXCL / pid 活即持有 / 接管 / 派生）", () => {
  it("空目录 → O_EXCL 建锁获得固定名 HOME，lockfile.pid=本进程", () => {
    const lock = acquireAppServerHomeLock(dataDir);
    expect(lock.poolKey).toBe(ZCODE_APPSERVER_POOL_KEY);
    expect(lock.tookOver).toBe(false);
    expect(readJson(lock.lockPath)).toMatchObject({ pid: process.pid });
    expect(isLockHeldByUs(lock.lockPath)).toBe(true);
  });

  it("锁被活宿主持有 → 派生 home-appserver-2，不碰他人锁/pidfile", () => {
    const holder = liveChild();
    const base = resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY);
    writeLock(base, holder.pid!);
    // 他人 pidfile（D6③ 时序：活宿主持有时派生方不触碰）
    const pidfile = path.join(base, ZCODE_APPSERVER_PIDFILE_NAME);
    fs.writeFileSync(pidfile, JSON.stringify({ pid: holder.pid, lstart: "whatever" }));

    const lock = acquireAppServerHomeLock(dataDir);
    expect(lock.poolKey).toBe(`${ZCODE_APPSERVER_POOL_KEY}-2`);
    expect(lock.homeDir).not.toBe(base);
    // 他人锁原样（pid 未被改写）
    expect(readJson(path.join(base, ZCODE_APPSERVER_LOCKFILE_NAME))).toMatchObject({ pid: holder.pid });
    // 他人 pidfile 原样
    expect(fs.existsSync(pidfile)).toBe(true);
  });

  it("pid 活即持有：心跳 mtime 过期不参与否决（古老 mtime 仍判活 → 派生）", () => {
    const holder = liveChild();
    const base = resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY);
    const ancient = new Date(Date.now() - 3 * 60 * 60 * 1000);
    writeLock(base, holder.pid!, { mtime: ancient });
    const lock = acquireAppServerHomeLock(dataDir);
    expect(lock.poolKey).toBe(`${ZCODE_APPSERVER_POOL_KEY}-2`); // 未被偷锁
  });

  it("持锁宿主已死 → 接管：删旧锁 + O_EXCL 重建（lockfile.pid=本进程，HOME 用固定名）", async () => {
    const dead = await deadPid();
    expect(isPidAlive(dead)).toBe(false);
    const base = resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY);
    writeLock(base, dead);
    const lock = acquireAppServerHomeLock(dataDir);
    expect(lock.poolKey).toBe(ZCODE_APPSERVER_POOL_KEY); // 接管固定名 HOME
    expect(lock.tookOver).toBe(true);
    expect(readJson(lock.lockPath)).toMatchObject({ pid: process.pid });
  });

  it("双接管者竞争闭环：接管 unlink 后他方先行建锁（活 pid）→ 本方 O_EXCL 失败重走循环 → 派生", async () => {
    const dead = await deadPid();
    const base = resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY);
    writeLock(base, dead);
    const rival = liveChild();
    const lock = acquireAppServerHomeLock(dataDir, {
      hooks: {
        // 竞争窗口注入：本方删旧锁后、O_EXCL 前，他方抢先以活 pid 建锁
        afterTakeoverUnlink: (lockPath) => {
          fs.writeFileSync(lockPath, JSON.stringify({ pid: rival.pid, acquiredAt: Date.now() }));
        },
      },
    });
    // 本方 O_EXCL 失败 → 重读锁 → 活 pid（rival）→ 派生 -2；且 rival 的锁未被覆盖
    expect(lock.poolKey).toBe(`${ZCODE_APPSERVER_POOL_KEY}-2`);
    expect(readJson(path.join(base, ZCODE_APPSERVER_LOCKFILE_NAME))).toMatchObject({ pid: rival.pid });
  });

  it("锁文件损坏（非 JSON）→ 按无主接管重建", () => {
    const base = resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, ZCODE_APPSERVER_LOCKFILE_NAME), "not json");
    const lock = acquireAppServerHomeLock(dataDir);
    expect(lock.poolKey).toBe(ZCODE_APPSERVER_POOL_KEY);
    expect(lock.tookOver).toBe(true);
  });

  it("acquireAppServerHome 组合：接管路径触发 pidfile 孤儿回收，非接管路径不触发", async () => {
    // 非接管（空目录）：orphanReap 恒 not-applicable
    const fresh = await acquireAppServerHome({ engineDataDir: dataDir, modelRef: `${PROVIDER_A}/m1`, sources: { v2ConfigPath: v2Path } });
    expect(fresh.orphanReap).toBe("not-applicable");
    // 接管（死宿主锁 + 无 pidfile）：回收执行（no-pidfile 分支）
    const dead = await deadPid();
    writeLock(resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY), dead);
    // 锁被本进程测试进程重新持有前需先释放（acquire 会接管同目录——直接再跑组合入口）
    const took = await acquireAppServerHome({ engineDataDir: dataDir, modelRef: `${PROVIDER_A}/m1`, sources: { v2ConfigPath: v2Path } });
    expect(took.tookOver).toBe(true);
    expect(["no-pidfile", "pid-dead", "criteria-mismatch", "reaped"]).toContain(took.orphanReap);
  });
});

// ============================================================
// pidfile 孤儿自愈三重判据（D6③）
// ============================================================

describe("pidfile 孤儿自愈（三重判据）", () => {
  it("三判据全过（pid 活 + lstart 一致 + 命令行含 app-server）→ 回收（SIGTERM）+ pidfile 清理", async () => {
    const homeDir = resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY);
    fs.mkdirSync(homeDir, { recursive: true });
    const orphan = appServerLikeChild();
    await writeAppServerPidFile(homeDir, orphan.pid!);
    const status = await reapOrphanAppServer(homeDir, { graceMs: 500 });
    expect(status).toBe("reaped");
    expect(fs.existsSync(path.join(homeDir, ZCODE_APPSERVER_PIDFILE_NAME))).toBe(false);
    // 回收生效：进程在 grace 内死亡（SIGTERM 对 node 默认终止）
    await vi.waitFor(() => expect(isPidAlive(orphan.pid!)).toBe(false), { timeout: 3_000 });
  });

  it("时间戳不一致（pid 活但 lstart 不符——pid 复用形态）→ 不杀，清陈旧 pidfile", async () => {
    const homeDir = resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY);
    fs.mkdirSync(homeDir, { recursive: true });
    const victim = appServerLikeChild();
    fs.writeFileSync(
      path.join(homeDir, ZCODE_APPSERVER_PIDFILE_NAME),
      JSON.stringify({ pid: victim.pid, lstart: "Mon Jan  1 00:00:00 2020", startedAt: 1 }),
    );
    const status = await reapOrphanAppServer(homeDir);
    expect(status).toBe("criteria-mismatch");
    expect(isPidAlive(victim.pid!)).toBe(true); // 不误杀
    expect(fs.existsSync(path.join(homeDir, ZCODE_APPSERVER_PIDFILE_NAME))).toBe(false);
  });

  it("命令行不匹配 app-server 形态（wrapper 假阴性）→ 不杀，清陈旧 pidfile", async () => {
    const homeDir = resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY);
    fs.mkdirSync(homeDir, { recursive: true });
    const victim = liveChild(); // 普通 node -e setTimeout——无 app-server 字样
    const lstart = await probePidLstart(victim.pid!);
    expect(lstart).toBeDefined();
    fs.writeFileSync(
      path.join(homeDir, ZCODE_APPSERVER_PIDFILE_NAME),
      JSON.stringify({ pid: victim.pid, lstart, startedAt: Date.now() }),
    );
    const status = await reapOrphanAppServer(homeDir);
    expect(status).toBe("criteria-mismatch");
    expect(isPidAlive(victim.pid!)).toBe(true);
  });

  it("pid 已死（宿主崩溃残留）→ 不杀任何进程，清陈旧 pidfile", async () => {
    const homeDir = resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY);
    fs.mkdirSync(homeDir, { recursive: true });
    const dead = await deadPid();
    fs.writeFileSync(
      path.join(homeDir, ZCODE_APPSERVER_PIDFILE_NAME),
      JSON.stringify({ pid: dead, lstart: "x", startedAt: 1 }),
    );
    expect(await reapOrphanAppServer(homeDir)).toBe("pid-dead");
    expect(fs.existsSync(path.join(homeDir, ZCODE_APPSERVER_PIDFILE_NAME))).toBe(false);
  });

  it("无 pidfile → no-op", async () => {
    const homeDir = resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY);
    fs.mkdirSync(homeDir, { recursive: true });
    expect(await reapOrphanAppServer(homeDir)).toBe("no-pidfile");
  });

  it("writeAppServerPidFile 记录真实 ps lstart（三重判据数据源自洽）", async () => {
    const homeDir = resolvePoolDir(dataDir, "zcode", ZCODE_APPSERVER_POOL_KEY);
    fs.mkdirSync(homeDir, { recursive: true });
    const child = appServerLikeChild();
    await writeAppServerPidFile(homeDir, child.pid!);
    const pidfile = readJson(path.join(homeDir, ZCODE_APPSERVER_PIDFILE_NAME));
    expect(pidfile["pid"]).toBe(child.pid);
    const recorded = pidfile["lstart"];
    expect(typeof recorded).toBe("string");
    expect(recorded).toBe(await probePidLstart(child.pid!));
  });
});

// ============================================================
// pid 活性探测边界
// ============================================================

describe("isPidAlive 边界", () => {
  it("非法 pid / pid 0 / 负值 → 恒死", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});
