// zcode-engine.live.test.ts —— 端到端真机门（验收 5）：真实 zcode CLI + 真实凭据 +
// 真实 LLM 调用。手动门（设计 §3.3.8 conformance run 层同构）：默认 skip，跑法：
//
//   cd extensions/universal/subagent-workflow
//   ENGINE_CONFORMANCE_LIVE=1 ZCODE_E2E_MODEL='<provider/model>' pnpm vitest run src/execution/engine/engines/zcode/__tests__/zcode-engine.live.test.ts
//
// ZCODE_E2E_MODEL 缺省值是采集 golden 样本的本机 provider（v2 config 实测带 apiKey、
// 公网可达）；换机器跑时用 env 覆盖为本机可用模型。池数据落 /tmp（跑完由本文件
// afterAll 清理），不污染真实 ~/.zcode。

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolvePoolDir } from "../../../paths.ts";
import type { AgentEvent } from "../../../types.ts";
import { ZCODE_APPSERVER_POOL_KEY } from "../constants.ts";
import { ZcodeEngine } from "../zcode-engine.ts";
import { assertAgentEventInvariants } from "../../../__tests__/conformance/agent-event-invariants.ts";

const LIVE = process.env["ENGINE_CONFORMANCE_LIVE"] === "1";
const E2E_MODEL = process.env["ZCODE_E2E_MODEL"] ?? "e512d53e-0bfc-4915-9081-860d4aa13cd0/mimo-v2.5-pro";
const DATA_ROOT = path.join(fs.realpathSync(os.tmpdir()), "zcode-p3-e2e-data");
const WORK_CWD = path.join(fs.realpathSync(os.tmpdir()), "zcode-p3-e2e-cwd");

describe.skipIf(!LIVE)("ZcodeEngine 端到端真机（真实 LLM 调用）", () => {
  let engine: ZcodeEngine;

  beforeAll(() => {
    fs.mkdirSync(WORK_CWD, { recursive: true });
    engine = new ZcodeEngine({
      engineDataDir: () => DATA_ROOT,
      // [R4] 钉扎 spawn 单轮（本门原为 spawn 链路实录；app-server 常驻真机门由 R6
      // live gate 改写接入——两模式各自的真机覆盖不合并）
      processEnv: { ...process.env, XYZ_ZCODE_MODE: "spawn" },
    });
  });

  afterAll(() => {
    // 用完清理：池数据 + 任务 cwd（保持 /tmp 干净，实录/验证不留残留）
    for (const dir of [DATA_ROOT, WORK_CWD]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 尽力清理
      }
    }
  });

  it("probe：二进制/版本/golden 三项全过", async () => {
    const report = await engine.probe();
    expect(report.ok).toBe(true);
    expect(report.engineVersion).toMatch(/^0\.\d+\.\d+$/);
  }, 60_000);

  it("run：schema 任务全链成功（隔离 HOME 新 session + outcome + read①级）", async () => {
    const { handle, outcome } = await engine.run(
      {
        task: 'Verify this arithmetic check: 2 + 2 = 4. If it is correct the verdict must be "ok", otherwise "bad".',
        slug: "e2e-schema",
        model: E2E_MODEL,
        cwd: WORK_CWD,
        schema: {
          type: "object",
          properties: { verdict: { type: "string", enum: ["ok", "bad"] } },
          required: ["verdict"],
          additionalProperties: false,
        },
      },
      { taskId: "sa-live-schema", poolKey: "" },
    );

    // outcome 正确
    expect(outcome.error).toBeUndefined();
    expect(outcome.exitCode).toBe(0);
    expect(outcome.content).toContain('"verdict"');
    expect(outcome.usage).toBeDefined();
    expect(outcome.usage!.input).toBeGreaterThan(0);
    expect(outcome.sessionId).toMatch(/^sess_/);
    // schema 仿真（D4 emulated 侧）：公共层三级容错提取 + ajv 校验产出 parsedOutput
    expect(outcome.parsedOutput).toEqual({ verdict: "ok" });

    // 隔离 HOME 有新 session（db.sqlite 落池内，非真实 ~/.zcode）——路径经 resolvePoolDir
    // SSOT（poolKey 里的 '.' 会被 sanitizeSeg 编码为 '-'，手工 join 会拼错目录）
    const dbPath = path.join(resolvePoolDir(DATA_ROOT, "zcode", handle.data.poolKey), ".zcode", "cli", "db", "db.sqlite");
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.statSync(dbPath).size).toBeGreaterThan(0);

    // read(handle) 第①级可读：turns 非空（验收 5 的 read 断言）
    const view = await engine.read(handle);
    expect(view.source).toBe("native");
    expect(view.sessionId).toBe(outcome.sessionId);
    expect(view.turns.length).toBeGreaterThanOrEqual(1);
    expect(view.turns[0]!.text).toContain("verdict");
  }, 300_000);

  it("abort：长任务中途取消 → 杀链合成终态、无僵尸进程", async () => {
    const controller = new AbortController();
    const runPromise = engine.run(
      {
        task:
          "Write an extremely detailed 5000-word technical essay about distributed systems consistency models. Do not stop early.",
        slug: "e2e-abort",
        model: E2E_MODEL,
        cwd: WORK_CWD,
      },
      { taskId: "sa-live-abort", poolKey: "", signal: controller.signal },
    );
    // 等 spawn 发生（prompt 已进 argv），再中途 abort
    await new Promise((r) => setTimeout(r, 4_000));
    controller.abort();
    const { outcome } = await runPromise;

    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain("SIGTERM");
    // 无僵尸进程：--cwd 指向本测试专用 tmp 目录的 zcode 进程应已消失
    const leftovers = listZcodeProcessesForCwd(WORK_CWD);
    expect(leftovers).toEqual([]);
  }, 120_000);
});

/** 扫系统进程表：--cwd 锚定到指定目录的 zcode CLI 进程（僵尸检测）。 */
function listZcodeProcessesForCwd(cwd: string): string[] {
  try {
    const out = execFileSync("ps", ["-eo", "command"], { encoding: "utf8" });
    return out
      .split("\n")
      .filter((line) => line.includes("zcode.cjs") && line.includes(`--cwd ${cwd}`));
  } catch {
    return [];
  }
}

// ============================================================
// [R6] app-server 常驻真机门（RA1/RA2/RA4 的本仓可测形态）：真实 zcode.cjs +
// 真实凭据 + 真实 app-server 进程，XYZ_ZCODE_MODE=appserver 定向（不探不降）。
// 与上方 spawn 门分立（两模式各自的真机覆盖不合并）；跨仓 live gate（RA8 live /
// zsw 真机）另由跨仓段承载。skip 条件与 spawn 门一致（ENGINE_CONFORMANCE_LIVE）。
// ============================================================

const AS_DATA_ROOT = path.join(fs.realpathSync(os.tmpdir()), "zcode-r6-appserver-e2e-data");
const AS_WORK_CWD = path.join(fs.realpathSync(os.tmpdir()), "zcode-r6-appserver-e2e-cwd");

describe.skipIf(!LIVE)("ZcodeEngine 端到端真机（app-server 常驻，[R6] live gate 改写）", () => {
  let engine: ZcodeEngine;

  beforeAll(() => {
    fs.mkdirSync(AS_WORK_CWD, { recursive: true });
    engine = new ZcodeEngine({
      engineDataDir: () => AS_DATA_ROOT,
      // 定向 appserver（D2①）：不探不降——常驻路径本体；缺省路径门控真机另由
      // RA5-②③（跨仓段）承载
      processEnv: { ...process.env, XYZ_ZCODE_MODE: "appserver" },
    });
  });

  afterAll(async () => {
    // dispose 是常驻进程的唯一收割入口（D6）——先 dispose 再清目录
    await engine.dispose().catch(() => undefined);
    for (const dir of [AS_DATA_ROOT, AS_WORK_CWD]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 尽力清理
      }
    }
  });

  it("run：常驻通道全链（RA2——stream 事件流出 + read①级 native + poolKey 锚定 home-appserver）", async () => {
    const events: AgentEvent[] = [];
    const { handle, outcome } = await engine.run(
      {
        task: 'Verify this arithmetic check: 2 + 2 = 4. If it is correct the verdict must be "ok", otherwise "bad".',
        slug: "e2e-appserver",
        model: E2E_MODEL,
        cwd: AS_WORK_CWD,
        schema: {
          type: "object",
          properties: { verdict: { type: "string", enum: ["ok", "bad"] } },
          required: ["verdict"],
          additionalProperties: false,
        },
      },
      { taskId: "sa-live-appserver", poolKey: "", onEvent: (e) => events.push(e) },
    );

    // C2：outcome 正确
    expect(outcome.error).toBeUndefined();
    expect(outcome.exitCode).toBe(0);
    expect(outcome.sessionId).toMatch(/^sess_/);
    expect(outcome.parsedOutput).toEqual({ verdict: "ok" });
    expect(outcome.usage?.input).toBeGreaterThan(0);

    // C3 stream 口径（RA2-①断言面）：text_delta 实时流出（非终态一次性）+ 不变量五条
    // （3a 拼接 == read 全文——content 来自 read 兜底/收尾帧，同源比对）
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    assertAgentEventInvariants(events, { granularity: "stream", content: outcome.content });

    // handle 锚定（RA2-②断言面）：poolKey=home-appserver，①级读取钥匙随 handle 走
    expect(handle.data.poolKey).toBe(ZCODE_APPSERVER_POOL_KEY);

    // read 第①级：SQLite 完整重建（非降级）
    const view = await engine.read(handle);
    expect(view.source).toBe("native");
    expect(view.turns.length).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it("abort：长任务中途取消（RA4）→ stop 链合成终态 exitCode=null + 常驻进程不残留 + 后续任务可用", async () => {
    const controller = new AbortController();
    const runPromise = engine.run(
      {
        task:
          "Write an extremely detailed 5000-word technical essay about distributed systems consistency models. Do not stop early.",
        slug: "e2e-appserver-abort",
        model: E2E_MODEL,
        cwd: AS_WORK_CWD,
      },
      { taskId: "sa-live-appserver-abort", poolKey: "", signal: controller.signal },
    );
    // 等 send 已发（会话在途），再中途 abort——覆盖 stop 链而非 pre-abort 短路
    await new Promise((r) => setTimeout(r, 4_000));
    controller.abort();
    const { outcome } = await runPromise;

    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain("session/stop");

    // 无残留：常驻 HOME 锚定的 app-server 进程在 dispose 前应 ≤1（abort 不误杀共享
    // 进程；杀的是本仓 HOME，与其他 zcode 实例区分靠 --cwd HOME 路径）
    const homeDir = resolvePoolDir(AS_DATA_ROOT, "zcode", ZCODE_APPSERVER_POOL_KEY);
    const leftovers = listZcodeProcessesForCwd(homeDir);
    expect(leftovers.length).toBeLessThanOrEqual(1);

    // 崩溃/中止后下一任务自动重建或复用（不变量 4 同路径）——abort 不污染常驻进程
    const second = await engine.run(
      { task: "Reply with the single word: ok", slug: "e2e-appserver-after-abort", model: E2E_MODEL, cwd: AS_WORK_CWD },
      { taskId: "sa-live-appserver-after-abort", poolKey: "" },
    );
    expect(second.outcome.error).toBeUndefined();
    expect(second.outcome.content.trim().length).toBeGreaterThan(0);
  }, 300_000);
});
