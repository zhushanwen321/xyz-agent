// fake-engine-protocol.mjs —— W10 协议黑盒套件的 fake 引擎 CLI（conformance 专用，
// 与 W2 client/__tests__ 的 fake-engine.mjs 分工：后者测 EngineClient 连接域语义，
// 本件是协议基线回放器——按 fixture（schemaVersion 1）回放帧序列）。
//
// 形态对齐协议 v1（stdout 独占 NDJSON；stdin 帧驱动）：
// - FAKE_PROTOCOL_FIXTURE：fixture JSON 路径（必填）；本件 = 该 fixture 的回放引擎；
// - 正向方法（10 个）：initialize / probe / run / cancel / interact / read /
//   listModels / validateModel / dispose / ping——结果取 fixture 对应段；
// - 反向通道（8 个）：host/log / host/askUser / host/permission / host/streamDelta /
//   host/poolResolved / host/handleReady / host/childSpawned / host/childStateChanged
//   ——run 期间按 fixture.run.script 逐动作播放；
// - 错误帧：FAKE_PROTOCOL_ERROR=run_failed（run 回错误帧）| unknown_method（对任意
//   未知名方法回 engine_method_unknown——不在 v1 错误码表内的码也必须原样透传，
//   断言的是帧形态而非码表）；FAKE_PROTOCOL_VERSION 越界 → initialize 回
//   engine_protocol_mismatch；
// - childSpawned 的 pid = 真 spawn 一个同组长眠 node 子进程（供 POSIX kill(-pid,0)
//   组探测断言与 killAll 收割断言——范围口径 R9-1：一代子进程 + 组内后代）。

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const fixturePath = process.env.FAKE_PROTOCOL_FIXTURE;
if (!fixturePath) {
  process.stderr.write("fake-engine-protocol: FAKE_PROTOCOL_FIXTURE is required\n");
  process.exit(1);
}
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const MODE = process.env.FAKE_PROTOCOL_ERROR ?? "none"; // none | run_failed | unknown_method
const PROTOCOL_VERSION = Number(process.env.FAKE_PROTOCOL_VERSION ?? fixture.protocolVersion ?? 1);

let grandchildren = []; // 同组长眠子进程（killAll 收割断言对象）

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}
function reverseRequest(id, method, params) {
  send({ id, method, params });
}

let nextRequestId = 100;

async function playRunScript(runId, script) {
  for (const action of script) {
    if (cancelledRuns.has(runId)) return;
    switch (action.op) {
      case "log":
        reverseRequest(`rev-log-${nextRequestId++}`, "host/log", {
          level: action.level ?? "info",
          component: action.component ?? "fake",
          message: action.message ?? "",
        });
        break;
      case "poolResolved":
        reverseRequest(`rev-pool-${nextRequestId++}`, "host/poolResolved", {
          runId,
          poolKey: action.poolKey ?? "shared",
        });
        break;
      case "handleReady":
        reverseRequest(`rev-ready-${nextRequestId++}`, "host/handleReady", {
          runId,
          sessionRef: action.sessionRef ?? { sessionId: "sess-fixture" },
          poolKey: action.poolKey ?? "shared",
        });
        break;
      case "childSpawned": {
        const grandchild = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { detached: false, stdio: "ignore" },
        );
        grandchildren.push(grandchild);
        reverseRequest(`rev-child-${nextRequestId++}`, "host/childSpawned", {
          pid: grandchild.pid,
          recordId: action.recordId ?? runId,
        });
        break;
      }
      case "childStateChanged":
        reverseRequest(`rev-childst-${nextRequestId++}`, "host/childStateChanged", {
          pid: grandchildren[grandchildren.length - 1]?.pid,
          recordId: action.recordId ?? runId,
          state: action.state ?? "exited",
          killed: action.killed ?? false,
          ...(action.exitCode !== undefined ? { exitCode: action.exitCode } : {}),
          ...(action.signal !== undefined ? { signal: action.signal } : {}),
        });
        break;
      case "streamDelta":
        reverseRequest(`rev-stream-${nextRequestId++}`, "host/streamDelta", {
          runId,
          delta: action.delta ?? "",
        });
        break;
      case "permission":
        reverseRequest(`rev-perm-${nextRequestId++}`, "host/permission", {
          runId,
          request: action.request ?? {},
        });
        break;
      case "askUser":
        reverseRequest(`rev-ask-${nextRequestId++}`, "host/askUser", {
          runId,
          request: action.request ?? {},
        });
        break;
      case "emit":
        send({ method: "event", params: { runId, seq: action.seq, event: action.event } });
        break;
      case "hang":
        // 挂起至 cancel 收敛（无 cancel 则永久挂起——core 3s 收敛窗口超时杀链面）
        await new Promise((resolveHang) => {
          hangingRuns.set(runId, resolveHang);
        });
        break;
      default:
        break;
    }
  }
}

const KNOWN_METHODS = new Set([
  "initialize", "probe", "run", "cancel", "interact", "read",
  "listModels", "validateModel", "dispose", "ping",
]);

const askUserResults = new Map(); // 反向请求 id → 最终结果帧②（交互面两阶段）
const hangingRuns = new Map(); // runId → settle()——cancel 收敛用（hang 动作挂起时登记）
const cancelledRuns = new Set(); // cancel 已收敛的 runId——后续脚本动作全部跳过

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }

  // 帧②（core 对反向请求的应答）：askUser 最终结果到达——回放层记录后继续。
  if (typeof frame.id === "string") {
    askUserResults.set(frame.id, frame.result ?? { unsupported: frame.error !== undefined });
    return;
  }

  const { id, method, params } = frame;
  if (MODE === "unknown_method" && !KNOWN_METHODS.has(method)) {
    send({
      id,
      error: {
        code: "engine_method_unknown",
        message: `method "${method}" is not part of protocol v1`,
        recovery: "Upgrade the engine package or align the protocol version.",
      },
    });
    return;
  }

  switch (method) {
    case "initialize": {
      if (PROTOCOL_VERSION !== fixture.protocolVersion) {
        send({
          id,
          error: {
            code: "engine_protocol_mismatch",
            message: `engine speaks protocol v${PROTOCOL_VERSION}, core requested/handshake produced v${fixture.protocolVersion}`,
            recovery: "Align the engine package version with the host.",
            data: { engineVersion: PROTOCOL_VERSION, coreVersion: fixture.protocolVersion },
          },
        });
        return;
      }
      send({ id, result: fixture.initialize.result });
      return;
    }
    case "probe":
      if (process.env.FAKE_PROBE_FAIL === "1" && fixture.probeFailure !== undefined) {
        send({ id, result: fixture.probeFailure });
      } else {
        send({ id, result: fixture.probe.result });
      }
      return;
    case "listModels":
      send({ id, result: fixture.listModels.result });
      return;
    case "validateModel":
      send({ id, result: fixture.validateModel.result });
      return;
    case "interact":
      send({ id, result: fixture.interact.result });
      return;
    case "read":
      send({ id, result: fixture.read.result });
      return;
    case "ping":
    case "dispose":
      send({ id, result: { ok: true } });
      if (method === "dispose") {
        for (const g of grandchildren) g.kill("SIGTERM");
        setImmediate(() => process.exit(0));
      }
      return;
    case "cancel": {
      // 受理应答 + 收敛在途挂起 run（3s 收敛窗口语义）：挂起中的 playRunScript
      // 以 cancelResult 终态应答回收（协议 cancel 契约：引擎须在窗口内收敛终态）。
      send({ id, result: { ok: true } });
      const runId = params?.runId;
      const settle = hangingRuns.get(runId);
      if (settle !== undefined) {
        hangingRuns.delete(runId);
        cancelledRuns.add(runId);
        settle(); // 收敛：挂起解除，run 以 cancelResult 终态应答（脚本余项跳过）
      }
      return;
    }
    case "run": {
      if (MODE === "run_failed") {
        send({
          id,
          error: {
            code: "engine_run_failed",
            message: "scripted run failure (redacted)",
            recovery: "Inspect the task and retry.",
          },
        });
        return;
      }
      const runId = params?.runId ?? "run-smoke-1";
      const script = process.env.FAKE_RUN_HANG === "1"
        ? [{ op: "poolResolved", poolKey: "shared" }, { op: "hang" }, ...fixture.run.script]
        : fixture.run.script;
      playRunScript(runId, script)
        .then(() => send({ id, result: cancelledRuns.has(runId)
          ? (fixture.run.cancelResult ?? {
              handle: fixture.run.result.handle,
              outcome: { content: "", error: "engine_run_failed: cancelled (fake)", exitCode: null, engineId: fixture.engineId },
            })
          : fixture.run.result }))
        .catch((err) => {
          send({ id, error: { code: "engine_run_failed", message: String(err), recovery: "Inspect the engine logs." } });
        });
      return;
    }
    default:
      send({
        id,
        error: {
          code: "engine_method_unknown",
          message: `unhandled method "${String(method)}"`,
          recovery: "Align protocol versions.",
        },
      });
  }
});

// stdin EOF（宿主死亡）→ 自灭 + 收割同组后代（R9-1：一代子进程 + 组内后代零残留；
// 引擎自身 detached 后代不在收割覆盖范围——设计 §3.9 已接受代价）。
process.stdin.on("end", () => {
  for (const g of grandchildren) g.kill("SIGKILL");
  process.exit(0);
});
