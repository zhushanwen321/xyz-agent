/**
 * 跨重启基线的文件系统侧实现（设计 D2 三路径中的路径 1/2 的读与路径 2 的写）。
 *
 * - readLastPromptFromSessionFile：直读 session JSONL（进程内 resume 的 targetSessionFile、
 *   fork 暂定的 previousSessionFile），倒序找最后一条 xyz:system-prompt 留痕 entry。
 * - readPersistedBaseline / writePersistedBaseline：dataDir 自持久化小文件
 *   （app 重启直 spawn resume 时唯一可用的基线来源），原子写入。
 *
 * 所有函数不抛错：读失败返回 null、写失败 console.error 后静默——基线丢失的代价只是
 * 下次 resume 多写一条留痕（设计 D2 已接受），不允许影响 agent 主流程。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isRecord, isSystemPromptTraceEntryData, SYSTEM_PROMPT_CUSTOM_TYPE } from "./types.js";
import type { PromptBaseline } from "./types.js";

/** 自持久化基线文件名（位于 pi agentDir 下）。 */
export const BASELINE_FILENAME = "system-prompt-trace-baseline.json";

/** 基线 map 保留的 session 数上限（按 updatedAt 保留最近 N 个，防多 session 长期使用无限增长）。 */
const MAX_BASELINE_SESSIONS = 64;

interface PersistedBaselineEntry {
	hash: string;
	version: number;
	updatedAt: string;
}

interface PersistedBaselineFile {
	schemaVersion: 1;
	sessions: Record<string, PersistedBaselineEntry>;
}

/**
 * 解析单行 session JSONL 为留痕 entry data（运行时 guard；任何形状不符 / JSON 损坏返回 null）。
 * pi 落盘形状：{"type":"custom","customType":"xyz:system-prompt","data":{...},...}
 * （session-manager.ts:1122 appendCustomEntry）。
 */
export function parseTraceEntryData(line: string): { hash: string; version: number; fullText: string } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (parsed["type"] !== "custom" || parsed["customType"] !== SYSTEM_PROMPT_CUSTOM_TYPE) return null;
	const data = parsed["data"];
	if (!isSystemPromptTraceEntryData(data)) return null;
	return { hash: data.hash, version: data.version, fullText: data.fullText };
}

/**
 * 倒序扫描 session JSONL，取最后一条留痕 entry 作基线。
 * 文件缺失 / 全部损坏 / 无留痕 entry（旧 session 先于本 extension）→ null。
 */
export function readLastPromptFromSessionFile(
	sessionFilePath: string,
	source: "target-file" | "previous-session-file",
): PromptBaseline | null {
	let content: string;
	try {
		content = readFileSync(sessionFilePath, "utf-8");
	} catch {
		return null;
	}
	const lines = content.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line === "") continue;
		const parsed = parseTraceEntryData(line);
		if (parsed !== null) {
			return { hash: parsed.hash, version: parsed.version, fullText: parsed.fullText, source };
		}
	}
	return null;
}

/** 读自持久化基线小文件。文件缺失 / JSON 损坏 / 形状不符 → null（视为无基线）。 */
export function readPersistedBaseline(baselineFilePath: string, sessionId: string): PromptBaseline | null {
	let raw: string;
	try {
		raw = readFileSync(baselineFilePath, "utf-8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const sessions = parsed["sessions"];
	if (!isRecord(sessions)) return null;
	if (!Object.hasOwn(sessions, sessionId)) return null;
	const entry = sessions[sessionId];
	if (!isRecord(entry)) return null;
	const hash = entry["hash"];
	const version = entry["version"];
	if (typeof hash !== "string" || typeof version !== "number") return null;
	return { hash, version, source: "persisted" };
}

/**
 * 写自持久化基线（read-modify-write + 临时文件原子 rename）。
 *
 * 并发语义：session pool 下多个 pi 进程共享同一 agentDir，RMW 竞态按 last-writer-wins
 * 容忍（丢的是某 session 的基线 → 下次 resume 走兜底多写一条，设计 D2 已接受）；
 * 原子 rename 保证读方永远不会看到半截 JSON。跨进程共享豁免锁论证 + tmp 唯一化登记于
 * data-source-registry.md §6（PR #186 MF2）。
 */

// ── 原子写 tmp 唯一化（对齐 quota-providers cache.ts / ext-config W4 同款）──
// 固定名 `<path>.tmp` 在多 pi 进程并发写时可碰撞互相截断；后缀 = pid + 36 进制随机段，
// 保证写方间名字空间不相交。
const TMP_RANDOM_BASE = 36;
const TMP_RANDOM_SLICE_START = 2; // 跳过 Math.random 字符串的 "0." 前缀
const TMP_RANDOM_SLICE_END = 10;
function uniqueTmpPath(filePath: string): string {
	return `${filePath}.tmp_${process.pid}_${Math.random()
		.toString(TMP_RANDOM_BASE)
		.slice(TMP_RANDOM_SLICE_START, TMP_RANDOM_SLICE_END)}`;
}

export function writePersistedBaseline(
	baselineFilePath: string,
	sessionId: string,
	hash: string,
	version: number,
): void {
	try {
		const file = loadBaselineFileForWrite(baselineFilePath);
		file.sessions[sessionId] = { hash, version, updatedAt: new Date().toISOString() };
		pruneSessions(file.sessions);
		mkdirSync(dirname(baselineFilePath), { recursive: true });
		const tmpPath = uniqueTmpPath(baselineFilePath);
		try {
			writeFileSync(tmpPath, JSON.stringify(file, null, "\t") + "\n");
			renameSync(tmpPath, baselineFilePath);
		} catch (err) {
			// 唯一名不自覆盖：写/rename 抛错的残留 tmp 须显式清理后重抛（registry §6 本文件
			// 条目；对齐 quota-providers atomicWriteJson）；清理失败不掩盖原错误
			try {
				if (existsSync(tmpPath)) unlinkSync(tmpPath);
			} catch {
				// 清理失败仅残留一个小文件，原错误优先上抛
			}
			throw err;
		}
	} catch (e) {
		// best-effort 降级：基线写失败只影响下次 app 重启 resume 的去重（多写一条留痕，
		// 设计 D2 已接受），不阻断 agent 主流程；错误进 pi stdout 随日志落盘供排查
		console.error("[pi-system-prompt-trace] write baseline failed:", e);
	}
}

/** 读现有基线文件供改写；读不到 / 损坏 → 空文件重开（逐 entry 校验，垃圾 entry 直接丢弃）。 */
function loadBaselineFileForWrite(baselineFilePath: string): PersistedBaselineFile {
	try {
		const parsed: unknown = JSON.parse(readFileSync(baselineFilePath, "utf-8"));
		if (!isRecord(parsed)) return emptyBaselineFile();
		const sessions = parsed["sessions"];
		if (!isRecord(sessions)) return emptyBaselineFile();
		const clean: Record<string, PersistedBaselineEntry> = {};
		for (const key of Object.keys(sessions)) {
			const v = sessions[key];
			if (!isRecord(v)) continue;
			const hash = v["hash"];
			const version = v["version"];
			const updatedAt = v["updatedAt"];
			if (typeof hash === "string" && typeof version === "number" && typeof updatedAt === "string") {
				clean[key] = { hash, version, updatedAt };
			}
		}
		return { schemaVersion: 1, sessions: clean };
	} catch {
		return emptyBaselineFile();
	}
}

function emptyBaselineFile(): PersistedBaselineFile {
	return { schemaVersion: 1, sessions: {} };
}

/** 超出上限时按 updatedAt 保留最近的 session（原地裁剪）。 */
function pruneSessions(sessions: Record<string, PersistedBaselineEntry>): void {
	const keys = Object.keys(sessions);
	if (keys.length <= MAX_BASELINE_SESSIONS) return;
	keys.sort((a, b) => sessions[b].updatedAt.localeCompare(sessions[a].updatedAt));
	for (const key of keys.slice(MAX_BASELINE_SESSIONS)) {
		delete sessions[key];
	}
}
