// zcode-engine-inflight.test.ts —— EnginePort.inFlightSnapshot 快照判定（u7a，fake
// appserver 子进程，绝不 spawn 真 zcode.cjs）。设计权威源：
// docs/design/crash-forensics-and-watchdog.md §3.3 D5「zcode 侧 = 新增只读快照面」。
//
// 机制锚点：计数权威 = activeSessions（attempt 在 create 应答后 add / finally settle
// 后 delete，与 dispose 的 close 帧目标集同一状态源）。语义裁决（D5 显式排除）：
// **appserver 空闲常驻（activeSessions 空、进程活）≠ 在途**——poolKey 'shared' 常驻
// 进程恒活，按进程存在判定会恒真、推迟常态化。本文件验证：
//   ① 从未 run（无运行时）→ 恒 0；
//   ② 在途 turn（create 应答后 settle 前）→ 1；
//   ③ dispose 收割在途 turn → 回 0（收割后无在途会话）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineRunResult, RunContext } from "../../../port.ts";
import type { AgentCallOpts } from "../../../../../orchestration/models/types.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";

/** 挂起场景：send 后零推送——turn 无事件无终态（稳定在途窗口的前提）。 */
const HANG_PUSHES: string[] = [];

const engines: ZcodeEngine[] = [];
let seq = 0;
let tmpRoot: string;
let dataDir: string;
let v2Path: string;

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-eng-inflight-"));
  dataDir = path.join(tmpRoot, "data");
  v2Path = path.join(tmpRoot, "v2.json");
  writeJson(v2Path, {
    provider: { [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } } },
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

interface EngineFixture {
  engine: ZcodeEngine;
  stateFile: string;
  scenarioFile: string;
  workspace: string;
}

function makeEngine(): EngineFixture {
  seq += 1;
  const stateFile = path.join(tmpRoot, `state-${seq}.jsonl`);
  const scenarioFile = path.join(tmpRoot, `scenario-${seq}.json`);
  const workspace = path.join(tmpRoot, `ws-${seq}`);
  writeJson(scenarioFile, {
    createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
    readResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
    sendPushes: HANG_PUSHES.map((l) => JSON.parse(l) as Record<string, unknown>),
  });
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2Path },
    processEnv: {
      PATH: process.env.PATH ?? "",
      XYZ_ZCODE_MODE: "appserver",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
    },
  };
  const engine = new ZcodeEngine(deps);
  engines.push(engine);
  return { engine, stateFile, scenarioFile, workspace };
}

// ── 流水读取 helpers（与 zcode-engine-dispose.test.ts 同款） ──

interface StateEvent {
  seq: number;
  ev: string;
  [key: string]: unknown;
}

function readState(file: string): StateEvent[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StateEvent);
  } catch {
    return [];
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sentMethods(stateFile: string): string[] {
  return readState(stateFile)
    .map((e) => e.frame)
    .filter((f): f is Record<string, unknown> => isRecord(f) && typeof f.method === "string")
    .map((f) => f.method as string);
}

/** 轮询流水直到指定 method 出现（create 应答 = activeSessions.add 的同步点；超时抛错）。 */
async function waitForMethod(stateFile: string, method: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sentMethods(stateFile).includes(method)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`流水 ${timeoutMs}ms 内未出现 ${method}——在途 turn 未建立`);
}

function makeTask(overrides?: Partial<AgentCallOpts>): AgentCallOpts {
  return { prompt: "做点什么", description: "s", model: `${PROVIDER}/m1`, ...overrides };
}

function makeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-inflight", poolKey: "", ...overrides };
}

describe("inFlightSnapshot 快照判定（D5：activeSessions 非空才算在途）", () => {
  it("从未 run（运行时未初始化）→ 恒 0；快照同步纯读", () => {
    const { engine } = makeEngine();
    // 引擎对象在场 ≠ 在途任务：快照只看 activeSessions，不看进程/连接存在性
    expect(engine.inFlightSnapshot()).toEqual({ inFlight: 0 });
    expect(engine.inFlightSnapshot()).toEqual({ inFlight: 0 });
  }, 15_000);

  it("在途 turn（create 应答后 settle 前）→ 1；dispose 收割后 → 0（收割≠重建，无残留计数）", async () => {
    // 两 timer 显式关闭（规则 19 opt-out 形态）——排除 timeout 判死路径，终态只能
    // 来自 dispose 收割链（快照归零的时序因此确定）。
    vi.stubEnv("XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS", "0");
    vi.stubEnv("XYZ_ZCODE_TURN_MAX_TIMEOUT_MS", "0");
    const f = makeEngine();
    const runPromise: Promise<EngineRunResult> = f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    await waitForMethod(f.stateFile, "session/send"); // create 应答已到达（activeSessions.add 已执行）

    // 在途窗口：turn 未落定，快照计 1（正在执行的 zcode 任务 = 在途）
    expect(f.engine.inFlightSnapshot()).toEqual({ inFlight: 1 });

    await f.engine.dispose();
    await runPromise.catch(() => undefined);
    // 收割后：activeSessions 已清（finally delete + dispose 目标集同源），无残留计数
    expect(f.engine.inFlightSnapshot()).toEqual({ inFlight: 0 });
  }, 30_000);
});
