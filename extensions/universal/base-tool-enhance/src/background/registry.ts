/**
 * registry.json 持久化读写（per-sessionId 目录，D8）。
 *
 * 路径：<dataDir>/base-tool-enhance/<sessionId>/registry.json（dataDir = pi
 * getAgentDir() 同源路径，由调用方解析传入）。条目记 ownerPiPid——M5 reaper 属主
 * 判定依据，M2 只负责写入。
 *
 * 写入协议：
 *  - 原子写 temp+rename（tmp 名带 pid+随机段防并发碰撞，llm-shared saveConfig 范式）
 *  - 锁内 RMW（@zhushanwen/pi-file-lock withFileLockSync）——同 sessionId 目录可能
 *    被桌面端 ephemeral 附着进程与发起进程并发写，跨进程互斥只依赖同一 lockfile
 *  - 锁获取失败不降级无锁写：返回 {success:false}，条目停留 running 由 M5 reaper
 *    兜底（§3.5「registry/entry 写不进则条目停留 running」）
 *  - 损坏读取防御（§3.6）：解析失败/形状非法 → 重命名 .corrupt 保留现场 + 按空表
 *    重建 + warn 日志
 *  - 终态条目 LRU 上限 50（与单例表对称）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "@zhushanwen/pi-extension-logger";
import { withFileLockSync } from "@zhushanwen/pi-file-lock";

import { isTerminalState, type BackgroundTask, type RegistryEntry } from "./types.ts";

const logger = getLogger("base-tool-enhance");

/** registry 文件格式版本（未来结构变更时迁移判据）。 */
const REGISTRY_VERSION = 1;
/** 终态条目 LRU 上限（与 task-store MAX_TERMINAL_TASKS 对称，§3.5）。 */
export const MAX_TERMINAL_REGISTRY_ENTRIES = 50;
const JSON_INDENT = 2;
// tmp 随机段参数（llm-shared uniqueTmpPath 同款：36 进制随机串，跳过 "0." 前缀）
const TMP_RADIX = 36;
const TMP_SLICE_START = 2;
const TMP_SLICE_END = 10;

export function getBaseToolEnhanceDir(dataDir: string): string {
	return join(dataDir, "base-tool-enhance");
}

export function getRegistryPath(dataDir: string, sessionId: string): string {
	return join(getBaseToolEnhanceDir(dataDir), sessionId, "registry.json");
}

interface RegistryFileShape {
	version: number;
	entries: RegistryEntry[];
}

/** 校验并归一化 registry 文件内容；形状非法返回 undefined（走 corrupt 路径）。 */
function parseRegistryContent(raw: string): RegistryFileShape | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { version, entries } = parsed as Record<string, unknown>;
	if (version !== REGISTRY_VERSION || !Array.isArray(entries)) return undefined;
	const valid: RegistryEntry[] = [];
	for (const item of entries) {
		if (typeof item !== "object" || item === null) continue;
		const e = item as Record<string, unknown>;
		// 最低限度形状校验：核心标识字段缺失即整条丢弃（不因单条脏数据报废全表）
		if (
			typeof e.taskId !== "string" ||
			typeof e.pid !== "number" ||
			typeof e.command !== "string" ||
			typeof e.outputFile !== "string" ||
			typeof e.startedAt !== "number" ||
			typeof e.state !== "string" ||
			typeof e.ownerPiPid !== "number" ||
			typeof e.sessionId !== "string"
		) {
			continue;
		}
		valid.push(item as RegistryEntry);
	}
	return { version: REGISTRY_VERSION, entries: valid };
}

/** .corrupt 落点：固定名优先；已存在则带时间戳，不覆盖前一份现场。 */
function corruptPathFor(registryPath: string): string {
	const base = `${registryPath}.corrupt`;
	return existsSync(base) ? `${base}-${Date.now()}` : base;
}

/**
 * 读取 registry 全量条目。文件不存在 / 读失败 / 解析失败均返回空表（工具面不因
 * registry 问题崩溃）；解析失败时重命名 .corrupt 保留现场 + warn（§3.6）。
 */
export function readRegistry(registryPath: string): Map<string, RegistryEntry> {
	if (!existsSync(registryPath)) return new Map();
	let raw: string;
	try {
		raw = readFileSync(registryPath, "utf8");
	} catch (err) {
		logger.warn("registry read failed, treating as empty", {
			detail: { path: registryPath, err: err instanceof Error ? err.message : String(err) },
		});
		return new Map();
	}
	const parsed = parseRegistryContent(raw);
	if (parsed === undefined) {
		const corruptPath = corruptPathFor(registryPath);
		try {
			renameSync(registryPath, corruptPath);
			logger.warn("registry corrupted, renamed to preserve scene and rebuilt empty", {
				detail: { path: registryPath, corruptPath },
			});
		} catch (err) {
			logger.warn("registry corrupted and rename failed, rebuilding empty in place", {
				detail: { path: registryPath, err: err instanceof Error ? err.message : String(err) },
			});
		}
		return new Map();
	}
	return new Map(parsed.entries.map((e) => [e.taskId, e]));
}

/** BackgroundTask → RegistryEntry（剥离运行时字段 intent/timeoutTimer/child/registryPath）。 */
export function taskToRegistryEntry(task: BackgroundTask): RegistryEntry {
	return {
		taskId: task.taskId,
		pid: task.pid,
		command: task.command,
		outputFile: task.outputFile,
		startedAt: task.startedAt,
		state: task.state,
		ownerPiPid: task.ownerPiPid,
		sessionId: task.sessionId,
		...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
		...(task.reason !== undefined ? { reason: task.reason } : {}),
		...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
		...(task.durationMs !== undefined ? { durationMs: task.durationMs } : {}),
		...(task.tailSummary !== undefined ? { tailSummary: task.tailSummary } : {}),
		...(task.pidStartTime !== undefined ? { pidStartTime: task.pidStartTime } : {}),
	};
}

function serializeRegistry(entries: RegistryEntry[]): string {
	const shape: RegistryFileShape = { version: REGISTRY_VERSION, entries };
	return `${JSON.stringify(shape, null, JSON_INDENT)}\n`;
}

/** 原子写：tmp（pid+随机段唯一化）+ rename（POSIX/Windows 均原子）；失败清理 tmp。 */
function atomicWriteRegistry(registryPath: string, content: string): void {
	mkdirSync(dirname(registryPath), { recursive: true });
	const tmpPath = `${registryPath}.tmp_${process.pid}_${Math.random().toString(TMP_RADIX).slice(TMP_SLICE_START, TMP_SLICE_END)}`;
	try {
		writeFileSync(tmpPath, content, "utf8");
		renameSync(tmpPath, registryPath);
	} catch (err) {
		try {
			if (existsSync(tmpPath)) unlinkSync(tmpPath);
		} catch (cleanupErr) {
			// tmp 清理失败不掩盖原错误，仅留诊断
			logger.warn("registry tmp cleanup failed", {
				detail: { tmpPath, err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) },
			});
		}
		throw err;
	}
}

/**
 * 写入/更新单条 registry 条目（锁内 RMW：读全量 → 合并同 id 覆盖 → 终态 LRU 50 →
 * 原子写）。任务登记（running）、killing intent、终态三条路径共用。
 * 失败返回 {success:false}——调用方按「写不进则条目停留 running，M5 reaper 兜底」
 * 处理（M2 只 warn，不重试不阻断主流程）。
 */
export function writeRegistryEntry(
	registryPath: string,
	entry: RegistryEntry,
): { success: boolean; error?: string } {
	const writeMerged = (): void => {
		const merged = readRegistry(registryPath);
		merged.set(entry.taskId, entry);
		const all = [...merged.values()];
		const terminal = all
			.filter((e) => isTerminalState(e.state))
			.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
		const excess = terminal.length - MAX_TERMINAL_REGISTRY_ENTRIES;
		for (let i = 0; i < excess; i++) merged.delete(terminal[i].taskId);
		atomicWriteRegistry(registryPath, serializeRegistry([...merged.values()]));
	};
	try {
		withFileLockSync(registryPath, writeMerged);
		return { success: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn("registry write failed; entry stays as-is (M5 reaper will reconcile)", {
			detail: { path: registryPath, taskId: entry.taskId, err: message },
		});
		return { success: false, error: message };
	}
}
