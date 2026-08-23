/**
 * Statusline 数据缓存层
 *
 * 架构（重构后）：
 *   - 各 provider 单独实现在 providers/*.ts，通过 PROVIDERS 注册表管理
 *   - cache.ts 只负责：TTL 缓存、并发控制、Promise.allSettled 拉取、磁盘持久化
 *   - 新增 provider：实现 QuotaProvider 接口 → 在 PROVIDERS 注册（零改动 cache.ts）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { getCachePath, getProvidersConfigPath, getSpeedDir } from "./paths.js";

const logger = getLogger("quota-cache");
// 架构修复：doUpdate 用 buildRuntimeProviders() 替代静态 PROVIDERS，
// 使 providers.json 中 enabled=false 的 provider 不会被 fetch。
// registry.ts 内部 import PROVIDERS，此处不直接引用。
import { buildRuntimeProviders } from "./registry.js";
import { avgSpeed, type SpeedRecord } from "./speed.js";
import { MIN_PER_HOUR, MS_PER_SEC, SEC_PER_DAY, SEC_PER_MIN } from "./time.js";

const DAY_MS = SEC_PER_DAY * MS_PER_SEC;

// ── 缓存 / 统计常量 ─────────────────────────────────────

/** 套餐用量刷新间隔（2 分钟） */
const TTL_MINUTES = 2;
const CACHE_TTL_MS = TTL_MINUTES * MIN_PER_HOUR * SEC_PER_MIN * MS_PER_SEC;
/** cache JSON 写入的 pretty-print indent */
const JSON_INDENT = 2;
/** token 速度统计保留天数 */
const SPEED_RETENTION_DAYS = 30;
/** token 速度统计窗口（最近 7 天） */
const SPEED_D7_DAYS = 7;
/** ISO date 字符串长度（YYYY-MM-DD） */
const DATE_STR_LEN = 10;
/** 每日记录的最小元组长度 */
const RECORD_MIN_FIELDS = 2;

// ── Paths ──────────────────────────────────────────────

const CACHE_PATH = getCachePath();
const SPEED_DIR = getSpeedDir();

// ── 原子写 tmp 唯一化（对齐 llm-shared config.ts 的 uniqueTmpPath，D1e 同款）──
// 固定名 `<path>.tmp` 在双侧并发写（同进程多 session / 跨进程）时可碰撞互相截断；
// 后缀 = pid + 36 进制随机段，保证写方间名字空间不相交。

const TMP_RANDOM_BASE = 36;
const TMP_RANDOM_SLICE_START = 2; // 跳过 Math.random 字符串的 "0." 前缀
const TMP_RANDOM_SLICE_END = 10;
function uniqueTmpPath(filePath: string): string {
	return `${filePath}.tmp_${process.pid}_${Math.random()
		.toString(TMP_RANDOM_BASE)
		.slice(TMP_RANDOM_SLICE_START, TMP_RANDOM_SLICE_END)}`;
}

/**
 * 原子写 JSON：唯一 tmp + rename（D1e 对齐）。写/rename 抛错时清理残留 tmp 后
 * 重抛原错误（RK3 对齐：唯一名不会自覆盖，不清理会随崩溃累积残留文件）。
 */
function atomicWriteJson(filePath: string, data: unknown): void {
	const tmpPath = uniqueTmpPath(filePath);
	try {
		writeFileSync(tmpPath, JSON.stringify(data, null, JSON_INDENT), "utf-8");
		renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			if (existsSync(tmpPath)) unlinkSync(tmpPath);
		} catch (cleanupErr) {
			// tmp 清理失败不掩盖原错误，仅记录
			logger.warn("tmp cleanup failed", { detail: { err: String(cleanupErr) } });
		}
		throw err;
	}
}

// ── 历史路径迁移 ────────────────────────────────────────
// [HISTORICAL] statusline 包已删，其遗留的 <agentDir>/statusline_cache.json 由本库接管
// 写入。旧文件名仍存在于已升级用户的磁盘上：首次加载时迁移到 config/quota-cache.json
// 并删旧。只迁移一次（模块级标志）；失败不阻断——缓存是易失数据（TTL 2 分钟），
// 下次 doUpdate 会重建，旧文件保留待下次进程启动重试。
let cacheMigrated = false;

function ensureCacheMigrated(): void {
	if (cacheMigrated) return;
	cacheMigrated = true;
	const legacyPath = join(getAgentDir(), "statusline_cache.json");
	if (!existsSync(legacyPath)) return;
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		if (existsSync(CACHE_PATH)) {
			// 新路径已有内容（已迁移或用户手动放置）→ 不覆盖，仅删旧
			unlinkSync(legacyPath);
			logger.warn("legacy cache superseded, removed legacy file", { detail: { legacyPath } });
		} else {
			renameSync(legacyPath, CACHE_PATH);
			logger.warn("migrated legacy cache", { detail: { legacyPath, cachePath: CACHE_PATH } });
		}
	} catch (e) {
		// 迁移失败属容错路径（best-effort）：保留旧文件待下次进程启动重试；缓存是易失数据（TTL 2 分钟），不阻断读取
		logger.warn("legacy cache migration failed (keeping old file)", { detail: { err: String(e) } });
	}
}

// ── CacheData（动态 schema，无需手动维护字段）───────
// provider 数据以 provider.id 为 key 存储，类型安全由 provider normalize 保证。
export interface CacheData {
	updatedAt: number;
	[providerId: string]: unknown;
}

const EMPTY_CACHE: CacheData = { updatedAt: 0 };

export interface SpeedData {
	current: number;
	day: number;
	d7: number;
	d30: number;
}

/** 缓存命中率数据 */
export interface CacheRatioData {
	/** 当前请求命中率 (0~100)，无缓存信息时为 null */
	current: number | null;
	/** 当天加权平均命中率 (0~100)，无数据时为 null */
	day: number | null;
}

// ── Cache 公共 API ─────────────────────────────────────

// [D8d write-after-invalidate] providers.json 变化（provider 删除/禁用）被 registry 按
// mtime 感知，但磁盘缓存条目要等 TTL 过期的 doUpdate 重建才消失——窗口内已删 provider
// 的旧数据仍被读到；进程不再读 cache 时残留永久。此处改为 mtime 变化即同步 prune。
let prunedForMtime = -1;

function pruneRemovedProviderEntries(): void {
	const configPath = getProvidersConfigPath();
	if (!existsSync(configPath)) return;
	const mtime = statSync(configPath).mtimeMs;
	if (mtime === prunedForMtime) return;
	prunedForMtime = mtime;
	// 集合为空（providers.json 解析失败/全删）时不清——防配置异常窗口误清全部条目
	const ids = new Set(buildRuntimeProviders().map((p) => p.id));
	if (ids.size === 0) return;

	const cached: Record<string, unknown> = { ...readCacheSync() };
	let removed = false;
	for (const key of Object.keys(cached)) {
		if (key !== "updatedAt" && !ids.has(key)) {
			delete cached[key];
			removed = true;
		}
	}
	if (!removed) return;
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		atomicWriteJson(CACHE_PATH, cached);
		logger.warn("pruned entries of removed providers");
	} catch (e) {
		// best-effort：写失败保留旧缓存，下次 mtime 变化重试；消费方按 plan key 取，残留不产生错误数据
		logger.warn("prune write failed (keeping old)", { detail: { err: String(e) } });
	}
}

export function readCache(): CacheData {
	pruneRemovedProviderEntries();
	const cached = readCacheSync();
	if (Date.now() - cached.updatedAt > CACHE_TTL_MS) triggerUpdate();
	return cached;
}

let updating = false;
let lastUpdateAt = 0; // 上次实际发起网络请求的时间

export function triggerUpdate(): void {
	if (updating) return;
	if (Date.now() - lastUpdateAt < CACHE_TTL_MS) return;
	updating = true;
	lastUpdateAt = Date.now();
	doUpdate()
		.finally(() => {
			updating = false;
		})
		.catch((e) => {
			logger.warn("doUpdate failed", { detail: { err: String(e) } });
		});
}

async function doUpdate(): Promise<void> {
	const old = readCacheSync();
	const providers = buildRuntimeProviders();
	const results = await Promise.allSettled(providers.map((p) => p.fetch()));

	const cache: Record<string, unknown> = { updatedAt: Date.now() };
	for (let i = 0; i < providers.length; i++) {
		const p = providers[i]!;
		const r = results[i]!;
		const oldVal = (old as Record<string, unknown>)[p.id] ?? null;
		if (r.status === "rejected") {
			// logger.error → appendEntry 持久化 + XYZ_AGENT_DEBUG=1 文件日志，方便排查
			logger.error("fetch failed", { detail: { providerId: p.id, err: String(r.reason?.message ?? r.reason) } });
		}
		cache[p.id] =
			r.status === "fulfilled" && r.value !== null ? r.value : oldVal;
	}

	// 原子写入：唯一 tmp + rename，防止半写损坏（tmp 唯一名防并发碰撞，D1e 对齐）
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		atomicWriteJson(CACHE_PATH, cache);
	} catch (e) {
		// 磁盘写失败属于容错路径：保留旧缓存，下次 triggerUpdate 会重试
		logger.warn("cache write failed (keeping old)", { detail: { err: String(e) } });
	}
}

function readCacheSync(): CacheData {
	ensureCacheMigrated();
	try {
		const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return { ...EMPTY_CACHE };
		// 确保 updatedAt 存在，其余字段原样保留（由 provider 动态管理）
		return { ...parsed, updatedAt: parsed.updatedAt ?? 0 };
	} catch (e) {
		// D1c quarantine：文件存在但读/parse 失败 → 隔离开现场再降级
		//（ENOENT = 尚无缓存，正常态不隔离）
		if (existsSync(CACHE_PATH)) quarantineCorrupt(CACHE_PATH, e);
		logger.warn("cache read failed (using empty)", { detail: { err: String(e) } });
		return { ...EMPTY_CACHE };
	}
}

// ── 损坏隔离（D1c 同模式，对齐 runtime json-store quarantineCorruptFile；
//    extension 环境无该依赖，就地最小实现）──────────────

/**
 * 把 parse 失败的文件 rename 为 <path>.corrupt-<ts> 保留取证并落 error 日志
 * （含恢复指引），防止后续写回把「半截文件」合法化为「全空文件」。
 * rename 失败（目录只读等）仅升级日志，不阻断调用方的降级路径。
 */
function quarantineCorrupt(path: string, cause: unknown): void {
	const ts = new Date().toISOString().replace(/[:.]/g, "");
	const quarantinePath = `${path}.corrupt-${ts}`;
	const msg = cause instanceof Error ? cause.message : String(cause);
	try {
		renameSync(path, quarantinePath);
		logger.error("corrupt file quarantined", { detail: { quarantinePath, cause: msg } });
	} catch (renameErr) {
		// 隔离失败不阻断读流程（调用方仍降级继续），只升级日志提示人工介入
		logger.error("quarantine rename failed", { detail: { path, cause: msg, renameError: renameErr instanceof Error ? renameErr.message : String(renameErr) } });
	}
}

// ── 持久化工具 ───────────────────────────────────────

/**
 * 读取、追加、清理、写回按日期分组的记录文件。
 *
 * trackSpeed 和 trackCacheRatio 共享的
 * "读 JSON → filter → append → GC → write" 模式。
 */
function persistDailyRecord<T extends unknown[]>(
	dir: string,
	filePath: string,
	record: T,
	recordName: string,
): Record<string, T[]> {
	const today = new Date().toISOString().slice(0, DATE_STR_LEN);
	const records: Record<string, T[]> = {};

	// 读取已有数据
	try {
		if (existsSync(filePath)) {
			const raw = JSON.parse(readFileSync(filePath, "utf-8"));
			for (const [date, entries] of Object.entries(raw as Record<string, unknown>)) {
				if (!Array.isArray(entries)) continue;
				records[date] = entries.filter(
					(e): e is T => Array.isArray(e) && e.length >= RECORD_MIN_FIELDS,
				);
			}
		}
	} catch (e) {
		// D1c quarantine：文件损坏属于容错路径——先隔离开现场（防下方写回把半截文件
		// 合法化为空），再 fallback 到空 records
		if (existsSync(filePath)) quarantineCorrupt(filePath, e);
		logger.warn("record read failed (using empty)", { detail: { recordName, err: String(e) } });
	}

	// 追加今日记录
	if (!records[today]) records[today] = [];
	records[today].push(record);

	// 清理过期数据
	const cutoff = new Date(Date.now() - SPEED_RETENTION_DAYS * DAY_MS)
		.toISOString()
		.slice(0, DATE_STR_LEN);
	for (const d of Object.keys(records)) {
		if (d < cutoff) delete records[d];
	}

	// 写回（原子写：唯一 tmp + rename，防并发多 session 半写损坏 + 读改写竞态截断）
	try {
		mkdirSync(dir, { recursive: true });
		atomicWriteJson(filePath, records);
	} catch (e) {
		// 写入失败属于容错路径：记录后继续（records 已返回，下次写入重试）
		logger.warn("record write failed", { detail: { recordName, err: String(e) } });
	}

	return records;
}

// ── Token Speed（与 provider 无关，保留在此）──────────────

// 每条记录存储 [outputTokens, durationMs]，用于正确计算加权平均速度
// SpeedRecord 类型已移至 speed.ts

export function trackSpeed(
	outputTokens: number,
	durationMs: number,
	model: string,
): SpeedData {
	const current =
		durationMs > 0 ? Math.round((outputTokens / durationMs) * MS_PER_SEC) : 0;
	if (!model || current <= 0) return { current, day: 0, d7: 0, d30: 0 };

	const safeName = model.replace(/[/\\\s:]/g, "_");
	const filePath = join(SPEED_DIR, `${safeName}.json`);

	const records = persistDailyRecord(
		SPEED_DIR, filePath, [outputTokens, durationMs] as SpeedRecord, "speed",
	);
	const today = new Date().toISOString().slice(0, DATE_STR_LEN);

	const dayEntries: SpeedRecord[] = [];
	const d7Entries: SpeedRecord[] = [];
	const d30Entries: SpeedRecord[] = [];
	const now = Date.now();

	for (const [date, entries] of Object.entries(records)) {
		d30Entries.push(...entries);
		if ((now - new Date(date).getTime()) / DAY_MS < SPEED_D7_DAYS) {
			d7Entries.push(...entries);
		}
		if (date === today) {
			dayEntries.push(...entries);
		}
	}

	return {
		current,
		day: avgSpeed(dayEntries),
		d7: avgSpeed(d7Entries),
		d30: avgSpeed(d30Entries),
	};
}

// ── Cache Ratio ─────────────────────────────────────────

const PERCENT_SCALE = 100;

/** 缓存命中率记录：[cacheRead, promptTotal=input+cacheRead+cacheWrite] */
type CacheRatioRecord = [number, number];

/** 缓存命中率统计目录 */
const CACHE_RATIO_DIR = join(getAgentDir(), "cache-ratio");

export function trackCacheRatio(
	usage: { input: number; cacheRead: number; cacheWrite: number },
	model: string,
): CacheRatioData {
	const { input, cacheRead, cacheWrite } = usage;
	const promptTotal = input + cacheRead + cacheWrite;

	// 无缓存信息时直接返回 null
	if (promptTotal <= 0) return { current: null, day: null };

	const current = Math.round((cacheRead / promptTotal) * PERCENT_SCALE);

	if (!model) return { current, day: null };

	const safeName = model.replace(/[/\\\s:]/g, "_");
	const filePath = join(CACHE_RATIO_DIR, `${safeName}.json`);

	const records = persistDailyRecord(
		CACHE_RATIO_DIR, filePath, [cacheRead, promptTotal] as CacheRatioRecord, "cache-ratio",
	);
	const today = new Date().toISOString().slice(0, DATE_STR_LEN);

	// 计算当天加权平均命中率
	const dayEntries = records[today] ?? [];
	let sumRead = 0;
	let sumTotal = 0;
	for (const [r, t] of dayEntries) {
		sumRead += r;
		sumTotal += t;
	}
	const day = sumTotal > 0 ? Math.round((sumRead / sumTotal) * PERCENT_SCALE) : null;

	return { current, day };
}

// avgSpeed 已移至 speed.ts，此处通过 import 使用
