import { describe, it, expect } from "vitest";
import {
  MAX_ACTION_RETRY,
  PROGRESSIVE_ACTIONS,
  VALID_LAYERS,
  isTerminal,
  assertValidUnitId,
  isTimeoutError,
  buildActionPrompt,
  buildActionSchema,
  handleReplan,
  topoSort,
  selectActionable,
  detectStuckNodes,
  reduceActionResults,
} from "../recursive-split-utils.cjs";

// ── 常量 ────────────────────────────────────────────────────────────

describe("常量", () => {
  it("MAX_ACTION_RETRY = 3", () => {
    expect(MAX_ACTION_RETRY).toBe(3);
  });

  it("PROGRESSIVE_ACTIONS 含 clarify/plan/design-review", () => {
    expect(PROGRESSIVE_ACTIONS.has("clarify")).toBe(true);
    expect(PROGRESSIVE_ACTIONS.has("plan")).toBe(true);
    expect(PROGRESSIVE_ACTIONS.has("design-review")).toBe(true);
    expect(PROGRESSIVE_ACTIONS.has("execute")).toBe(false);
  });

  it("VALID_LAYERS 含 epic/feature/slice/wave", () => {
    for (const layer of ["epic", "feature", "slice", "wave"]) {
      expect(VALID_LAYERS.has(layer)).toBe(true);
    }
    expect(VALID_LAYERS.has("invalid")).toBe(false);
  });
});

// ── isTerminal ──────────────────────────────────────────────────────

describe("isTerminal", () => {
  it("closed 和 aborted 是终态", () => {
    expect(isTerminal("closed")).toBe(true);
    expect(isTerminal("aborted")).toBe(true);
  });

  it("created/executing/testing 等非终态", () => {
    expect(isTerminal("created")).toBe(false);
    expect(isTerminal("executing")).toBe(false);
    expect(isTerminal("testing")).toBe(false);
  });
});

// ── assertValidUnitId ───────────────────────────────────────────────

describe("assertValidUnitId", () => {
  it("合法 unitId 通过", () => {
    expect(() => assertValidUnitId("wave:test-wave")).not.toThrow();
    expect(() => assertValidUnitId("slice:my-slug")).not.toThrow();
    expect(() => assertValidUnitId("feature:sub:feature-1")).not.toThrow();
  });

  it("非法 unitId throw", () => {
    expect(() => assertValidUnitId("invalid")).toThrow();
    expect(() => assertValidUnitId("")).toThrow();
  });

  it("shell 注入串 throw", () => {
    expect(() => assertValidUnitId("wave; rm -rf /")).toThrow();
    expect(() => assertValidUnitId("wave:$(whoami)")).toThrow();
    expect(() => assertValidUnitId("wave:test`reboot`")).toThrow();
  });
});

// ── isTimeoutError ──────────────────────────────────────────────────

describe("isTimeoutError", () => {
  it("含 timeout 关键词返回 true", () => {
    expect(isTimeoutError({ error: "action timeout" })).toBe(true);
    expect(isTimeoutError({ error: "TIMEOUT exceeded" })).toBe(true);
  });

  it("含 aborted 关键词返回 true", () => {
    expect(isTimeoutError({ error: "task was aborted" })).toBe(true);
  });

  it("无 error 返回 false", () => {
    expect(isTimeoutError({})).toBe(false);
    expect(isTimeoutError({ error: "" })).toBe(false);
  });

  it("非超时错误返回 false", () => {
    expect(isTimeoutError({ error: "file not found" })).toBe(false);
  });
});

// ── buildActionSchema ───────────────────────────────────────────────

describe("buildActionSchema", () => {
  const waveNode = { unitId: "wave:test", scope: "wave" };
  const sliceNode = { unitId: "slice:test", scope: "slice" };

  it("planning execute 返回含 children 的 schema", () => {
    const schema = buildActionSchema(sliceNode, "execute", false);
    expect(schema.properties.children).toBeDefined();
    expect(schema.properties.children.items.properties.unitId).toBeDefined();
    expect(schema.properties.children.items.properties.dependsOn).toBeDefined();
  });

  it("wave 层 execute 不返回 children（wave 是叶子层）", () => {
    const schema = buildActionSchema(waveNode, "execute", true);
    expect(schema.properties.children).toBeUndefined();
  });

  it("wave closeout 返回含 commitHash + summary", () => {
    const schema = buildActionSchema(waveNode, "closeout", true);
    expect(schema.properties.commitHash).toBeDefined();
    expect(schema.properties.summary).toBeDefined();
  });

  it("所有 action 含 replan 信号字段（baseProps）", () => {
    const schema = buildActionSchema(waveNode, "clarify", true);
    expect(schema.properties.replanTriggered).toBeDefined();
    expect(schema.properties.abortedChildren).toBeDefined();
    expect(schema.properties.done).toBeDefined();
  });

  it("非 execute/closeout action 返回 base schema", () => {
    const schema = buildActionSchema(waveNode, "test", true);
    expect(schema.properties.done).toBeDefined();
    expect(schema.properties.commitHash).toBeUndefined();
    expect(schema.properties.children).toBeUndefined();
  });
});

// ── buildActionPrompt ───────────────────────────────────────────────

describe("buildActionPrompt", () => {
  const node = { unitId: "wave:test-wave", scope: "wave" };

  it("含 unitId 和 action", () => {
    const prompt = buildActionPrompt(node, "clarify");
    expect(prompt).toContain("wave:test-wave");
    expect(prompt).toContain("clarify");
  });

  it("含 cw handoff 指令", () => {
    const prompt = buildActionPrompt(node, "clarify");
    expect(prompt).toContain("cw handoff --unitId wave:test-wave");
  });

  it("planning execute 含 children 抄录指示", () => {
    const sliceNode = { unitId: "slice:test", scope: "slice" };
    const prompt = buildActionPrompt(sliceNode, "execute");
    expect(prompt).toContain("children");
    expect(prompt).toContain("cw tree");
  });

  it("wave execute 不含 children 抄录指示", () => {
    const prompt = buildActionPrompt(node, "execute");
    expect(prompt).not.toContain("检查 stdout JSON 的 children");
  });

  it("replan hint 只对 plan/design-review/execute/test 注入", () => {
    expect(buildActionPrompt(node, "plan")).toContain("replan");
    expect(buildActionPrompt(node, "execute")).toContain("replan");
    expect(buildActionPrompt(node, "test")).toContain("replan");
    expect(buildActionPrompt(node, "design-review")).toContain("replan");
    // retrospect/closeout 不注入 replan hint
    expect(buildActionPrompt(node, "retrospect")).not.toContain("replan");
    expect(buildActionPrompt(node, "closeout")).not.toContain("replan");
  });

  it("不硬编码 --input '<JSON>' 字面语法（L0 修复验证）", () => {
    const prompt = buildActionPrompt(node, "clarify");
    expect(prompt).not.toContain("--input '<");
    expect(prompt).not.toContain("--input '<根据");
  });
});

// ── topoSort ────────────────────────────────────────────────────────

describe("topoSort", () => {
  it("无内部依赖全 concurrent", () => {
    const nodes = [
      { unitId: "a", dependsOn: [] },
      { unitId: "b", dependsOn: [] },
    ];
    const { concurrent, sequential } = topoSort(nodes);
    expect(concurrent).toHaveLength(2);
    expect(sequential).toHaveLength(0);
  });

  it("有内部依赖分到 sequential", () => {
    const nodes = [
      { unitId: "a", dependsOn: [] },
      { unitId: "b", dependsOn: ["a"] },
    ];
    const { concurrent, sequential } = topoSort(nodes);
    expect(concurrent).toHaveLength(1);
    expect(concurrent[0].unitId).toBe("a");
    expect(sequential).toHaveLength(1);
    expect(sequential[0].unitId).toBe("b");
  });

  it("外部依赖不影响分组（仍 concurrent）", () => {
    const nodes = [
      { unitId: "a", dependsOn: ["external-id"] },
      { unitId: "b", dependsOn: ["external-id"] },
    ];
    const { concurrent, sequential } = topoSort(nodes);
    expect(concurrent).toHaveLength(2);
    expect(sequential).toHaveLength(0);
  });

  it("Kahn 拓扑排序：被依赖者排前面", () => {
    // a → b → c（a 被依赖最多，应排最前）
    const nodes = [
      { unitId: "c", dependsOn: ["b"] },
      { unitId: "b", dependsOn: ["a"] },
      { unitId: "a", dependsOn: [] },
    ];
    const { sequential } = topoSort(nodes);
    expect(sequential).toHaveLength(2); // b 和 c 有内部依赖
    // Kahn 排序后 b 应在 c 前面
    expect(sequential[0].unitId).toBe("b");
    expect(sequential[1].unitId).toBe("c");
  });

  it("直接环 A↔B throw", () => {
    const nodes = [
      { unitId: "a", dependsOn: ["b"] },
      { unitId: "b", dependsOn: ["a"] },
    ];
    expect(() => topoSort(nodes)).toThrow(/Circular dependency/);
  });

  it("间接环 A→B→C→A throw", () => {
    const nodes = [
      { unitId: "a", dependsOn: ["c"] },
      { unitId: "b", dependsOn: ["a"] },
      { unitId: "c", dependsOn: ["b"] },
    ];
    expect(() => topoSort(nodes)).toThrow(/Circular dependency/);
  });

  it("dependsOn 缺省视为空数组", () => {
    const nodes = [
      { unitId: "a" },
      { unitId: "b" },
    ];
    const { concurrent } = topoSort(nodes as any[]);
    expect(concurrent).toHaveLength(2);
  });
});

// ── selectActionable ────────────────────────────────────────────────

describe("selectActionable", () => {
  it("过滤 blocked 节点", () => {
    const frontier = {
      nodes: [
        { unitId: "a", blocked: false, status: "executing" },
        { unitId: "b", blocked: true, status: "executing" },
      ],
    };
    const { actionable } = selectActionable(frontier);
    expect(actionable).toHaveLength(1);
    expect(actionable[0].unitId).toBe("a");
  });

  it("过滤终态节点", () => {
    const frontier = {
      nodes: [
        { unitId: "a", blocked: false, status: "closed" },
        { unitId: "b", blocked: false, status: "aborted" },
        { unitId: "c", blocked: false, status: "executing" },
      ],
    };
    const { actionable } = selectActionable(frontier);
    expect(actionable).toHaveLength(1);
    expect(actionable[0].unitId).toBe("c");
  });

  it("全终态 shouldBreak=true", () => {
    const frontier = {
      nodes: [
        { unitId: "a", blocked: false, status: "closed" },
        { unitId: "b", blocked: false, status: "aborted" },
      ],
    };
    const { actionable, shouldBreak } = selectActionable(frontier);
    expect(shouldBreak).toBe(true);
    expect(actionable).toHaveLength(0);
  });

  it("空 frontier shouldBreak=true", () => {
    const { shouldBreak } = selectActionable({ nodes: [] });
    expect(shouldBreak).toBe(true);
  });

  it("有 actionable shouldBreak=false", () => {
    const frontier = {
      nodes: [{ unitId: "a", blocked: false, status: "executing" }],
    };
    const { shouldBreak } = selectActionable(frontier);
    expect(shouldBreak).toBe(false);
  });
});

// ── detectStuckNodes ────────────────────────────────────────────────

describe("detectStuckNodes", () => {
  it("progressive action 豁免（不计入熔断）", () => {
    const actionable = [{ unitId: "a", nextAction: "clarify" }];
    const retryCount = {};
    const prevNextAction = {};
    const stuck = detectStuckNodes(actionable, retryCount, prevNextAction);
    expect(stuck).toHaveLength(0);
  });

  it("首轮建基线不计入累加", () => {
    // 第一次见到节点 a 的 execute action，不触发熔断
    const actionable = [{ unitId: "a", nextAction: "execute" }];
    const retryCount = {};
    const prevNextAction = {};
    const stuck = detectStuckNodes(actionable, retryCount, prevNextAction);
    expect(stuck).toHaveLength(0);
  });

  it("连续 N 轮同 action 触发 abort", () => {
    const actionable = [{ unitId: "a", nextAction: "execute" }];
    // 模拟已连续 MAX_ACTION_RETRY 轮
    const retryCount = { "a:execute": MAX_ACTION_RETRY - 1 };
    const prevNextAction = { a: "execute" };
    const stuck = detectStuckNodes(actionable, retryCount, prevNextAction);
    expect(stuck).toEqual(["a"]);
  });

  it("action 变化重置计数（新 action key 从 0 开始）", () => {
    // 上一轮 execute（有计数），本轮 test → 新 key 首轮不累加
    const actionable = [{ unitId: "a", nextAction: "test" }];
    const retryCount = { "a:execute": 5 };
    const prevNextAction = { a: "execute" };
    detectStuckNodes(actionable, retryCount, prevNextAction);
    // 新 action key 首轮不累加（prevAction=execute !== test → 走 else 分支设为 0）
    expect(retryCount["a:test"]).toBe(0);
    // 旧 key 残留但无害（下次 action 变回 execute 时 prevAction 不匹配会重置）
    expect(retryCount["a:execute"]).toBe(5);
  });

  it("prevNextAction 被更新为当前 action", () => {
    const actionable = [{ unitId: "a", nextAction: "test" }];
    const prevNextAction = {};
    detectStuckNodes(actionable, {}, prevNextAction);
    expect(prevNextAction["a"]).toBe("test");
  });
});

// ── handleReplan ────────────────────────────────────────────────────

describe("handleReplan", () => {
  it("设 replanOverride 为 plan", () => {
    const replanOverride = {};
    handleReplan(
      { unitId: "slice:1", abortedChildren: [] },
      replanOverride, {}, {}, {}
    );
    expect(replanOverride["slice:1"]).toBe("plan");
  });

  it("清理 aborted 子节点的 sessionFile", () => {
    const sessionFiles = { "wave:child1": "/path/1", "wave:child2": "/path/2" };
    handleReplan(
      { unitId: "slice:1", abortedChildren: ["wave:child1"] },
      {}, sessionFiles, {}, {}
    );
    expect(sessionFiles["wave:child1"]).toBeUndefined();
    expect(sessionFiles["wave:child2"]).toBe("/path/2");
  });

  it("清理 aborted 子节点的 retryCount", () => {
    const retryCount = { "wave:child1:execute": 2, "wave:child2:test": 1 };
    handleReplan(
      { unitId: "slice:1", abortedChildren: ["wave:child1"] },
      {}, {}, retryCount, {}
    );
    expect(retryCount["wave:child1:execute"]).toBeUndefined();
    expect(retryCount["wave:child2:test"]).toBe(1);
  });

  it("清理 aborted 子节点的 prevNextAction", () => {
    const prevNextAction = { "wave:child1": "execute", "wave:child2": "test" };
    handleReplan(
      { unitId: "slice:1", abortedChildren: ["wave:child1"] },
      {}, {}, {}, prevNextAction
    );
    expect(prevNextAction["wave:child1"]).toBeUndefined();
    expect(prevNextAction["wave:child2"]).toBe("test");
  });

  it("重置触发节点自身的 retryCount（所有 action）", () => {
    const retryCount = { "slice:1:execute": 3, "slice:1:test": 1, "other:2:plan": 2 };
    handleReplan(
      { unitId: "slice:1", abortedChildren: [] },
      {}, {}, retryCount, {}
    );
    expect(retryCount["slice:1:execute"]).toBeUndefined();
    expect(retryCount["slice:1:test"]).toBeUndefined();
    expect(retryCount["other:2:plan"]).toBe(2); // 不影响其他节点
  });

  it("返回 aborted Set", () => {
    const aborted = handleReplan(
      { unitId: "slice:1", abortedChildren: ["wave:a", "wave:b"] },
      {}, {}, {}, {}
    );
    expect(aborted instanceof Set).toBe(true);
    expect(aborted.has("wave:a")).toBe(true);
    expect(aborted.has("wave:b")).toBe(true);
  });

  it("空 abortedChildren 返回空 Set", () => {
    const aborted = handleReplan(
      { unitId: "slice:1", abortedChildren: [] },
      {}, {}, {}, {}
    );
    expect(aborted.size).toBe(0);
  });
});

// ── reduceActionResults ─────────────────────────────────────────────

describe("reduceActionResults", () => {
  const baseCtx = () => ({
    replanOverride: {},
    sessionFiles: {},
    retryCount: {},
    prevNextAction: {},
    logFn: () => {},
  });

  it("成功结果回收 sessionFile", () => {
    const ctx = baseCtx();
    reduceActionResults(
      { unitId: "wave:1", sessionFile: "/path/session.jsonl" },
      ctx
    );
    expect(ctx.sessionFiles["wave:1"]).toBe("/path/session.jsonl");
  });

  it("parallel 归一化 throw（status:failed）不 throw，只记日志", () => {
    const logs: string[] = [];
    const ctx = { ...baseCtx(), logFn: (msg: string) => logs.push(msg) };
    // 不应 throw
    expect(() => reduceActionResults(
      { status: "failed", error: "crashed" },
      ctx
    )).not.toThrow();
    expect(logs.some((l) => l.includes("crashed"))).toBe(true);
  });

  it("replanTriggered 触发 handleReplan（设 replanOverride）", () => {
    const ctx = baseCtx();
    const result = reduceActionResults(
      { unitId: "slice:1", replanTriggered: true, abortedChildren: ["wave:child1"] },
      ctx
    );
    expect(ctx.replanOverride["slice:1"]).toBe("plan");
    expect(result.abortedChildren).toBeDefined();
    expect(result.abortedChildren!.has("wave:child1")).toBe(true);
  });

  it("replanTriggered 后 aborted 子节点 sessionFile 不被回收", () => {
    const ctx = baseCtx();
    ctx.sessionFiles["wave:child1"] = "/old/path"; // 子节点已有 sessionFile
    reduceActionResults(
      { unitId: "slice:1", replanTriggered: true, abortedChildren: ["wave:child1"] },
      ctx
    );
    // handleReplan 清了它
    expect(ctx.sessionFiles["wave:child1"]).toBeUndefined();
  });

  it("null 结果安全处理", () => {
    const ctx = baseCtx();
    expect(() => reduceActionResults(null as any, ctx)).not.toThrow();
  });

  it("failedReason 记日志", () => {
    const logs: string[] = [];
    const ctx = { ...baseCtx(), logFn: (msg: string) => logs.push(msg) };
    reduceActionResults(
      { unitId: "wave:1", failedReason: "test failed" },
      ctx
    );
    expect(logs.some((l) => l.includes("test failed"))).toBe(true);
  });
});
