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
import { ZcodeEngine } from "../zcode-engine.ts";

const LIVE = process.env["ENGINE_CONFORMANCE_LIVE"] === "1";
const E2E_MODEL = process.env["ZCODE_E2E_MODEL"] ?? "e512d53e-0bfc-4915-9081-860d4aa13cd0/mimo-v2.5-pro";
const DATA_ROOT = path.join(fs.realpathSync(os.tmpdir()), "zcode-p3-e2e-data");
const WORK_CWD = path.join(fs.realpathSync(os.tmpdir()), "zcode-p3-e2e-cwd");

describe.skipIf(!LIVE)("ZcodeEngine 端到端真机（真实 LLM 调用）", () => {
  let engine: ZcodeEngine;

  beforeAll(() => {
    fs.mkdirSync(WORK_CWD, { recursive: true });
    engine = new ZcodeEngine({ engineDataDir: () => DATA_ROOT });
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
