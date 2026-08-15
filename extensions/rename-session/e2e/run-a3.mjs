#!/usr/bin/env node
/**
 * A3 场景：防覆盖手动命名 —— 3a 静态 + 3b 竞态 + 3c 一次性语义（设计 §8.3 A3）。
 *
 * 3a 静态：先 setSessionName「我的手动名字」再发 prompt；等 rename settled 后再等 ≥10s，
 *         最后 session_info 仍为手动名 + 日志 skip: name exists。
 * 3b 竞态：发 prompt 后等 stderr 出现 LLM request 日志（rename LLM 调用进行中、尚未返回）
 *         立即 setSessionName「竞态命名」；等 rename settled 后断言 skip: name exists + 名字未被覆盖。
 *         known-flaky（设计 C3）：rename 返回快于「轮询 + RPC 往返」时断言 miss，重跑上限 2 次。
 * 3c 一次性：3a 完成后（同一 session）发第二条 prompt；断言无新 LLM request、无新自动
 *         session_info、正向证据 skip: count=2（堵「handler 未被调用」的假通过）。
 *
 * 3a+3c 共用一个 session（3c 依赖 3a 的既有手动名），3b 独立 session。
 */

import { pathToFileURL } from "node:url";

import { HarnessError, runScenario, spawnPi } from "./harness.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(cond, message) {
	if (!cond) throw new HarnessError("assertion", message);
}

/** 时间轴中 LLM request 日志条数（3c「无新 LLM request」断言用）。 */
function countLlmRequests(pi) {
	return pi.timeline.all().filter((e) => e.stream === "err" && e.line.includes("LLM request messages: ")).length;
}

/** session JSONL 中 session_info 条数（3c「无新自动 session_info」断言用）。 */
async function countSessionInfos(pi) {
	const lines = await pi.readSessionLines();
	if (!Array.isArray(lines)) return 0;
	let count = 0;
	for (const line of lines) {
		try {
			if (JSON.parse(line)?.type === "session_info") count++;
		} catch {
			// 坏行跳过
		}
	}
	return count;
}

/** 最后一条 session_info.name（等待 ≥10s 后的防覆盖终态断言用）。 */
async function lastSessionInfoName(pi) {
	const lines = await pi.readSessionLines();
	assert(Array.isArray(lines), "session JSONL 不存在或不可读");
	let last = null;
	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "session_info") last = entry;
		} catch {
			// 坏行跳过
		}
	}
	return last?.name ?? null;
}

/** 3a + 3c：静态防覆盖 + 一次性语义（同一 session 两轮）。 */
async function seg3aAnd3c(log) {
	const MANUAL = "我的手动名字";
	const pi = await spawnPi({ tag: "a3a" });
	try {
		// ── 3a 静态 ──
		await pi.rpc.setSessionName(MANUAL);
		const settled1P = pi.rpc.waitAgentSettled(180_000);
		await pi.rpc.prompt("1+1等于几？只回答数字");
		await settled1P;
		// 显式等 skip: name exists（waitRenameSettled 的 skip 分支可能匹配到中间 iteration 日志）
		await pi.rpc.waitForStderr("skip: name exists", { timeoutMs: 45_000 });
		await sleep(10_500); // ≥10s 观察窗口（迟到覆盖检测）
		assert((await lastSessionInfoName(pi)) === MANUAL, "3a 等待 10s 后手动名被覆盖");
		log(`3a OK: skip: name exists + 10s 后仍为「${MANUAL}」`);

		// ── 3c 一次性（同 session 第二轮）──
		const llmBefore = countLlmRequests(pi);
		const infoBefore = await countSessionInfos(pi);
		const settled2P = pi.rpc.waitAgentSettled(180_000);
		await pi.rpc.prompt("2+2等于几？只回答数字");
		await settled2P;
		await pi.rpc.waitForStderr("skip: count=2", { timeoutMs: 45_000 });
		assert(countLlmRequests(pi) === llmBefore, `3c 出现新 LLM request（${llmBefore} → ${countLlmRequests(pi)}）`);
		assert(
			(await countSessionInfos(pi)) === infoBefore,
			`3c 出现新自动 session_info（${infoBefore} → ${await countSessionInfos(pi)}）`,
		);
		assert((await lastSessionInfoName(pi)) === MANUAL, "3c 第二轮后手动名被覆盖");
		log("3c OK: skip: count=2 + 无新 LLM request + 无新 session_info");
	} finally {
		pi.cleanup();
	}
}

/** 3b 竞态单次尝试（known-flaky，失败由调用方重跑，上限 2 次）。 */
async function seg3bOnce(log) {
	const RACE_NAME = "竞态命名";
	const pi = await spawnPi({ tag: "a3b" });
	try {
		const settledP = pi.rpc.waitAgentSettled(180_000);
		await pi.rpc.prompt("3+5等于几？只回答数字");
		// 等 LLM request 日志（debug 内省在 callLLM 之前打出——此刻 rename LLM 调用进行中）
		const llmReq = await pi.rpc.waitForStderr("LLM request messages: ", { timeoutMs: 180_000 });
		// 立即抢入手动命名（竞态窗口内，llmReq.t 到 rename 返回通常 1-3s）
		const tGrab = Date.now();
		await pi.rpc.setSessionName(RACE_NAME);
		log(`3b 抢入命名：LLM request 后 ${tGrab - llmReq.t}ms 完成 set_session_name`);
		await settledP;
		// rename 终态时序（实测）：llm.ts 先打 `renamed to "<title>"`（返回 title 前），
		// 随后 handler .then() 落库前重查命中防覆盖才打 `skip: name exists`。
		// 故成功防覆盖 = renamed to 之后紧跟 skip: name exists；真 miss（标题先落库）时
		// skip 不会出现——5s 窗口未现即判 miss，交重跑
		await pi.rpc.waitForStderr('renamed to "', { timeoutMs: 45_000 });
		await pi.rpc.waitForStderr("skip: name exists", { timeoutMs: 5_000 });
		await sleep(10_500); // ≥10s 观察窗口
		assert((await lastSessionInfoName(pi)) === RACE_NAME, "3b 等待 10s 后竞态命名被覆盖");
		log(`3b OK: rename 返回时 skip: name exists + 名字未被覆盖（仍为「${RACE_NAME}」）`);
	} finally {
		pi.cleanup();
	}
}

export async function runA3() {
	return runScenario("A3", async (log) => {
		await seg3aAnd3c(log);

		// 3b known-flaky：断言 miss（竞态窗口输给 rename 返回速度）重跑上限 2 次
		const MAX_RERUNS = 2;
		let lastErr = null;
		for (let attempt = 0; attempt <= MAX_RERUNS; attempt++) {
			try {
				if (attempt > 0) log(`3b 重跑（第 ${attempt}/${MAX_RERUNS} 次，known-flaky 容忍）`);
				await seg3bOnce(log);
				return;
			} catch (e) {
				lastErr = e;
				log(`3b 尝试 ${attempt + 1} 失败: ${e?.message ?? e}`);
			}
		}
		throw new HarnessError(
			"assertion",
			`3b 竞态断言在 ${MAX_RERUNS + 1} 次尝试内均 miss（超出 known-flaky 容忍，按真失败处理）: ${lastErr?.message ?? lastErr}`,
		);
	});
}

// ── 独立执行入口（node e2e/run-a3.mjs）──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	runA3().then((r) => {
		process.exitCode = r.ok ? 0 : 1;
	});
}
