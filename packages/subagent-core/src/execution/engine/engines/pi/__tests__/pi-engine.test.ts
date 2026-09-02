// src/execution/engine/engines/pi/__tests__/pi-engine.test.ts
//
// PiEngine 引擎边界测试（D2 后形态）：capabilities 链路接通口径（D3）、run 双分支
//（chat ticket 交接 / workflow executeAndAwait 委托）与中立声明→ExecuteOptions 映射、
// interact message 原生协议（stdin 直写 + 冷路径续轮回调；D2 协议知识下沉）、close/cancel
// 直通、read 三级降级、probe 形状（C1）。fake PiEngineService 注入，不 spawn 真进程。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../../../../execution-record.ts";
import type { ExecuteOptions, SubagentRecord } from "../../../../types.ts";
import { IDENTITY_CUSTOM_TYPE } from "../../../../session-reconstructor.ts";
import { SubagentStream } from "../../../../stream-sink.ts";
import type { RunContext } from "../../../port.ts";
import type { AgentTaskSpec, EngineHandle } from "../../../types.ts";
import { spawnedChildren } from "../session-runner.ts";
import { resetAllEpipeFailures } from "../stdin-writer.ts";
import {
  PI_ADAPTER_VERSION,
  PI_ENGINE_ID,
  PiEngine,
  type ChatRoundTicket,
  type PiEngineService,
} from "../pi-engine.ts";

// ── fake 编排服务（结构子集，记录调用） ──

interface ServiceCalls {
  executeOpts?: ExecuteOptions;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
  stream?: unknown;
  resumeChatRound?: { recordId: string; text: string };
  close?: { recordId: string; force: boolean };
  cancelId?: string;
  getRecordId?: string;
  reportedTransitionIds?: string[];
}

/** 构造最小完整 SubagentRecord（collectRecords 返回项——resolveRecordId 只读 id/sessionFile）。 */
function makeListedRecord(id: string, sessionFile: string | undefined): SubagentRecord {
  return {
    id,
    agent: "reviewer",
    task: "t",
    slug: "s",
    status: "running",
    mode: "background",
    startedAt: 1,
    rootSessionId: undefined,
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 0,
    totalTokens: 0,
    model: "p/m",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...(sessionFile !== undefined ? { sessionFile } : {}),
  };
}

function makeFakeService(overrides?: {
  executeResult?: Awaited<ReturnType<PiEngineService["executeAndAwait"]>>;
  executeReject?: Error;
  recordsById?: Map<string, ReturnType<typeof createRecord>>;
  listed?: Array<{ id: string; sessionFile?: string }>;
  cancelResult?: boolean;
  resumeReject?: Error;
}): { service: PiEngineService; calls: ServiceCalls } {
  const calls: ServiceCalls = { reportedTransitionIds: [] };
  const record = createRecord("sa-fake", {
    agent: "reviewer",
    model: "p/m",
    thinkingLevel: "high",
    mode: "background",
    task: "t",
    slug: "s",
    startedAt: 1,
    controller: new AbortController(),
  });
  const service: PiEngineService = {
    executeAndAwait: async (opts, signal, onEvent, stream) => {
      calls.executeOpts = opts;
      calls.signal = signal;
      calls.onEvent = onEvent;
      calls.stream = stream;
      if (overrides?.executeReject) throw overrides.executeReject;
      return (
        overrides?.executeResult ?? {
          content: "done",
          durationMs: 42,
          toolCalls: [],
        }
      );
    },
    getRecordForAction: (id) => {
      calls.getRecordId = id;
      // recordsById 提供时严格查表（模拟「record 不存在 → throw」路径）；缺省返回默认 record
      if (overrides?.recordsById) {
        const found = overrides.recordsById.get(id);
        if (!found) {
          throw new Error(`subagent not found or not owned: ${id}`);
        }
        return found;
      }
      return record;
    },
    resumeChatRound: (rec, text) => {
      calls.resumeChatRound = { recordId: rec.id, text };
      if (overrides?.resumeReject) throw overrides.resumeReject;
    },
    reportRecordTransition: (rec) => {
      calls.reportedTransitionIds?.push(rec.id);
    },
    closeSubagent: async (rec, force) => {
      calls.close = { recordId: rec.id, force };
    },
    cancel: (id) => {
      calls.cancelId = id;
      return overrides?.cancelResult ?? true;
    },
    collectRecords: () =>
      (overrides?.listed ?? []).map(({ id, sessionFile }) => makeListedRecord(id, sessionFile)),
  };
  return { service, calls };
}

/** 全字段任务声明（覆盖全部泛化点）。 */
function makeSpec(): AgentTaskSpec {
  return {
    task: "do the thing",
    slug: "do-thing",
    agent: "reviewer",
    model: "zai-coding-cn/glm-5.2",
    effort: "high",
    persona: { skillPath: "/skills/r/SKILL.md", appendSystemPrompt: ["extra"] },
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
    maxTurns: 5,
    graceTurns: 2,
    fork: true,
    worktree: false,
    cwd: "/work",
    conversation: true,
    idleTimeoutMs: 99,
  };
}

function makeHandle(sessionRef: Record<string, string>): EngineHandle {
  return { data: { v: 1, engineId: PI_ENGINE_ID, sessionRef, poolKey: "shared", adapterVersion: PI_ADAPTER_VERSION } };
}

function makeRunCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-test", poolKey: "shared", ...overrides };
}

// ── capabilities ──

describe("PiEngine.capabilities（D3 链路接通口径）", () => {
  it("id = 'pi'；声明本仓 subagent 链路实际接通的能力（非 RPC 理论能力）", () => {
    const engine = new PiEngine({ getService: () => null });
    expect(engine.id).toBe(PI_ENGINE_ID);
    expect(engine.capabilities()).toEqual({
      schemaEnforcement: "native", // PI_WORKFLOW_SCHEMA env 注入链路（方案 A 唯一权威）
      steer: "unsupported", // RPC 有 steer 但 spawn 链路未接通（session-runner no-op）
      conversation: "native", // chatMode idle 复用 + message/close/cancel 已接通
      personaInjection: "flag", // --skill / --append-system-prompt
      eventGranularity: "stream", // 30+ 事件流
      sandbox: "emulated", // 无 OS sandbox；worktree 隔离
      sessionRead: "full", // pi JSONL 完整重建
      resume: "native", // 同进程 idle 复用 + --session 冷续写
      interrupt: "kill-only", // 现链路 abort = SIGTERM，rpc abort 未接通
      permissionMode: "native", // argv-mirror 镜像主进程 flag
      maxTurns: true, // [D3-④] turn limiter 兑现
    });
  });
});

// ── run ──

describe("PiEngine.run", () => {
  it("中立声明 → ExecuteOptions 映射 + signal/onEvent/stream/ctxModel 直通（行为零变化）", async () => {
    const { service, calls } = makeFakeService();
    const engine = new PiEngine({ getService: () => service });
    const spec = makeSpec();
    const ctxModel = { id: "m", name: "M", provider: "p", reasoning: false };
    const onEvent = (e: unknown) => void e;
    const stream = new SubagentStream("sa-test", { setWidget: () => {} });
    const signal = new AbortController().signal;

    const { handle, outcome } = await engine.run(spec, makeRunCtx({ signal, onEvent, ctxModel, stream }));

    // 传参恒等（SAR 接线前的直接调用形态）
    expect(calls.signal).toBe(signal);
    expect(calls.onEvent).toBe(onEvent);
    expect(calls.stream).toBe(stream);
    expect(calls.executeOpts).toEqual({
      task: "do the thing",
      slug: "do-thing",
      agent: "reviewer",
      model: "zai-coding-cn/glm-5.2",
      thinkingLevel: "high", // effort 恒等映射回
      skillPath: "/skills/r/SKILL.md", // persona 还原
      appendSystemPrompt: ["extra"],
      schema: spec.schema,
      schemaEnv: JSON.stringify(spec.schema), // schema 派生（D-A6 bridge）
      maxTurns: 5,
      graceTurns: 2,
      ctxModel,
      fork: true,
      worktree: false,
      cwd: "/work",
      conversation: true,
      idleTimeoutMs: 99,
      engine: "pi", // P4 引擎留痕（D9①）：实际执行引擎 id 进 record 投影链
    });

    // outcome 字段全集映射（缺字段在此转红——SAR outcomeToRunnerResult 的完整性依赖）
    expect(outcome).toEqual({
      content: "done",
      parsedOutput: undefined,
      usage: undefined,
      durationMs: 42,
      error: undefined,
      sessionId: undefined,
      sessionFile: undefined,
      worktreePath: undefined,
      toolCalls: [],
      engineId: "pi",
    });

    // handle 自描述（engineId + sessionRef + poolKey + adapter 版本）
    expect(handle.data).toMatchObject({
      v: 1,
      engineId: "pi",
      poolKey: "shared",
      adapterVersion: PI_ADAPTER_VERSION,
    });
  });

  it("sessionFile 回填进 handle.sessionRef；ctx.poolKey 透传（空串兜底 'shared'）", async () => {
    const { service } = makeFakeService({
      executeResult: { content: "x", sessionFile: "/tmp/s.jsonl", sessionId: "sess-1", toolCalls: [] },
    });
    const engine = new PiEngine({ getService: () => service });
    const r1 = await engine.run({ task: "t", slug: "s" }, makeRunCtx({ poolKey: "agent-reviewer" }));
    expect(r1.handle.data.sessionRef).toEqual({ sessionFile: "/tmp/s.jsonl" });
    expect(r1.handle.data.poolKey).toBe("agent-reviewer");
    expect(r1.outcome.sessionId).toBe("sess-1");
    const r2 = await engine.run({ task: "t", slug: "s" }, makeRunCtx({ poolKey: "" }));
    expect(r2.handle.data.poolKey).toBe("shared");
  });

  it("[D2 chat 分支] ctx.taskId 命中交接包 → runChatRound 执行 + handle/outcome 形态（chat 编排不消费，形态完备）", async () => {
    const ticketCalls: string[] = [];
    const record = createRecord("sa-chat-ticket", {
      agent: "reviewer", model: "p/m", thinkingLevel: "high", mode: "background",
      task: "t", slug: "s", startedAt: 1, controller: new AbortController(),
    });
    const chatTicket: ChatRoundTicket = {
      record,
      opts: { task: "chat task", slug: "s" },
      identity: { agent: "reviewer", agentConfig: undefined, resolved: { model: { id: "m", name: "M", provider: "p", reasoning: false }, thinkingLevel: "high" } },
      ctx: { cwd: "/w" } as ChatRoundTicket["ctx"],
      signal: undefined,
      priority: 1000,
    };
    const service: PiEngineService = {
      executeAndAwait: async () => { throw new Error("workflow branch must not run"); },
      getRecordForAction: () => { throw new Error("unused"); },
      closeSubagent: async () => {},
      cancel: () => true,
      collectRecords: () => [],
      takeChatRound: (taskId) => {
        ticketCalls.push(taskId);
        return taskId === "sa-chat-ticket" ? chatTicket : undefined;
      },
      runChatRound: async (t) => ({
        text: "chat done", turns: 2, durationMs: 7, success: true,
        sessionId: t.record.id, toolCalls: [],
      }),
    };
    const engine = new PiEngine({ getService: () => service });
    const { handle, outcome } = await engine.run({ task: "t", slug: "s" }, makeRunCtx({ taskId: "sa-chat-ticket" }));
    expect(ticketCalls).toEqual(["sa-chat-ticket"]);
    expect(handle.data.sessionRef).toEqual({ recordId: "sa-chat-ticket" });
    expect(handle.data.poolKey).toBe("shared");
    expect(outcome).toMatchObject({ content: "chat done", engineId: "pi", sessionId: "sa-chat-ticket" });
    // 非 chat taskId（workflow 域）→ 交接 miss → executeAndAwait 分支（此处 throw 证明未误入）
    await expect(engine.run({ task: "t", slug: "s" }, makeRunCtx({ taskId: "sa-workflow" }))).rejects.toThrow(
      "workflow branch must not run",
    );
  });

  it("服务不可用（prepare 期）→ reject 且不产生 handle", async () => {
    const engine = new PiEngine({ getService: () => null });
    await expect(engine.run({ task: "t", slug: "s" }, makeRunCtx())).rejects.toThrow(/SubagentService unavailable/);
  });

  it("executeAndAwait throw（嵌套超限等创建期异常）→ 向上传播（SAR catch 兜底不变）", async () => {
    const { service } = makeFakeService({ executeReject: new Error("nesting depth exceeded") });
    const engine = new PiEngine({ getService: () => service });
    await expect(engine.run({ task: "t", slug: "s" }, makeRunCtx())).rejects.toThrow("nesting depth exceeded");
  });
});

// ── interact ──

describe("PiEngine.interact（chatMode 交互面：message 原生协议 + close/cancel 直通）", () => {
  // [D2] message 分支原生实现（PiEngine.deliverPrompt）：热路径经真实 session-runner
  // spawnedChildren Map + 真实 stdin-writer（不 mock——端到端验证协议字节）。
  let hotChildren: Map<string, unknown>;
  beforeEach(() => {
    hotChildren = spawnedChildren as unknown as Map<string, unknown>;
    hotChildren.clear();
  });
  afterEach(() => {
    hotChildren.clear();
    resetAllEpipeFailures();
  });

  function makeHotChild(): { child: ChildProcess; stdin: PassThrough } {
    // exitCode/signalCode 缺省 null（[race-F5] 写后死检测的判据，undefined 会被误判已死）
    const stdin = new PassThrough();
    const child = { stdin, pid: 4242, exitCode: null, signalCode: null, killed: false } as unknown as ChildProcess;
    return { child, stdin };
  }

  function readStdinLines(stdin: PassThrough): Array<Record<string, unknown>> {
    stdin.pause();
    const text = stdin.read()?.toString() ?? "";
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("message 热路径（进程活）：sendPromptCommand 直写 stdin，interrupt → streamingBehavior（steer/followUp）+ record 迁移上报", async () => {
    const { service, calls } = makeFakeService();
    const engine = new PiEngine({ getService: () => service });
    const { child, stdin } = makeHotChild();
    hotChildren.set("sa-fake", child);

    const res = await engine.interact(makeHandle({ recordId: "sa-fake" }), { kind: "message", payload: "next round", interrupt: true });
    expect(res).toEqual({ ok: true, delivered: true });

    const lines = readStdinLines(stdin);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: "prompt", message: "next round", streamingBehavior: "steer" });

    // 无 interrupt → followUp；record 迁移经 reportRecordTransition 上报（轮始信号清除后）
    const { stdin: stdin2 } = makeHotChild();
    hotChildren.set("sa-fake", { stdin: stdin2, pid: 4243, exitCode: null, signalCode: null, killed: false } as unknown as ChildProcess);
    await engine.interact(makeHandle({ recordId: "sa-fake" }), { kind: "message", payload: "queued" });
    const lines2 = readStdinLines(stdin2);
    expect(lines2[0]).toMatchObject({ type: "prompt", message: "queued", streamingBehavior: "followUp" });
    expect(calls.reportedTransitionIds).toEqual(["sa-fake", "sa-fake"]);
  });

  it("message 冷路径（进程死）：resumeChatRound 编排回调（重开 session 续聊）", async () => {
    const { service, calls } = makeFakeService();
    const engine = new PiEngine({ getService: () => service });
    // spawnedChildren 无该 record → getChildByRecord undefined → 冷路径
    const res = await engine.interact(makeHandle({ recordId: "sa-fake" }), { kind: "message", payload: "resume msg" });
    expect(res).toEqual({ ok: true, delivered: true });
    expect(calls.resumeChatRound).toEqual({ recordId: "sa-fake", text: "resume msg" });
  });

  it("close → closeSubagent(record, force)；payload 缺省 force=false", async () => {
    const { service, calls } = makeFakeService();
    const engine = new PiEngine({ getService: () => service });
    await engine.interact(makeHandle({ recordId: "sa-fake" }), { kind: "close", payload: { force: true } });
    expect(calls.close).toEqual({ recordId: "sa-fake", force: true });
    await engine.interact(makeHandle({ recordId: "sa-fake" }), { kind: "close" });
    expect(calls.close).toEqual({ recordId: "sa-fake", force: false });
  });

  it("cancel → service.cancel(recordId)", async () => {
    const { service, calls } = makeFakeService();
    const engine = new PiEngine({ getService: () => service });
    const res = await engine.interact(makeHandle({ recordId: "sa-fake" }), { kind: "cancel" });
    expect(res).toEqual({ ok: true, delivered: true });
    expect(calls.cancelId).toBe("sa-fake");
  });

  it("cancel 返回 false → engine_interact_failed", async () => {
    const { service } = makeFakeService({ cancelResult: false });
    const engine = new PiEngine({ getService: () => service });
    const res = await engine.interact(makeHandle({ recordId: "sa-fake" }), { kind: "cancel" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("engine_interact_failed");
      expect(res.message).toContain("sa-fake");
    }
  });

  it("recordId 缺席时按 sessionFile 扫描兜底定位（collectRecords 匹配）", async () => {
    const { service, calls } = makeFakeService({ listed: [{ id: "sa-scan-hit", sessionFile: "/x/s.jsonl" }] });
    const engine = new PiEngine({ getService: () => service });
    await engine.interact(makeHandle({ sessionFile: "/x/s.jsonl" }), { kind: "message", payload: "hi" });
    expect(calls.getRecordId).toBe("sa-scan-hit");
  });

  it("死 handle（无定位符 / record 不存在）→ engine_session_not_resumable（含 cold resume 指引）", async () => {
    const { service } = makeFakeService();
    const engine = new PiEngine({ getService: () => service });
    const res = await engine.interact(makeHandle({}), { kind: "message", payload: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("engine_session_not_resumable");
      expect(res.message).toContain("--session");
    }
  });

  it("交互面 throw → engine_interact_failed（message 文案透传行动语言）", async () => {
    const { service } = makeFakeService({
      resumeReject: new Error("subagent sa-fake is not ready for a new message"),
    });
    const engine = new PiEngine({ getService: () => service });
    const res = await engine.interact(makeHandle({ recordId: "sa-fake" }), { kind: "message", payload: "hi" });
    expect(res).toEqual({
      ok: false,
      code: "engine_interact_failed",
      message: "subagent sa-fake is not ready for a new message",
    });
  });

  it("服务不可用 → reject", async () => {
    const engine = new PiEngine({ getService: () => null });
    await expect(
      engine.interact(makeHandle({ recordId: "x" }), { kind: "message", payload: "hi" }),
    ).rejects.toThrow(/SubagentService unavailable/);
  });
});

// ── read ──

describe("PiEngine.read（D6 降级链）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-engine-read-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("无 sessionRef → outcome-only（turns 空）", async () => {
    const engine = new PiEngine({ getService: () => null });
    const view = await engine.read(makeHandle({}));
    expect(view).toEqual({ engineId: "pi", turns: [], source: "outcome-only" });
  });

  it("sessionFile 不存在/损坏 → outcome-only（不 throw）", async () => {
    const engine = new PiEngine({ getService: () => null });
    const view = await engine.read(makeHandle({ sessionFile: path.join(tmpDir, "missing.jsonl") }));
    expect(view.source).toBe("outcome-only");
  });

  it("pi JSONL 原生读取（第①级）：turns 重建 + usage 聚合 + 内部态剥离", async () => {
    const file = path.join(tmpDir, "s.jsonl");
    const lines: string[] = [
      JSON.stringify({ type: "session", version: 3, id: "sess-uuid", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
      JSON.stringify({
        type: "custom", id: "id-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
        customType: IDENTITY_CUSTOM_TYPE,
        data: { id: "bg-1", agent: "worker", mode: "background", task: "t", startedAt: 500 },
      }),
      JSON.stringify({
        type: "message", id: "msg-1", parentId: "id-1", timestamp: new Date(1000).toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hello" },
            { type: "toolCall", id: "tc-1", name: "bash", arguments: { cmd: "ls" } },
          ],
          usage: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2, totalTokens: 33, cost: { total: 0.5 } },
          stopReason: "stop",
          timestamp: 1000,
        },
      }),
      JSON.stringify({
        type: "message", id: "tr-1", parentId: "msg-1", timestamp: new Date(2000).toISOString(),
        message: {
          role: "toolResult", toolCallId: "tc-1", toolName: "bash",
          content: [{ type: "text", text: "ok" }], timestamp: 2000,
        },
      }),
    ];
    fs.writeFileSync(file, lines.join("\n") + "\n");

    const engine = new PiEngine({ getService: () => null });
    const view = await engine.read(makeHandle({ sessionFile: file }));
    expect(view.source).toBe("native");
    expect(view.engineId).toBe("pi");
    expect(view.sessionId).toBe("bg-1");
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0].text).toBe("hello");
    expect(view.turns[0].closed).toBe(true);
    // toolCall 纯净形状（无 _status/startedTs 内部态）
    expect(view.turns[0].toolCalls[0]).toMatchObject({ toolName: "bash" });
    expect("_status" in view.turns[0].toolCalls[0]).toBe(false);
    // usage 聚合（turn usageDelta → AgentUsageTotal）
    expect(view.usage).toEqual({ input: 10, output: 20, cacheRead: 1, cacheWrite: 2, cost: 0.5, total: 33 });
  });
});

// ── probe ──

describe("PiEngine.probe（D7 + C1 形状）", () => {
  const originalArgv = process.argv;
  const originalExecPath = process.execPath;
  const originalPath = process.env.PATH;

  afterEach(() => {
    Object.defineProperty(process, "argv", { value: originalArgv, configurable: true });
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
    process.env.PATH = originalPath;
  });

  it("探针成功：invocation + version 两级 check，engineVersion 实测", async () => {
    const probeVersion = vi.fn(async () => "pi 0.84.1");
    const engine = new PiEngine({ getService: () => null, probeVersion });
    const report = await engine.probe();
    expect(report.ok).toBe(true);
    expect(report.engineVersion).toBe("pi 0.84.1");
    expect(report.checks.map((c) => c.name)).toEqual(["invocation", "version"]);
    expect(report.error).toBeUndefined();
    expect(probeVersion).toHaveBeenCalledTimes(1);
  });

  it("版本探测失败 → ok=false 且 error.recovery 非空（C1：恢复指引必填）", async () => {
    const engine = new PiEngine({ getService: () => null, probeVersion: async () => undefined });
    const report = await engine.probe();
    expect(report.ok).toBe(false);
    expect(report.error?.code).toBe("engine_probe_failed");
    expect(report.error?.recovery.length).toBeGreaterThan(0);
  });

  it("结果缓存：二次 probe 不重跑；force 强探重跑", async () => {
    const probeVersion = vi.fn(async () => "pi 1.0");
    const engine = new PiEngine({ getService: () => null, probeVersion });
    const first = await engine.probe();
    const second = await engine.probe();
    expect(second).toBe(first); // 缓存命中（同对象）
    expect(probeVersion).toHaveBeenCalledTimes(1);
    await engine.probe({ force: true });
    expect(probeVersion).toHaveBeenCalledTimes(2);
  });

  it("invocation 不可解析（PATH 无 pi）→ 第 1 check 失败，不再尝试版本探测", async () => {
    // bun 虚拟脚本 + 通用 runtime → 退化为 PATH 依赖形态（command === "pi"）
    Object.defineProperty(process, "argv", { value: ["bun", "/$bunfs/root/pi"], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/bin/bun", configurable: true });
    process.env.PATH = path.join(os.tmpdir(), `no-pi-here-${Date.now()}`);
    const probeVersion = vi.fn(async () => "should-not-run");
    const engine = new PiEngine({ getService: () => null, probeVersion });
    const report = await engine.probe();
    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0].name).toBe("invocation");
    expect(report.checks[0].ok).toBe(false);
    expect(probeVersion).not.toHaveBeenCalled();
  });
});
