#!/usr/bin/env node
/**
 * A4 场景：error 轮不命名 + 重启 --session 续跑后下一成功轮命名（设计 §8.3 A4）。
 *
 * 阶段 1：tmp 配坏 provider（models.json 覆盖 baseUrl → http://127.0.0.1:1/v1，探针 4 写法）
 *         发「帮我看下这个目录结构」→ round error。断言：turn_end 带 stopReason=error、
 *         无 LLM request 日志、无自动 session_info、正向证据 skip: stopReason=error、pi 存活。
 * 阶段 2：kill 进程、spawnPi 以 --session <文件> 续跑（新 tmp agentDir 不含坏 models.json，
 *         provider 恢复正常——配置在进程启动时读取，必须重启），发「现在把刚才目录里的
 *         ts 文件数一下」→ round 成功。断言：LLM request 出现 + session_info 落库 slug 标题。
 *
 * 阶段 1 tmp（含 session 文件）保留到阶段 2 结束后才清理（--session 指向其中的文件）。
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { HarnessError, runScenario, spawnPi } from "./harness.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(cond, message) {
	if (!cond) throw new HarnessError("assertion", message);
}

/** fixture：含 ts 文件的临时工作目录（阶段 2 prompt 引用「刚才目录」）。 */
function makeTsFixture() {
	const dir = mkdtempSync(join(tmpdir(), "rename-e2e-a4-fixture."));
	writeFileSync(
		join(dir, "alpha.ts"),
		Array.from({ length: 30 }, (_, i) => `export const alphaLine${i} = ${i};`).join("\n") + "\n",
	);
	writeFileSync(
		join(dir, "beta.ts"),
		Array.from({ length: 8 }, (_, i) => `export const betaLine${i} = ${i};`).join("\n") + "\n",
	);
	writeFileSync(join(dir, "notes.md"), "# notes\n\n非 ts 文件。\n");
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** session JSONL 中是否存在自动 session_info（A4 两阶段的负向断言用）。 */
function hasAutoSessionInfo(lines) {
	for (const line of lines ?? []) {
		try {
			if (JSON.parse(line)?.type === "session_info") return true;
		} catch {
			// 坏行跳过
		}
	}
	return false;
}

/** 最后一条 session_info entry（阶段 2 标题断言用）。 */
function lastSessionInfo(lines) {
	let last = null;
	for (const line of lines ?? []) {
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "session_info") last = entry;
		} catch {
			// 坏行跳过
		}
	}
	return last;
}

export async function runA4() {
	return runScenario("A4", async (log) => {
		const fixture = makeTsFixture();

		// ── 阶段 1：坏 provider → error 轮 ──
		const h1 = await spawnPi({
			tag: "a4p1",
			cwd: fixture.dir,
			modelsJson: { providers: { "xiaomi-token-plan-cn": { baseUrl: "http://127.0.0.1:1/v1" } } },
		});
		let sessionFile = null;
		try {
			const errEndP = h1.rpc.waitFor("turn_end", {
				timeoutMs: 120_000,
				filter: (ev) => ev?.message?.stopReason === "error",
			});
			const settled1P = h1.rpc.waitAgentSettled(120_000);
			await h1.rpc.prompt("帮我看下这个目录结构");
			const errEnd = await errEndP;
			await settled1P; // settled 不代表成功（探针 4：error 轮照常 settled）
			log(`阶段1 turn_end stopReason=${errEnd.message?.stopReason} errorMessage=${errEnd.message?.errorMessage}`);

			const skipErr = await h1.rpc.waitForStderr(/skip: stopReason=/);
			assert(skipErr.line.includes("skip: stopReason=error"), `阶段1 期望 skip: stopReason=error，实际: ${skipErr.line}`);

			const llmCount = h1.timeline
				.all()
				.filter((e) => e.stream === "err" && e.line.includes("LLM request messages: ")).length;
			assert(llmCount === 0, `阶段1 出现 ${llmCount} 条 LLM request（error 轮不应触发 rename LLM 调用）`);

			const lines1 = await h1.readSessionLines();
			assert(!hasAutoSessionInfo(lines1), "阶段1 出现自动 session_info（error 轮不应命名）");

			// pi 存活 + 取 session 文件路径（阶段 2 续跑前提）
			const st1 = await h1.rpc.getState();
			sessionFile = st1.data?.sessionFile ?? null;
			assert(sessionFile, "阶段1 get_state 未返回 sessionFile");
			assert(existsSync(sessionFile), `阶段1 session 文件不存在（--session 续跑前提缺失）: ${sessionFile}`);
			log(`阶段1 OK: skip: stopReason=error / 无 LLM request / 无 session_info / pi 存活`);
		} finally {
			h1.kill(); // 只杀进程；tmp（含 session 文件）留到阶段 2 结束后清理
		}

		// ── 阶段 2：正常配置 + --session 续跑 → 下一成功轮命名 ──
		const h2 = await spawnPi({ tag: "a4p2", cwd: fixture.dir, sessionFile });
		try {
			const settled2P = h2.rpc.waitAgentSettled(180_000);
			await h2.rpc.prompt("现在把刚才目录里的 ts 文件数一下");
			await settled2P;
			const llmReq = await h2.rpc.waitForStderr("LLM request messages: ", { timeoutMs: 120_000 });
			assert(!!llmReq, "阶段2 未见 LLM request 日志");
			const rename2 = await h2.rpc.waitForStderr('renamed to "', { timeoutMs: 45_000 });
			assert(rename2.line.includes('renamed to "'), `阶段2 期望 renamed to，实际: ${rename2.line}`);
			await sleep(600); // setSessionName 落库 flush 余量

			const st2 = await h2.rpc.getState();
			assert(st2.data?.sessionFile === sessionFile, `阶段2 sessionFile 不一致: ${st2.data?.sessionFile} vs ${sessionFile}`);
			const lines2 = await h2.readSessionLines();
			assert(Array.isArray(lines2), "阶段2 session JSONL 不存在或不可读");
			const lastInfo = lastSessionInfo(lines2);
			assert(lastInfo && typeof lastInfo.name === "string" && lastInfo.name.length > 0, "阶段2 session_info 无标题");
			const logTitle = rename2.line.match(/renamed to "(.*)"$/)?.[1];
			assert(logTitle === lastInfo.name, `阶段2 日志标题与落库不一致: "${logTitle}" vs "${lastInfo.name}"`);
			log(`阶段2 OK: LLM request 出现 + session_info 落库标题「${lastInfo.name}」`);
		} finally {
			h2.cleanup();
			h1.cleanup(); // 阶段 2 已结束，此时才删阶段 1 tmp（session 文件已用完）
			fixture.cleanup();
		}
	});
}

// ── 独立执行入口（node e2e/run-a4.mjs）──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	runA4().then((r) => {
		process.exitCode = r.ok ? 0 : 1;
	});
}
