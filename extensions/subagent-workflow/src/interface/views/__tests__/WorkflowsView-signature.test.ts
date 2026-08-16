/**
 * computeRenderSignature（IF11/TC7/DM6）— 渲染签名单测（now 参数化）。
 *
 * 契约：tick 条件失效的判据——签名字段集覆盖 header（renderHeader）/节点行
 * （renderLevel1 agent list）/L2 detail（buildDetailContent）当前消费的全部动态
 * 字段。本测试证明「已入字段变化 → 签名变」+「静态 run 不变」（完备性无法靠
 * 测试证明，字段核对表见 WorkflowsView.ts computeRenderSignature doc）。
 *
 * 确定性说明：签名非完全纯——live 节点 elapsedSeconds 由 projectLiveProgress 内
 * computeElapsedSeconds 现算（record.endedAt ?? Date.now()）。fake timers 控制
 * Date.now() 与 now 参数同源推进，保证确定性。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { computeRenderSignature } from "../WorkflowsView.ts";
import type { ExecutionRecord } from "../../../execution/types.ts";
import type { ExecutionTraceNode, WorkerLogEntry } from "../../../orchestration/models/types.ts";
import type { WorkflowRun } from "../../../orchestration/models/workflow-run.ts";

// ── Fixtures（duck typing，对齐 detail-content-session-file.test.ts 先例）──

const T0 = 1_700_000_000_000; // 固定 epoch ms

function makeLive(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "run-0",
    agent: "worker",
    model: "default",
    thinkingLevel: undefined,
    mode: "sync",
    task: "t",
    slug: "s",
    startedAt: T0,
    rootSessionId: undefined,
    parentRecordId: undefined,
    depth: 0,
    status: "running",
    turns: [],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    endedAt: T0 + 5000,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    ...overrides,
  } as unknown as ExecutionRecord;
}

function makeNode(overrides: Partial<ExecutionTraceNode> = {}): ExecutionTraceNode {
  return {
    stepIndex: 0,
    agent: "worker",
    task: "do",
    model: "default",
    status: "running",
    ...overrides,
  };
}

interface RunShape {
  status?: string;
  budget?: { usedTokens: number; maxTokens?: number; usedCost: number };
  nodes?: ExecutionTraceNode[];
  errorLogs?: WorkerLogEntry[];
}

function makeRun(shape: RunShape = {}): WorkflowRun {
  return {
    state: {
      status: shape.status ?? "running",
      budget: shape.budget ?? { usedTokens: 0, maxTokens: 200_000, usedCost: 0 },
      trace: { toArray: () => shape.nodes ?? [] },
      errorLogs: shape.errorLogs ?? [],
    },
  } as unknown as WorkflowRun;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("computeRenderSignature — 基础确定性", () => {
  it("同输入同签名（含 live 节点，endedAt 固定使 elapsed 确定）", () => {
    const run = makeRun({ nodes: [makeNode({ live: makeLive() })] });
    expect(computeRenderSignature(run, T0)).toBe(computeRenderSignature(run, T0));
  });

  it("静态 run（无 live、同秒桶）200ms 内签名不变", () => {
    const run = makeRun({ nodes: [makeNode({ status: "completed" })] });
    expect(computeRenderSignature(run, T0)).toBe(computeRenderSignature(run, T0 + 200));
  });

  it("秒桶跨秒（now 相差 1s 桶）→ 签名变", () => {
    const run = makeRun();
    expect(computeRenderSignature(run, T0)).not.toBe(computeRenderSignature(run, T0 + 1000));
  });
});

describe("computeRenderSignature — run 级字段", () => {
  it("run.state.status 变化 → 签名变", () => {
    const a = makeRun({ status: "running" });
    const b = makeRun({ status: "done" });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });

  it("completed/total 变化（节点 status 推导）→ 签名变", () => {
    const a = makeRun({ nodes: [makeNode({ status: "running" })] });
    const b = makeRun({ nodes: [makeNode({ status: "completed" })] });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });

  it("budget tokens 量化值变化 → 签名变", () => {
    const a = makeRun({ budget: { usedTokens: 1500, maxTokens: 200_000, usedCost: 0.01 } });
    const b = makeRun({ budget: { usedTokens: 2500, maxTokens: 200_000, usedCost: 0.01 } });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });

  it("budget cost 第 4 位小数变化（toFixed(4) 可见精度）→ 签名变", () => {
    // 0.0100 vs 0.0101：量化展示相同到第 3 位，第 4 位是渲染可见精度
    const a = makeRun({ budget: { usedTokens: 0, maxTokens: 200_000, usedCost: 0.0100 } });
    const b = makeRun({ budget: { usedTokens: 0, maxTokens: 200_000, usedCost: 0.0101 } });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });

  it("run.state.errorLogs 追加 → 签名变（末条内容入指纹）", () => {
    const a = makeRun({ errorLogs: [{ level: "error", message: "E-0" }] });
    const b = makeRun({ errorLogs: [{ level: "error", message: "E-0" }, { level: "warn", message: "W-1" }] });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });

  it("errorLogs 封顶后 length 不变内容移（push+slice(-MAX_ERROR_LOGS)）→ 签名仍变（指纹非 length）", () => {
    // 模拟 error-recovery 的变异路径：push 后 slice(-500) 截断。两次 state 均 500 条
    // （length 相同），仅末条/窗口内容不同——指纹含末条内容才不漏失效。
    const MAX_ERROR_LOGS = 500;
    const mk = (n: number): WorkerLogEntry[] => ({ level: "error", message: `E-${n}` });
    const before: WorkerLogEntry[] = Array.from({ length: MAX_ERROR_LOGS }, (_, i) => mk(i));
    const after = [...before, mk(MAX_ERROR_LOGS)].slice(-MAX_ERROR_LOGS); // E-1..E-500
    expect(after).toHaveLength(MAX_ERROR_LOGS); // 前置校验：封顶后 length 不变
    const a = makeRun({ errorLogs: before });
    const b = makeRun({ errorLogs: after });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });
});

describe("computeRenderSignature — 节点级字段（live 投影）", () => {
  it("节点 status 变化 → 签名变", () => {
    const a = makeRun({ nodes: [makeNode({ status: "running" })] });
    const b = makeRun({ nodes: [makeNode({ status: "failed" })] });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });

  it("live.totalTokens 变化 → 签名变", () => {
    const a = makeRun({ nodes: [makeNode({ live: makeLive({ totalTokens: 1000 }) })] });
    const b = makeRun({ nodes: [makeNode({ live: makeLive({ totalTokens: 2000 }) })] });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });

  it("getAllToolCalls(node.live).length 变化 → 签名变（toolCalls 追加）", () => {
    const live1 = makeLive({
      turns: [{ text: "", closed: false, toolCalls: [{ toolName: "read", args: {}, result: "", isError: false, _status: "completed", startedTs: T0 }] }],
    });
    const live2 = makeLive({
      turns: [{ text: "", closed: false, toolCalls: [
        { toolName: "read", args: {}, result: "", isError: false, _status: "completed", startedTs: T0 },
        { toolName: "bash", args: {}, result: "", isError: false, _status: "completed", startedTs: T0 },
      ] }],
    });
    const a = makeRun({ nodes: [makeNode({ live: live1 })] });
    const b = makeRun({ nodes: [makeNode({ live: live2 })] });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });

  it("live.elapsedSeconds 变化 → 签名变（running 节点跨秒）", () => {
    // endedAt undefined → computeElapsedSeconds 用真实 Date.now()；fake timers 推进 1s
    const live = makeLive({ endedAt: undefined });
    const run = makeRun({ nodes: [makeNode({ live })] });
    const before = computeRenderSignature(run, T0);
    vi.setSystemTime(T0 + 1000);
    const after = computeRenderSignature(run, T0 + 1000);
    expect(after).not.toBe(before);
  });

  it("live.turns 计数变化 → 签名变", () => {
    const a = makeRun({ nodes: [makeNode({ live: makeLive({ turnCount: 1 }) })] });
    const b = makeRun({ nodes: [makeNode({ live: makeLive({ turnCount: 2 }) })] });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });

  it("live.eventLog 追加（turn 闭合产生 turn_end 条目）→ 签名变", () => {
    const live1 = makeLive({
      turns: [{ text: "partial", closed: false, toolCalls: [] }],
    });
    const live2 = makeLive({
      turns: [{ text: "partial", closed: true, closedTs: T0, toolCalls: [] }],
    });
    const a = makeRun({ nodes: [makeNode({ live: live1 })] });
    const b = makeRun({ nodes: [makeNode({ live: live2 })] });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });

  it("live.currentActivity 出现 / 变化（type+label）→ 签名变", () => {
    const noActivity = makeLive({ turns: [{ text: "", closed: false, toolCalls: [] }] });
    const toolRunning = makeLive({
      turns: [{ text: "", closed: false, toolCalls: [{ toolName: "write", args: {}, result: "", isError: false, _status: "running", startedTs: T0 }] }],
    });
    const toolRunningOtherLabel = makeLive({
      turns: [{ text: "", closed: false, toolCalls: [{ toolName: "bash", args: {}, result: "", isError: false, _status: "running", startedTs: T0 }] }],
    });
    const base = makeRun({ nodes: [makeNode({ live: noActivity })] });
    const withTool = makeRun({ nodes: [makeNode({ live: toolRunning })] });
    const otherLabel = makeRun({ nodes: [makeNode({ live: toolRunningOtherLabel })] });

    const s0 = computeRenderSignature(base, T0);
    expect(computeRenderSignature(withTool, T0)).not.toBe(s0); // 出现
    expect(computeRenderSignature(otherLabel, T0)).not.toBe(computeRenderSignature(withTool, T0)); // label 变
  });

  it("live.lastError 出现（内容入签名）→ 签名变", () => {
    const a = makeRun({ nodes: [makeNode({ live: makeLive({ lastError: undefined }) })] });
    const b = makeRun({ nodes: [makeNode({ live: makeLive({ lastError: "EPIPE: broken pipe" }) })] });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });

  it("node.sessionFile 出现 → 签名变", () => {
    const a = makeRun({ nodes: [makeNode({})] });
    const b = makeRun({ nodes: [makeNode({ sessionFile: "/tmp/sessions/run-0.jsonl" })] });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });
});

describe("computeRenderSignature — 多节点与无 live 终态", () => {
  it("多节点逐一拼接（节点序参与签名）", () => {
    const run = makeRun({
      nodes: [
        makeNode({ stepIndex: 0, status: "completed" }),
        makeNode({ stepIndex: 1, status: "running", live: makeLive({ totalTokens: 500 }) }),
      ],
    });
    const sig = computeRenderSignature(run, T0);
    expect(sig).toContain("0:completed:-:-1:-1:-1:-1:-1:-:-");
    expect(sig).toContain("1:running:-:500:0:5:0:0:-:-");
  });

  it("节点重排（trace 数组序对调，stepIndex 维度）→ 签名变", () => {
    // 同一节点集、字段值均不变，仅 trace 数组顺序对调——nodeParts 按 trace 序拼接，
    // 首字段 stepIndex 随之换位，签名必变（不漏失效）。
    const first = makeNode({ stepIndex: 0, status: "completed" });
    const second = makeNode({ stepIndex: 1, status: "running", live: makeLive() });
    const a = makeRun({ nodes: [first, second] });
    const b = makeRun({ nodes: [second, first] });
    expect(computeRenderSignature(a, T0)).not.toBe(computeRenderSignature(b, T0));
  });

  it("无节点 run 签名仅含 run 级五段（status/秒桶/completed-total/budget/errorLogs）", () => {
    const sig = computeRenderSignature(makeRun({ nodes: [] }), T0);
    expect(sig.split("|")).toHaveLength(5);
  });
});
