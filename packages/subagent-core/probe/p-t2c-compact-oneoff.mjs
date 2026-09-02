// probe/p-t2c-compact-oneoff.mjs
//
// P-T2c 附属实验：显式 compact 的真实耗时（大 session compaction 量级参考）。
// P-T2c 主探针 6 轮（最高 400KB ~100k tokens）均未触发 auto-compact，
// agent_end→settled 窗口全 0ms。本实验用 {type:"compact"} 命令直接测量
// compaction 执行耗时，为 T2-③ 10min 硬上限的「compact 分支」提供量级参考。
// 注：显式 compact 不在 settled 窗口语义内（那是 agent_end 后的 auto-compact
// 检查），数据仅作量级参照，不作窗口实测样本。
//
// 运行：node probe/p-t2c-compact-oneoff.mjs   （在 packages/subagent-core/ 下）

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";

const MODEL = "xiaomi-token-plan-cn/mimo-v2.5-pro";
const PI_BIN = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const STARTED = Date.now();
function log(msg) {
  process.stdout.write(`[compact-oneoff ${((Date.now() - STARTED) / 1000).toFixed(1)}s] ${msg}\n`);
}
function makeLongText(sizeKB) {
  const unit =
    "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. " +
    "How vexingly quick daft zebras jump. Sphinx of black quartz, judge my vow. ";
  const block = unit.repeat(16);
  return block.repeat(Math.ceil((sizeKB * 1024) / block.length));
}

const sessionDir = mkdtempSync("/tmp/p-t2c-compact-");
const child = spawn(
  PI_BIN,
  ["--mode", "rpc", "--no-extensions", "--session-dir", sessionDir, "--model", MODEL, "--approve"],
  { stdio: ["pipe", "pipe", "pipe"] },
);

let buf = "";
let compactStartAt = null;
const timeline = [];

/** compaction_start / compaction_end 打点（compact 耗时测量的主事件）。 */
function handleCompactionEvent(ev, now) {
  if (ev.type === "compaction_start") {
    compactStartAt = now;
    timeline.push({ event: "compaction_start", t: now - STARTED });
    log("compaction_start");
  }
  if (ev.type === "compaction_end") {
    timeline.push({ event: "compaction_end", t: now - STARTED, durationMs: compactStartAt ? now - compactStartAt : null });
    log(`compaction_end (duration=${compactStartAt ? now - compactStartAt : "?"}ms)`);
  }
}

/** agent_settled 打点。 */
function handleAgentSettledEvent(now) {
  timeline.push({ event: "agent_settled", t: now - STARTED });
  log("agent_settled");
}

/** response 应答按 command 分打点（compact / prompt 拒绝 / session stats）。 */
function handleResponseEvent(ev, now) {
  if (ev.command === "compact") {
    timeline.push({ event: "compact response", t: now - STARTED, success: ev.success, error: ev.error ?? null });
    log(`compact response success=${ev.success} ${ev.error ?? ""}`);
  }
  if (ev.command === "prompt" && !ev.success) {
    log(`prompt rejected: ${ev.error}`);
  }
  if (ev.command === "get_session_stats") {
    timeline.push({ event: "session_stats", t: now - STARTED, data: ev.data });
    log(`session stats: ${JSON.stringify(ev.data).slice(0, 300)}`);
  }
}

/** stdout 分帧：拆行 → JSON.parse（坏行丢弃）→ 按事件类别分派（类型互斥）。 */
function onStdoutChunk(chunk) {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const now = Date.now();
    if (ev.type === "compaction_start" || ev.type === "compaction_end") handleCompactionEvent(ev, now);
    else if (ev.type === "agent_settled") handleAgentSettledEvent(now);
    else if (ev.type === "response") handleResponseEvent(ev, now);
  }
}

child.stdout.on("data", onStdoutChunk);

function send(cmd) {
  child.stdin.write(JSON.stringify(cmd) + "\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 流程：3x 400KB 撑上下文 → get_session_stats → compact → stats → 收尾
send({ type: "prompt", message: "Reply with exactly: OK-1. No other text.", id: "warm" });
await sleep(15000);
for (let i = 1; i <= 3; i++) {
  send({ type: "prompt", message: makeLongText(400) + `\n\nReply with exactly: ACK-${i}.`, id: `fill-${i}` });
  log(`fill-${i} sent (400KB)`);
  await sleep(45000);
}
send({ type: "get_session_stats", id: "stats1" });
await sleep(2000);
log("sending explicit compact...");
send({ type: "compact", id: "compact1" });
await sleep(120000); // compact 上限观察 2min
send({ type: "get_session_stats", id: "stats2" });
await sleep(3000);

console.log("TIMELINE:", JSON.stringify(timeline, null, 2));
try {
  child.kill("SIGTERM");
} catch {}
await sleep(1500);
try {
  rmSync(sessionDir, { recursive: true, force: true });
} catch {}
process.exit(0);
