// 探针：验证 ZCODE_SESSION_DB_PATH 是否能把 app-server 的会话库隔离到别处
// （不污染宿主 ~/.zcode/cli/db/db.sqlite）。只做 session/create + close，不发 prompt。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const sqlite = require_("node:sqlite");

const ts = Date.now();
const probeDir = join(tmpdir(), `zc-probe-${ts}`);
const wsDir = join(probeDir, "ws");
mkdirSync(wsDir, { recursive: true });
const dbPath = join(probeDir, "isolated", "db.sqlite");
mkdirSync(join(probeDir, "isolated"), { recursive: true });

const LAUNCHER = join(homedir(), ".xyz-agent/engines/zcode/appserver-launcher.cjs");
const HOST_DB = join(homedir(), ".zcode/cli/db/db.sqlite");

const env = { ...process.env };
for (const k of [
  "ELECTRON_RUN_AS_NODE",
  "XYZ_AGENT_DATA_DIR",
  "XYZ_SUBAGENT_RELAY_STDIN",
  "XYZ_SUBAGENT_RELAY_STDOUT",
  "XYZ_SUBAGENT_RELAY_STDERR",
]) delete env[k];
Object.assign(env, {
  ZCODE_ENG_CLI_PATH: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
  ZCODE_ENG_V2_CONFIG: join(homedir(), ".zcode/v2/config.json"),
  ZCODE_SESSION_DB_PATH: dbPath,
  ZCODE_MODEL_TELEMETRY_ENABLED: "false",
});

console.log("[probe] 隔离库路径:", dbPath);
console.log("[probe] 宿主库路径:", HOST_DB);

const child = spawn(process.execPath, [LAUNCHER, "app-server", "--cwd", wsDir], {
  cwd: wsDir,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const replies = new Map();
const stderrTail = [];
child.stderr.on("data", (d) => {
  stderrTail.push(String(d));
  if (stderrTail.length > 20) stderrTail.shift();
});
child.stdout.on("data", (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      replies.set(msg.id, msg);
    } else if (msg.method) {
      // 反向请求必须应答，否则 15s 超时断连
      if (msg.id !== undefined) {
        const prefs =
          msg.method === "session/requestRuntimePreferences"
            ? { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: "preflight-v1" }
            : {};
        child.stdin.write(JSON.stringify({ id: msg.id, result: prefs }) + "\n");
      }
    }
  }
});

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const wait = (id, ms = 20000) =>
  new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      if (replies.has(id)) return res(replies.get(id));
      if (Date.now() - t0 > ms) return res({ timeout: true });
      setTimeout(tick, 100);
    };
    tick();
  });

const ws = { workspacePath: wsDir, workspaceKey: "ws-probe-" + ts };

// ① 普通 create（带 titleGenerationEnabled:false）
send({
  id: 1,
  method: "session/create",
  params: { workspace: ws, mode: "yolo", persistence: "immediate", titleGenerationEnabled: false },
});
const r1 = await wait(1);
console.log("\n[① create] =>", JSON.stringify(r1).slice(0, 1800));
const sid1 = r1?.result?.session?.sessionId ?? r1?.result?.session?.id ?? r1?.result?.sessionId; console.log("sid1 =", sid1);

// ② create 带 parentSessionId（指向①）+ 帧级 traceId（探测是否能带自定义标记）
send({
  id: 2,
  traceId: "xyz-probe-trace-001",
  method: "session/create",
  params: {
    workspace: ws,
    mode: "yolo",
    persistence: "immediate",
    titleGenerationEnabled: false,
    parentSessionId: sid1,
  },
});
const r2 = await wait(2);
console.log("\n[② create+parent] =>", JSON.stringify(r2).slice(0, 800));
const sid2 = r2?.result?.session?.sessionId ?? r2?.result?.session?.id ?? r2?.result?.sessionId; console.log("sid2 =", sid2);

// ③ create 带 taskType（预期 strict schema 拒收 -32602）
send({
  id: 3,
  method: "session/create",
  params: { workspace: ws, mode: "yolo", persistence: "immediate", taskType: "subagent_child" },
});
const r3 = await wait(3);
console.log("\n[③ create+taskType] =>", JSON.stringify(r3).slice(0, 300));

for (const [id, sid] of [[4, sid1], [5, sid2]]) {
  if (sid) send({ id, method: "session/close", params: { sessionId: sid } });
  if (sid) await wait(id, 5000);
}

const q = (path, sql) => {
  try {
    const db = new sqlite.DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(sql).all();
    db.close();
    return rows;
  } catch (e) {
    return "ERR: " + e.message;
  }
};

await new Promise((r) => setTimeout(r, 800));
console.log("\n=== 结果核对 ===");
console.log("隔离库存在:", existsSync(dbPath));
if (existsSync(dbPath)) {
  console.log("隔离库 session 行:", JSON.stringify(q(dbPath,
    `select id, task_type, parent_id, title_source, trace_id, directory from session`)));
  console.log("隔离库表数:", JSON.stringify(q(dbPath, `select count(*) n from sqlite_master where type='table'`)));
}
if (sid1) {
  console.log("宿主库是否出现 sid1:", JSON.stringify(q(HOST_DB, `select count(*) n from session where id='${sid1}'`)));
}
if (sid2) {
  console.log("宿主库是否出现 sid2:", JSON.stringify(q(HOST_DB, `select count(*) n from session where id='${sid2}'`)));
}
console.log("stderr 尾:", stderrTail.join("").slice(-500));

child.stdin.end();
child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 1500));
if (child.exitCode === null) child.kill("SIGKILL");
console.log("\n[probe] 结束。清理: rm -rf", probeDir);
