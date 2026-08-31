// src/execution/engine/engines/zcode/appserver-home.ts
//
// [R4 D7] app-server 常驻 HOME 管理（设计 zcode-engine-appserver-resident.md §3.3
// D7 全量 + D6③ pidfile 孤儿自愈）。从 preparer.ts 拆出（单一关注点：常驻 HOME 的
// 所有权与引导；preparer.ts 保留 spawn 池语义）：
//   - 常驻 HOME = resolvePoolDir(engineDataDir,'zcode','home-appserver')（poolKey
//     固定名，锚定不变量 poolDir==HOME==db 所在目录——SQLite 落 HOME/.zcode/cli/db/
//     db.sqlite，journal 同落该池目录）；
//   - config.json 写入全部带 apiKey 的 provider（allProviders 引导——per-session
//     model 经 create 参数传递，不走 config.main 串池）；
//   - 凭据刷新按「provider 注册表内容 hash」比对（model.main 不参与——任务间换模型
//     不触发连接重建）；
//   - 目录锁（O_EXCL + 持锁宿主 pid + 心跳 mtime；活持有判定 = pid 活即持有，心跳
//     不参与否决）与 pidfile 孤儿回收（三重判据）。
//
// 依赖方向：本模块 import preparer 的源 config 读取件与结构化错误（同目录平级，无环）。

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "../../../../core/logger.ts";

import { resolvePoolDir } from "../../paths.ts";
import {
  ZCODE_APPSERVER_LOCKFILE_NAME,
  ZCODE_APPSERVER_LOCK_HEARTBEAT_MS,
  ZCODE_APPSERVER_MAX_DERIVED_HOMES,
  ZCODE_APPSERVER_PIDFILE_GRACE_MS,
  ZCODE_APPSERVER_PIDFILE_NAME,
  ZCODE_APPSERVER_POOL_KEY,
  ZCODE_ENGINE_ID,
  ZCODE_POOL_CONFIG_SUFFIX,
} from "./constants.ts";
import {
  CONFIG_INDENT_SPACES,
  ZcodePrepareError,
  defaultV2ConfigPath,
  hasApiKey,
  isProviderEntry,
  isRecord,
  readSourceConfig,
  type ZcodeProviderEntry,
  type ZcodeSourcePaths,
} from "./preparer.ts";

// core log facade（engines/zcode 目录惯例：模块顶层缓存，best-effort 清理路径的
// 最小留痕——见 taste/no-silent-catch 的「至少记录」要求）
const logger = getLogger("subagents");

/** 孤儿回收的退出轮询间隔（ms）。 */
const PID_REAP_POLL_INTERVAL_MS = 50;

/** 错误/日志出声用的 message 提取（非 Error 值不抛二次异常）。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================
// [R4 D7] app-server 常驻 HOME：allProviders 引导 + 内容 hash 刷新
// ============================================================

/** v2 config 内全部带 apiKey 的 provider（appserver HOME 的引导面——allProviders 方案）。 */
function providersWithKey(sources?: ZcodeSourcePaths): Map<string, ZcodeProviderEntry> {
  const v2 = readSourceConfig(sources?.v2ConfigPath ?? defaultV2ConfigPath());
  return new Map([...v2.providers.entries()].filter(([, e]) => hasApiKey(e)));
}

/**
 * provider 注册表的规范化内容 hash（D7 凭据刷新判据）。只覆盖 provider 数据——
 * model.main 刻意排除：任务间换模型是常态（per-session model），若计入 hash 会在
 * 每次模型切换时误判「凭据变化」杀掉常驻进程，冷启动收益归零。provider id 排序后
 * 序列化，防 v2 config 键序变化产生假差异。
 */
export function hashProviderRegistry(providers: Map<string, ZcodeProviderEntry>): string {
  const canonical: Array<[string, unknown]> = [...providers.keys()].sort().map((id) => [id, providers.get(id)]);
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** 常驻 HOME 内 config.json 的 provider 段 hash（读不出/损坏/无 provider 段 = undefined——恒判需重写）。 */
export function hashPoolConfigProviders(configPath: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed["provider"])) return undefined;
  const providers = new Map<string, ZcodeProviderEntry>();
  for (const [id, entry] of Object.entries(parsed["provider"])) {
    if (isProviderEntry(entry)) providers.set(id, entry);
  }
  return hashProviderRegistry(providers);
}

export interface AppServerConfigBootstrap {
  configPath: string;
  /** 本次是否实际重写（内容 hash 命中时 false——连接不重建，零开销）。 */
  wroteConfig: boolean;
  /** 引导后的 provider 注册表 hash（凭据刷新比对的落盘基准）。 */
  providerHash: string;
  /** 写入的 provider id 清单（诊断/断言面）。 */
  providerIds: string[];
}

/**
 * 引导 app-server 常驻 HOME 的 config（D7①）：写入全部带 apiKey 的 provider
 * （进程启动即要求 $HOME/.zcode/cli/config.json 有模型配置——缺失则 create 恒
 * -32603）。重写判据 = provider 注册表内容 hash 与池内现状不一致（内容基准取代
 * spawn 池的 mtime 基准：常驻 HOME 的 config 可能被本进程早前任务写就，mtime 比对
 * 无法识别「内容回退」形态）。model.main 一并落（create 未带 model 的兜底），但
 * 不参与 hash（见 hashProviderRegistry）。
 */
export function bootstrapAppServerConfig(opts: {
  homeDir: string;
  modelRef: string;
  sources?: ZcodeSourcePaths;
}): AppServerConfigBootstrap {
  const providers = providersWithKey(opts.sources);
  if (providers.size === 0) {
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `zcode 常驻 HOME 引导失败：v2 config 无任何带 apiKey 的 provider（${opts.sources?.v2ConfigPath ?? defaultV2ConfigPath()}）。` +
        `恢复指引：先在 ZCode 桌面端登录并配置 provider 后重试。`,
    );
  }
  const configPath = path.join(opts.homeDir, ...ZCODE_POOL_CONFIG_SUFFIX);
  const providerHash = hashProviderRegistry(providers);
  let wroteConfig = false;
  if (hashPoolConfigProviders(configPath) !== providerHash) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const providerObj: Record<string, unknown> = {};
    for (const [id, entry] of providers) providerObj[id] = entry;
    const payload = JSON.stringify({ model: { main: opts.modelRef }, provider: providerObj }, null, CONFIG_INDENT_SPACES);
    writeAtomic(configPath, payload);
    wroteConfig = true;
  }
  return { configPath, wroteConfig, providerHash, providerIds: [...providers.keys()] };
}

/** tmp+rename 原子写（跨进程并发下读者永远看到完整文件；spawn 池同款纪律）。 */
function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (err) {
      logger.debug(`[zcode-preparer] 原子写残留清理失败（${filePath}，best-effort）: ${errMessage(err)}`);
    }
  }
}

// ============================================================
// [R4 D7] 目录锁（lockfile：O_EXCL + 持锁宿主 pid + 心跳 mtime）
// ============================================================

/**
 * pid 活性探测（信号 0 探针）。EPERM = 进程存在但非本方所有（仍活）；
 * ESRCH = 已死。pid 归属纪律：本函数只用于 lockfile.pid（宿主进程）与 pidfile.pid
 * （app-server 进程）的活性判据，两文件的语义互不混用（D7 pid 归属分离钉死）。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** lockfile 内容（持锁宿主进程 pid + 获取时间；心跳只刷 mtime 不改内容）。 */
interface LockFileContent {
  pid: number;
  acquiredAt: number;
}

/** O_EXCL 创建 lockfile（已存在返回 false——互斥判据即 open 'wx' 的原子性）。 */
function tryCreateLock(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() } satisfies LockFileContent));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** 读 lockfile 的持锁 pid（损坏/缺失 = undefined——按无主处理走接管）。 */
function readLockPid(lockPath: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (isRecord(parsed) && typeof parsed["pid"] === "number") return parsed["pid"];
    return undefined;
  } catch {
    return undefined;
  }
}

/** 本进程是否仍持有该锁（引擎「已持有则跳过重复获取」的判据——自持锁对判定循环表现为活持有，会误派生）。 */
export function isLockHeldByUs(lockPath: string): boolean {
  return readLockPid(lockPath) === process.pid;
}

export interface AppServerHomeLockHooks {
  /**
   * 接管方删旧锁之后、O_EXCL 重建之前的窗口回调（测试注入——双接管者竞争闭环的
   * 确定性构造点：窗口内他方先行建锁，本方 O_EXCL 必失败、重走判定循环读到活 pid
   * → 派生）。生产不传。
   */
  afterTakeoverUnlink?: (lockPath: string) => void;
}

export interface AppServerHomeLock {
  /** 实际落定的池 key（固定名或派生后缀名——handle.poolKey 数据源）。 */
  poolKey: string;
  homeDir: string;
  lockPath: string;
  /** 是否经「锁无主接管」获得（D6③：仅接管路径触发 pidfile 孤儿回收）。 */
  tookOver: boolean;
}

/**
 * 常驻 HOME 目录锁判定（D7 所有权隔离）。「活持有」判定钉死：lockfile.pid 活 ⇒
 * 一律视为持有（新实例派生后缀目录 home-appserver-2…作自己的 HOME）——心跳 mtime
 * **不参与活持有否决**（桌面睡眠/长 GC 致心跳过期时误判死 → 偷锁双写同一 SQLite，
 * 不可接受），仅 pid 已死时用于锁破坏加速的观测。宿主死 ⇒ 锁无主 ⇒ 接管方接管：
 * 删旧锁 + O_EXCL 重建；O_EXCL 失败 = 他方已先行接管，失败方重走判定循环（读到
 * 对方活 pid → 派生）。
 */
export function acquireAppServerHomeLock(
  engineDataDir: string,
  opts: { pidAlive?: (pid: number) => boolean; hooks?: AppServerHomeLockHooks } = {},
): AppServerHomeLock {
  const pidAlive = opts.pidAlive ?? isPidAlive;
  for (let n = 1; n <= ZCODE_APPSERVER_MAX_DERIVED_HOMES; n++) {
    const name = n === 1 ? ZCODE_APPSERVER_POOL_KEY : `${ZCODE_APPSERVER_POOL_KEY}-${n}`;
    const homeDir = resolvePoolDir(engineDataDir, ZCODE_ENGINE_ID, name);
    fs.mkdirSync(homeDir, { recursive: true });
    const lockPath = path.join(homeDir, ZCODE_APPSERVER_LOCKFILE_NAME);
    let tookOver = false;
    for (;;) {
      if (tryCreateLock(lockPath)) return { poolKey: name, homeDir, lockPath, tookOver };
      const holder = readLockPid(lockPath);
      if (holder !== undefined && pidAlive(holder)) {
        // 活持有（心跳 mtime 不参与否决）：派生下一个目录，不碰他人 HOME/pidfile
        break;
      }
      // 锁无主（持锁宿主已死）/损坏残留：接管 = 删旧锁 + O_EXCL 重建
      tookOver = true;
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        // 恰被并发清理/消失——继续 O_EXCL 争夺即可
        logger.debug(`[zcode-preparer] 接管删锁失败（${lockPath}，继续争夺）: ${errMessage(err)}`);
      }
      opts.hooks?.afterTakeoverUnlink?.(lockPath);
      // 循环重走：O_EXCL 成功 = 接管完成；失败（EEXIST）= 他方先行——重读 pid，
      // 活 pid → break 派生；仍无主 → 再度接管争夺
    }
  }
  throw new Error(
    `[engine_run_failed] zcode 常驻 HOME 目录锁竞争超限（${ZCODE_APPSERVER_MAX_DERIVED_HOMES} 个派生目录全被活宿主持有）。` +
      `恢复指引：清理 ${resolvePoolDir(engineDataDir, ZCODE_ENGINE_ID, ZCODE_APPSERVER_POOL_KEY)} 下无主 lockfile 后重试。`,
  );
}

/**
 * 目录锁心跳（D7）：定期刷新 lockfile mtime。语义边界（钉死）：心跳只作观测面
 * （pid 已死时区分「崩溃残留 vs 活持有」的加速信息），绝不参与活持有否决。
 *
 * @returns 停跳函数（引擎 dispose 语义下通常无需停——锁随宿主进程存活，进程退出
 *          即无主；unref 保证不阻塞进程退出）
 */
export function startLockHeartbeat(lockPath: string): () => void {
  const timer = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
    } catch (err) {
      // 锁文件被接管方清理等场景：心跳停跳即可——debug 留痕，不外溢
      logger.debug(`[zcode-preparer] 锁心跳 touch 失败（${lockPath}，停跳）: ${errMessage(err)}`);
    }
  }, ZCODE_APPSERVER_LOCK_HEARTBEAT_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

// ============================================================
// [R4 D6③] pidfile 孤儿自愈（三重判据回收）
// ============================================================

/** pidfile 内容：app-server 进程 pid + 启动时间戳（ps lstart 输出原文）。 */
interface PidFileContent {
  pid: number;
  lstart?: string;
  startedAt: number;
}

function pidfilePath(homeDir: string): string {
  return path.join(homeDir, ZCODE_APPSERVER_PIDFILE_NAME);
}

function psField(pid: number, field: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), `-o`, `${field}=`], { encoding: "utf8", timeout: 2_000 }, (err, stdout) => {
      // ps 失败/进程消失：undefined（三重判据按不满足处理——漏回收可接受，误杀不可）
      resolve(err ? undefined : stdout.trim() || undefined);
    });
  });
}

/** 进程启动时间戳（ps lstart 原文——pid 复用封死判据）。 */
export function probePidLstart(pid: number): Promise<string | undefined> {
  return psField(pid, "lstart");
}

/** 进程命令行（ps command——app-server 形态匹配判据）。 */
export function probePidCommand(pid: number): Promise<string | undefined> {
  return psField(pid, "command");
}

/**
 * 常驻进程 spawn 后写 pidfile（D6③）。lstart 采集失败仍写 pid（届时三重判据中的
 * 时间戳判据不可满足 → 宁漏回收不误杀，wrapper 形态假阴性同口径）。
 */
export async function writeAppServerPidFile(homeDir: string, pid: number): Promise<void> {
  const content: PidFileContent = {
    pid,
    startedAt: Date.now(),
    ...(pid > 0 ? { lstart: await probePidLstart(pid) } : {}),
  };
  writeAtomic(pidfilePath(homeDir), JSON.stringify(content, null, CONFIG_INDENT_SPACES));
}

/** 回收判定结论（诊断/测试断言面）。 */
export type OrphanReapStatus =
  | "no-pidfile"
  | "pid-dead"
  | "criteria-mismatch"
  | "reaped";

/**
 * pidfile 孤儿自愈（D6③）。前提时序（钉死）：**先过 D7 目录锁判定**——本函数只在
 * 「锁无主、本方接管 HOME」后被调用（锁被活宿主持有时派生新 HOME，不触碰他人
 * pidfile）。三重判据全过才回收：pid 仍活 AND ps lstart 与 pidfile 记录一致（封死
 * pid 复用误杀）AND 命令行匹配 app-server 形态（wrapper 形态假阴性漏回收可接受）。
 * pidfile 在所有分支处理毕即清理（死 pid / 判据不符 = 陈旧记录，无保留价值）。
 */
export async function reapOrphanAppServer(homeDir: string, opts: { graceMs?: number } = {}): Promise<OrphanReapStatus> {
  const file = pidfilePath(homeDir);
  let content: PidFileContent | undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isRecord(parsed) && typeof parsed["pid"] === "number") {
      content = { pid: parsed["pid"], startedAt: 0, ...(typeof parsed["lstart"] === "string" ? { lstart: parsed["lstart"] } : {}) };
    }
  } catch {
    content = undefined;
  }
  if (content === undefined) return "no-pidfile";
  const unlinkPidfile = (): void => {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      logger.debug(`[zcode-preparer] pidfile 清理失败（${file}，已被并发清理则无妨）: ${errMessage(err)}`);
    }
  };
  if (!isPidAlive(content.pid)) {
    unlinkPidfile();
    return "pid-dead";
  }
  // 两次独立探测串行（互不依赖也互不需齐备——任一 undefined 即判据不满足）
  const lstart = await probePidLstart(content.pid);
  const command = await probePidCommand(content.pid);
  const lstartMatches = content.lstart !== undefined && lstart !== undefined && lstart === content.lstart;
  const commandMatches = command !== undefined && command.includes("app-server");
  if (lstartMatches && commandMatches) {
    reapPid(content.pid, opts.graceMs ?? ZCODE_APPSERVER_PIDFILE_GRACE_MS);
    unlinkPidfile();
    return "reaped";
  }
  // 判据不符（pid 被复用成无关进程 / wrapper 形态）：不杀，清陈旧 pidfile
  unlinkPidfile();
  return "criteria-mismatch";
}

/** 非 child 进程的回收：SIGTERM → 轮询 grace → SIGKILL（best-effort，异常吞掉）。 */
function reapPid(pid: number, graceMs: number): void {
  const killWith = (signal: NodeJS.Signals): void => {
    try {
      process.kill(pid, signal);
    } catch (err) {
      // 进程恰已退出——回收目的已达，debug 留痕
      logger.debug(`[zcode-preparer] 孤儿回收信号 ${signal} 未送达（pid ${pid}，可能已退出）: ${errMessage(err)}`);
    }
  };
  killWith("SIGTERM");
  const deadline = Date.now() + graceMs;
  const poll = (): void => {
    if (!isPidAlive(pid)) return;
    if (Date.now() >= deadline) {
      killWith("SIGKILL");
      return;
    }
    const t = setTimeout(poll, PID_REAP_POLL_INTERVAL_MS);
    if (typeof t.unref === "function") t.unref();
  };
  poll();
}

// ============================================================
// [R4 D7] 常驻 HOME 组合入口（锁 → 孤儿回收 → config 引导）
// ============================================================

export interface AppServerHomeHandle extends AppServerHomeLock, AppServerConfigBootstrap {
  /** 孤儿回收结论（非接管路径恒 "no-pidfile" 语义的 not-applicable 占位）。 */
  orphanReap: OrphanReapStatus | "not-applicable";
}

/**
 * 获取 app-server 常驻 HOME（每任务调用——含凭据刷新比对）。首次：目录锁判定
 * （活持有 → 派生；无主 → 接管 + pidfile 孤儿回收）+ config 引导。后续：config
 * 内容 hash 比对（不一致 → 重写，调用方据此重建连接）。锚定不变量：poolDir ==
 * HOME == db 所在目录（SQLite 落 HOME/.zcode/cli/db/db.sqlite；journal 同落该池，
 * 文件名 = record id 无冲突）。
 */
export async function acquireAppServerHome(opts: {
  engineDataDir: string;
  modelRef: string;
  sources?: ZcodeSourcePaths;
  pidAlive?: (pid: number) => boolean;
  hooks?: AppServerHomeLockHooks;
}): Promise<AppServerHomeHandle> {
  const lock = acquireAppServerHomeLock(opts.engineDataDir, {
    ...(opts.pidAlive !== undefined ? { pidAlive: opts.pidAlive } : {}),
    ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
  });
  // D6③ 时序钉死：仅接管路径（锁无主）才回收 pidfile——锁被活宿主持有时派生目录，
  // 派生目录内的 pidfile（若有）属本方历史残留之外的形态，不碰
  const orphanReap = lock.tookOver ? await reapOrphanAppServer(lock.homeDir) : "not-applicable";
  const boot = bootstrapAppServerConfig({ homeDir: lock.homeDir, modelRef: opts.modelRef, sources: opts.sources });
  return { ...lock, ...boot, orphanReap };
}
