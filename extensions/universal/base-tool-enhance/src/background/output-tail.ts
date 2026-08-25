/**
 * 输出文件 tail 读取（D7：输出落文件不占内存，查询时按需读尾部）。
 *
 * 截断规则与 pi 内置 bash 一致：末尾 2000 行 / 50KB 先到为准（bash.js truncate.ts
 * DEFAULT_MAX_LINES/DEFAULT_MAX_BYTES）。实现从文件末尾按字节窗口读（不整读大文件，
 * O(maxBytes) 而非 O(fileSize)）。
 */

import { openSync, readSync, closeSync, statSync } from "node:fs";

import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("base-tool-enhance");

/** pi 内置 bash 同款截断上限（last 2000 lines / 50KB = 51200 bytes，先到为准）。 */
export const TAIL_MAX_LINES = 2000;
export const TAIL_MAX_BYTES = 51_200;
/** 字节窗口余量：截窗口可能吞掉首行前半，余量降低残行概率。 */
const TAIL_WINDOW_MARGIN_BYTES = 64;
/** exit 边沿 tail 摘要参数（存条目/M3 通知用）。 */
const SUMMARY_TAIL_LINES = 5;
const SUMMARY_MAX_CHARS = 800;

export interface TailResult {
	output: string;
	/** 读取窗口被截断（内容超上限）时 true。 */
	truncated: boolean;
}

/**
 * 读文件尾部（行/字节双上限）。文件不存在/不可读返回 undefined——bash_output 对
 * 此降级为 {output:"<lost>"} 不崩溃（§3.6）。
 */
export function readOutputTail(
	outputFile: string,
	maxLines: number = TAIL_MAX_LINES,
	maxBytes: number = TAIL_MAX_BYTES,
): TailResult | undefined {
	let size: number;
	try {
		size = statSync(outputFile).size;
	} catch {
		return undefined;
	}
	// 字节窗口从末尾取 maxBytes + 余量（截窗口可能吞掉首行前半，余量降低概率）
	const windowSize = Math.min(size, maxBytes + TAIL_WINDOW_MARGIN_BYTES);
	const buffer = Buffer.alloc(windowSize);
	let fd: number | undefined;
	try {
		fd = openSync(outputFile, "r");
		readSync(fd, buffer, 0, windowSize, size - windowSize);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch (err) {
				// 已读完内容，close 失败不影响结果，仅留诊断
				logger.debug("output tail close failed", {
					detail: { outputFile, err: err instanceof Error ? err.message : String(err) },
				});
			}
		}
	}
	const text = buffer.toString("utf8");
	const lines = text.split("\n");
	// 窗口起点可能落在行中间：首行是残行时丢弃（它必然不完整）
	const firstLineIsPartial = windowSize < size && lines.length > 0;
	const effectiveLines = firstLineIsPartial ? lines.slice(1) : lines;
	const byteTruncated = size > maxBytes;
	const shown = effectiveLines.slice(-maxLines).join("\n");
	return { output: shown, truncated: byteTruncated || effectiveLines.length > maxLines };
}

/**
 * 轮询器 exit 边沿的 tail 摘要（存进条目、M3 通知用）：末尾几行的紧凑文本。
 */
export function readTailSummary(outputFile: string, maxChars: number = SUMMARY_MAX_CHARS): string | undefined {
	const tail = readOutputTail(outputFile, SUMMARY_TAIL_LINES, maxChars);
	if (tail === undefined) return undefined;
	const compact = tail.output.trim();
	return compact.length > 0 ? compact.slice(-maxChars) : undefined;
}
