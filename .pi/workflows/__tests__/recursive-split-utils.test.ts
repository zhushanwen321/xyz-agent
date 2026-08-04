import { describe, it, expect } from "vitest";
import {
  MAX_NODE_ROUNDS,
  MAX_FRONTIER_RETRIES,
  VALID_LAYERS,
  PROGRESSIVE_ACTIONS,
  isTerminal,
  isProgressive,
  assertValidUnitId,
  isTimeoutError,
  escapeSingleQuotes,
  slugFromUnitId,
  decideNodeOutcome,
  isAgentReportedFailure,
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

  it("PROGRESSIVE_ACTIONS 含 clarify/plan/design-review/replan", () => {
    for (const action of ["clarify", "plan", "design-review", "replan"]) {
      expect(PROGRESSIVE_ACTIONS.has(action)).toBe(true);
    }
    expect(PROGRESSIVE_ACTIONS.has("execute")).toBe(false);
  });

  it("isProgressive 识别 progressive action", () => {
    expect(isProgressive("clarify")).toBe(true);
    expect(isProgressive("execute")).toBe(false);
    expect(isProgressive("design-review")).toBe(true);
  });

  it("isProgressive 边界（undefined / 空串）", () => {
    expect(isProgressive(undefined)).toBe(false);
    expect(isProgressive("")).toBe(false);
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

// ── slugFromUnitId ──────────────────────────────────────────────────

describe("slugFromUnitId", () => {
  it("根 unitId（无 :: 子分隔符）取冒号后的部分", () => {
    expect(slugFromUnitId("wave:recursive-root")).toBe("recursive-root");
    expect(slugFromUnitId("slice:auth-module")).toBe("auth-module");
  });

  it("子 unitId（含 ::）取完整冒号后部分 + :: 替换为 -", () => {
    expect(slugFromUnitId("wave:recursive-root::renderer")).toBe("recursive-root-renderer");
    expect(slugFromUnitId("wave:recursive-root::main")).toBe("recursive-root-main");
  });

  it("多层嵌套子 unitId（多个 ::）全部替换为 -", () => {
    expect(slugFromUnitId("wave:root::child::grandchild")).toBe("root-child-grandchild");
  });

  it("拼成 description 后多个子 wave 可区分（回归 bug 验证）", () => {
    const ids = [
      "wave:recursive-root::renderer",
      "wave:recursive-root::styles",
      "wave:recursive-root::tests",
      "wave:recursive-root::main",
    ];
    const descs = ids.map((id) => "w-clarify-" + slugFromUnitId(id));
    expect(new Set(descs).size).toBe(4);
    expect(descs).toContain("w-clarify-recursive-root-renderer");
    expect(descs).toContain("w-clarify-recursive-root-main");
  });

  it("无冒号的异常入参原样返回", () => {
    expect(slugFromUnitId("no-colon")).toBe("no-colon");
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

// ── isAgentReportedFailure（失败来源 2：agent 自报失败） ────────────

describe("isAgentReportedFailure", () => {
  it("stopReason=gate-failed → true", () => {
    expect(isAgentReportedFailure({ stopReason: "gate-failed" })).toBe(true);
  });

  it("stopReason=cannot-proceed → true", () => {
    expect(isAgentReportedFailure({ stopReason: "cannot-proceed", failedReason: "缺依赖" })).toBe(true);
  });

  it("stopReason=action-done → false（即使 failedReason 残留——MF-3 回归用例）", () => {
    // LLM 结构化输出不受 schema 约束：action 成功后 failedReason 残留是常见现象，
    // 按 failedReason 判定会把刚成功的节点立即 abortUnit 销毁。
    expect(isAgentReportedFailure({ stopReason: "action-done", failedReason: "旧失败原因残留" })).toBe(false);
  });

  it("stopReason=progressive-done / closed → false", () => {
    expect(isAgentReportedFailure({ stopReason: "progressive-done" })).toBe(false);
    expect(isAgentReportedFailure({ stopReason: "closed" })).toBe(false);
  });

  it("value 为 undefined / null → false", () => {
    expect(isAgentReportedFailure(undefined)).toBe(false);
    expect(isAgentReportedFailure(null)).toBe(false);
  });

  it("value 为空串/非对象 → false（属性访问安全降级）", () => {
    expect(isAgentReportedFailure("")).toBe(false);
    expect(isAgentReportedFailure("plain-text")).toBe(false);
    expect(isAgentReportedFailure({})).toBe(false);
  });
});

// ── buildActionSchema ───────────────────────────────────────────────

describe("buildActionSchema", () => {
  const waveNode = { unitId: "wave:test", scope: "wave", nextAction: "execute" };
  const sliceNode = { unitId: "slice:test", scope: "slice", nextAction: "execute" };

  it("required: ['stopReason']", () => {
    for (const node of [waveNode, sliceNode]) {
      const schema = buildActionSchema(node);
      expect(schema.required).toEqual(["stopReason"]);
    }
  });

  it("stopReason 是 enum（6 个值）", () => {
    const schema = buildActionSchema(waveNode);
    expect(schema.properties.stopReason.enum).toEqual([
      "progressive-done",
      "action-done",
      "gate-failed",
      "crosslayer-descend",
      "closed",
      "cannot-proceed",
    ]);
  });

  it("含 actionsExecuted / crossLayer / failedReason 属性", () => {
    const schema = buildActionSchema(waveNode);
    expect(schema.properties.actionsExecuted).toBeDefined();
    expect(schema.properties.crossLayer).toBeDefined();
    expect(schema.properties.failedReason).toBeDefined();
  });

  it("不含旧字段 done/lastStatus/replanTriggered/abortedChildren/children", () => {
    const schema = buildActionSchema(waveNode);
    expect(schema.properties.done).toBeUndefined();
    expect(schema.properties.lastStatus).toBeUndefined();
    expect(schema.properties.replanTriggered).toBeUndefined();
    expect(schema.properties.abortedChildren).toBeUndefined();
    expect(schema.properties.children).toBeUndefined();
  });

  it("统一 schema——不再区分 wave/planning", () => {
    const waveSchema = buildActionSchema(waveNode);
    const sliceSchema = buildActionSchema(sliceNode);
    expect(sliceSchema).toEqual(waveSchema);
  });
});

// ── buildActionPrompt ───────────────────────────────────────────────

describe("buildActionPrompt", () => {
  const waveNode = { unitId: "wave:test-wave", scope: "wave", nextAction: "execute" };
  const sliceNode = { unitId: "slice:test-slice", scope: "slice", nextAction: "clarify" };

  it("含 node.unitId", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("wave:test-wave");
  });

  it("含 design-review 跑完必须停语义", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("design-review");
    expect(prompt.toLowerCase()).toMatch(/停|stop/);
  });

  it("含读 ActionResult.nextAction 推进指令", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("ActionResult.nextAction");
  });

  it("含不要重新调 cw handoff 防死循环警告", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("handoff");
    expect(prompt).toMatch(/死循环|幂等/);
  });

  it("含 gate fail 重试引导（3 次上限 + 具体操作）", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("gate fail");
    expect(prompt).toContain("3 次");
    expect(prompt).toContain("ok"); // 教 agent 读 cw 返回的 ok 字段
    expect(prompt).toContain("input"); // 教 agent 修 input 文件
  });

  it("含 replan 合法性说明（design-reviewed 起可用）", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("replan");
    expect(prompt).toContain("design-reviewed");
    // cw 语义：replan 是合法旁路 action，不构成死路（MF-2 修复）
    expect(prompt).not.toContain("死路");
    expect(prompt).toMatch(/guard|illegal_transition/);
  });

  it("含禁止 spawn subagent 约束（P0-1 修复）", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("subagent");
    expect(prompt).toMatch(/禁止|不得|禁止 spawn/);
    // 确保教 agent 自己做而非委派
    expect(prompt).toContain("审查就是你这个 agent 的职责");
  });

  it("传入 node.nextAction 时 prompt 含该 action（起点说明）", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("execute");
  });

  it("wave node 不含 children 抄录引导", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).not.toContain("planning 层的 execute");
    expect(prompt).not.toContain("cw tree");
  });

  it("planning node 不含 children 抄录引导", () => {
    const prompt = buildActionPrompt(sliceNode);
    expect(prompt).not.toContain("planning 层的 execute");
    expect(prompt).not.toContain("cw tree");
    expect(prompt).not.toContain("crossLayer.descend");
  });

  it("含 test 测试文件产出引导（wave 层）", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("vitest");
    expect(prompt).toContain("测试文件");
  });

  it("含 execute commitHash 引导（wave 层）", () => {
    const prompt = buildActionPrompt(waveNode);
    expect(prompt).toContain("commitHash");
  });

  it("planning node 不含 wave 层 test/execute 提示", () => {
    const prompt = buildActionPrompt(sliceNode);
    expect(prompt).not.toContain("vitest");
    expect(prompt).not.toContain("测试文件");
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

// ── detectStuckNodes replan 判定 ────────────────────

describe("detectStuckNodes replan 判定", () => {
  it("lastStatusHistoryAction=replan + status=design-reviewed → 不 abort，重置 nodeRounds", () => {
    const actionable = [{ unitId: "a", status: "design-reviewed", lastStatusHistoryAction: "replan" }];
    const prevStatus: Record<string, string> = {};
    const nodeRounds: Record<string, number> = {};
    const stuck = detectStuckNodes(actionable, prevStatus, nodeRounds);
    expect(stuck).toHaveLength(0);
    expect(nodeRounds["a"]).toBe(0); // 放行并重置熔断计数
    expect(prevStatus["a"]).toBe("design-reviewed"); // 基线更新
  });

  it("lastStatusHistoryAction=replan + status=executing → 不 abort（wave replan.from 合法）", () => {
    const actionable = [{ unitId: "a", status: "executing", lastStatusHistoryAction: "replan" }];
    const stuck = detectStuckNodes(actionable, {}, {});
    expect(stuck).toHaveLength(0);
  });

  it("lastStatusHistoryAction=replan + status=testing → 不 abort（wave replan.from 合法）", () => {
    const actionable = [{ unitId: "a", status: "testing", lastStatusHistoryAction: "replan" }];
    const stuck = detectStuckNodes(actionable, {}, {});
    expect(stuck).toHaveLength(0);
  });

  it("lastStatusHistoryAction=replan + status=tested → 不 abort（wave replan.from 合法）", () => {
    const actionable = [{ unitId: "a", status: "tested", lastStatusHistoryAction: "replan" }];
    const stuck = detectStuckNodes(actionable, {}, {});
    expect(stuck).toHaveLength(0);
  });

  it("lastStatusHistoryAction=replan + status=exec-reviewed → 不 abort（wave replan.from 合法）", () => {
    const actionable = [{ unitId: "a", status: "exec-reviewed", lastStatusHistoryAction: "replan" }];
    const stuck = detectStuckNodes(actionable, {}, {});
    expect(stuck).toHaveLength(0);
  });

  it("lastStatusHistoryAction=replan + status=retrospected → 不 abort（wave replan.from 合法）", () => {
    const actionable = [{ unitId: "a", status: "retrospected", lastStatusHistoryAction: "replan" }];
    const stuck = detectStuckNodes(actionable, {}, {});
    expect(stuck).toHaveLength(0);
  });

  it("replan 重置已累积的 nodeRounds（replan 是活动信号，不算 stuck）", () => {
    const actionable = [{ unitId: "a", status: "executing", lastStatusHistoryAction: "replan" }];
    const prevStatus: Record<string, string> = { a: "executing" };
    const nodeRounds: Record<string, number> = { a: 2 }; // 之前已累积 2 轮未推进
    const stuck = detectStuckNodes(actionable, prevStatus, nodeRounds);
    expect(stuck).toHaveLength(0);
    expect(nodeRounds["a"]).toBe(0); // replan 轮重置计数，后续轮重新累计
  });

  it("lastStatusHistoryAction 非 replan（如 clarify）→ 走原有 status 未推进逻辑", () => {
    const actionable = [{ unitId: "a", status: "clarifying", lastStatusHistoryAction: "clarify" }];
    const prevStatus = { a: "clarifying" };
    const nodeRounds: Record<string, number> = { a: MAX_NODE_ROUNDS - 1 };
    const stuck = detectStuckNodes(actionable, prevStatus, nodeRounds);
    expect(stuck).toEqual(["a"]); // 原有熔断触发
  });

  it("无 lastStatusHistoryAction 字段 → 走原有逻辑（向后兼容）", () => {
    const actionable = [{ unitId: "a", status: "planning" }];
    const prevStatus = { a: "clarifying" };
    const nodeRounds: Record<string, number> = { a: 2 };
    detectStuckNodes(actionable, prevStatus, nodeRounds);
    expect(nodeRounds["a"]).toBe(0); // status 变了重置
  });

  it("replan 仅豁免首轮——连续 replan 轮（agent replan 后卡死）按未推进累计", () => {
    const node = { unitId: "a", status: "executing", lastStatusHistoryAction: "replan" };
    const prevStatus: Record<string, string> = {};
    const nodeRounds: Record<string, number> = {};
    const replanArm: Record<string, boolean> = {};

    // 第 1 轮：replan 刚发生 → 放行 + arm
    detectStuckNodes([node], prevStatus, nodeRounds, replanArm);
    expect(nodeRounds["a"]).toBe(0);
    expect(replanArm["a"]).toBe(true);

    // 第 2 轮：replan 条目残留（无新 action）→ 不再豁免，累计 1
    detectStuckNodes([node], prevStatus, nodeRounds, replanArm);
    expect(nodeRounds["a"]).toBe(1);

    // 第 3 轮：继续残留 → 累计 2
    detectStuckNodes([node], prevStatus, nodeRounds, replanArm);
    expect(nodeRounds["a"]).toBe(2);
  });

  it("replan 卡死到 MAX_NODE_ROUNDS → 触发 abort（熔断不再被永久豁免）", () => {
    const node = { unitId: "a", status: "executing", lastStatusHistoryAction: "replan" };
    const prevStatus: Record<string, string> = {};
    const nodeRounds: Record<string, number> = {};
    const replanArm: Record<string, boolean> = {};

    // 首轮 replan 放行 + arm；之后连续 replan 轮累计到阈值 → abort
    detectStuckNodes([node], prevStatus, nodeRounds, replanArm);
    for (let i = 0; i < MAX_NODE_ROUNDS - 1; i++) {
      detectStuckNodes([node], prevStatus, nodeRounds, replanArm);
    }
    expect(nodeRounds["a"]).toBe(MAX_NODE_ROUNDS - 1);
    const stuck = detectStuckNodes([node], prevStatus, nodeRounds, replanArm);
    expect(stuck).toEqual(["a"]);
  });

  it("replan 后 agent 产生新 action（非 replan 轮）→ 解除 arm，后续 replan 再次放行", () => {
    const replanNode = { unitId: "a", status: "executing", lastStatusHistoryAction: "replan" };
    const actedNode = { unitId: "a", status: "executing", lastStatusHistoryAction: "execute" };
    const prevStatus: Record<string, string> = {};
    const nodeRounds: Record<string, number> = {};
    const replanArm: Record<string, boolean> = {};

    // replan 轮 → 放行 + arm
    detectStuckNodes([replanNode], prevStatus, nodeRounds, replanArm);
    expect(replanArm["a"]).toBe(true);

    // 非 replan 轮（agent 执行了 execute，但 status 未变）→ 解除 arm，按未推进累计 1
    detectStuckNodes([actedNode], prevStatus, nodeRounds, replanArm);
    expect(replanArm["a"]).toBe(false);
    expect(nodeRounds["a"]).toBe(1);

    // 再次 replan（新一轮 replan）→ arm 已解除，重新放行并归零
    detectStuckNodes([replanNode], prevStatus, nodeRounds, replanArm);
    expect(nodeRounds["a"]).toBe(0);
    expect(replanArm["a"]).toBe(true);
  });

  it("replan 轮 status 变化（armed 时 prev 与当前不同）→ 归零不 abort", () => {
    const prevStatus: Record<string, string> = { a: "executing" };
    const nodeRounds: Record<string, number> = { a: 0 };
    const replanArm: Record<string, boolean> = { a: true };
    const stuck = detectStuckNodes(
      [{ unitId: "a", status: "testing", lastStatusHistoryAction: "replan" }],
      prevStatus,
      nodeRounds,
      replanArm
    );
    expect(stuck).toHaveLength(0);
    expect(nodeRounds["a"]).toBe(0);
    expect(prevStatus["a"]).toBe("testing");
  });
});

// ── pruneTerminalEntries（终态节点 entry 清理） ─────────────────────

describe("pruneTerminalEntries", () => {
  it("清理本轮不在 frontier 的节点 entry", () => {
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

  it("本轮仍在 frontier 的节点保留", () => {
    const prevStatus: Record<string, string> = { a: "closed" };
    const nodeRounds: Record<string, number> = { a: 0 };
    const pruned = pruneTerminalEntries(prevStatus, nodeRounds, ["a"]);
    expect(pruned).toEqual([]);
    expect(prevStatus).toEqual({ a: "closed" });
  });

  it("本轮不在 frontier 即清理（queryFrontier 失败时主循环 continue 不调本函数，无抖动漏报）", () => {
    // prevStatus 只由 detectStuckNodes 从 frontier（非终态）节点写入，不含终态值；
    // 不在本轮 frontier ⟹ 已退出调度，直接清理（MF-1：不再按 status 判定）
    const prevStatus: Record<string, string> = { a: "executing" };
    const nodeRounds: Record<string, number> = { a: 1 };
    const pruned = pruneTerminalEntries(prevStatus, nodeRounds, []);
    expect(pruned).toEqual(["a"]);
    expect(prevStatus).toEqual({});
    expect(nodeRounds).toEqual({});
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

  it("replanArm 标记随终态节点一并清理", () => {
    const prevStatus: Record<string, string> = { a: "aborted" };
    const nodeRounds: Record<string, number> = { a: 5 };
    const replanArm: Record<string, boolean> = { a: true };
    const pruned = pruneTerminalEntries(prevStatus, nodeRounds, [], replanArm);
    expect(pruned).toEqual(["a"]);
    expect(replanArm).toEqual({});
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
