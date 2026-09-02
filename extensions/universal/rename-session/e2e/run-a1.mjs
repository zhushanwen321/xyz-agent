#!/usr/bin/env node
/**
 * A1 场景：工具型首轮 —— 触发时机 + 输入内容证据链（设计 §8.3 A1 / 契约 C1）。
 *
 * 流程：真实 pi + mimo，在有 ts 文件的 fixture 目录发「列出当前目录的 ts 文件并统计行数」
 * （触发多 iteration 工具调用），round 完成后等 rename 落库，然后五重断言：
 *   ① 流序判别（主）：session JSONL 中 LLM request 日志 entry 时刻之后，stdout 时间轴上无
 *      turn_start/message_start/message_end 事件（中途触发的特征是其时刻之后仍有后续 turn
 *      事件）；时刻辅助 t(LLM request) ≥ t(最终 message_end) − 1s；round 中间 iteration 的
 *      turn_end 后仅 skip: stopReason=toolUse 类日志
 *   ② 仅一条 LLM request，user 段含「ts 文件」，结构为 [user, assistant, user] 三条
 *   ③ 内容匹配（主判别器）：日志 assistant 段（preview 截断后）与 session JSONL 最后一条
 *      stop assistant message 文本经 rebuildPreview 同构重构后一致
 *   ④ 负向：LLM request 的任何 message 段不含 toolResult 原始输出特征行
 *      （从实际 toolResult 内容选「仅原始输出才有的形态」——已剔除会出现在结论里的行）
 *   ⑤ session_info 行位于 round 全部 message entry 之后且 name 非空（行序佐证）
 *
 * 断言依据的探针事实见 e2e/README.md（P0）。rename 日志 entry 数据源 = session JSONL 的
 * extension-logger appendEntry 通道（customType rename-session:log），不写 pi 进程 stderr。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	LLM_REQUEST_MARKER,
	assert,
	assertLogTitleMatches,
	extractLastStopAssistant,
	extractRenameLogEntries,
	parseJsonlEntries,
	parseLogMessages,
	rebuildPreview,
	runScenario,
	runStandalone,
	spawnPi,
} from "./harness.mjs";

/** fixture：含多个 ts 文件的临时工作目录（行数错开，让工具原始输出特征可辨别）。 */
function makeTsFixture() {
	const dir = mkdtempSync(join(tmpdir(), "rename-e2e-fixture."));
	writeFileSync(
		join(dir, "alpha.ts"),
		Array.from({ length: 37 }, (_, i) => `export const alphaLine${i} = ${i};`).join("\n") + "\n",
	);
	writeFileSync(
		join(dir, "beta.ts"),
		Array.from({ length: 12 }, (_, i) => `export const betaLine${i} = ${i};`).join("\n") + "\n",
	);
	writeFileSync(
		join(dir, "gamma.ts"),
		Array.from({ length: 21 }, (_, i) => `export const gammaLine${i} = ${i};`).join("\n") + "\n",
	);
	writeFileSync(join(dir, "notes.md"), "# notes\n\n非 ts 文件，用于验证过滤。\n");
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 收集 toolResult message 的原始输出行（A1 ④ 负向断言的特征候选来源）。 */
function collectToolResultLines(entries) {
	const rawLines = [];
	for (const entry of entries) {
		if (entry?.type !== "message" || entry.message?.role !== "toolResult") continue;
		if (!Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content) {
			if (block?.type === "text" && typeof block.text === "string") {
				rawLines.push(...block.text.split("\n"));
			}
		}
	}
	return rawLines;
}

export async function runA1() {
	return runScenario("A1", async (log) => {
		const PROMPT = "列出当前目录的 ts 文件并统计行数";
		const fixture = makeTsFixture();
		const pi = await spawnPi({ tag: "a1", cwd: fixture.dir });
		try {
			// waitFor 只匹配未来事件，round 相关等待须在 prompt 前注册
			const settledP = pi.rpc.waitAgentSettled(180_000);
			const finalStopEndP = pi.rpc.waitFor("message_end", {
				timeoutMs: 180_000,
				filter: (ev) => ev?.message?.role === "assistant" && ev?.message?.stopReason === "stop",
			});
			await pi.rpc.prompt(PROMPT);
			await finalStopEndP;
			await settledP;
			// 等 rename 最终结果（显式等 renamed to 终态标记——宽松匹配 skip 日志会命中
			// 中间 iteration 的 skip: stopReason=toolUse 提前返回，那不是最终结果）
			const renameRes = await pi.rpc.waitForSessionLog('renamed to "', { timeoutMs: 45_000 });
			// 轮询等 session_info 落盘再读全量行（pi append→flush 有延迟，日志先于落库）
			await pi.waitSessionInfoEntry(10_000);

			const timeline = pi.timeline.all();
			// rename 日志 entry（extension-logger appendEntry 落 session JSONL）
			const lines = await pi.readSessionLines();
			assert(Array.isArray(lines), "session JSONL 不存在或不可读");
			const logEntries = extractRenameLogEntries(lines);

			// ── ② 仅一条 LLM request ──
			const llmReqEntries = logEntries.filter((e) => e.message.includes(LLM_REQUEST_MARKER));
			assert(
				llmReqEntries.length === 1,
				`期望仅 1 条 LLM request 日志，实际 ${llmReqEntries.length} 条`,
			);
			const llmReq = llmReqEntries[0];

			// ── ① 流序判别（主）+ 时刻辅助 ──
			// 锚点 = session JSONL 中 LLM request entry 的时刻（data.timestamp，与时间轴同为
			// 本机 epoch ms 可比较）。断言集 = 设计 §8.3 A1① 的 turn_start/message_start/
			// message_end（不含 turn_end：pi 先调 turn_end handler 再向 stdout 写事件，最终
			// turn_end 滞后 LLM request 1ms 级是通道顺序伪影非中途触发；中途触发的真特征是
			// 其时刻之后仍有下一 iteration 事件）
			const turnEventTypes = new Set(["turn_start", "message_start", "message_end"]);
			const lateTurnEvents = [];
			let finalStopEndT = null;
			for (const e of timeline) {
				if (e.stream !== "out") continue;
				let ev;
				try {
					ev = JSON.parse(e.line);
				} catch {
					continue;
				}
				if (ev?.type === "message_end" && ev.message?.role === "assistant" && ev.message?.stopReason === "stop") {
					finalStopEndT = e.t;
				}
				if (e.t > llmReq.t && turnEventTypes.has(ev?.type)) {
					lateTurnEvents.push(`${ev.type}@t=${e.t}`);
				}
			}
			assert(
				lateTurnEvents.length === 0,
				`LLM request 之后仍出现 turn 事件（中途触发特征）: ${lateTurnEvents.join(", ")}`,
			);
			assert(finalStopEndT !== null, "时间轴上未找到最终 stop assistant message_end");
			assert(
				llmReq.t >= finalStopEndT - 1000,
				`时刻辅助失败: t(LLM request)=${llmReq.t} 早于 t(最终 message_end)-1s=${finalStopEndT - 1000}`,
			);

			// ── ① 补：中间 iteration turn_end 后仅 skip: stopReason=toolUse 类日志 ──
			const skipBefore = logEntries.filter((e) => e.message.includes("skip: ") && e.t < llmReq.t);
			assert(skipBefore.length >= 1, `期望多 iteration 场景至少 1 条 toolUse skip 日志，实际 ${skipBefore.length} 条`);
			for (const e of skipBefore) {
				assert(
					/skip: stopReason=toolUse\b/.test(e.message),
					`LLM request 前出现非 toolUse 类 skip 日志: ${e.message}`,
				);
			}
			log(`round 中间 iteration skip 日志 ${skipBefore.length} 条（均 stopReason=toolUse）`);

			// ── ② 补：user 段内容 + 结构 ──
			const messages = parseLogMessages(llmReq.message);
			assert(messages !== null, "LLM request 行 JSON 解析失败");
			assert(
				messages.length === 3 &&
					messages[0].role === "user" &&
					messages[1].role === "assistant" &&
					messages[2].role === "user",
				`messages 结构非 [user, assistant, user]: ${JSON.stringify(messages?.map((m) => m.role))}`,
			);
			assert(messages[0].text.includes("ts 文件"), `user 段不含 prompt 特征「ts 文件」: ${messages[0].text}`);
			assert(messages[2].text.includes("slug"), `instruction 段不含「slug」特征: ${messages[2].text}`);

			// ── ③ 内容匹配（主判别器）──
			const finalText = extractLastStopAssistant(lines);
			assert(
				typeof finalText === "string" && finalText.length > 0,
				"JSONL 中无 stop assistant 文本（finalText 为空）",
			);
			const rebuilt = rebuildPreview(finalText);
			// 同构前提：finalText ≤ 4000 码点（truncateForTitle 截断上界）——真实日志链路是
			// previewText(truncateForTitle(finalText))，超过上界时截断版尾部（码点 3901-4000）
			// ≠ 全文尾部（码点 N-99..N），rebuildPreview 对原始文本的 preview 断言会假失败。
			// 取舍：不引入 mjs↔ts 同构截断函数（避免扩大维护面），改为前置断言锁定输入规模。
			assert(
				Array.from(finalText).length <= 4000,
				`finalText 超过 4000 码点（${Array.from(finalText).length}），rebuildPreview 同构断言前提失效`,
			);
			assert(
				messages[1].text === rebuilt,
				`内容不匹配（中途触发或注入内容错误）:\n  日志 assistant 段: ${JSON.stringify(messages[1].text)}\n  重构 preview:    ${JSON.stringify(rebuilt)}`,
			);

			// ── ④ 负向：不含 toolResult 原始输出特征行 ──
			const entries = parseJsonlEntries(lines);
			const toolRawLines = collectToolResultLines(entries);
			// 特征选择：含 .ts 且不出现在结论文本中的行（「仅原始输出才有的形态」，剔除会进结论的词）
			const features = toolRawLines.filter(
				(l) => l.includes(".ts") && l.trim().length >= 8 && !finalText.includes(l.trim()),
			);
			assert(features.length > 0, "未找到 toolResult 原始输出特征行（负向断言前提缺失）");
			const leaked = features.filter((f) => messages.some((m) => m.text.includes(f) || m.text.includes(f.trim())));
			assert(
				leaked.length === 0,
				`LLM request 含 toolResult 原始输出特征（全量注入残留）: ${JSON.stringify(leaked.slice(0, 3))}`,
			);

			// ── ⑤ session_info 行序 + name 非空 ──
			let lastMsgIdx = -1;
			const infoIdx = [];
			entries.forEach((entry, i) => {
				if (entry?.type === "session_info") infoIdx.push(i);
				if (entry?.type === "message") lastMsgIdx = i;
			});
			assert(infoIdx.length >= 1, "session JSONL 无 session_info entry（rename 未落库）");
			assert(
				infoIdx.every((i) => i > lastMsgIdx),
				`session_info 行序异常: info=[${infoIdx}] 最后 message idx=${lastMsgIdx}`,
			);
			const lastInfo = entries[infoIdx[infoIdx.length - 1]];
			assert(typeof lastInfo.name === "string" && lastInfo.name.length > 0, "session_info.name 为空");
			assertLogTitleMatches(renameRes.message, lastInfo.name);
			log(`标题: ${lastInfo.name}`);
			log(
				`证据链: 流序①OK / 仅1条request+user段②OK / 内容匹配③OK（preview ${messages[1].text.length} 字符）/ 负向④OK（${features.length} 条特征行零泄漏）/ 行序⑤OK`,
			);
		} finally {
			pi.cleanup();
			fixture.cleanup();
		}
	});
}

// ── 独立执行入口（node e2e/run-a1.mjs）──
runStandalone(import.meta.url, runA1);
