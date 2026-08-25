/**
 * reaper 孤儿收殓（M5，设计文档 docs/design/base-tool-enhance.md §3.5 数据流末段 /
 * §2.3 术语 ownerPiPid·reaper / §3.3 D8·D12 / §3.6「reaper 误判防御」/ §4 S5·S8-B）。
 *
 * 职责：任意 session 启动时扫描 <dataDir>/base-tool-enhance/ 下全部 sessionId
 * 目录的 registry.json，按**属主判定**处置孤儿——pi 被强杀（SIGKILL）/崩溃后
 * detached 后台任务被 init 收养永久存活的兜底防线。R4 轮教训：「一律收殓」会
 * 误杀桌面端并行 session（每 session 独立 pi 进程）的合法任务——**属主判定是
 * 这道防线的全部依据，宁可漏杀不可误杀**。
 *
 * 三分支判定（§3.5 原文逐字落实）：
 *  ①属主判定——条目 ownerPiPid 进程仍活 → 跳过（活进程的合法任务，桌面端并行
 *    session 的常态；kill(pid,0) 判活，ESRCH=死）
 *  ②孤儿补杀——属主已死 && 任务 pid 存活 → kill-tree 补杀（复用 kill-tree.ts）
 *    + registry 标 state:"orphaned"
 *  ③终态收尾——属主已死 && 任务 pid 已死 && 条目仍 running（graceful 收殓写盘
 *    没完成的遗留）→ 不补杀，仅转终态 state:"orphaned"（registry 终态闭环，
 *    M3 对账以此判据）
 *
 * killing 条目：属主死 → 一并按孤儿处理（bash_kill 已发令但属主死前没等到轮询
 * 边沿确认，补杀幂等无害）；属主活 → 跳过（属主自己的轮询器正在收尾瞬态）。
 * exited/orphaned 已终态跳过——这是二次扫描幂等 no-op 的构造性来源。
 *
 * pid 复用防御（§3.6）：判「任务 pid 存活」时校验进程 start time，与条目登记值
 * 不匹配视为已死（防系统复用 pid 后误杀无辜进程）；无法取 start time 的平台
 * 保守跳过整个处置（宁延迟勿误杀，worktree-manager 同原则）。终态收尾分支③
 * 无需校验——kill(pid,0) ESRCH 无歧义，校验只服务「判活防复用」。
 *
 * 已知缺口→已闭合（M3 补写）：spawn 侧现已写入 pidStartTime（spawn-background.ts
 * spawn 后读 ps start time，读取失败省略），新条目走精确比较（同单位 epoch 秒）。
 * 存量旧条目（M3 之前登记、缺该字段）仍降级用 startedAt 秒级校验兜底：
 * actualStartSec <= floor(startedAt/1000) 视为原进程——登记发生在 spawn 之后（进程
 * 先启动、条目后登记），原进程必然满足降级判据（floor 单调性，零误跳）。误杀窗口
 * 如实描述：原进程可在 spawn 与登记之间的毫秒窗口内死亡，pid 又被复用——复用进程
 * 的 start time 只需晚于原进程死亡（不必然晚于登记时刻），故降级判据的实际误杀窗口
 * 是「spawn 所在秒内原进程死亡且 pid 被复用」（含登记前死亡+复用与登记后同秒复用
 * 两种形态），不止「登记后同秒」（概率趋零，方向已登记）。
 *
 * 多进程并发串行化：扫描/补杀/写 registry 全程持跨进程文件锁（固定名
 * reaper.lock）——防两个 pi 进程同时 reap 同一批条目（kill 幂等无害，但 RMW
 * 写会交错覆盖终态）。误杀防御不依赖锁（属主判定承担），锁只消灭扫描/写入
 * 交错。fn 内全同步（readdir/read/kill/write 毫秒级），满足 file-lock
 * 「fn 内禁止任何 await」契约；registry 条目写在 reaper 锁内再取 registry.json
 * 自身的锁（writeRegistryEntry 内部）——锁序恒为 reaper.lock → registry 锁，
 * spawn 侧只取 registry 锁，无环无死锁。
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { getLogger } from "@zhushanwen/pi-extension-logger";
import { withFileLock } from "@zhushanwen/pi-file-lock";

import { getBaseToolEnhanceDir, readRegistry, writeRegistryEntry } from "./background/registry.ts";
import { isActiveState, type RegistryEntry } from "./background/types.ts";
import { isPidAlive, killProcessTree } from "./kill-tree.ts";

const logger = getLogger("base-tool-enhance");

/** ps 调用超时：卡死的 ps 不拖垮 reaper（超时按取不到处理 → 保守跳过）。 */
const PS_TIMEOUT_MS = 5000;
/** 毫秒 → 秒（epoch 秒换算，spawn-background.ts 同名常量先例）。 */
const MS_PER_SECOND = 1000;

/**
 * 锁目标名（proper-lockfile 落 <目标>.lock；4.x 实测锁文件是 **mkdir 目录**形态，
 * 不是普通文件——扫描时须按名排除，否则每轮对锁目录做一次无谓 readRegistry
 * 且计入 scannedDirs）。
 */
const REAPER_LOCK_TARGET = "reaper";

/**
 * registry 条目扩展字段（M5 reaper 引入；M3 起 spawn 侧已补写——types.ts
 * RegistryEntry 直接携带 pidStartTime，本接口保留为 reaper 视角的显式声明与
 * 存量条目（M3 前登记）的读取形状）。单位 epoch 秒（ps -o lstart= 解析值），
 * 勿混用 /proc tick 毫秒值。
 */
export interface RegistryEntryStartTime {
	pidStartTime?: number;
}

/** reaper 视角的 registry 条目（M2 RegistryEntry + start time 扩展字段）。 */
export type ReaperRegistryEntry = RegistryEntry & RegistryEntryStartTime;

/** 读条目扩展字段（运行时 guard：in + typeof + 有限性，防脏数据混入比较）。 */
function readPidStartTimeSec(entry: RegistryEntry): number | undefined {
	if ("pidStartTime" in entry) {
		const registered = (entry as ReaperRegistryEntry).pidStartTime;
		if (typeof registered === "number" && Number.isFinite(registered)) {
			return registered;
		}
	}
	return undefined;
}

/**
 * 取进程 start time（epoch 秒）。ps -o lstart= 跨 macOS/Linux（Linux /proc/
 * <pid>/stat 精度更高但 macOS 无 /proc，统一 ps 保跨平台一致）；= 号去表头。
 * 返回 undefined：进程不存在 / ps 不可用 / 输出不可解析——调用方一律按
 * 「无法校验 → 保守跳过」处理。
 */
export function getProcessStartTimeSec(pid: number): number | undefined {
	let result: SpawnSyncReturns<string>;
	try {
		result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: PS_TIMEOUT_MS,
		});
	} catch {
		return undefined;
	}
	if (result.error || result.status !== 0 || !result.stdout) return undefined;
	// lstart 形如 "Mon Aug 25 14:23:45 2026"（本地时区），Date.parse 按本地时区解释
	const ms = Date.parse(result.stdout.trim());
	return Number.isNaN(ms) ? undefined : Math.floor(ms / MS_PER_SECOND);
}

/** 单轮扫描统计（日志 + 测试断言面；写失败单独计数保持守恒）。 */
export interface ReapResult {
	/** 扫描的 sessionId 目录数（含无 registry / 无活跃条目的目录）。 */
	scannedDirs: number;
	/** 分支①跳过：属主活（含 ownerPiPid === 本进程的防御性跳过）。 */
	ownerAliveSkipped: number;
	/** 分支②补杀成功：kill-tree 已发令 + orphaned 终态写入。 */
	killedOrphans: number;
	/** 分支③终态收尾成功：未补杀，仅转 orphaned。 */
	finalizedOrphans: number;
	/** 保守跳过：start time 无法获取 / 复用嫌疑不匹配（含锁内写失败条目停留 running）。 */
	conservativelySkipped: number;
}

export interface ReapOptions {
	/** 测试接缝：进程 start time 获取（epoch 秒）。默认真实 ps。 */
	getProcessStartTimeSec?: (pid: number) => number | undefined;
}

/**
 * 扫描并处置孤儿（跨进程文件锁内执行）。幂等：终态条目跳过 + 属主活跳过，
 * 二次扫描对已处置孤儿天然 no-op。锁获取失败（重试耗尽）抛 ELOCKED 给调用方
 * ——孤儿保持原状，下一 session_start 重试，无害。
 */
export async function reapOrphanedTasks(dataDir: string, opts: ReapOptions = {}): Promise<ReapResult> {
	const getStartSec = opts.getProcessStartTimeSec ?? getProcessStartTimeSec;
	const baseDir = getBaseToolEnhanceDir(dataDir);
	// 锁目标传 reaper（proper-lockfile 落 <目标>.lock = reaper.lock，固定名）
	return withFileLock(join(baseDir, REAPER_LOCK_TARGET), () =>
		Promise.resolve(scanAndReapSync(baseDir, getStartSec)),
	);
}

function emptyResult(): ReapResult {
	return { scannedDirs: 0, ownerAliveSkipped: 0, killedOrphans: 0, finalizedOrphans: 0, conservativelySkipped: 0 };
}

function scanAndReapSync(
	baseDir: string,
	getStartSec: (pid: number) => number | undefined,
): ReapResult {
	const result = emptyResult();
	let dirents: Dirent[];
	try {
		dirents = readdirSync(baseDir, { withFileTypes: true });
	} catch (err) {
		// baseDir 不存在（从未有过后台任务）是常态，不告警；读失败（权限等）warn 后放弃本轮
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.warn("reaper: base dir unreadable, skipping this scan", {
				detail: { dir: baseDir, err: err instanceof Error ? err.message : String(err) },
			});
		}
		return result;
	}
	for (const dirent of dirents) {
		// reaper.lock（proper-lockfile mkdir 目录形态）与 .DS_Store 等非 session 目录跳过
		if (!dirent.isDirectory() || dirent.name === `${REAPER_LOCK_TARGET}.lock`) continue;
		result.scannedDirs++;
		try {
			reapSessionDirSync(join(baseDir, dirent.name), getStartSec, result);
		} catch (err) {
			// 错误容忍：单目录失败跳过 + warn，不中断整体扫描（readRegistry 已内建
			// 损坏防御 rename .corrupt + 空表重建，此处 catch 是目录级双保险）
			logger.warn("reaper: session dir scan failed, skipping dir", {
				detail: { dir: dirent.name, err: err instanceof Error ? err.message : String(err) },
			});
		}
	}
	return result;
}

function reapSessionDirSync(
	sessionDir: string,
	getStartSec: (pid: number) => number | undefined,
	result: ReapResult,
): void {
	const registryPath = join(sessionDir, "registry.json");
	// 不存在 → 空表；损坏 → .corrupt 保留现场 + 空表重建（M2 内建防御，双保险）
	const entries = readRegistry(registryPath);
	for (const entry of entries.values()) {
		if (!isActiveState(entry.state)) continue; // exited/orphaned 终态跳过
		reapEntrySync(entry, registryPath, getStartSec, result);
	}
}

/** 三分支判定主体（§3.5 原文；注释里的 ①②③ 与文件头逐条对应）。 */
function reapEntrySync(
	entry: RegistryEntry,
	registryPath: string,
	getStartSec: (pid: number) => number | undefined,
	result: ReapResult,
): void {
	// ①属主判定：ownerPiPid === 当前进程 pid = 自己进程的条目出现在别的 session
	// 目录（理论不该发生——单例表条目唯一来源是本进程 spawn；防御性视为属主活）。
	// ephemeral 短命附着进程触发 reaper 时，其他进程的任务属主活 → 此处天然
	// 跳过，无需特判。reaper 永不介入属主存活的挂死任务（bash_kill / 用户职责）。
	if (entry.ownerPiPid === process.pid || isPidAlive(entry.ownerPiPid)) {
		result.ownerAliveSkipped++;
		return;
	}

	// 属主已死 → 孤儿身份成立，按任务 pid 死活分流
	if (!isPidAlive(entry.pid)) {
		// ③终态收尾：任务 pid 已死但条目仍 running/killing（graceful 收殓的
		// registry 写入没写完/写不进的遗留）→ 不补杀，仅转终态 orphaned——
		// 保证 registry 终态闭环，对账判据才有依据。ESRCH 无歧义，无需
		// start-time 校验（校验只服务「判活防复用」）
		writeOrphanedTerminal(entry, registryPath, "finalized", result);
		return;
	}

	// 任务 pid 存活 → ②孤儿补杀前先过 pid 复用防御（§3.6）
	const actualStartSec = getStartSec(entry.pid);
	if (actualStartSec === undefined) {
		// 无法取 start time（平台无 ps / ps 失败 / 输出不可解析）→ 保守跳过
		// 整个处置：不补杀（可能误杀复用 pid 上的无辜进程）也不转终态（条目
		// 停留 running，下一 session_start 重试）。宁延迟勿误杀
		result.conservativelySkipped++;
		logger.warn("reaper: cannot read pid start time, conservatively skipping entry", {
			detail: { taskId: entry.taskId, pid: entry.pid, ownerPiPid: entry.ownerPiPid },
		});
		return;
	}
	const registeredStartSec = readPidStartTimeSec(entry);
	const matchesRegistered =
		registeredStartSec !== undefined
			? actualStartSec === registeredStartSec
			: // 降级校验（M3 前登记、缺 pidStartTime 的存量条目，见文件头「已知缺口→已闭合」）
				actualStartSec <= Math.floor(entry.startedAt / MS_PER_SECOND);
	if (!matchesRegistered) {
		// start time 与登记值不匹配 = pid 已被系统复用，当前占用者是无关新进程
		// → 视为已死：不误杀，也不转终态（任务真实死活未知，交下一周期）
		result.conservativelySkipped++;
		logger.warn("reaper: pid start time mismatch (likely pid reuse), skipping entry", {
			detail: {
				taskId: entry.taskId,
				pid: entry.pid,
				ownerPiPid: entry.ownerPiPid,
				actualStartSec,
				registeredStartSec,
			},
		});
		return;
	}

	// ②孤儿补杀：属主已死 + 原进程身份成立（pid 活 + start time 匹配）
	killProcessTree(entry.pid);
	logger.warn("reaper: orphan task killed", {
		detail: { taskId: entry.taskId, pid: entry.pid, ownerPiPid: entry.ownerPiPid, command: entry.command },
	});
	writeOrphanedTerminal(entry, registryPath, "killed", result);
}

/**
 * 写 orphaned 终态（分支②③共用）。reason 不写：reason 枚举（natural/timeout/
 * killed/process-exit）属 exited 语义，orphaned 的成因（属主强杀遗留）不在
 * 枚举内，保持 undefined 而非造词。
 */
function writeOrphanedTerminal(
	entry: RegistryEntry,
	registryPath: string,
	kind: "killed" | "finalized",
	result: ReapResult,
): void {
	const endedAt = Date.now();
	const orphaned: ReaperRegistryEntry = {
		...entry,
		state: "orphaned",
		endedAt,
		durationMs: endedAt - entry.startedAt,
	};
	const written = writeRegistryEntry(registryPath, orphaned);
	if (!written.success) {
		// 写失败：条目停留 running。补杀分支进程已死，下一轮 reap 走③收尾；
		// 终态收尾分支下一轮重试——幂等闭环，无静默丢失
		result.conservativelySkipped++;
		return;
	}
	if (kind === "killed") result.killedOrphans++;
	else result.finalizedOrphans++;
}
