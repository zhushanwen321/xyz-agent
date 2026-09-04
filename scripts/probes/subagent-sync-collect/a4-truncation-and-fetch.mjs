#!/usr/bin/env node
// scripts/probes/subagent-sync-collect/a4-truncation-and-fetch.mjs
//
// [A4] 批条目截断 + session_read 取回一致（两子场景）
// 设计 docs/design/subagent-sync-collect.md §4 验收表 A4 行：
//   ① 1 个 collect:"sync" start，task 要求输出 >10000 字符 → 批条目按
//      perItemChars=4000 截断，指针行给出 session_read 取回路径；随后发
//      session_read {"action":"result","session":"<id>"} 取回，与截断前全文一致。
//   ② 7 个 sync 各输出 ~6000 字符 → 条目预算收紧至 floor(24000/7)=3428，
//      条目正文总量不超 totalChars=24000。
// 预期输出：
//   ① 恰 1 条批通知（批头 `1 finished, 0 failed, 0 cancelled`）；条目正文 ≤4000 字符；
//      指针行 `[truncated ... full result: session_read {"action":"result","session":"<id>"}]`；
//      session_read 取回 toolResult == 子 session 磁盘全文（逐字节）。
//   ② 恰 1 条批通知（批头 `7 finished, 0 failed, 0 cancelled`）；每条目正文 ≤3428；
//      条目正文总量 ≤24000；批条目 id 集 == 派发 7 成员 id 集。
//
// 用法：node a4-truncation-and-fetch.mjs [--dry-run] [--only single|seven]
//   PI_PROBE_MODEL 覆盖模型（缺省 xiaomi-token-plan-cn/mimo-v2.5-pro）
//   本场景含 11000 字符长文生成 + 7 并发成员，属长时场景——主 agent 统一执行，
//   探针只保证可执行性。

import * as C from "./common.mjs";

const SCENARIO = "A4";
const DESIGN = "subagent-sync-collect.md §4 验收表 A4（批条目截断 + session_read 取回一致）";
const EXPECT =
  "①条目截断至 4000 + 指针行 + session_read 取回与全文逐字节一致；②7 成员各收紧至 3428、总量 ≤24000";

function argOnly() {
  const i = process.argv.indexOf("--only");
  const v = i >= 0 ? process.argv[i + 1] : "both";
  if (v === "single") return ["single"];
  if (v === "seven") return ["seven"];
  return ["single", "seven"];
}

/** 条目内指针行（以 `[truncated ` 开头的行）。 */
function pointerLineOf(item) {
  return item.split("\n").find((l) => l.startsWith("[truncated ")) || null;
}

/** 从指针行解析 session_read 的 session id。 */
function pointerSessionId(item) {
  const line = pointerLineOf(item);
  if (!line) return null;
  const m = line.match(/"session"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function firstDiffIndex(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** 批唤醒 turn 可能仍在跑（LLM 见指针后或自行 session_read），prompt 被拒则退避重试。 */
async function promptWithRetry(session, message, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await session.prompt(message, 180000);
    } catch (err) {
      lastErr = err;
      await C.sleep(10000);
    }
  }
  throw lastErr;
}

// ── 子场景 ①：单成员 11000 字符 → 截断 4000 + 指针 + 取回一致 ──

async function runSingle(checks) {
  const ws = C.makeWorkspace("a4-single");
  const session = C.spawnSession({
    piBin: C.resolvePiBin(),
    cwd: ws.cwd,
    sessionDir: ws.sessionDir,
    model: C.resolveModel(),
    label: `${SCENARIO}-single`,
  });
  try {
    const ready = await session.waitReady();
    checks.check("[①] pi RPC 就绪", !!ready, ready ? "" : session.stderrTail());

    const prompt = C.dispatchPrompt({
      starts: [
        {
          task:
            "You MUST actually run this exact bash command first: head -c 11000 /dev/zero | tr '\\0' 'A' . " +
            "Then your ENTIRE final reply must be exactly that command's output: the letter 'A' repeated 11000 " +
            "times on a single line. Do not summarize, truncate or annotate it — reproduce it in full.",
          slug: "long-output",
          collect: "sync",
        },
      ],
    });
    const turn = await session.prompt(prompt, 120000);
    checks.check("[①] 派发轮 turn_end", !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

    const entries = await C.waitForNotify(session.sessionFile, 240000, (ns) => ns.length > 0, "批 notify entry");
    const batches = C.syncBatchNotifyEntries(entries);
    checks.check("[①] 恰 1 条批通知", batches.length === 1, `batches=${batches.length}`);
    if (!batches[0]) return;
    const batch = batches[0];
    const header = batch.content.split("\n")[0];
    checks.check(
      "[①] 批头 `1 finished, 0 failed, 0 cancelled`",
      header === "Subagent batch completed: 1 finished, 0 failed, 0 cancelled.",
      header,
    );

    const segs = C.batchSegments(batch.content);
    checks.check("[①] 批头 + 1 条目", segs.length === 2, `segments=${segs.length}`);
    const item = segs[1];
    if (!item) return;

    const body = C.itemResultBody(item);
    checks.check(
      "[①] 条目正文截断至 ≤4000 字符（perItemChars）",
      body.length > 0 && body.length <= C.BUDGET.perItemChars,
      `body=${body.length} limit=${C.BUDGET.perItemChars}`,
    );
    checks.note("[①] 实际保留长度", `${body.length}`);

    const pLine = pointerLineOf(item);
    checks.check("[①] 指针行存在（[truncated ... session_read ...]）", !!pLine, pLine || "(无)");
    const sid = pointerSessionId(item);
    checks.check("[①] 指针行含取回路径 session id", !!sid, sid || "(未解析到)");

    // 截断前全文（磁盘同源：子 session 最终 assistant 正文）
    const subFiles = C.subagentSessionFiles(ws);
    checks.check("[①] 子 session 文件唯一", subFiles.length === 1, `files=${subFiles.length}`);
    if (subFiles.length !== 1) return;
    const fullText = C.finalAssistantText(subFiles[0]);
    checks.check(
      "[①] 截断前全文 >4000 字符（截断确实发生）",
      fullText.length > C.BUDGET.perItemChars,
      `full=${fullText.length}`,
    );
    if (fullText.length < 10000) {
      checks.note("[①] 全文未达设计意图的 10000+（模型欠产；截断门不受影响）", `full=${fullText.length}`);
    }

    const starts = C.dispatchedStarts(entries);
    const syncStarts = starts.filter((s) => s.collect === "sync");
    checks.check("[①] 派发 1 个 collect:sync start", syncStarts.length === 1, `starts=${starts.length}`);
    if (syncStarts.length === 1) {
      checks.check("[①] 批条目 == 派发成员", item.includes(syncStarts[0].saId), `expect ${syncStarts[0].saId}`);
    }

    if (!sid) return;

    // session_read 取回（指针行给出的路径）
    const fetchPrompt =
      `Use the session_read tool with exactly these arguments: {"action":"result","session":${JSON.stringify(sid)}}. ` +
      "Do not pass any other arguments. After the tool result returns, reply with only: fetched";
    const fetchTurn = await promptWithRetry(session, fetchPrompt);
    checks.check("[①] session_read 取回轮 turn_end", !!fetchTurn.ok, `stopReason=${fetchTurn.stopReason || "n/a"}`);

    const entries2 = C.readJsonlEntries(session.sessionFile);
    const results = C.toolResultTexts(entries2, "session_read");
    const fetched = results.length > 0 ? results[results.length - 1] : null;
    checks.check("[①] session_read toolResult 存在", !!fetched, `results=${results.length}`);
    if (!fetched) return;
    const identical = fetched === fullText;
    checks.check(
      "[①] 取回与截断前全文逐字节一致",
      identical,
      identical
        ? `len=${fetched.length}`
        : `fetched=${fetched.length} full=${fullText.length} 首差异@${firstDiffIndex(fetched, fullText)}`,
    );
    if (!identical && fetched.includes(fullText)) {
      checks.note("[①] 取回为全文 + 额外包装（完整性成立，逐字节门未过）", `wrapper=${fetched.length - fullText.length} chars`);
    }

    C.appendResultRecord(SCENARIO, [
      `- [①] 模型: ${C.resolveModel()}`,
      `- [①] 全文长度: ${fullText.length}（截断前）／保留: ${body.length}（≤${C.BUDGET.perItemChars}）`,
      `- [①] 取回一致: ${identical ? "yes（逐字节）" : "no"}`,
    ]);
  } finally {
    session.kill();
    await session.waitExit();
    ws.cleanup();
  }
}

// ── 子场景 ②：7 成员各 ~6000 字符 → 收紧至 3428 + 总量不超限 ──

async function runSeven(checks) {
  const ws = C.makeWorkspace("a4-seven");
  const session = C.spawnSession({
    piBin: C.resolvePiBin(),
    cwd: ws.cwd,
    sessionDir: ws.sessionDir,
    model: C.resolveModel(),
    label: `${SCENARIO}-seven`,
  });
  try {
    const ready = await session.waitReady();
    checks.check("[②] pi RPC 就绪", !!ready, ready ? "" : session.stderrTail());

    const starts = Array.from({ length: 7 }, (_, i) => ({
      task:
        "Do not use any tools. Your ENTIRE final reply must be the uppercase letter 'B' repeated 6000 times " +
        "on a single line. No other text, no numbering, no commentary.",
      slug: `bulk-six-${i + 1}`,
      collect: "sync",
    }));
    const prompt = C.dispatchPrompt({ starts });
    const turn = await session.prompt(prompt, 120000);
    checks.check("[②] 派发轮 turn_end", !!turn.ok, `stopReason=${turn.stopReason || "n/a"}`);

    const entries = await C.waitForNotify(session.sessionFile, 300000, (ns) => ns.length > 0, "批 notify entry（7 成员）");
    const batches = C.syncBatchNotifyEntries(entries);
    checks.check("[②] 恰 1 条批通知", batches.length === 1, `batches=${batches.length}`);
    if (!batches[0]) return;
    const batch = batches[0];
    const header = batch.content.split("\n")[0];
    checks.check(
      "[②] 批头 `7 finished, 0 failed, 0 cancelled`",
      header === "Subagent batch completed: 7 finished, 0 failed, 0 cancelled.",
      header,
    );

    const segs = C.batchSegments(batch.content);
    checks.check("[②] 批头 + 7 条目", segs.length === 8, `segments=${segs.length}`);

    const bodies = segs.slice(1).map((s) => C.itemResultBody(s));
    const over = bodies.map((b, i) => [i + 1, b.length]).filter(([, len]) => len > C.EFFECTIVE_PER_ITEM_7);
    checks.check(
      "[②] 每条目正文 ≤3428（floor(24000/7) 收紧）",
      over.length === 0,
      over.length > 0
        ? `超限: ${over.map(([n, len]) => `#${n}=${len}`).join(",")}`
        : `lens=${bodies.map((b) => b.length).join(",")}`,
    );
    const total = bodies.reduce((a, b) => a + b.length, 0);
    checks.check(
      "[②] 条目正文总量 ≤24000（totalChars）",
      total <= C.BUDGET.totalChars,
      `total=${total} limit=${C.BUDGET.totalChars}`,
    );

    const truncated = segs.slice(1).filter((s) => pointerLineOf(s));
    checks.check("[②] 至少 1 条目带截断指针（收紧确实发生）", truncated.length >= 1, `truncated=${truncated.length}/7`);
    if (truncated.length < 7) {
      checks.note("[②] 未全部截断（成员欠产 6000 字符）", `truncated=${truncated.length}/7 lens=${bodies.map((b) => b.length).join(",")}`);
    }

    const dispatched = C.dispatchedStarts(entries);
    const syncStarts = dispatched.filter((s) => s.collect === "sync");
    checks.check("[②] 派发 7 个 collect:sync start", dispatched.length === 7 && syncStarts.length === 7, `starts=${dispatched.length}/${syncStarts.length} sync`);
    const itemIds = new Set(segs.slice(1).map((s) => (s.match(/sa-[0-9a-f]+/i) || [])[0]).filter(Boolean));
    const startIds = new Set(syncStarts.map((s) => s.saId));
    checks.check(
      "[②] 批条目 id 集 == 派发 sync 成员 id 集",
      itemIds.size === 7 && startIds.size === 7 && [...itemIds].every((id) => startIds.has(id)),
      `items=${itemIds.size} starts=${startIds.size}`,
    );

    C.appendResultRecord(SCENARIO, [
      `- [②] 成员正文长度: ${bodies.map((b) => b.length).join(" / ")}（上限 ${C.EFFECTIVE_PER_ITEM_7}）`,
      `- [②] 总量: ${total}（≤${C.BUDGET.totalChars}）`,
    ]);
  } finally {
    session.kill();
    await session.waitExit();
    ws.cleanup();
  }
}

async function main() {
  if (C.isDryRun(process.argv)) {
    process.exit(
      C.dryRunReport({
        scenarioId: SCENARIO,
        design: DESIGN,
        expect: EXPECT,
        scriptFile: import.meta.url,
        plan: [
          "① mkdtemp + spawn pi RPC → 1 个 collect:sync start（task 要求 11000 字符 'A' 输出）",
          "① 等批通知 ≤240s：批头 1 finished / 条目正文 ≤4000 / 指针行含 session id",
          "① 发 session_read {action:result, session:<id>} → toolResult 与子 session 磁盘全文逐字节一致",
          "② 新工作区：同轮 7 个 collect:sync start（各要求 6000 字符 'B' 输出）",
          "② 等批通知 ≤300s：批头 7 finished / 每条目 ≤3428 / 总量 ≤24000 / id 集一致",
          "可选 --only single|seven 分跑子场景",
        ],
      }),
    );
  }

  const checks = C.makeChecks();
  const only = argOnly();
  if (only.includes("single")) await checks.guard("[①] 子场景执行异常", () => runSingle(checks));
  if (only.includes("seven")) await checks.guard("[②] 子场景执行异常", () => runSeven(checks));
  checks.finish(SCENARIO);
}

C.runScenario(SCENARIO, main);
