import { describe, it, expect } from "vitest";
import {
  MAX_NODE_ROUNDS,
  VALID_LAYERS,
  isTerminal,
  assertValidUnitId,
  isTimeoutError,
  buildActionPrompt,
  buildActionSchema,
  topoSort,
  selectActionable,
  detectStuckNodes,
} from "../recursive-split-utils.cjs";

// ── 常量 ────────────────────────────────────────────────────────────

describe("常量", () => {
  it("MAX_NODE_ROUNDS = 3", () => {
    expect(MAX_NODE_ROUNDS).toBe(3);
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

  it("wave node 返回 base schema（无 children）", () => {
    const schema = buildActionSchema(waveNode);
    expect(schema.properties.done).toBeDefined();
    expect(schema.properties.stopReason).toBeDefined();
    expect(schema.properties.lastStatus).toBeDefined();
    expect(schema.properties.replanTriggered).toBeDefined();
    expect(schema.properties.abortedChildren).toBeDefined();
    expect(schema.properties.children).toBeUndefined();
    expect(schema.required).toEqual(["done"]);
  });

  it("planning node 返回含 children 的 schema", () => {
    const schema = buildActionSchema(sliceNode);
    expect(schema.properties.children).toBeDefined();
    expect(schema.properties.children.items.properties.unitId).toBeDefined();
    expect(schema.properties.children.items.properties.dependsOn).toBeDefined();
  });

  it("所有 schema 含 done + stopReason（推进到阻塞模型）", () => {
    for (const node of [waveNode, sliceNode]) {
      const schema = buildActionSchema(node);
      expect(schema.properties.done).toBeDefined();
      expect(schema.properties.stopReason).toBeDefined();
    }
  });
});

// ── buildActionPrompt ───────────────────────────────────────────────

describe("buildActionPrompt", () => {
  const waveNode = { unitId: "wave:test-wave", scope: "wave" };
  const sliceNode = { unitId: "slice:test-slice", scope: "slice" };

  it("含 unitId", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("wave:test-wave");
  });

  it("含停止条件（推进到阻塞模型）", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("停止条件");
    expect(prompt).toContain("crossLayer");
    expect(prompt).toContain("gate fail");
  });

  it("含 cw handoff 指令", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("cw handoff --unitId wave:test-wave");
  });

  it("引导 agent gate pass 后继续推进（不返回）", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("gate pass 后不要返回");
    expect(prompt).toContain("继续调");
  });

  it("含 clarify 前进引导（防止 progressive 循环）", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("clarify");
    expect(prompt).toContain("cw plan");
    expect(prompt).toContain("前进");
  });

  it("含 test 测试文件产出引导", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("vitest");
    expect(prompt).toContain("测试文件");
  });

  it("planning node 含 children 抄录引导", () => {
    const prompt = buildActionPrompt(sliceNode);
    expect(prompt).toContain("children");
    expect(prompt).toContain("cw tree");
    expect(prompt).toContain("crossLayer.descend");
  });

  it("wave node 不含 children 抄录引导", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).not.toContain("planning 层的 execute");
  });

  it("不含 --input '<JSON>' 字面语法（L0 修复验证）", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).not.toContain("--input '<");
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

// ── detectStuckNodes（node 级熔断） ─────────────────────────────────

describe("detectStuckNodes", () => {
  it("status 变化时重置计数（node 在推进）", () => {
    const actionable = [{ unitId: "a", status: "planning" }];
    const prevStatus = { a: "clarifying" }; // 上一轮 clarifying，本轮 planning → 推进了
    const nodeRounds = { a: 2 }; // 之前累积了 2 轮没推进
    detectStuckNodes(actionable, prevStatus, nodeRounds);
    expect(nodeRounds["a"]).toBe(0); // 重置
  });

  it("status 不变时累加计数", () => {
    const actionable = [{ unitId: "a", status: "clarifying" }];
    const prevStatus = { a: "clarifying" }; // 没变
    const nodeRounds = { a: 1 };
    detectStuckNodes(actionable, prevStatus, nodeRounds);
    expect(nodeRounds["a"]).toBe(2);
  });

  it("连续 MAX_NODE_ROUNDS 轮 status 不变 → 触发 abort", () => {
    const actionable = [{ unitId: "a", status: "clarifying" }];
    const prevStatus = { a: "clarifying" };
    const nodeRounds = { a: MAX_NODE_ROUNDS - 1 }; // 再加 1 就到阈值
    const stuck = detectStuckNodes(actionable, prevStatus, nodeRounds);
    expect(stuck).toEqual(["a"]);
  });

  it("首轮（prevStatus 无记录）不触发 abort", () => {
    const actionable = [{ unitId: "a", status: "created" }];
    const prevStatus = {}; // 第一次见到这个 node
    const nodeRounds = {};
    const stuck = detectStuckNodes(actionable, prevStatus, nodeRounds);
    expect(stuck).toHaveLength(0);
    expect(nodeRounds["a"]).toBe(0); // status 设为当前，rounds 归零
  });

  it("prevStatus 被更新为当前 status", () => {
    const actionable = [{ unitId: "a", status: "planning" }];
    const prevStatus = {};
    detectStuckNodes(actionable, prevStatus, {});
    expect(prevStatus["a"]).toBe("planning");
  });

  it("多个 node 独立计数", () => {
    const actionable = [
      { unitId: "a", status: "clarifying" },
      { unitId: "b", status: "planning" },
    ];
    const prevStatus = { a: "clarifying", b: "clarifying" };
    const nodeRounds = { a: 0, b: 0 };
    detectStuckNodes(actionable, prevStatus, nodeRounds);
    // a 没变 → rounds 累加
    expect(nodeRounds["a"]).toBe(1);
    // b 变了（clarifying→planning）→ rounds 重置
    expect(nodeRounds["b"]).toBe(0);
  });

  it("progressive action 不再豁免——status 不变就累加", () => {
    // 旧模型 PROGRESSIVE_ACTIONS 豁免已删除。
    // clarify 的 status 不推进（clarifying→clarifying）也会累加 → 最终熔断
    const actionable = [{ unitId: "a", status: "clarifying" }];
    const prevStatus = { a: "clarifying" };
    const nodeRounds = { a: MAX_NODE_ROUNDS - 1 };
    const stuck = detectStuckNodes(actionable, prevStatus, nodeRounds);
    expect(stuck).toEqual(["a"]); // 不豁免，触发熔断
  });
});
