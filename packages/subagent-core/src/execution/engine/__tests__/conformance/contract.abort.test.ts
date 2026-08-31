// contract.abort.test.ts —— conformance C4（abort 行为）：运行中 cancel → 宿主合成
// 终态（exitCode=null）、无悬挂 promise（run 正常 resolve、exited 收口）、错误事件
// 先于终态 emit（不变量 5 的事件面）。fake launcher 注入（不依赖真机）。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunContext } from "../../port.ts";
import type { AgentEvent, AgentTaskSpec } from "../../types.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../../engines/zcode/zcode-engine.ts";
import type { ZcodeLaunchedProcess } from "../../engines/zcode/launcher.ts";

const PROVIDER = "provider-x";

let tmpRoot: string;
let dataDir: string;
let v2Path: string;

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v));
}

/** 长驻 fake 进程：stdout 永不结束（模拟运行中），abort 由测试主动触发。 */
function makeHangingLaunch(): {
  launch: ZcodeEngineDeps["launch"];
  proc: () => ZcodeLaunchedProcess | undefined;
  triggerAbort: () => void;
} {
  let launched: ZcodeLaunchedProcess | undefined;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killTriggered = false;
  let resolveExited: (v: { code: number | null; signal: string | undefined }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: string | undefined }>((resolve) => {
    resolveExited = resolve;
  });
  const launch = (): ZcodeLaunchedProcess => {
    launched = {
      // D10 记账形态：child = 立即退出的真实 node 短进程（本用例不消费记账面）
      child: spawn(process.execPath, ["-e", ""]),
      pid: 4242,
      stdout,
      stderr,
      abort: async () => {
        killTriggered = true;
        // 杀链语义：进程被信号杀死（code=null）——微任务后 settle 模拟 kill 时序
        setTimeout(() => resolveExited({ code: null, signal: "SIGTERM" }), 5);
      },
      exited,
      killedByUs: () => killTriggered,
    };
    return launched;
  };
  return { launch, proc: () => launched, triggerAbort: () => resolveExited({ code: null, signal: "SIGTERM" }) };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c4-abort-"));
  dataDir = path.join(tmpRoot, "data");
  v2Path = path.join(tmpRoot, "v2.json");
  writeJson(v2Path, {
    provider: { [PROVIDER]: { options: { apiKey: "k" }, models: { m1: {} } } },
  });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("conformance C4：abort 行为（运行中 cancel → 合成终态、无悬挂）", () => {
  it("abort → run 正常 resolve（不悬挂）：exitCode=null + error 事件合成 + killedByUs", async () => {
    const fake = makeHangingLaunch();
    const engine = new ZcodeEngine({
      engineDataDir: () => dataDir,
      sources: { v2ConfigPath: v2Path },
      processEnv: { PATH: "/usr/bin", XYZ_ZCODE_MODE: "spawn" },
      launch: fake.launch,
    });

    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const ctx: RunContext = {
      taskId: "sa-c4",
      poolKey: "",
      signal: controller.signal,
      onEvent: (ev) => events.push(ev),
    };
    const task: AgentTaskSpec = { task: "hang", slug: "abort", model: `${PROVIDER}/m1` };

    const runP = engine.run(task, ctx);
    // run 进行中触发 abort（等待 spawn 完成——微任务两拍让 launch 已执行）
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const { handle, outcome } = await runP; // 必须正常 resolve（杀链合成终态，不悬挂）

    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain("中止");
    // 终态前 error 事件已 emit（不变量 5 的事件面——journal 可重放出失败事实）
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(fake.proc()?.killedByUs()).toBe(true);
    expect(handle.data.engineId).toBe("zcode");
  }, 15_000);
});
