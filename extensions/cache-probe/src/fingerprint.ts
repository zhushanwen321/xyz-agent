/**
 * cache-probe 指纹纯函数层 —— 设计文档 docs/todo/cache-probe-design.md §7.1。
 *
 * entry schema v2（长期生效版，数据量精简为长期采集优化）：
 *  - hash 用 sha256 前 16 hex（64bit，同 session 内对比，碰撞概率可忽略）
 *  - baseline entry 存全量 9 hash + cwd + startReason
 *  - normal entry 只存变化项（增量 merge，脚本侧回放合并）
 *  - error entry 只存 v/seq/error
 */

import { createHash } from "node:crypto";

/** 指纹 hash 长度（hex 字符数）。 */
export const HASH_LEN = 16;

/** entry schema 版本（v2：短 hash + 增量 entry）。 */
export const SCHEMA_VERSION = 2;

export type FingerprintKey =
	| "spFull"
	| "toolsSent"
	| "contextFiles"
	| "skills"
	| "toolsList"
	| "toolsReg"
	| "append"
	| "guidelines"
	| "customPrompt";

export type Fingerprints = Record<FingerprintKey, string>;

export interface ProbeEntryData {
	v: typeof SCHEMA_VERSION;
	seq: number;
	baseline?: true;
	startReason?: string;
	cwd?: string;
	changed?: string[];
	/** baseline 存全量；normal 只存变化项。 */
	h?: Partial<Fingerprints>;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/** 递归 sort keys 的稳定序列化（undefined 归一为 null，防 key 顺序抖动产生假变化）。 */
export function stableStringify(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
	const keys = Object.keys(value).sort();
	return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") + "}";
}

export function hashOf(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, HASH_LEN);
}

/**
 * 从 provider payload 提取 system 内容（最终视角）。三种口径：
 *  - OpenAI 兼容：messages 内 role 为 system 或 developer
 *    （pi 源码 ai/src/api/openai-completions.ts 的 useDeveloperRole 分支）
 *  - Anthropic：顶层 system（数组）
 *  - Google：顶层 systemInstruction（对象）
 */
export function extractSystem(payload: unknown): unknown | null {
	if (!isRecord(payload)) return null;
	const system = payload["system"];
	if (Array.isArray(system)) return system;
	const systemInstruction = payload["systemInstruction"];
	if (isRecord(systemInstruction)) return systemInstruction;
	const messages = payload["messages"];
	if (Array.isArray(messages)) {
		const sys = messages.filter(
			(m): m is Record<string, unknown> =>
				isRecord(m) && (m["role"] === "system" || m["role"] === "developer"),
		);
		if (sys.length > 0) return sys;
	}
	return null;
}

/** 从 provider payload 提取最终发送的 tools 数组；缺失返回 null。 */
export function sentToolsOf(payload: unknown): unknown[] | null {
	if (!isRecord(payload)) return null;
	const tools = payload["tools"];
	return Array.isArray(tools) ? tools : null;
}

export function diffFingerprints(cur: Fingerprints, last: Fingerprints | null): FingerprintKey[] {
	if (last === null) return [];
	return (Object.keys(cur) as FingerprintKey[]).filter((k) => last[k] !== cur[k]);
}

/**
 * 构建待写入的 probe entry；无变化返回 null（不写 entry，session 零膨胀）。
 * baseline 全量；normal 增量。cwd 仅 baseline 携带（cwd 变化必然带动 contextFiles 变化，
 * 变化事实由 changed 体现，诊断回溯最近 baseline）。
 */
export function buildProbeEntry(
	cur: Fingerprints,
	last: Fingerprints | null,
	meta: { seq: number; needsBaseline: boolean; startReason: string | null; cwd: string | null },
): ProbeEntryData | null {
	if (meta.needsBaseline || last === null) {
		return {
			v: SCHEMA_VERSION,
			seq: meta.seq,
			baseline: true,
			startReason: meta.startReason ?? undefined,
			cwd: meta.cwd ?? undefined,
			changed: ["*"],
			h: cur,
		};
	}
	const changed = diffFingerprints(cur, last);
	if (changed.length === 0) return null;
	const delta: Partial<Fingerprints> = {};
	for (const k of changed) delta[k] = cur[k];
	return { v: SCHEMA_VERSION, seq: meta.seq, changed, h: delta };
}
