// bench/concurrent-scan.bench.ts
//
// [perf L-1] sessions-index.json 多实例并发验收 bench（设计文档 §4.2 的可复现测量脚本，
// 上游 .xyz-harness/2026-08-15-subagent-workflow-perf/sessions-index-design.md）。
//
// 场景：模拟 xyz-agent session-pool 的多个 pi 进程共享同一 sessionsDir——同进程内起
// N 个 RecordStore 实例各循环 M 轮 collectRecords，外部随机 append/touch 制造文件变化
// （append 只追加不含 "subagent-identity" 特征串的纯日志行——identity 探测结论不变，
// ground truth 固定；touch 只改 mtime）。写入侧为 tmp(pid+seq)+rename 原子写（无锁），
// 本 bench 验证并发下读侧只见完整 JSON、输出不错。
//
// 可复现命令（先 cp 真实目录副本，不污染原目录）：
//
//   ENC="--Users-zhushanwen-Code-xyz-agent-workspace-feat-optimize-ui--"  # 任一真实 <enc> 段
//   cp -R ~/.pi/agent/subagents/$ENC /tmp/bench-enc/
//   npx tsx bench/concurrent-scan.bench.ts /tmp/bench-enc/$ENC/sessions --workers 3 --iters 20
//   rm -rf /tmp/bench-enc   # 跑完清理副本
//
// 四判定（任一失败 exit 1，错误信息含下一步动作；对应设计文档 §4.2 判定 1-4）：
//   D1 全程无未捕获异常 / 未处理 rejection（进程级监听器兜底 fire-and-forget 泄漏）
//   D2 结束后 sessions-index.json JSON.parse 成功且 version 字段存在（rename 原子性）
//   D3 <enc> 段内无 sessions-index.json.tmp.* 残留（写失败路径的 tmp 清理）
//   D4 每实例每轮输出五元组 (id,agent,task,rootSessionId,status) 与单进程全量探测的
//      ground truth 完全一致（戳校验兜住陈旧索引；id 集一致不足以捕获字段级漂移）
//
// 不进 vitest（vitest.config.ts include 仅 src/**/__tests__/**/*.test.ts）、不进 CI。

import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { RecordStore } from "../src/execution/record-store.ts";
import { INDEX_FILENAME } from "../src/execution/sessions-index.ts";
import type { SubagentRecord } from "../src/execution/types.ts";

const DEFAULT_WORKERS = 3;
const DEFAULT_ITERS = 20;
const DEFAULT_LIMIT = 2000;
const DEFAULT_SEED = 20260815;
/** 单进程全量探测（ground truth）后、并发轮开始前的预变异文件数：保证每个实例的首扫
 *  都有戳不匹配 → 重探测 → dirty → 各自发起落盘，制造 tmp(pid+seq) 交错与 rename 竞争。 */
const PRE_MUTATIONS = 5;
/** fire-and-forget 写落盘等待上限、观察窗间隔与轮询上限（deadline 之上再加一道循环保险）。 */
const SETTLE_TIMEOUT_MS = 15_000;
const SETTLE_POLL_INTERVAL_MS = 150;
const SETTLE_MAX_POLLS = 10_000;
/** argv 中脚本参数起始下标（node + 脚本路径之后）。 */
const ARGV_ARGS_OFFSET = 2;
/** 差异预览截断长度（防超长 task 文本刷屏）。 */
const DIFF_PREVIEW_CHARS = 160;
/** mulberry32 算法固有常量（具名以满足 no-magic-numbers）。 */
const MUL_A = 0x6d2b79f5;
const MUL_SHIFT_A = 15;
const MUL_SHIFT_B = 7;
const MUL_XOR_C = 61;
const MUL_SHIFT_C = 14;
const UINT32_SCALE = 4_294_967_296;
/** 变异掷硬币的 append 概率（其余为 touch）。 */
const APPEND_PROBABILITY = 0.5;
/** 变异日志行的随机 tag 上界。 */
const MUTATION_TAG_RANGE = 1_000_000;
/** 每轮附加变异次数上界（1 + randInt(本值)）。 */
const MAX_EXTRA_MUTATIONS = 3;
/** 变异后的最小间隔（给在途写让出观察窗）。 */
const MUTATION_SETTLE_MS = 2;
/** 输出不一致/残留 tmp 的报告条数上限。 */
const MAX_REPORTED_MISMATCHES = 5;
const MAX_LISTED_TMP = 5;

// ============================================================
// CLI（手写解析，不引新依赖）
// ============================================================

interface ParsedArgs {
	sessionsDir: string;
	workers: number;
	iters: number;
	limit: number;
	seed: number;
}

const USAGE = `用法: npx tsx bench/concurrent-scan.bench.ts <sessionsDir> [--workers N] [--iters N] [--limit N] [--seed N]

  <sessionsDir>  真实 sessions 目录的【副本】路径（如 /tmp/bench-enc/<enc>/sessions）
  --workers N    并发 RecordStore 实例数（默认 ${DEFAULT_WORKERS}）
  --iters N      每实例 collectRecords 轮数（默认 ${DEFAULT_ITERS}）
  --limit N      collectRecords limit（默认 ${DEFAULT_LIMIT}）
  --seed N       随机种子（默认 ${DEFAULT_SEED}，固定种子可复现变异序列）`;

function parseArgs(argv: readonly string[]): { ok: true; value: ParsedArgs } | { ok: false; error: string } {
	let sessionsDir: string | undefined;
	let workers = DEFAULT_WORKERS;
	let iters = DEFAULT_ITERS;
	let limit = DEFAULT_LIMIT;
	let seed = DEFAULT_SEED;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") {
			return { ok: false, error: USAGE };
		}
		if (a.startsWith("--")) {
			const key = a;
			const raw = i + 1 < argv.length ? argv[i + 1] : undefined;
			const n = raw !== undefined ? Number(raw) : NaN;
			if (!Number.isInteger(n) || n < 0) {
				return { ok: false, error: `${key} 需要非负整数参数（收到 "${raw ?? ""}"）\n${USAGE}` };
			}
			if (key === "--workers") workers = n;
			else if (key === "--iters") iters = n;
			else if (key === "--limit") limit = n;
			else if (key === "--seed") seed = n;
			else return { ok: false, error: `未知参数 ${key}\n${USAGE}` };
			i++;
		} else if (sessionsDir === undefined) {
			sessionsDir = a;
		} else {
			return { ok: false, error: `多余的位置参数 ${a}（只需 sessionsDir）\n${USAGE}` };
		}
	}
	if (sessionsDir === undefined) {
		return { ok: false, error: `缺少位置参数 sessionsDir\n${USAGE}` };
	}
	if (workers <= 0 || iters <= 0 || limit <= 0) {
		return { ok: false, error: `--workers/--iters/--limit 必须为正整数\n${USAGE}` };
	}
	return { ok: true, value: { sessionsDir, workers, iters, limit, seed } };
}

// ============================================================
// 共享工具（与 cold-scan.bench.ts 同形态；bench 不引 src 内部测试工具，保持独立可跑）
// ============================================================

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function projectRecords(records: readonly SubagentRecord[]): string[] {
	return records.map((r) => [r.id, r.agent, r.task, r.rootSessionId ?? "", r.status].join("\u0001"));
}

function firstDiff(actual: readonly string[], expected: readonly string[]): string {
	const n = Math.min(actual.length, expected.length);
	for (let i = 0; i < n; i++) {
		if (actual[i] !== expected[i]) {
			return `第 ${i} 条不一致：实际 "${actual[i]!.slice(0, DIFF_PREVIEW_CHARS)}" vs 基准 "${expected[i]!.slice(0, DIFF_PREVIEW_CHARS)}"`;
		}
	}
	return `条数不一致：实际 ${actual.length} vs 基准 ${expected.length}`;
}

function fmtMs(ms: number): string {
	return `${ms.toFixed(1)}ms`;
}

/** 逐行比较（不用 join 后比较：task 文本自身可能含换行等任意字符）。 */
function sameRows(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/** mulberry32（确定性 PRNG：固定 seed 可复现同一变异序列）。 */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + MUL_A) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> MUL_SHIFT_A), t | 1);
		t ^= t + Math.imul(t ^ (t >>> MUL_SHIFT_B), t | MUL_XOR_C);
		return ((t ^ (t >>> MUL_SHIFT_C)) >>> 0) / UINT32_SCALE;
	};
}

function listIndexTmp(encDir: string): string[] {
	return fs.readdirSync(encDir).filter((f) => f.startsWith(`${INDEX_FILENAME}.tmp.`));
}

function rmIndexArtifacts(encDir: string): void {
	const indexPath = path.join(encDir, INDEX_FILENAME);
	if (fs.existsSync(indexPath)) fs.rmSync(indexPath, { force: true });
	for (const tmp of listIndexTmp(encDir)) {
		fs.rmSync(path.join(encDir, tmp), { force: true });
	}
}

/** 等待所有在途写落盘：索引存在且连续两个观察窗（150ms）无 tmp 残留。 */
async function waitIndexSettle(encDir: string, timeoutMs: number): Promise<void> {
	const stable = (): boolean => fs.existsSync(path.join(encDir, INDEX_FILENAME)) && listIndexTmp(encDir).length === 0;
	const deadline = Date.now() + timeoutMs;
	for (let i = 0; i < SETTLE_MAX_POLLS; i++) {
		if (Date.now() > deadline) {
			throw new Error(
				`索引落盘等待超时（${timeoutMs}ms）：${path.join(encDir, INDEX_FILENAME)} 未出现或 tmp 未清理。` +
					`检查目录可写性；PI_EXT_DEBUG=1 重跑可在 ~/.pi/agent/logs/ 看扩展写入失败日志`,
			);
		}
		const s1 = stable();
		await sleep(SETTLE_POLL_INTERVAL_MS);
		if (s1 && stable()) return;
	}
	throw new Error("waitIndexSettle: unreachable（deadline 已兜底）");
}

function hasNumberVersion(v: unknown): v is { version: unknown } {
	return typeof v === "object" && v !== null && "version" in v;
}

// ============================================================
// 外部变异（append / touch）
// ============================================================

/**
 * 追加一条纯日志行：必须是合法 JSON 但不含 "subagent-identity" 特征串——探测函数
 * （readIdentityHeader/Tail/Anywhere）按该特征串预筛，追加了它会让 identity 结论漂移、
 * ground truth 失效；纯日志行只改 size/mtime（触发戳不匹配重探测），探测结论不变。
 */
function appendPureLogLine(file: string, iter: number, workerRngTag: number): void {
	const line = {
		type: "message",
		timestamp: new Date().toISOString(),
		message: { role: "user", content: `bench concurrent append iter=${iter} tag=${workerRngTag}` },
	};
	fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf-8");
}

/** touch：只改 mtime（size 不变）——最廉价的戳不匹配制造。 */
function touchFile(file: string): void {
	const now = new Date();
	fs.utimesSync(file, now, now);
}

// ============================================================
// 主流程
// ============================================================

const runtimeErrors: string[] = [];
process.on("uncaughtException", (err: Error) => {
	runtimeErrors.push(`uncaughtException: ${err.message}`);
});
process.on("unhandledRejection", (reason: unknown) => {
	runtimeErrors.push(`unhandledRejection: ${String(reason)}`);
});

async function main(): Promise<number> {
	const parsedArgv = parseArgs(process.argv.slice(ARGV_ARGS_OFFSET));
	if (!parsedArgv.ok) {
		process.stderr.write(`${parsedArgv.error}\n`);
		return 1;
	}
	const { sessionsDir, workers, iters, limit, seed } = parsedArgv.value;
	const encDir = path.dirname(path.resolve(sessionsDir));
	const indexPath = path.join(encDir, INDEX_FILENAME);
	const rng = mulberry32(seed);
	const randInt = (n: number): number => Math.floor(rng() * n);

	if (!fs.existsSync(sessionsDir) || !fs.statSync(sessionsDir).isDirectory()) {
		process.stderr.write(`sessionsDir 不是目录: ${sessionsDir}\n先复制真实 <enc> 段副本：cp -R ~/.pi/agent/subagents/<enc> /tmp/bench-enc/\n`);
		return 1;
	}
	const jsonlFiles = fs
		.readdirSync(sessionsDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => path.join(sessionsDir, f));
	if (jsonlFiles.length === 0) {
		process.stderr.write(`sessionsDir 内没有 *.jsonl: ${sessionsDir}（应指向 <enc>/sessions）\n`);
		return 1;
	}

	// ── ground truth：单进程无索引全量探测 ──
	rmIndexArtifacts(encDir);
	const gtStore = new RecordStore(sessionsDir);
	let gtRecords: readonly SubagentRecord[];
	try {
		gtRecords = gtStore.collectRecords(limit, "all");
	} finally {
		gtStore.dispose();
	}
	const gt = projectRecords(gtRecords);
	await waitIndexSettle(encDir, SETTLE_TIMEOUT_MS);
	process.stdout.write(
		`[concurrent-scan bench] 目录=${sessionsDir}\n  ground truth: 单进程全量探测 ${gtRecords.length} 条（jsonl=${jsonlFiles.length}）\n`,
	);

	// ── 预变异：保证每个实例首扫都有戳不匹配 → 各自 dirty → 落盘交错 ──
	const mutated = new Set<string>();
	let appendCount = 0;
	let touchCount = 0;
	const mutateOne = (file: string, iter: number): void => {
		mutated.add(file);
		if (rng() < APPEND_PROBABILITY) {
			appendPureLogLine(file, iter, randInt(MUTATION_TAG_RANGE));
			appendCount++;
		} else {
			touchFile(file);
			touchCount++;
		}
	};
	for (let i = 0; i < Math.min(PRE_MUTATIONS, jsonlFiles.length); i++) {
		mutateOne(jsonlFiles[randInt(jsonlFiles.length)]!, 0);
	}

	// ── 并发阶段：N 实例 × M 轮，轮间随机变异，yield 让在途写与下一轮扫描交错 ──
	const stores: RecordStore[] = [];
	for (let w = 0; w < workers; w++) stores.push(new RecordStore(sessionsDir));
	const mismatches: string[] = [];
	const t0 = performance.now();
	let indexRewrites = 0;
	let lastIndexMtime = fs.existsSync(indexPath) ? fs.statSync(indexPath).mtimeMs : -1;

	try {
		for (let iter = 1; iter <= iters; iter++) {
			for (let w = 0; w < workers; w++) {
				const records = stores[w]!.collectRecords(limit, "all");
				const proj = projectRecords(records);
				if (!sameRows(proj, gt) && mismatches.length < MAX_REPORTED_MISMATCHES) {
					mismatches.push(`实例 ${w + 1} 轮 ${iter}: ${firstDiff(proj, gt)}`);
				}
				await sleep(1); // 给在途 fire-and-forget 写让出事件循环（制造读写交错窗口）
			}
			const mutationCount = 1 + randInt(MAX_EXTRA_MUTATIONS);
			for (let m = 0; m < mutationCount; m++) {
				mutateOne(jsonlFiles[randInt(jsonlFiles.length)]!, iter);
			}
			await sleep(MUTATION_SETTLE_MS);
			// 观测写放大（P-throttle 探针）：索引 mtime 变化即发生了一次成功落盘
			const mtimeNow = fs.existsSync(indexPath) ? fs.statSync(indexPath).mtimeMs : -1;
			if (mtimeNow !== lastIndexMtime) {
				indexRewrites++;
				lastIndexMtime = mtimeNow;
			}
		}
	} finally {
		for (const s of stores) s.dispose();
	}
	const elapsed = performance.now() - t0;

	// 等全部在途写收敛后再做终态判定
	await waitIndexSettle(encDir, SETTLE_TIMEOUT_MS);

	// ── 四判定 ──
	let failed = false;

	if (runtimeErrors.length > 0) {
		process.stderr.write(`D1 失败：${runtimeErrors.length} 条未捕获异常/rejection：\n${runtimeErrors.join("\n")}\n`);
		failed = true;
	}

	if (!fs.existsSync(indexPath)) {
		process.stderr.write(`D2 失败：索引不存在 ${indexPath}（并发写全部失败？查目录权限）\n`);
		failed = true;
	} else {
		const idxParsed: unknown = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
		if (!hasNumberVersion(idxParsed) || typeof idxParsed.version !== "number") {
			process.stderr.write(`D2 失败：索引 JSON.parse 失败或缺 version 字段: ${indexPath}\n`);
			failed = true;
		}
	}

	const tmpResidue = listIndexTmp(encDir);
	if (tmpResidue.length > 0) {
		process.stderr.write(`D3 失败：<enc> 段残留 tmp 文件 ${tmpResidue.length} 个：${tmpResidue.slice(0, MAX_LISTED_TMP).join(", ")}\n`);
		failed = true;
	}

	if (mismatches.length > 0) {
		process.stderr.write(`D4 失败：输出与 ground truth 不一致（前 5 条）：\n${mismatches.join("\n")}\n`);
		failed = true;
	}

	// 报告（P-throttle 观测：写次数应远小于扫描轮数——60s 节流 + 纯命中轮不写）
	const indexBytes = fs.existsSync(indexPath) ? fs.statSync(indexPath).size : 0;
	process.stdout.write(
		`  并发: ${workers} 实例 × ${iters} 轮（总 ${workers * iters} 次扫描）耗时 ${fmtMs(elapsed)}\n` +
			`  变异: append=${appendCount} touch=${touchCount}（覆盖 ${mutated.size} 个不同文件，seed=${seed}）\n` +
			`  索引观测: 重写 ${indexRewrites} 次，终态 ${indexBytes} bytes（节流下写次数 << 扫描轮数）\n`,
	);
	if (failed) {
		process.stderr.write("四判定存在失败项（见上）；修复后重跑本命令验证\n");
		return 1;
	}
	process.stdout.write("  四判定 D1/D2/D3/D4: PASS\n");
	return 0;
}

main().then(
	(code: number) => {
		process.exitCode = code;
	},
	(err: unknown) => {
		process.stderr.write(`bench 异常退出: ${err instanceof Error ? err.stack : String(err)}\n`);
		process.exitCode = 1;
	},
);
