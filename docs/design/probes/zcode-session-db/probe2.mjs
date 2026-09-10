// 探针 2：隔离 session DB + 真实一轮 prompt 端到端（验证 create→send→落库→read→close）
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const sqlite = require_("node:sqlite");

const ts = Date.now();
const probeDir = join(tmpdir(), `zc-probe2-${ts}`);
const wsDir = join(probeDir, "ws");
const isoDir = join(probeDir, "isolated");
mkdirSync(wsDir, { recursive: true });
mkdirSync(isoDir, { recursive: true });
const dbPath = join(isoDir, "db.sqlite");
const LAUNCHER = join(homedir(), ".xyz-agent/engines/zcode/appserver-launcher.cjs");
const HOST_DB = join(homedir(), ".zcode/cli/db/db.sqlite");

const env = { ...process.env };
for (const k of ["ELECTRON_RUN_AS_NODE", "XYZ_AGENT_DATA_DIR", "XYZ_SUBAGENT_RELAY_STDIN", "XYZ_SUBAGENT_RELAY_STDOUT", "XYZ_SUBAGENT_RELAY_STDERR"]) delete env[k];
Object.assign(env, {
  ZCODE_ENG_CLI_PATH: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
  ZCODE_ENG_V2_CONFIG: join(homedir(), ".zcode/v2/config.json"),
  ZCODE_SESSION_DB_PATH: dbPath,
  ZCODE_MODEL_TELEMETRY_ENABLED: "false",
});

const child = spawn(process.execPath, [LAUNCHER, "app-server", "--cwd", wsDir], { cwd: wsDir, env, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const replies = new Map();
const frames = [];
const stderrTail = [];
child.stderr.on("data", (d) => { stderrTail.push(String(d)); if (stderrTail.length > 20) stderrTail.shift(); });
child.stdout.on("data", (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    frames.push(msg);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) replies.set(msg.id, msg);
    else if (msg.method && msg.id !== undefined) {
      const prefs = msg.method === "session/requestRuntimePreferences"
        ? { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: "preflight-v1" }
        : {};
      child.stdin.write(JSON.stringify({ id: msg.id, result: prefs }) + "\n");
    }
  }
});
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const wait = (id, ms = 60000) => new Promise((res) => { const t0 = Date.now(); const tick = () => { if (replies.has(id)) return res(replies.get(id)); if (Date.now() - t0 > ms) return res({ timeout: true }); setTimeout(tick, 100); }; tick(); });

const ws = { workspacePath: wsDir, workspaceKey: "ws-probe2-" + ts };
send({ id: 1, method: "session/create", params: { workspace: ws, mode: "yolo", persistence: "immediate", titleGenerationEnabled: false } });
const r1 = await wait(1);
const sid = r1?.result?.session?.sessionId;
console.log("[① create] sessionId =", sid, "| sessionKind =", r1?.result?.session?.sessionKind, "| title =", JSON.stringify(r1?.result?.session?.title));
send({ id: 2, method: "session/subscribe", params: { sessionId: sid, deliveryKind: "desktop-continuous" } });
console.log("[② subscribe] =>", JSON.stringify(await wait(2, 10000)).slice(0, 160));
send({ id: 3, method: "session/send", params: { sessionId: sid, content: "只回复两个字：收到" } });
console.log("[③ send] =>", JSON.stringify(await wait(3, 20000)).slice(0, 160));

const t0 = Date.now();
let terminal = false;
while (Date.now() - t0 < 120000) {
  if (frames.some((f) => f.method === "v4/telemetry/event" && f.params?.kind === "turn.terminal")) { terminal = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("[④ 终态到达]", terminal, `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);

send({ id: 4, method: "session/read", params: { sessionId: sid } });
const r4 = await wait(4, 15000);
console.log("[⑤ read] =>", JSON.stringify(r4).slice(0, 300));
send({ id: 5, method: "session/close", params: { sessionId: sid } });
await wait(5, 5000);

await new Promise((r) => setTimeout(r, 1000));
const q = (p, sql) => { try { const db = new sqlite.DatabaseSync(p, { readOnly: true }); const rows = db.prepare(sql).all(); db.close(); return rows; } catch (e) { return "ERR: " + e.message; } };
console.log("\n=== 落库核对 ===");
console.log("隔离库 session 行:", JSON.stringify(q(dbPath, `select id, task_type, parent_id, title, title_source, directory from session`)));
console.log("隔离库 message 行数:", JSON.stringify(q(dbPath, `select count(*) n from message`)));
console.log("隔离库 model_usage:", JSON.stringify(q(dbPath, `select query_source, count(*) n from model_usage group by 1`)));
console.log("宿主库该会话行数:", JSON.stringify(q(HOST_DB, `select count(*) n from session where id='${sid}'`)));
console.log("隔离库文件:", existsSync(dbPath), "| wal:", existsSync(dbPath + "-wal"));
console.log("stderr 尾:", stderrTail.join("").slice(-300));

child.stdin.end(); child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 1500));
if (child.exitCode === null) child.kill("SIGKILL");
console.log("\n[probe2] 清理: rm -rf", probeDir);
