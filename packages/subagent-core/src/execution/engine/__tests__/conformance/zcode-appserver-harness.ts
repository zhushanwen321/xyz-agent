// zcode-appserver-harness.ts —— conformance 层的 fake app-server 引擎组装器（R6）。
//
// 与 engines/zcode/__tests__/zcode-engine-appserver.test.ts 的 makeEngine 同模式
// （scenario 文件随 env 固化进 fake 子进程），抽出为 conformance 专用副本而非跨测试
// 目录 import 测试文件——conformance 套件自包含（A12：套件不依赖被测引擎自己的
// 单测文件结构）。协议/断言面同源：fake-appserver.mjs + ZCODE_APPSERVER_GOLDEN。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { ZCODE_APPSERVER_GOLDEN } from "../../engines/zcode/golden-sample.ts";
import { ZcodeEngine } from "../../engines/zcode/zcode-engine.ts";

const FAKE_CLI = fileURLToPath(
  new URL("../../engines/zcode/__tests__/__fixtures__/fake-appserver.mjs", import.meta.url),
);
const PROVIDER = "conformance-provider";

export interface AppserverHarnessOptions {
  /** 覆盖 send 推送帧（缺省 = golden pushStream + 终态两帧；dropTurnTerminal 置真时去 turn.terminal）。 */
  dropTurnTerminal?: boolean;
  /** 覆盖 read 应答（read 是全文权威来源）。 */
  readResult?: unknown;
  /** session/stop 行为（fake scenario.stopBehavior；缺省 'terminal' = stop 优雅生效）。 */
  stopBehavior?: "terminal" | "none";
  /** 只保留 state.updated（挂起场景——turn 永不自然落定，abort 用例用）。 */
  hangOnly?: boolean;
}

export interface AppserverHarness {
  engine: ZcodeEngine;
  /** fake 子进程的事件流水文件（帧序断言数据源）。 */
  stateFile: string;
  workspace: string;
  dataDir: string;
  dispose(): Promise<void>;
}

/** 组装连到 fake-appserver 的常驻引擎（单一 app-server 形态——2026-09 起无模式分派）。 */
export function makeAppserverHarness(opts: AppserverHarnessOptions = {}): AppserverHarness {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-conformance-appserver-"));
  const dataDir = path.join(tmpRoot, "data");
  const stateFile = path.join(tmpRoot, "state.jsonl");
  const scenarioFile = path.join(tmpRoot, "scenario.json");
  const workspace = path.join(tmpRoot, "ws");
  const v2Path = path.join(tmpRoot, "v2.json");

  fs.mkdirSync(path.dirname(v2Path), { recursive: true });
  fs.writeFileSync(
    v2Path,
    JSON.stringify({
      provider: { [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } } },
    }),
  );

  const pushes = opts.hangOnly
    ? [ZCODE_APPSERVER_GOLDEN.pushStream[0]].map((l) => JSON.parse(l) as unknown)
    : [
        ...ZCODE_APPSERVER_GOLDEN.pushStream,
        ...(opts.dropTurnTerminal ? [] : [ZCODE_APPSERVER_GOLDEN.terminal[0]]),
        ZCODE_APPSERVER_GOLDEN.terminal[1],
      ].map((l) => JSON.parse(l) as unknown);
  fs.writeFileSync(
    scenarioFile,
    JSON.stringify({
      createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
      readResult: opts.readResult ?? JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
      sendPushes: pushes,
      ...(opts.stopBehavior !== undefined ? { stopBehavior: opts.stopBehavior } : {}),
    }),
  );

  const engine = new ZcodeEngine({
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2Path },
    processEnv: {
      PATH: process.env.PATH ?? "",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
    },
  });
  return {
    engine,
    stateFile,
    workspace,
    dataDir,
    dispose: () =>
      engine.dispose().finally(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }),
  };
}

/** 读 fake 流水（帧序断言用）。 */
export function readFakeState(file: string): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** fake 收到的客户端帧方法名序列（abort 链「stop 先于杀链」断言面）。 */
export function sentMethodNames(stateFile: string): string[] {
  return readFakeState(stateFile)
    .map((e) => e["frame"])
    .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null && typeof f["method"] === "string")
    .map((f) => f["method"] as string);
}

/** golden read 应答里 assistant 消息的 text parts 拼接（read 全文——不变量 3a 的比对基准）。 */
export function goldenReadFullText(): string {
  const read = JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse) as {
    messages: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>;
  };
  return (read.messages.at(-1)?.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}
