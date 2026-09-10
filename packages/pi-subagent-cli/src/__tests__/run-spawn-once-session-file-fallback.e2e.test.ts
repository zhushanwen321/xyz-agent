// src/__tests__/run-spawn-once-session-file-fallback.e2e.test.ts
//
// M4 生产接线端到端测试（设计 §4 V4；pump 装配见 spawn-runner.ts 的
// `sessionFileFallback: { prompt: params.task, spawnStartedAtMs: startTime,
// sessionDir: params.sessionDir }`）。
//
// 被测链路 = 真实 runSpawnOnce → 真实 pump/close finalizer → 真实 session-file-locator
// → 真实 fs，仅 pi 对端用 fake 脚本替代（同 run-spawn-once.integration.test.ts 手法，
// 设计 §4 验收分层声明）。fake pi 形态 = 「get_state 全程不应答」（原事故现实形态：
// 并发负载下握手窗口无应答）+ 正常按 pi 0.84.4 落盘形态写 session 文件 + 正常跑完。
//
// 覆盖：
//   - 单命中 → outcome.sessionFile 真被填上 + handleReady 通知 + 采纳 warn
//     （未接线时该用例失败：sessionFile 缺失 + warn「not wired」——反向探针证据见
//     汇报，接线前后两段输出已留档）；
//   - 多命中（同模板同 prompt 双开）→ 放弃 + warn + run 正常终态；
//   - [chatMode] 同形态：pump close 收尾对 chat 与 one-shot 同一条链，chat 会话
//     close 由子进程自行退出触发（agent_settled 后进程保活、session 结束才 close）；
//     多命中一律放弃（不误采纳），单命中才采纳（安全底线）。
//
// 全部 fixture 落 mkdtempSync 自建目录（tmpdir 白名单，不触碰真实数据目录）。

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "@zhushanwen/subagent-engine-sdk";
import { configureLoggerSink, resetLoggerSinkForTests, type LogLevel } from "@zhushanwen/subagent-engine-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  killAllActiveChildren,
  runSpawnOnce,
  type SpawnRunCallbacks,
  type SpawnRunParams,
  type SpawnRunResult,
} from "../spawn-runner.ts";
import { resetAllEpipeFailures } from "../stdin-writer.ts";

/**
 * fake pi：rpc 形态子进程。
 * - `get_state` **全程不应答**（原事故形态；M2 的 agent_end 回补同样收不到应答）；
 * - 收到 prompt 后按实装 pi 落盘形态（逐行 JSON.stringify + "\n"）把 user message
 *   写进 `<sessionDir>/<ts>_<id>.jsonl`（FAKE_M4_FILES 份，构造单/多命中）；
 * - 正常收尾：message_end → agent_end（→ 引擎 M2 回补 1s 超时后 kill，触发 close）；
 * - chat 形态（FAKE_M4_CHAT=1）：agent_end 后 agent_settled 触发 run resolve，进程
 *   保活一小段后自行退出（session 结束 → close → M4 扫描）。
 */
const FAKE_PI_SCRIPT = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const send = (obj) => { process.stdout.write(JSON.stringify(obj) + "\\n"); };
const dirIdx = process.argv.indexOf("--session-dir");
const sessionDir = dirIdx >= 0 ? process.argv[dirIdx + 1] : "/tmp/fake-m4-sessions";
const fileCount = Number(process.env.FAKE_M4_FILES ?? "1");
const chatMode = process.env.FAKE_M4_CHAT === "1";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "extension_ui_response") return;
  // 握手 / agent_end 回补的 get_state 一律不应答（不写 response 行）
  if (msg.type === "get_state") return;
  if (msg.type !== "prompt") return;

  for (let i = 0; i < fileCount; i++) {
    const entry = {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: msg.message }] },
    };
    writeFileSync(join(sessionDir, "20260910T010101_fake-m4-" + i + ".jsonl"), JSON.stringify(entry) + "\\n");
  }
  send({ type: "message_end", message: { stopReason: "stop" } });
  send({ type: "agent_end", willRetry: false, reason: "end_turn" });
  send({ type: "agent_settled" });
  if (chatMode) setTimeout(() => process.exit(0), 20);
});
`;

let rootDir: string;
let sessionDir: string;
let scriptPath: string;
let argv1Saved: string | undefined;
let logs: Array<{ level: LogLevel; component: string; message: string }>;

interface Harness {
  events: AgentEvent[];
  handleReady: Array<{ sessionRef: Record<string, string>; poolKey: string }>;
  stateChanges: Array<{ pid: number; state: string; killed: boolean }>;
}

function makeHarness(fileCount: number, chatMode: boolean): Harness {
  rootDir = fs.mkdtempSync(join(tmpdir(), "pi-cli-test-m4-"));
  sessionDir = join(rootDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  scriptPath = join(rootDir, "fake-pi.mjs");
  fs.writeFileSync(scriptPath, FAKE_PI_SCRIPT);
  process.env.FAKE_M4_FILES = String(fileCount);
  if (chatMode) process.env.FAKE_M4_CHAT = "1";
  argv1Saved = process.argv[1];
  process.argv[1] = scriptPath; // getPiInvocation 分支 1：node <script> <args>
  logs = [];
  configureLoggerSink({
    log: (level, component, message) => {
      logs.push({ level, component, message });
    },
  });
  return { events: [], handleReady: [], stateChanges: [] };
}

function callbacksOf(h: Harness): SpawnRunCallbacks {
  return {
    onEvent: (e) => h.events.push(e),
    onHandleReady: (p) => h.handleReady.push(p),
    onChildStateChanged: (p) => h.stateChanges.push({ pid: p.pid, state: p.state, killed: p.killed }),
  };
}

function baseParams(overrides: Partial<SpawnRunParams> = {}): SpawnRunParams {
  return {
    recordId: "rec-m4-e2e",
    task: 'M4 e2e 任务 "引号"\n第二行 \\ 反斜杠',
    agentName: "m4-agent",
    model: "prov/model-1",
    sessionDir,
    cwd: rootDir,
    ...overrides,
  };
}

/** session 目录内 fixture 文件路径（fake pi 落盘命名）。 */
function fallbackFile(index: number): string {
  return join(sessionDir, `20260910T010101_fake-m4-${index}.jsonl`);
}

/** 本 run 的 [sessionfile] warn 文案。 */
function sessionFileWarnings(): string[] {
  return logs
    .filter((l) => l.level === "warn" && l.message.includes("[sessionfile]"))
    .map((l) => l.message);
}

/** 等待谓词成立（chat 形态 close 由子进程自行退出触发）。 */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(() => {
  resetLoggerSinkForTests();
  killAllActiveChildren();
  resetAllEpipeFailures();
  process.argv[1] = argv1Saved ?? "";
  delete process.env.FAKE_M4_FILES;
  delete process.env.FAKE_M4_CHAT;
  if (rootDir !== undefined && fs.existsSync(rootDir)) {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("M4 生产接线端到端（runSpawnOnce + fake pi 全程不应答）", () => {
  it("单命中：close 后 outcome.sessionFile 真被填上 + handleReady 通知 + 采纳审计 warn", async () => {
    const h = makeHarness(1, false);

    const result: SpawnRunResult = await runSpawnOnce(baseParams(), callbacksOf(h));

    expect(result.success).toBe(true);
    expect(result.sessionFile).toBe(fallbackFile(0)); // ← V4 核心断言
    // 决策 4 的采纳面只有 sessionFile（scan 不反推 sessionId）——sessionId 仍缺
    expect(result.sessionId).toBeUndefined();
    expect(h.handleReady).toHaveLength(1);
    expect(h.handleReady[0]?.sessionRef.sessionFile).toBe(fallbackFile(0));

    const warns = sessionFileWarnings();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("recovered for rec-m4-e2e by M4 prompt-head scan");
    expect(warns[0]).toContain("file=20260910T010101_fake-m4-0.jsonl");
    expect(warns[0]).toContain("promptHeadHash=");
    // 接线生效的反证：未接线形态会打 "M4 prompt-head scan not wired"
    expect(warns[0]).not.toContain("not wired");
  });

  it("多命中：放弃 + warn(multiple_matches) + run 正常终态（不误采纳）", async () => {
    const h = makeHarness(2, false);

    const result: SpawnRunResult = await runSpawnOnce(baseParams(), callbacksOf(h));

    expect(result.success).toBe(true); // 正常终态（agent_end → exit 0 口径）
    expect(result.sessionFile).toBeUndefined();
    expect(h.handleReady).toHaveLength(0);
    const warns = sessionFileWarnings();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("unobtainable for rec-m4-e2e");
    expect(warns[0]).toContain("reason=multiple_matches");
    expect(warns[0]).toContain("candidates=2");
  });

  it("[chatMode] 单命中：chat 会话 close 收尾同样采纳（安全底线=单命中才采纳）", async () => {
    const h = makeHarness(1, true);

    const result = await runSpawnOnce(baseParams({ chatMode: true }), callbacksOf(h));

    // chat 形态 run 在 agent_settled 即 resolve（进程保活）；close 由子进程退出触发
    expect(result.success).toBe(true);
    await waitFor(() => h.stateChanges.some((s) => s.state === "exited"));

    expect(h.handleReady.some((p) => p.sessionRef.sessionFile === fallbackFile(0))).toBe(true);
    expect(sessionFileWarnings()[0]).toContain("recovered for rec-m4-e2e by M4 prompt-head scan");
  });

  it("[chatMode] 多命中：放弃 + warn + run 正常终态（同模板复用不误采纳）", async () => {
    const h = makeHarness(2, true);

    const result = await runSpawnOnce(baseParams({ chatMode: true }), callbacksOf(h));

    expect(result.success).toBe(true);
    await waitFor(() => h.stateChanges.some((s) => s.state === "exited"));

    expect(h.handleReady).toHaveLength(0);
    const warns = sessionFileWarnings();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("reason=multiple_matches");
    expect(warns[0]).toContain("candidates=2");
    expect(warns[0]).toContain("record finalized without transcript anchor");
  });
});
