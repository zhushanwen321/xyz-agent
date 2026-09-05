// zcode-engine-status.test.ts —— [P0-1 U3] 引擎终态 status 消费测试（设计权威源
// docs/design/timeout-zcode-turn-and-settled-watchdog.md §6 D5、§5.2 F-3、§8 A4；
// ⛔P-Z2 降级路径约束「只消费 source="turn.terminal" 的 status」）。
// 全部跑 __fixtures__/fake-appserver.mjs 子进程（sendPushes 逐帧显式注入两种帧序），
// 绝不 spawn 真 zcode.cjs。覆盖：
//   - status='error' 终态 → run-failed（不再假成功——§3.2 缺陷 B）：
//     ① 帧序 A：turn.terminal error 先到（权威 settle，source="turn.terminal"）；
//     ② 帧序 B：final-frame 宽松 settle success 先到 + turn.terminal error 迟到
//        （u-z1 lastTerminalStatus 衔接——channel 只记录不改写落定，消费层识破假成功）；
//   - P-Z2 降级形态：final-frame 先到且 read 无错误信息 → 仍 run-failed 不假成功；
//   - 全空形态（无 delta/收尾帧/read 内容）→ 不伪造错误详情；
//   - 成功路径零回归：terminal success 先到 / final-frame 先到 + terminal success
//     迟到 / final-frame 独走（无 turn.terminal）三形态均 parsed；
//   - schema 任务遇 error 终态：分流先于 schema 校验（不产 schema_emulation_failed、
//     不进强化重试）。
// 错误终态即时到达，idle/ceiling 默认阈值不参与——无需 env stub。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EngineRunResult, RunContext } from "../../../port.ts";
import type { AgentTaskSpec } from "../../../types.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";

const GOLDEN_SESSION_ID = "sess_golden_r3_01";
const GOLDEN_FULL_TEXT = "你好，任务完成";
/** 权威终态 turn.terminal 的 error 帧（A.2 ⑤——status 原样透传）。 */
const TERMINAL_ERROR_FRAME =
  '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"error"}}';
/** 收尾帧（A.2 ⑤ response 形态）——final-frame 宽松终态的注入材料（golden terminal[1]）。 */
const GOLDEN_FINAL_FRAME = ZCODE_APPSERVER_GOLDEN.terminal[1];
/** read 兜底返回的服务端错误文本（read 是全文权威来源——§8 A4「尾部内容可见」载体）。 */
const READ_ERROR_TEXT = "Error: provider request failed (401 Unauthorized)";

let engines: ZcodeEngine[] = [];
let seq = 0;
let tmpRoot: string;
let dataDir: string;
let v2Path: string;

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

beforeEach(() => {
  engines = [];
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-eng-status-"));
  dataDir = path.join(tmpRoot, "data");
  v2Path = path.join(tmpRoot, "v2.json");
  writeJson(v2Path, {
    provider: { [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } } },
  });
});

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

interface ScenarioOverrides {
  /** send 应答前逐帧推送的注入序列（覆盖缺省 golden 流）。 */
  sendPushes: string[];
  /** 覆盖 read 应答（缺省 golden readResponse——assistant 全文）。 */
  readResult?: unknown;
}

interface EngineFixture {
  engine: ZcodeEngine;
  workspace: string;
}

function makeEngine(overrides: ScenarioOverrides): EngineFixture {
  seq += 1;
  const scenarioFile = path.join(tmpRoot, `scenario-${seq}.json`);
  const workspace = path.join(tmpRoot, `ws-${seq}`);
  writeJson(scenarioFile, {
    createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
    readResult: overrides.readResult ?? JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
    sendPushes: overrides.sendPushes.map((l) => JSON.parse(l) as Record<string, unknown>),
  });
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2Path },
    processEnv: {
      PATH: process.env.PATH ?? "",
      // 钉扎 appserver 定向（定向不探不降，与 zcode-engine-appserver.test.ts 同款）
      XYZ_ZCODE_MODE: "appserver",
      FAKE_SESSION_SCENARIO: scenarioFile,
    },
  };
  const engine = new ZcodeEngine(deps);
  engines.push(engine);
  return { engine, workspace };
}

function makeTask(overrides?: Partial<AgentTaskSpec>): AgentTaskSpec {
  return { task: "做点什么", slug: "s", model: `${PROVIDER}/m1`, ...overrides };
}

function makeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-status", poolKey: "", ...overrides };
}

// ============================================================
// status='error' 终态 → run-failed（D5②，§3.2 缺陷 B 根修回归面）
// ============================================================

describe("error 终态分流（P0-1 U3：parsed 前消费 status → run-failed，不假成功）", () => {
  it("帧序 A：turn.terminal error 先到（权威 settle）+ read 错误尾部 → run-failed 且尾部内容可见（A4）", async () => {
    const f = makeEngine({
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, TERMINAL_ERROR_FRAME],
      readResult: { messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: READ_ERROR_TEXT }] }] },
    });
    const r: EngineRunResult = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    // F-3 文案形态：engine_run_failed 前缀 + 终态 status=error + 会话 id（非 engine_timeout 族）
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=error/);
    expect(r.outcome.error).toContain(`（会话 ${GOLDEN_SESSION_ID}）`);
    expect(r.outcome.error).not.toContain("engine_timeout");
    // A4「尾部内容可见」：read 权威全文的错误内容进 message（诊断信息不丢）
    expect(r.outcome.error).toContain(READ_ERROR_TEXT);
    // 恢复指引（F-3）
    expect(r.outcome.error).toContain("engine_credential_missing 同族排查");
    // 失败形态（非成功）：异常终态口径 exitCode=null、content 空
    expect(r.outcome.exitCode).toBeNull();
    expect(r.outcome.content).toBe("");
    // run 不 reject——正常 handle 返回（record 必须收尾），sessionId 留痕进 sessionRef
    expect(r.outcome.sessionId).toBe(GOLDEN_SESSION_ID);
    expect(r.handle.data.sessionRef).toEqual({ sessionId: GOLDEN_SESSION_ID, dbPath: ".zcode/cli/db/db.sqlite" });
  }, 15_000);

  it("帧序 B：final-frame 宽松 settle success 先到 + turn.terminal error 迟到（lastTerminalStatus 衔接）→ 仍 run-failed", async () => {
    const f = makeEngine({
      // final-frame 先落定（session-channel 恒 settle success），权威 error 只被记录
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, GOLDEN_FINAL_FRAME, TERMINAL_ERROR_FRAME],
      readResult: { messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: READ_ERROR_TEXT }] }] },
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=error/);
    // read 权威内容优先于 finalText（收尾帧的「你好，任务完成」是假成功面，不进 message）
    expect(r.outcome.error).toContain(READ_ERROR_TEXT);
    expect(r.outcome.error).not.toContain(GOLDEN_FULL_TEXT);
    expect(r.outcome.exitCode).toBeNull();
    expect(r.outcome.content).toBe("");
  }, 15_000);

  it("P-Z2 降级形态：final-frame 先到且 read 无错误信息 → 只消费 turn.terminal status，仍 run-failed 不假成功", async () => {
    const f = makeEngine({
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, GOLDEN_FINAL_FRAME, TERMINAL_ERROR_FRAME],
      readResult: { messages: [] }, // read 无错误信息（降级形态判据）
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    // 覆盖面收窄但不假成功：final-frame 的宽松 success 不采信
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=error/);
    expect(r.outcome.exitCode).toBeNull();
    expect(r.outcome.content).toBe("");
    // 尾部以 finalText 降级合成（read 空 → 收尾帧全文 → delta 聚合的既有降级链）
    expect(r.outcome.error).toContain(GOLDEN_FULL_TEXT);
  }, 15_000);

  it("全空形态：仅 turn.terminal error（无 delta/收尾帧）+ read 空 → run-failed 且不伪造错误详情", async () => {
    const f = makeEngine({
      sendPushes: [TERMINAL_ERROR_FRAME],
      readResult: { messages: [] },
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=error/);
    expect(r.outcome.error).toContain("服务端无返回内容");
    expect(r.outcome.exitCode).toBeNull();
    expect(r.outcome.content).toBe("");
  }, 15_000);

  it("schema 任务遇 error 终态：分流先于 schema 校验（不产 schema_emulation_failed、不进强化重试）", async () => {
    const f = makeEngine({
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, TERMINAL_ERROR_FRAME],
      readResult: { messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: READ_ERROR_TEXT }] }] },
    });
    const r = await f.engine.run(
      makeTask({ cwd: f.workspace, schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }),
      makeCtx(),
    );
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=error/);
    expect(r.outcome.error).not.toContain("schema_emulation_failed");
    expect(r.outcome.parsedOutput).toBeUndefined();
  }, 15_000);
});

// ============================================================
// 成功路径零回归（负面验证——§8 A6 同族）
// ============================================================

describe("成功路径零回归（U3 分流不误伤正常终态）", () => {
  it("terminal success 先到（golden 流）→ parsed：content 全文、exitCode 0、无 error", async () => {
    const f = makeEngine({
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, ...ZCODE_APPSERVER_GOLDEN.terminal],
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toBeUndefined();
    expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(r.outcome.exitCode).toBe(0);
  }, 15_000);

  it("final-frame 先到 + terminal success 迟到 → parsed（权威 success 后到不改写已落定的成功）", async () => {
    const f = makeEngine({
      // final-frame 在权威 terminal 之前到达（宽松终态先 settle，权威后到只记录）
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, GOLDEN_FINAL_FRAME, ZCODE_APPSERVER_GOLDEN.terminal[0]],
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toBeUndefined();
    expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(r.outcome.exitCode).toBe(0);
  }, 15_000);

  it("final-frame 独走（无 turn.terminal 到达）→ parsed（无权威 status 可消费，不判失败）", async () => {
    const f = makeEngine({
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, GOLDEN_FINAL_FRAME],
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toBeUndefined();
    expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(r.outcome.exitCode).toBe(0);
  }, 15_000);
});
