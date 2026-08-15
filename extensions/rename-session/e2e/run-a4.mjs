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

import { assert, assertTitleGuards, runScenario, spawnPi } from "./harness.mjs";

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


export async function runA4() {
	return runScenario("A4", async (log) => {
		const fixture = makeTsFixture();
		// 两阶段共享 fixture/h1 资源；阶段 1 失败时阶段 2 不执行，
		// 若只在阶段 2 的 finally 清理，失败路径会泄漏 h1.tmp 与 fixture 目录——
		// 用 stage2Reached 标记让外层 finally 兜底（成功路径由阶段 2 finally 精确清理）
		let stage2Reached = false;
		const h1 = await spawnPi({
			tag: "a4p1",
			cwd: fixture.dir,
			modelsJson: { providers: { "xiaomi-token-plan-cn": { baseUrl: "http://127.0.0.1:1/v1" } } },
		});
		try {
			// ── 阶段 1：坏 provider → error 轮 ──
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
		stage2Reached = true; // h2 spawn 成功后内层 finally 负责全部清理
		try {
			const settled2P = h2.rpc.waitAgentSettled(180_000);
			await h2.rpc.prompt("现在把刚才目录里的 ts 文件数一下");
			await settled2P;
			await h2.rpc.waitForStderr("LLM request messages: ", { timeoutMs: 120_000 });
			const rename2 = await h2.rpc.waitForStderr('renamed to "', { timeoutMs: 45_000 });
			const st2 = await h2.rpc.getState();
			assert(st2.data?.sessionFile === sessionFile, `阶段2 sessionFile 不一致: ${st2.data?.sessionFile} vs ${sessionFile}`);
			// 轮询等落盘（pi append→flush 有延迟）
			const lastInfo = await h2.waitSessionInfoEntry(10_000);
			assert(lastInfo && typeof lastInfo.name === "string" && lastInfo.name.length > 0, "阶段2 session_info 无标题");
			const logTitle = rename2.line.match(/renamed to "(.*)"$/)?.[1];
			assert(logTitle === lastInfo.name, `阶段2 日志标题与落库不一致: "${logTitle}" vs "${lastInfo.name}"`);
			// 落库标题须为 slug 形态（与 A2 同款两层断言：kebab 遵从是模型问题只记录，
			// 其余（代词开头/时态结尾/超长/句尾标点）是 cleanTitle 契约回归，硬失败）
			const guards = assertTitleGuards(lastInfo.name);
			const kebabViol = guards.violations.find((v) => v.rule === "english-kebab-case");
			const hardViol = guards.violations.filter((v) => v.rule !== "english-kebab-case");
			if (kebabViol) {
				log(`KEBAB_NON_COMPLIANT [A4] 实际标题: "${lastInfo.name}"`);
			}
			assert(
				hardViol.length === 0,
				`阶段2 标题 "${lastInfo.name}" slug guard 失败:\n${hardViol.map((v) => `  [${v.layer}/${v.rule}] ${v.message}`).join("\n")}`,
			);
			log(`阶段2 OK: LLM request 出现 + session_info 落库标题「${lastInfo.name}」`);
		} finally {
			h2.cleanup();
			h1.cleanup(); // 阶段 2 已结束，此时才删阶段 1 tmp（session 文件已用完）
			fixture.cleanup();
		}
		} finally {
			// 失败路径兜底：阶段 1 断言失败（阶段 2 未执行）时清理 h1 与 fixture；
			// 成功/阶段 2 失败路径已由内层 finally 清理，cleanup 幂等可重入
			if (!stage2Reached) {
				h1.cleanup();
				fixture.cleanup();
			}
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
