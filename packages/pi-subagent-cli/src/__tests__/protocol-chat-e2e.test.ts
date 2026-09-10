// src/__tests__/protocol-chat-e2e.test.ts
//
// [v1.x] chat 会话形态 e2e（真机 NDJSON 往返）：spawn bin/pi-subagent-cli.mjs +
// fake-pi-chat.mjs（PATH 注入，长驻形态）。覆盖 chat 轮次四路径的线上形态：
//   ① 首轮 run chat（resume 缺省）→ 反向帧链（poolResolved/childSpawned[recordId]/
//      handleReady/streamDelta[runId]/roundLifecycle settled+idle[runId]）→ run 应答；
//   ② 续聊 interact message → recordId 键 streamDelta + settled/idle；
//   ③ 冷续 run chat + resume（--session 续写——fake 沿用 resume 文件定位）；
//   ④ 关断 interact close force（idle 态收割）→ 会话消亡（message 冷拒绝）。
// cancel 收敛的升级路径（fake timers 杀链）在 chat-session.test 单元覆盖——e2e 面在
// 此验证 idle 态 cancel 的进程回收。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ENGINE_PROTOCOL_VERSION } from "@zhushanwen/subagent-engine-sdk";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(PKG_ROOT, "bin", "pi-subagent-cli.mjs");
const FIXTURE_DIR = path.join(PKG_ROOT, "src", "__tests__", "__fixtures__");

interface Frame {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
  params?: Record<string, unknown>;
}

/** fake 宿主（protocol-e2e.test.ts 同款形态）：spawn 引擎 CLI + NDJSON 帧路由。 */
class FakeHost {
  readonly proc: ReturnType<typeof spawn>;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, (f: Frame) => void>();
  readonly reverseFrames: Frame[] = [];
  private readonly reverseResolvers = new Map<string, ((f: Frame) => void)[]>();

  constructor(dataDir: string) {
    this.proc = spawn(process.execPath, [BIN], {
      env: {
        ...process.env,
        XYZ_AGENT_DATA_DIR: dataDir,
        FAKE_PI_MODE: "chat",
        PATH: `${FIXTURE_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim() !== "") this.consume(JSON.parse(line) as Frame);
        nl = this.buffer.indexOf("\n");
      }
    });
  }

  private consume(frame: Frame): void {
    if (typeof frame.id === "number") {
      this.pending.get(frame.id)?.(frame);
      return;
    }
    this.reverseFrames.push(frame);
    const waiters = this.reverseResolvers.get(String(frame.method));
    waiters?.shift()?.(frame);
  }

  send(frame: unknown): void {
    this.proc.stdin!.write(`${JSON.stringify(frame)}\n`);
  }

  request(method: string, params: unknown): Promise<Frame> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  /** 等指定 method 的反向请求帧（先扫已到达的，再等未来帧；每帧只匹配一次）。 */
  waitForReverse(method: string, timeoutMs = 10_000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for reverse ${method}`)), timeoutMs);
      const done = (f: Frame): void => {
        clearTimeout(timer);
        resolve(f);
      };
      const buffered = this.reverseFrames.find((f) => f.method === method && !consumed.has(f));
      if (buffered !== undefined) {
        consumed.add(buffered);
        done(buffered);
        return;
      }
      const list = this.reverseResolvers.get(method) ?? [];
      list.push((f) => {
        consumed.add(f);
        done(f);
      });
      this.reverseResolvers.set(method, list);
    });
  }

  replyReverse(id: string, result: unknown): void {
    this.send({ id, result });
  }

  kill(): void {
    this.proc.kill("SIGKILL");
  }
}

/** waitForReverse 的已消费帧去重面。 */
const consumed = new WeakSet<Frame>();

async function initialize(host: FakeHost, dataDir: string): Promise<void> {
  const init = await host.request("initialize", {
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    hostInfo: { name: "fake-host", version: "0.0.0", dataRoot: dataDir },
    engineConfig: {},
  });
  expect(init.error).toBeUndefined();
}

describe("pi-subagent-cli chat 会话形态 e2e（bin 真机 NDJSON 往返）", () => {
  let dataDir: string | undefined;
  let host: FakeHost | undefined;

  afterEach(() => {
    host?.kill();
    host = undefined;
    if (dataDir !== undefined) {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      dataDir = undefined;
    }
  });

  it("首轮 → 续聊 → 冷续 → 关断 全链", async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-chat-"));
    host = new FakeHost(dataDir);
    await initialize(host, dataDir);
    const handle = { v: 1, engineId: "pi", sessionRef: { recordId: "rec-chat-1" }, poolKey: "shared", adapterVersion: "1.0.0" };

    // ① 首轮 run chat：反向帧链 + runId 键相位 → run 应答（进程保活）
    const runP = host.request("run", {
      runId: "run-chat-1",
      task: { prompt: "hello", conversation: true, description: "chat-e2e" },
      ctx: { poolKey: "shared", cwd: dataDir, model: "fake-provider/fake-model", streamMode: "stream" },
      chat: { recordId: "rec-chat-1" },
    });
    const poolResolved = await host.waitForReverse("host/poolResolved");
    expect((poolResolved.params as { poolKey: string }).poolKey).toBe("shared");
    host.replyReverse(String(poolResolved.id), { ok: true });

    const childSpawned = await host.waitForReverse("host/childSpawned");
    expect((childSpawned.params as { recordId: string }).recordId).toBe("rec-chat-1");
    host.replyReverse(String(childSpawned.id), { ok: true });

    const handleReady = await host.waitForReverse("host/handleReady");
    const sessionFile = (handleReady.params as { sessionRef: Record<string, string> }).sessionRef.sessionFile;
    expect(typeof sessionFile).toBe("string");
    host.replyReverse(String(handleReady.id), { ok: true });

    const firstDelta = await host.waitForReverse("host/streamDelta");
    expect(firstDelta.params).toEqual({ runId: "run-chat-1", delta: "chat-first-answer" });
    host.replyReverse(String(firstDelta.id), { ok: true });

    const settled1 = await host.waitForReverse("host/roundLifecycle");
    expect(settled1.params).toMatchObject({ runId: "run-chat-1", phase: "settled", usage: { input: 42, output: 21 } });
    host.replyReverse(String(settled1.id), { ok: true });
    const idle1 = await host.waitForReverse("host/roundLifecycle");
    expect(idle1.params).toMatchObject({
      runId: "run-chat-1",
      phase: "idle",
      anchor: { sessionRef: { recordId: "rec-chat-1", sessionFile }, poolKey: "shared" },
    });
    host.replyReverse(String(idle1.id), { ok: true });

    const runFrame = await runP;
    expect(runFrame.error).toBeUndefined();
    const runResult = runFrame.result as { handle: { sessionRef: Record<string, string> }; outcome: { content: string } };
    expect(runResult.handle.sessionRef.recordId).toBe("rec-chat-1");
    expect(runResult.handle.sessionRef.sessionFile).toBe(sessionFile);
    expect(runResult.outcome.content).toContain("chat-first-answer");

    // ② 续聊 interact message：recordId 键 active 心跳（工具执行期）+ delta + settled/idle
    const msg = await host.request("interact", {
      handle: { ...handle, sessionRef: { recordId: "rec-chat-1", sessionFile } },
      action: { kind: "message", payload: "next" },
    });
    expect(msg.result).toEqual({ ok: true, delivered: true });
    // [F3] fake 先发 tool_execution_update → translator 节流 → activity → active 相位
    //（recordId 键、无载荷——续聊轮「仅工具输出、零正文」形态的中段守护刷新面）
    const activeFrame = await host.waitForReverse("host/roundLifecycle");
    expect(activeFrame.params).toEqual({ recordId: "rec-chat-1", phase: "active" });
    host.replyReverse(String(activeFrame.id), { ok: true });
    const followUpDelta = await host.waitForReverse("host/streamDelta");
    expect(followUpDelta.params).toEqual({ recordId: "rec-chat-1", delta: "chat-followUp-answer" });
    host.replyReverse(String(followUpDelta.id), { ok: true });
    const settled2 = await host.waitForReverse("host/roundLifecycle");
    expect(settled2.params).toMatchObject({ recordId: "rec-chat-1", phase: "settled" });
    host.replyReverse(String(settled2.id), { ok: true });
    const idle2 = await host.waitForReverse("host/roundLifecycle");
    expect(idle2.params).toMatchObject({ recordId: "rec-chat-1", phase: "idle" });
    host.replyReverse(String(idle2.id), { ok: true });

    // idle 态 cancel：受理即回收（无在途轮——进程退出，无 failed 相位）
    const cancel = await host.request("interact", {
      handle: { ...handle, sessionRef: { recordId: "rec-chat-1", sessionFile } },
      action: { kind: "cancel" },
    });
    expect(cancel.result).toEqual({ ok: true, delivered: true });
    const afterCancel = await host.request("interact", {
      handle: { ...handle, sessionRef: { recordId: "rec-chat-1", sessionFile } },
      action: { kind: "message", payload: "cold?" },
    });
    expect((afterCancel.result as { ok: boolean; code: string }).ok).toBe(false);
    expect((afterCancel.result as { code: string }).code).toBe("engine_session_not_resumable");

    // ③ 冷续 run chat + resume：--session 续写（fake 沿用 resume 文件定位）
    const coldP = host.request("run", {
      runId: "run-cold-1",
      task: { prompt: "continue", conversation: true },
      ctx: { poolKey: "shared", cwd: dataDir, model: "fake-provider/fake-model" },
      chat: { recordId: "rec-chat-1", resume: { sessionRef: { recordId: "rec-chat-1", sessionFile }, poolKey: "shared" } },
    });
    const coldSettled = await host.waitForReverse("host/roundLifecycle");
    expect(coldSettled.params).toMatchObject({ runId: "run-cold-1", phase: "settled" });
    host.replyReverse(String(coldSettled.id), { ok: true });
    const coldIdle = await host.waitForReverse("host/roundLifecycle");
    expect(coldIdle.params).toMatchObject({ runId: "run-cold-1", phase: "idle" });
    host.replyReverse(String(coldIdle.id), { ok: true });
    const coldFrame = await coldP;
    expect(coldFrame.error).toBeUndefined();
    const coldResult = coldFrame.result as { handle: { sessionRef: Record<string, string> } };
    expect(coldResult.handle.sessionRef.sessionFile).toBe(sessionFile);

    // ④ 关断 interact close force：idle 态收割 → 会话消亡
    const close = await host.request("interact", {
      handle: { ...handle, sessionRef: { recordId: "rec-chat-1", sessionFile } },
      action: { kind: "close", payload: { force: true } },
    });
    expect(close.result).toEqual({ ok: true, delivered: true });
    const afterClose = await host.request("interact", {
      handle: { ...handle, sessionRef: { recordId: "rec-chat-1", sessionFile } },
      action: { kind: "message", payload: "gone?" },
    });
    expect((afterClose.result as { ok: boolean; code: string }).ok).toBe(false);
    expect((afterClose.result as { code: string }).code).toBe("engine_session_not_resumable");
  }, 60_000);
});
