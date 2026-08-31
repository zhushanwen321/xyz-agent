// zcode-engine-degrade.test.ts —— [R5] 降级链四步（D2）+ probe 冒烟（D8）单测。
// 全部跑 __fixtures__/fake-appserver.mjs 子进程（scenario 注入），绝不 spawn 真
// zcode.cjs。覆盖（impl-plan R5 验收条款 ①-④）：
//   ① RA5-① 回归门：fixture 注入 -32602（create）/ -32601（send）→ 首任务降级
//      spawn 重跑成功 + outcome.engineFallback 标注 degraded: spawn + 第二任务直走
//      spawn（断言不再尝试 app-server 连接：boot/create 帧计数冻结）；
//   ② probe 冒烟：探针连接帧序（create→close、无 send 帧——不发模型请求）、
//      mtime 未变不重探、mtime 变化（fake 触碰）后重探、预算超时（hangCreate）失败降级、
//      探针 create error 失败降级；
//   ③ env 三态：缺省（探+降）/ appserver 定向（不探不降，失败直接报）/ spawn 定向
//      （不探不降直 spawn）；
//   ④ 错误分类表：-32603 → engine_credential_missing 不降级；-32004/-32010 →
//      engine_run_failed 上报不降级（非漂移类）。
// 探针/主连接区分判据：探针 env 带 ZCODE_APPSERVER_PROBE_CONN=1（fake env 快照记
// probe 标志；探针 scenario 只读 FAKE_PROBE_SCENARIO——故障注入互不串扰）。

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunContext } from "../../../port.ts";
import type { AgentTaskSpec } from "../../../types.ts";
import { resolvePoolDir } from "../../../paths.ts";
import { ZCODE_APPSERVER_GOLDEN, ZCODE_GOLDEN_STDOUT } from "../golden-sample.ts";
import type { ZcodeLaunchedProcess } from "../launcher.ts";
import { ZcodeEngine, pinnedZcodeMode, type ZcodeEngineDeps } from "../zcode-engine.ts";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";

const GOLDEN_SESSION_ID = "sess_golden_r3_01";

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-eng-degrade-"));
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

// ── fake launcher（降级 spawn 重跑的成功通道——golden stdout 单轮） ──

function makeFakeLaunch(stdout = ZCODE_GOLDEN_STDOUT) {
  const calls: Array<{ cliPath: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const launch = (o: { cliPath: string; args: string[]; env: NodeJS.ProcessEnv }): ZcodeLaunchedProcess => {
    calls.push(o);
    const child: ChildProcess = spawn(process.execPath, ["-e", ""]);
    const out = new PassThrough();
    out.end(stdout);
    const stderr = new PassThrough();
    stderr.end("");
    let killed = false;
    return {
      child,
      pid: 4242,
      stdout: out,
      stderr,
      abort: async () => {
        killed = true;
      },
      exited: Promise.resolve({ code: 0, signal: undefined }),
      killedByUs: () => killed,
    };
  };
  return { launch, calls };
}

interface DegradeScenario {
  /** 主连接（常驻）scenario 覆盖（缺省 golden 成功形态）。 */
  createError?: { code: number; message: string; data?: unknown };
  sendError?: { code: number; message: string; data?: unknown };
  /** 探针 scenario（只作用于探针连接）。 */
  probeScenario?: Record<string, unknown>;
  /** 探针预算（缺省走 10s 常量——测试注入短值验证超时路径）。 */
  probeBudgetMs?: number;
  /** env 定向（XYZ_ZCODE_MODE）。 */
  mode?: "appserver" | "spawn";
}

/** 建一个缺省（探+降）或定向模式的引擎 + 配套 launch fake。 */
function makeDegradeEngine(s: DegradeScenario = {}) {
  seq += 1;
  const stateFile = path.join(tmpRoot, `state-${seq}.jsonl`);
  const scenarioFile = path.join(tmpRoot, `scenario-${seq}.json`);
  const workspace = path.join(tmpRoot, `ws-${seq}`);
  const pushes = [...ZCODE_APPSERVER_GOLDEN.pushStream, ...ZCODE_APPSERVER_GOLDEN.terminal].map((l) =>
    typeof l === "string" ? (JSON.parse(l) as Record<string, unknown>) : l,
  );
  writeJson(scenarioFile, {
    createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
    readResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
    sendPushes: pushes,
    ...(s.createError !== undefined ? { createError: s.createError } : {}),
    ...(s.sendError !== undefined ? { sendError: s.sendError } : {}),
  });
  let probeScenarioFile: string | undefined;
  if (s.probeScenario !== undefined) {
    probeScenarioFile = path.join(tmpRoot, `probe-scenario-${seq}.json`);
    writeJson(probeScenarioFile, s.probeScenario);
  }
  const fakeLaunch = makeFakeLaunch();
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2Path },
    processEnv: {
      PATH: process.env.PATH ?? "",
      ...(s.mode !== undefined ? { XYZ_ZCODE_MODE: s.mode } : {}),
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
      ...(probeScenarioFile !== undefined ? { FAKE_PROBE_SCENARIO: probeScenarioFile } : {}),
    },
    ...(s.probeBudgetMs !== undefined ? { probeBudgetMs: s.probeBudgetMs } : {}),
    launch: fakeLaunch.launch as unknown as ZcodeEngineDeps["launch"],
  };
  const engine = new ZcodeEngine(deps);
  engines.push(engine);
  return { engine, stateFile, workspace, fakeLaunch };
}

// ── 流水读取 helpers（与 zcode-engine-appserver.test.ts 同款 + 探针判据） ──

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

function recvFrames(stateFile: string, method: string): Array<{ id: number; params: Record<string, unknown> }> {
  return readState(stateFile)
    .filter((e) => e.ev === "recv")
    .map((e) => e.frame)
    .filter(
      (f): f is { id: number; params: Record<string, unknown> } =>
        isRecord(f) && f.method === method && isRecord(f.params) && typeof f.id === "number",
    );
}

function recvMethods(stateFile: string): string[] {
  return readState(stateFile)
    .filter((e) => e.ev === "recv")
    .map((e) => e.frame)
    .filter((f): f is Record<string, unknown> => isRecord(f) && typeof f.method === "string")
    .map((f) => f.method as string);
}

/** 探针进程 boot 数（env 快照带 probe='1'——探针连接标记）。 */
function probeBootCount(stateFile: string): number {
  return readState(stateFile).filter((e) => e.ev === "env" && e["probe"] === "1").length;
}

/** 全部 boot 数（探针 + 常驻主连接）。 */
function bootCount(stateFile: string): number {
  return readState(stateFile).filter((e) => e.ev === "boot").length;
}

function makeTask(overrides?: Partial<AgentTaskSpec>): AgentTaskSpec {
  return { task: "做点什么", slug: "s", model: `${PROVIDER}/m1`, ...overrides };
}

function makeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-degrade", poolKey: "", ...overrides };
}

// ============================================================
// ① RA5-① 回归门：首败漂移降级（D2②）
// ============================================================

describe("首败漂移降级（RA5-① 回归门）", () => {
  it("-32602（create 阶段）：首任务降级 spawn 重跑成功 + 标注 degraded: spawn + 第二任务直走 spawn", async () => {
    const { engine, stateFile, workspace, fakeLaunch } = makeDegradeEngine({
      createError: { code: -32602, message: "Invalid params", data: [{ path: ["model"] }] },
    });
    // 首任务：探针过（探针连接不受主 scenario 影响）→ 主连接 create -32602 → 漂移
    // → 同一任务 spawn 重跑（fake launch golden）成功
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx({ taskId: "d1" }));
    expect(r1.outcome.error).toBeUndefined();
    expect(r1.outcome.content).toBe("ok"); // spawn golden 单轮回复（ZCODE_GOLDEN_STDOUT）
    expect(r1.outcome.engineFallback).toBeDefined();
    expect(r1.outcome.engineFallback?.from).toBe("zcode:appserver");
    expect(r1.outcome.engineFallback?.reason).toContain("degraded: spawn");
    expect(r1.outcome.engineFallback?.reason).toContain("protocol-drift");
    expect(r1.outcome.engineFallback?.reason).toContain("-32602");
    expect(fakeLaunch.calls).toHaveLength(1); // 重跑走的是 spawn 通道
    const bootsAfter1 = bootCount(stateFile);
    const createsAfter1 = recvFrames(stateFile, "session/create").length;

    // 第二任务：直走 spawn——不再尝试 app-server 连接（boot/create 帧计数冻结）
    const r2 = await engine.run(makeTask({ cwd: workspace }), makeCtx({ taskId: "d2" }));
    expect(r2.outcome.error).toBeUndefined();
    expect(r2.outcome.engineFallback?.reason).toContain("degraded: spawn");
    expect(fakeLaunch.calls).toHaveLength(2);
    expect(bootCount(stateFile)).toBe(bootsAfter1);
    expect(recvFrames(stateFile, "session/create").length).toBe(createsAfter1);
  }, 20_000);

  it("-32601（send 阶段）同归类：首任务漂移降级 + 后续直走 spawn", async () => {
    const { engine, stateFile, workspace, fakeLaunch } = makeDegradeEngine({
      sendError: { code: -32601, message: "method not found: session/send" },
    });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r1.outcome.error).toBeUndefined();
    expect(r1.outcome.content).toBe("ok"); // spawn golden 单轮回复（ZCODE_GOLDEN_STDOUT）
    expect(r1.outcome.engineFallback?.reason).toContain("-32601");
    expect(fakeLaunch.calls).toHaveLength(1);
    const createsAfter1 = recvFrames(stateFile, "session/create").length;
    const r2 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r2.outcome.error).toBeUndefined();
    expect(recvFrames(stateFile, "session/create").length).toBe(createsAfter1);
    expect(fakeLaunch.calls).toHaveLength(2);
  }, 20_000);
});

// ============================================================
// ② probe 冒烟（D8：帧序 / 无模型请求 / mtime 缓存与重探 / 预算）
// ============================================================

describe("probe 冒烟（D8）", () => {
  it("探针通过 → 走 app-server；帧序 create→close、无 send 帧（不发模型请求）；结论记 CLI mtime", async () => {
    const { engine, stateFile, workspace, fakeLaunch } = makeDegradeEngine();
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r1.outcome.error).toBeUndefined();
    expect(r1.outcome.sessionId).toBe(GOLDEN_SESSION_ID); // 走的是 app-server 常驻路径
    expect(fakeLaunch.calls).toHaveLength(0);
    // 探针连接恰好 1 个 boot，且先于常驻主连接（首帧 env 快照带 probe 标志）
    expect(probeBootCount(stateFile)).toBe(1);
    const envs = readState(stateFile).filter((e) => e.ev === "env");
    expect(envs[0]?.["probe"]).toBe("1");
    expect(envs[1]?.["probe"]).toBeUndefined();
    // 探针帧序：探针 create（workspace=常驻 HOME）→ 探针 close，均在主连接 create 之前
    const creates = recvFrames(stateFile, "session/create");
    const homeDir = resolvePoolDir(dataDir, "zcode", "home-appserver");
    expect(creates[0]?.params["workspace"]).toMatchObject({ workspacePath: homeDir });
    const methods = recvMethods(stateFile);
    const firstCreate = methods.indexOf("session/create");
    const firstClose = methods.indexOf("session/close");
    const secondCreate = methods.indexOf("session/create", firstCreate + 1);
    expect(firstClose).toBeGreaterThan(firstCreate);
    expect(secondCreate).toBeGreaterThan(firstClose);
    // 不发模型请求：探针会话（首条 close 帧的 sessionId）从未出现 send 帧
    const probeSessionId = recvFrames(stateFile, "session/close")[0]?.params["sessionId"];
    expect(typeof probeSessionId).toBe("string");
    expect(probeSessionId).not.toBe(GOLDEN_SESSION_ID);
    const sendTargets = recvFrames(stateFile, "session/send").map((f) => f.params["sessionId"]);
    expect(sendTargets).not.toContain(probeSessionId);
  }, 20_000);

  it("mtime 未变不重探：第二任务探针 boot 计数不增；mtime 变化（触碰 CLI）后重探", async () => {
    const { engine, stateFile, workspace } = makeDegradeEngine();
    await engine.run(makeTask({ cwd: workspace }), makeCtx());
    await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(probeBootCount(stateFile)).toBe(1); // 缓存命中
    // 触碰 CLI 伪造 zcode 升级（mtime 前移 2s——避开 fs 时间精度）
    const now = new Date();
    fs.utimesSync(FAKE_CLI, new Date(now.getTime() + 2000), new Date(now.getTime() + 2000));
    const r3 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r3.outcome.error).toBeUndefined();
    expect(probeBootCount(stateFile)).toBe(2); // mtime 变化 → 首个任务前重探
  }, 20_000);

  it("探针预算超时（hangCreate + 500ms 预算）→ 探针失败 → 直接 spawn + 标注 probe-failed", async () => {
    const { engine, stateFile, workspace, fakeLaunch } = makeDegradeEngine({
      probeScenario: { hangCreate: true },
      probeBudgetMs: 500,
    });
    const started = Date.now();
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    // 500ms 预算内收割（不真等 10s 常量），随后 spawn 重跑成功
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(r1.outcome.error).toBeUndefined();
    expect(r1.outcome.engineFallback?.reason).toContain("probe-failed");
    expect(r1.outcome.engineFallback?.reason).toContain("超时");
    expect(fakeLaunch.calls).toHaveLength(1);
    // 探针连接未发出 close（create 挂死）——但也没有任何 send 帧
    expect(recvMethods(stateFile)).not.toContain("session/send");
  }, 20_000);

  it("探针 create error（-32602）→ 探针失败 → 直接 spawn（主连接 scenario 不受影响也未被触碰）", async () => {
    const { engine, stateFile, workspace, fakeLaunch } = makeDegradeEngine({
      probeScenario: { createError: { code: -32602, message: "Invalid params" } },
    });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r1.outcome.error).toBeUndefined();
    expect(r1.outcome.engineFallback?.reason).toContain("probe-failed");
    expect(fakeLaunch.calls).toHaveLength(1);
    // 探针失败短路：常驻主连接从未建立（boot 全部来自探针）
    expect(bootCount(stateFile)).toBe(probeBootCount(stateFile));
    // 失败结论同样绑 mtime 缓存（smokeConclusion 缓存命中不分成败）：同一 CLI mtime 下
    // 第二任务不重探（探针 boot 冻结）且仍直走 spawn，不再触碰主连接
    const probeBootsAfter1 = probeBootCount(stateFile);
    const bootsAfter1 = bootCount(stateFile);
    const r2 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r2.outcome.error).toBeUndefined();
    expect(r2.outcome.engineFallback?.reason).toContain("probe-failed");
    expect(fakeLaunch.calls).toHaveLength(2);
    expect(probeBootCount(stateFile)).toBe(probeBootsAfter1);
    expect(bootCount(stateFile)).toBe(bootsAfter1);
  }, 20_000);
});

// ============================================================
// ③ env 三态（D2④ 定向不探不降）
// ============================================================

describe("env 三态（XYZ_ZCODE_MODE）", () => {
  it("pinnedZcodeMode 三态判定：定向值原样 / 缺省与未知值 undefined", () => {
    expect(pinnedZcodeMode({ XYZ_ZCODE_MODE: "spawn" })).toBe("spawn");
    expect(pinnedZcodeMode({ XYZ_ZCODE_MODE: "appserver" })).toBe("appserver");
    expect(pinnedZcodeMode({})).toBeUndefined();
    expect(pinnedZcodeMode({ XYZ_ZCODE_MODE: "garbage" })).toBeUndefined();
  });

  it("appserver 定向：不探（探针 boot 0）不降（-32602 直接上报，spawn 通道不启用）", async () => {
    const { engine, stateFile, workspace, fakeLaunch } = makeDegradeEngine({
      mode: "appserver",
      createError: { code: -32602, message: "Invalid params" },
    });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r1.outcome.error).toContain("engine_run_failed");
    expect(r1.outcome.error).toContain("-32602");
    expect(r1.outcome.engineFallback).toBeUndefined(); // 不降级 → 无标注
    expect(fakeLaunch.calls).toHaveLength(0);
    expect(probeBootCount(stateFile)).toBe(0);
    // 定向持续失败直接报：第二任务仍走 app-server（create 计数增长，非降级冻结）
    const createsBefore = recvFrames(stateFile, "session/create").length;
    const r2 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r2.outcome.error).toContain("-32602");
    expect(recvFrames(stateFile, "session/create").length).toBeGreaterThan(createsBefore);
    expect(fakeLaunch.calls).toHaveLength(0);
  }, 20_000);

  it("spawn 定向：不探不降直 spawn（零 app-server boot、零协议帧）", async () => {
    const { engine, stateFile, workspace, fakeLaunch } = makeDegradeEngine({ mode: "spawn" });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r1.outcome.error).toBeUndefined();
    expect(r1.outcome.engineFallback).toBeUndefined();
    expect(fakeLaunch.calls).toHaveLength(1);
    expect(bootCount(stateFile)).toBe(0);
    expect(readState(stateFile).filter((e) => e.ev === "recv")).toHaveLength(0);
  }, 15_000);
});

// ============================================================
// ④ 错误分类表（非漂移类：-32603 / -32004 / -32010 不降级）
// ============================================================

describe("错误分类（错误规格表）", () => {
  it("-32603 'Model config is missing' → engine_credential_missing，不降级（第二任务仍走 app-server）", async () => {
    const { engine, stateFile, workspace, fakeLaunch } = makeDegradeEngine({
      createError: { code: -32603, message: "Model config is missing" },
    });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r1.outcome.error).toContain("engine_credential_missing");
    expect(r1.outcome.engineFallback).toBeUndefined();
    expect(fakeLaunch.calls).toHaveLength(0);
    const createsBefore = recvFrames(stateFile, "session/create").length;
    const r2 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r2.outcome.error).toContain("engine_credential_missing");
    expect(recvFrames(stateFile, "session/create").length).toBeGreaterThan(createsBefore);
    expect(fakeLaunch.calls).toHaveLength(0);
  }, 20_000);

  it("-32004 'Session is not active' → 任务失败上报，不降级", async () => {
    const { engine, workspace, fakeLaunch } = makeDegradeEngine({
      createError: { code: -32004, message: "Session is not active" },
    });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r1.outcome.error).toContain("engine_run_failed");
    expect(r1.outcome.error).toContain("-32004");
    expect(r1.outcome.engineFallback).toBeUndefined();
    expect(fakeLaunch.calls).toHaveLength(0);
  }, 20_000);

  it("-32010（send busy）→ 任务失败上报，不降级", async () => {
    const { engine, workspace, fakeLaunch } = makeDegradeEngine({
      sendError: { code: -32010, message: "A turn is already running" },
    });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(r1.outcome.error).toContain("engine_run_failed");
    expect(r1.outcome.error).toContain("-32010");
    expect(r1.outcome.engineFallback).toBeUndefined();
    expect(fakeLaunch.calls).toHaveLength(0);
  }, 20_000);
});
