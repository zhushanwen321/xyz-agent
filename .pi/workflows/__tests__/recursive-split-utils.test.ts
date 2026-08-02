import { describe, it, expect } from "vitest";
import {
  MAX_NODE_ROUNDS,
  MAX_FRONTIER_RETRIES,
  VALID_LAYERS,
  isTerminal,
  assertValidUnitId,
  isTimeoutError,
  escapeSingleQuotes,
  decideNodeOutcome,
  buildActionPrompt,
  buildActionSchema,
  topoSort,
  selectActionable,
  detectStuckNodes,
  pruneTerminalEntries,
} from "../recursive-split-utils.cjs";

// ── 局部最小类型 ────────────────────────────────────────────────────
// Suggestion #4：去掉测试中的 `as any[]`，定义与 topoSort/selectActionable 入参契约一致的最小
// node 形状（fields all optional，覆盖不同测试场景的子集）。
type FrontierNode = {
  unitId: string;
  status?: string;
  blocked?: boolean;
  dependsOn?: string[];
};

// ── 常量 ────────────────────────────────────────────────────────────

describe("常量", () => {
  it("MAX_NODE_ROUNDS = 3", () => {
    expect(MAX_NODE_ROUNDS).toBe(3);
  });

  it("MAX_FRONTIER_RETRIES = 3", () => {
    expect(MAX_FRONTIER_RETRIES).toBe(3);
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

// ── escapeSingleQuotes ─────────────────────────────────────────────

describe("escapeSingleQuotes", () => {
  it("空串保持空串", () => {
    expect(escapeSingleQuotes("")).toBe("");
  });

  it("不含单引号的正常串原样返回", () => {
    expect(escapeSingleQuotes("hello world")).toBe("hello world");
    expect(escapeSingleQuotes("写代码 + 跑测试")).toBe("写代码 + 跑测试");
  });

  it("单引号被转义为 '\\''", () => {
    // 每个 ' 替换为 '\''（POSIX 单引号转义约定）
    expect(escapeSingleQuotes("it's")).toBe("it'\\''s");
    expect(escapeSingleQuotes("'quoted'")).toBe("'\\''quoted'\\''");
  });

  it("多个连续单引号逐个转义", () => {
    expect(escapeSingleQuotes("''")).toBe("'\\'''\\''");
    expect(escapeSingleQuotes("a'b'c")).toBe("a'\\''b'\\''c");
  });

  it("含 $() 和反引号的 shell 元字符串不被额外处理（交给单引号包裹防注入）", () => {
    // task 在 createRootUnit 中被单引号包裹：'${safe}'。
    // 单引号内 $ ` () 无特殊语义——escapeSingleQuotes 只需保证不产生裸单引号即可。
    const input = "run $(whoami) and `reboot`";
    expect(escapeSingleQuotes(input)).toBe(input);
    expect(escapeSingleQuotes("${HOME}")).toBe("${HOME}");
  });

  it("非字符串入参强制 String() 转换", () => {
    // createRootUnit 的 task 来自 $ARGS，可能 undefined → "undefined"。
    expect(escapeSingleQuotes(undefined)).toBe("undefined");
    expect(escapeSingleQuotes(null)).toBe("null");
    expect(escapeSingleQuotes(42)).toBe("42");
  });

  it("转义后用单引号包裹可安全拼进 shell 命令（行为契约）", () => {
    // createRootUnit 拼接：`cw create ... --objective '${safeObjective}'`。
    // POSIX 单引号转义约定：单引号串内不能有裸 '，每个 ' 替换为 '\''（关闭串 → 转义 ' → 重开串）。
    const task = "don't break; rm -rf /";
    const wrapped = "'" + escapeSingleQuotes(task) + "'";
    expect(wrapped).toBe("'don'\\''t break; rm -rf /'");
    // 契约：包裹后的 token 经 shell 单引号解析后必须还原原 task（无注入、无截断）。
    // 模拟解析：剥外层引号后把每个 '\'' 还原成 '。
    const parsed = wrapped.slice(1, -1).replace(/'\\''/g, "'");
    expect(parsed).toBe(task);
    // 转义后不再残留裸单引号（即所有 ' 都属于 '\'' 序列的一部分）
    const stripped = wrapped.slice(1, -1).replace(/'\\''/g, "");
    expect(stripped).not.toContain("'");
  });
});

// ── decideNodeOutcome ──────────────────────────────────────────────

describe("decideNodeOutcome", () => {
  it("r.error 非空 → 失败，failedReason = r.error", () => {
    const r = { error: "agent crashed", value: "partial", sessionFile: "s.json" };
    const outcome = decideNodeOutcome(r);
    expect(outcome.failed).toBe(true);
    expect(outcome.failedReason).toBe("agent crashed");
  });

  it("r.error 含 timeout 关键词 → 失败", () => {
    const r = { error: "action timeout exceeded" };
    const outcome = decideNodeOutcome(r);
    expect(outcome.failed).toBe(true);
    expect(outcome.failedReason).toBe("action timeout exceeded");
  });

  it("r.error 含 aborted 关键词 → 失败", () => {
    const r = { error: "task aborted by caller" };
    const outcome = decideNodeOutcome(r);
    expect(outcome.failed).toBe(true);
    expect(outcome.failedReason).toBe("task aborted by caller");
  });

  it("无 error（正常）→ failed=false，无 failedReason", () => {
    const r = { error: undefined, value: "ok", sessionFile: "s.json" };
    const outcome = decideNodeOutcome(r);
    expect(outcome.failed).toBe(false);
    expect(outcome.failedReason).toBeUndefined();
  });

  it("空串 error → 正常（returnMeta 回退值视为成功）", () => {
    // 与 isTimeoutError({error:""})===false 对齐：空串 error 不构成失败
    const r = { error: "", value: "ok" };
    const outcome = decideNodeOutcome(r);
    expect(outcome.failed).toBe(false);
    expect(outcome.failedReason).toBeUndefined();
  });

  it("缺 error 字段 → 正常", () => {
    const r = { value: "ok" };
    const outcome = decideNodeOutcome(r);
    expect(outcome.failed).toBe(false);
  });

  it("失败时不读取 value/sessionFile 字段（仅判定失败语义）", () => {
    // 契约：decideNodeOutcome 只产出 {failed, failedReason?}；
    // value/sessionFile 由调用方自行从 r 取出组装返回值。
    const r = { error: "boom", value: "v", sessionFile: "s" };
    const outcome = decideNodeOutcome(r);
    expect(outcome).toEqual({ failed: true, failedReason: "boom" });
    expect(Object.keys(outcome)).toEqual(["failed", "failedReason"]);
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
    const nodes: FrontierNode[] = [
      { unitId: "a" },
      { unitId: "b" },
    ];
    const { concurrent } = topoSort(nodes);
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

// ── pruneTerminalEntries（终态节点 entry 清理） ─────────────────────

describe("pruneTerminalEntries", () => {
  it("清理本轮不在 frontier 且上轮 status 终态的节点 entry", () => {
    // a 上轮 closed → 本轮 frontier 不含 a（已退出调度）→ 清理
    // b 本轮仍在 frontier（非终态）→ 保留
    const prevStatus: Record<string, string> = { a: "closed", b: "executing" };
    const nodeRounds: Record<string, number> = { a: 2, b: 0 };
    const pruned = pruneTerminalEntries(prevStatus, nodeRounds, ["b"]);
    expect(pruned).toEqual(["a"]);
    expect(prevStatus).toEqual({ b: "executing" });
    expect(nodeRounds).toEqual({ b: 0 });
  });

  it("aborted 终态也被清理", () => {
    const prevStatus: Record<string, string> = { a: "aborted" };
    const nodeRounds: Record<string, number> = { a: 5 };
    const pruned = pruneTerminalEntries(prevStatus, nodeRounds, []);
    expect(pruned).toEqual(["a"]);
    expect(prevStatus).toEqual({});
    expect(nodeRounds).toEqual({});
  });

  it("本轮仍在 frontier 的节点保留（即使上轮 status 终态——理论不会发生但保守保留）", () => {
    const prevStatus: Record<string, string> = { a: "closed" };
    const nodeRounds: Record<string, number> = { a: 0 };
    const pruned = pruneTerminalEntries(prevStatus, nodeRounds, ["a"]);
    expect(pruned).toEqual([]);
    expect(prevStatus).toEqual({ a: "closed" });
  });

  it("本轮不在 frontier 但上轮 status 非终态 → 保留（可能 frontier 抖动漏报，下轮再判）", () => {
    // 保守策略：非终态节点突然消失可能是临时性 frontier 失败/漏报，不清避免误清活跃节点
    const prevStatus: Record<string, string> = { a: "executing" };
    const nodeRounds: Record<string, number> = { a: 1 };
    const pruned = pruneTerminalEntries(prevStatus, nodeRounds, []);
    expect(pruned).toEqual([]);
    expect(prevStatus).toEqual({ a: "executing" });
  });

  it("同时清理 prevStatus 和 nodeRounds 两 Map", () => {
    const prevStatus: Record<string, string> = {
      a: "closed",
      b: "aborted",
      c: "planning",
    };
    const nodeRounds: Record<string, number> = { a: 0, b: 3, c: 1 };
    const pruned = pruneTerminalEntries(prevStatus, nodeRounds, ["c"]);
    // a/b 终态且不在本轮 → 清理；c 仍在 → 保留
    expect(pruned.sort()).toEqual(["a", "b"]);
    expect(prevStatus).toEqual({ c: "planning" });
    expect(nodeRounds).toEqual({ c: 1 });
  });

  it("空 prevStatus 返回空数组", () => {
    const prevStatus: Record<string, string> = {};
    const nodeRounds: Record<string, number> = {};
    const pruned = pruneTerminalEntries(prevStatus, nodeRounds, ["a", "b"]);
    expect(pruned).toEqual([]);
  });

  it("空 currentUnitIds + 全终态 prevStatus → 全清", () => {
    const prevStatus: Record<string, string> = {
      a: "closed",
      b: "aborted",
    };
    const nodeRounds: Record<string, number> = { a: 0, b: 0 };
    const pruned = pruneTerminalEntries(prevStatus, nodeRounds, []);
    expect(pruned.sort()).toEqual(["a", "b"]);
    expect(prevStatus).toEqual({});
    expect(nodeRounds).toEqual({});
  });

  it("纯函数就地 mutate（不返回新 Map，调用方传入的对象被修改）", () => {
    const prevStatus: Record<string, string> = { a: "closed" };
    const nodeRounds: Record<string, number> = { a: 9 };
    const prevRef = prevStatus;
    const roundsRef = nodeRounds;
    pruneTerminalEntries(prevStatus, nodeRounds, []);
    // 同一引用被就地修改（与 detectStuckNodes 一致的副作用契约）
    expect(prevRef).toBe(prevStatus);
    expect(roundsRef).toBe(nodeRounds);
    expect(prevStatus).toEqual({});
    expect(nodeRounds).toEqual({});
  });
});
