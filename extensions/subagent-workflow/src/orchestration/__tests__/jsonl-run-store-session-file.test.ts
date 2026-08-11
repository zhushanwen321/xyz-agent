// src/orchestration/__tests__/jsonl-run-store-session-file.test.ts
//
// W1: jsonl-run-store 序列化/反序列化 sessionFile round-trip 测试
//
// 防的 bug：sessionFile 加入 AgentCall + ExecutionTraceNode 后，序列化时必须写入快照，
// 反序列化时必须恢复——否则 pause/resume 或跨 session 重水合后 agent 的 session jsonl
// 路径丢失，overlay 无法定位。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentCall } from "../models/agent-call.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import type { ExecutionTraceNode } from "../models/types.ts";
import type { RunSpec } from "../models/run-spec.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import { JsonlRunStore } from "../jsonl-run-store.ts";

function makeSpec(): RunSpec {
  return {
    scriptSource: "module.exports = async () => {};",
    args: {},
    scriptName: "test-script",
    scriptPath: "/tmp/test.js",
    description: "test",
  };
}

function makeTraceNode(stepIndex: number): ExecutionTraceNode {
  return {
    stepIndex,
    agent: "worker",
    task: "do thing",
    model: "default",
    status: "pending",
  };
}

function makeRunWithDoneCall(): WorkflowRun {
  const trace = new Trace();
  const node = makeTraceNode(0);
  trace.append(node);
  const call = new AgentCall(0, {
    prompt: "task",
    agent: "worker",
    cwd: "/tmp",
  } as never, node);
  // 模拟已完成 agent call：带 sessionId + sessionFile
  call.markRunning();
  call.markDone({
    content: "done",
    sessionId: "session-abc",
    sessionFile: "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
  });
  call.setSessionId("session-abc");
  call.setSessionFile("/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl");
  trace.update(0, {
    status: "completed",
    result: call.result,
    completedAt: new Date().toISOString(),
    sessionId: "session-abc",
    sessionFile: "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
  });

  return new WorkflowRun(
    "run-test-001",
    makeSpec(),
    {
      status: "done",
      reason: "completed",
      budget: new Budget(),
      calls: new Map([[0, call]]),
      trace,
      errorLogs: [],
    },
    { startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
  );
}

describe("W1: JsonlRunStore sessionFile 序列化 round-trip", () => {
  let tmpDir: string;
  let store: JsonlRunStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-test-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save + loadAll round-trip: AgentCall.sessionFile 保留", async () => {
    const run = makeRunWithDoneCall();
    await store.save(run);

    // 从磁盘直接读快照验证 sessionFile 写入了序列化
    const stateDir = path.join(tmpDir, "workflow-state");
    const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const raw = fs.readFileSync(path.join(stateDir, files[0]!), "utf8");
    const snapshot = JSON.parse(raw.trim());
    const serializedCall = snapshot.state.calls[0];
    expect(serializedCall.sessionFile).toBe(
      "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
    );
  });

  it("save + loadAll round-trip: ExecutionTraceNode.sessionFile 保留", async () => {
    const run = makeRunWithDoneCall();
    await store.save(run);

    const raw = fs.readFileSync(
      path.join(tmpDir, "workflow-state", "run-test-001.jsonl"),
      "utf8",
    );
    const snapshot = JSON.parse(raw.trim());
    const traceNode = snapshot.state.trace[0];
    expect(traceNode.sessionFile).toBe(
      "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl",
    );
  });

  it("save → loadAll 完整 round-trip: 反序列化后 AgentCall.sessionFile 可读", async () => {
    // 闭环测试：serialize（save）→ deserialize（loadAll）→ 验证 run.state.calls 的 AgentCall.sessionFile
    const sessionFilePath = "/abs/.pi/agent/subagents/enc/sessions/2026-07-15T_session-abc.jsonl";

    // mock pi + ctx：save 写 pointer entry，loadAll 读同一组 entries
    const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
    const mockPi = {
      appendEntry: vi.fn((type: string, data: unknown) => {
        entries.push({ type: "custom", customType: type, data });
      }),
    };
    const mockCtx = {
      sessionManager: { getEntries: () => entries },
    };

    const storeWithCtx = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mockPi as never,
      ctx: mockCtx as never,
    });

    const run = makeRunWithDoneCall();
    await storeWithCtx.save(run);

    const loaded = await storeWithCtx.loadAll();
    expect(loaded).toHaveLength(1);
    const restoredCall = loaded[0]!.state.calls.get(0);
    expect(restoredCall).toBeDefined();
    expect(restoredCall!.sessionFile).toBe(sessionFilePath);
  });
});

describe("W2: RunStore.stateFilePath 暴露 run 状态文件路径", () => {
  let tmpDir: string;
  let store: JsonlRunStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-test-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stateFilePath(runId) 返回 <sessionDir>/workflow-state/<runId>.jsonl", () => {
    const result = store.stateFilePath("run-xyz");
    expect(result).toBe(path.join(tmpDir, "workflow-state", "run-xyz.jsonl"));
  });
});

// W3: save 兜底容错——run 工作目录被并发清理时 mkdir 抛 ENOENT，save 静默返回。
//
// 防的 bug（PR #166 CI 回归）：review-fix-loop-e2e 等 runAndWait 测试中，
// handleReturn 的 run.transition("done") 同步改 status 后，runAndWait 轮询发现 done
// 并 resolve，测试 afterEach 随即 rmSync 删除 sessionDir；此时 handleReturn 内 in-flight
// 的 await save 尚未完成，mkdir 遇到目录链被并发删除 → ENOENT。原实现 await save 让错误
// 冒泡为 unhandled promise rejection（worker-host onMessage 无 catch），CI exit 1。
// 修复：save 仅容错 ENOENT（run 已终态，状态不再变化，持久化无意义也无法完成）→ silent return；
// 非 ENOENT 错误（EACCES/ENOSPC 等真实磁盘问题）仍重新抛出，不掩盖。
//
// 注：真正的 ENOENT 只在 rmSync 与 mkdir 并发时出现（串行 rmSync 后 mkdir {recursive:true}
// 会重建目录而非抛 ENOENT），故用 mock 直接锁定 save 的容错判定逻辑，不依赖竞态时序复现。
describe("W3: JsonlRunStore.save 兜底容错（run 工作目录被并发清理时的竞态）", () => {
  let tmpDir: string;
  let store: JsonlRunStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-store-enoent-"));
    store = new JsonlRunStore({ sessionDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("mkdir 抛 ENOENT（sessionDir 被并发清理）→ save 静默返回，不抛 unhandled rejection", async () => {
    const run = makeRunWithDoneCall();
    const spy = vi
      .spyOn(fs.promises, "mkdir")
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT: no such file or directory, mkdir"), {
          code: "ENOENT",
        }),
      );
    // run 已终态 + 工作目录消失 → save 放弃持久化，resolve undefined（不抛）
    await expect(store.save(run)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it("mkdir 抛非 ENOENT 错误（EACCES）→ save 重新抛出，不掩盖真实磁盘问题", async () => {
    const run = makeRunWithDoneCall();
    const spy = vi
      .spyOn(fs.promises, "mkdir")
      .mockRejectedValueOnce(
        Object.assign(new Error("permission denied"), { code: "EACCES" }),
      );
    await expect(store.save(run)).rejects.toThrow("permission denied");
    expect(spy).toHaveBeenCalled();
  });
});
