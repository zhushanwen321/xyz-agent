// src/execution/engine/engines/pi/__tests__/spawn-opts-direct.test.ts
//
// [D6 任务形状合流 / 实施期门⑤ ⛔ 硬门产物] pi 边界一次直出映射
// （agentCallToExecuteOptions：AgentCallOpts → ExecuteOptions）的字段完整性对照表
// 与逐字段断言。本文件取代已删除的两个往返保真测试：
//   - execution/__tests__/execute-options-mapper.test.ts（mapToExecuteOptions，18 用例）
//   - engines/pi/__tests__/task-spec-mapper.test.ts（spec 往返保真，12 用例）
//
// ════════════════════════════════════════════════════════════════════════
// 字段完整性对照表（从两个被删 mapper 的现有测试提取字段全集，逐字段核对）
// ════════════════════════════════════════════════════════════════════════
//
// 合流前链路（三形态两映射）：
//   AgentCallOpts --mapToExecuteOptions--> ExecuteOptions
//     --executeOptionsToTaskSpec--> AgentTaskSpec --taskSpecToExecuteOptions--> ExecuteOptions
// 合流后（单一形状一次直出）：
//   AgentCallOpts --agentCallToExecuteOptions--> ExecuteOptions
//
// ┌────────────────────┬──────────────────────────────────────┬────────────────────────────────────┬──────────────┐
// │ ExecuteOptions 字段 │ 合流前（两级链的合成语义）             │ 合流后（一次直出）                   │ 断言用例      │
// ├────────────────────┼──────────────────────────────────────┼────────────────────────────────────┼──────────────┤
// │ task               │ prompt→opts.task→spec.task（恒等往返）│ prompt 直取                          │ D-01         │
// │ slug               │ description??agent??"workflow-agent"  │ 同规则内联（截断 SLUG_MAX_LENGTH=35）│ D-02..D-05   │
// │                    │ 截断（mapToExecuteOptions）            │                                      │              │
// │ agent              │ spec.agent ?? persona.agentRef        │ agent 直取（agentRef 无写入方，裁撤） │ D-06         │
// │ model              │ 透传（显式 override，不与 ctxModel 混）│ 同                                   │ D-07         │
// │ thinkingLevel      │ spec.effort 恒等映射回                 │ thinkingLevel 直取（恒等层删除）      │ D-08         │
// │ skillPath          │ persona.skillPath 收拢/还原（恒等）    │ skillPath 直取（平铺保留）           │ D-09         │
// │ appendSystemPrompt │ persona.appendSystemPrompt 收拢/还原   │ appendSystemPrompt 直取              │ D-10         │
// │ schema             │ 透传                                  │ 同                                   │ D-11         │
// │ schemaEnv          │ spec.schema 派生优先（stringifyCached  │ schema 派生优先；无 schema 时         │ D-12..D-14   │
// │                    │ compact，与 resolver 同函数同缓存）+   │ schemaEnv 兜底（原 ctx.schemaEnv      │              │
// │                    │ ctx.schemaEnv 兜底（源 = opts.schemaEnv）│ 通道的合流等价）；均无 → undefined   │              │
// │ maxTurns           │ 透传（预算语义：undefined = 不限）      │ 同                                   │ D-15         │
// │ graceTurns         │ 透传（spec 字段）                      │ 同（合流形状可选字段）                │ D-16         │
// │ ctxModel           │ RunContext.ctxModel 回填               │ 第 2 参直取（运行期件，不入声明）     │ D-17         │
// │ fork               │ 透传                                  │ 同                                   │ D-18         │
// │ worktree           │ 透传（boolean | WorktreeHandle 三态）  │ 同                                   │ D-19         │
// │ cwd                │ 透传                                  │ 同                                   │ D-20         │
// │ conversation       │ 透传（interact 控制面 task 标志）      │ 同                                   │ D-21         │
// │ idleTimeoutMs      │ 透传（同上）                           │ 同                                   │ D-22         │
// │ engine/engineFallback│ PiEngine.run 调用方追加（D9① 留痕）  │ 同（不在本函数，pi-engine.test 覆盖） │ pi-engine.test│
// │ signal/onComplete  │ 不入 opts（port 设计删字段去向）       │ 同（RunContext/编排侧各归其位）       │ D-23         │
// └────────────────────┴──────────────────────────────────────┴────────────────────────────────────┴──────────────┘
//
// 调用方扩展字段（引擎不消费，不入 spawn 参数）：scene / timeoutMs（SAR mergeTimeoutSignal
// 合并进 signal）/ skill（resolver 解析为 skillPath）/ engine（SAR 路由层）/ returnMeta
// （worker 层）——不入本映射即正确（D-24 断言不泄漏）。
// 已裁撤字段（D6 登记于 AgentCallOpts 类型注释）：persona.agentRef、requires。
//
// 全字段直出快照断言（D-00）+ 逐字段用例双保险：快照锁全集、用例锁语义边界。

import { describe, expect, it } from "vitest";

import type { AgentCallOpts } from "../../../../../orchestration/models/types.ts";
import { SLUG_MAX_LENGTH } from "../../../../../orchestration/models/types.ts";
import type { ModelInfo } from "../../../../model-resolver.ts";
import type { ExecuteOptions } from "../../../../types.ts";
import { agentCallToExecuteOptions } from "../pi-engine.ts";

/** 全字段样例（覆盖对照表全部直出映射点）。 */
function makeFullCall(): AgentCallOpts {
  return {
    prompt: "review the diff",
    description: "review-diff",
    agent: "/agents/reviewer.md",
    model: "zai-coding-cn/glm-5.2",
    thinkingLevel: "high",
    skillPath: "/skills/code-review/SKILL.md",
    appendSystemPrompt: ["extra system prompt line"],
    schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
    maxTurns: 20,
    graceTurns: 3,
    fork: true,
    worktree: true,
    cwd: "/repo/worktree-x",
    conversation: true,
    idleTimeoutMs: 600_000,
  };
}

describe("agentCallToExecuteOptions（D6 一次直出：AgentCallOpts → pi spawn 编排参数）", () => {
  it("D-00 全字段直出快照（与合流前两级链的合成结果逐字段一致——原往返保真测试的直出等价物）", () => {
    const result = agentCallToExecuteOptions(makeFullCall());
    const expected: ExecuteOptions = {
      task: "review the diff",
      slug: "review-diff",
      agent: "/agents/reviewer.md",
      model: "zai-coding-cn/glm-5.2",
      thinkingLevel: "high",
      skillPath: "/skills/code-review/SKILL.md",
      appendSystemPrompt: ["extra system prompt line"],
      schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
      schemaEnv: JSON.stringify({ type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] }),
      maxTurns: 20,
      graceTurns: 3,
      ctxModel: undefined,
      fork: true,
      worktree: true,
      cwd: "/repo/worktree-x",
      conversation: true,
      idleTimeoutMs: 600_000,
    };
    expect(result).toEqual(expected);
  });

  // ── task / slug（D-01..D-05）──

  it("D-01 prompt → task", () => {
    expect(agentCallToExecuteOptions({ prompt: "do the thing" }).task).toBe("do the thing");
  });

  it("D-02 description → slug", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", description: "fix-login" }).slug).toBe("fix-login");
  });

  it("D-03 description 缺失 → 回落 agent 名（保证 slug 非空）", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", agent: "worker" }).slug).toBe("worker");
  });

  it("D-04 description 与 agent 均缺失 → 回落 'workflow-agent'", () => {
    expect(agentCallToExecuteOptions({ prompt: "t" }).slug).toBe("workflow-agent");
  });

  it("D-05 slug 截断：description > SLUG_MAX_LENGTH(35) 截到 35；= 35 不截（边界）", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", description: "a".repeat(36) }).slug).toBe("a".repeat(35));
    expect(agentCallToExecuteOptions({ prompt: "t", description: "a".repeat(35) }).slug).toBe("a".repeat(35));
    expect(SLUG_MAX_LENGTH).toBe(35);
  });

  // ── 身份 / 模型 / 推理档位（D-06..D-08）──

  it("D-06 agent 直取（原 persona.agentRef 兜底随 PersonaSpec 裁撤——无生产写入方）", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", agent: "/a.md" }).agent).toBe("/a.md");
    expect(agentCallToExecuteOptions({ prompt: "t" }).agent).toBeUndefined();
  });

  it("D-07 model：显式 override 透传；缺省 undefined（不与 ctxModel 混合）", () => {
    const ctxModel: ModelInfo = { id: "ctx-model", provider: "test", input: [] } as ModelInfo;
    expect(agentCallToExecuteOptions({ prompt: "t", model: "explicit-model" }, ctxModel).model).toBe("explicit-model");
    expect(agentCallToExecuteOptions({ prompt: "t" }, ctxModel).model).toBeUndefined();
  });

  it("D-08 thinkingLevel 直取（原 effort 恒等映射层删除，含 7 档外的缺省）", () => {
    for (const level of ["off", "low", "medium", "high", "max", undefined]) {
      expect(agentCallToExecuteOptions({ prompt: "t", thinkingLevel: level }).thinkingLevel).toBe(level);
    }
  });

  // ── persona 平铺字段（D-09..D-10）──

  it("D-09 skillPath 直取（原 persona 收拢/还原恒等）", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", skillPath: "/s" }).skillPath).toBe("/s");
    expect(agentCallToExecuteOptions({ prompt: "t" }).skillPath).toBeUndefined();
  });

  it("D-10 appendSystemPrompt 直取（含空数组归一语义：空数组保持空数组——下游 spread no-op 等价）", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", appendSystemPrompt: ["l1", "l2"] }).appendSystemPrompt).toEqual(["l1", "l2"]);
    expect(agentCallToExecuteOptions({ prompt: "t", appendSystemPrompt: [] }).appendSystemPrompt).toEqual([]);
    expect(agentCallToExecuteOptions({ prompt: "t" }).appendSystemPrompt).toBeUndefined();
  });

  // ── schema / schemaEnv（D-11..D-14）──

  it("D-11 schema 透传为原始对象引用", () => {
    const schema = { type: "object" };
    expect(agentCallToExecuteOptions({ prompt: "t", schema }).schema).toBe(schema);
  });

  it("D-12 schemaEnv 派生：与 agent-opts-resolver 同函数（stringifySchemaCached compact），逐字节等值", () => {
    const schema = { type: "object", properties: { a: { type: "number" } } };
    expect(agentCallToExecuteOptions({ prompt: "t", schema }).schemaEnv).toBe(JSON.stringify(schema));
  });

  it("D-13 派生优先：schema 存在时 opts.schemaEnv（stale 值）被忽略", () => {
    const schema = { type: "object" };
    expect(agentCallToExecuteOptions({ prompt: "t", schema, schemaEnv: "STALE" }).schemaEnv).toBe(JSON.stringify(schema));
  });

  it("D-14 schemaEnv 兜底/缺省：无 schema 时用 opts.schemaEnv（解耦形态，原 ctx 兜底通道等价）；均无 → undefined（BC-6：childEnv 不注入）", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", schemaEnv: '{"type":"object"}' }).schemaEnv).toBe('{"type":"object"}');
    expect(agentCallToExecuteOptions({ prompt: "t" }).schemaEnv).toBeUndefined();
  });

  // ── 轮数 / 运行期 / 隔离（D-15..D-20）──

  it("D-15 maxTurns 透传（undefined = 不限，不挂 turns 估算 watchdog）", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", maxTurns: 20 }).maxTurns).toBe(20);
    expect(agentCallToExecuteOptions({ prompt: "t" }).maxTurns).toBeUndefined();
  });

  it("D-16 graceTurns 透传（合流形状可选字段，chat 域经 host-task-spec 填充）", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", graceTurns: 3 }).graceTurns).toBe(3);
    expect(agentCallToExecuteOptions({ prompt: "t" }).graceTurns).toBeUndefined();
  });

  it("D-17 ctxModel 从第 2 参回填（运行期件不入任务声明——D-008 兼底链路）", () => {
    const ctxModel: ModelInfo = { id: "mimo-v2.5-pro", provider: "router-openai", input: [] } as ModelInfo;
    expect(agentCallToExecuteOptions({ prompt: "t" }, ctxModel).ctxModel).toBe(ctxModel);
    expect(agentCallToExecuteOptions({ prompt: "t" }).ctxModel).toBeUndefined();
  });

  it("D-18 fork 透传", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", fork: true }).fork).toBe(true);
  });

  it("D-19 worktree 三态（true/false/WorktreeHandle）直出保持", () => {
    const handle = { path: "/wt", branch: "b", baseCommit: "c", mainCwd: "/repo" };
    for (const wt of [true, false, handle] as const) {
      expect(agentCallToExecuteOptions({ prompt: "t", worktree: wt }).worktree).toBe(wt);
    }
  });

  it("D-20 cwd 透传", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", cwd: "/work" }).cwd).toBe("/work");
  });

  // ── 交互控制面（D-21..D-22）──

  it("D-21 conversation 透传（interact 控制面的 task 标志）", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", conversation: true }).conversation).toBe(true);
  });

  it("D-22 idleTimeoutMs 透传", () => {
    expect(agentCallToExecuteOptions({ prompt: "t", idleTimeoutMs: 12345 }).idleTimeoutMs).toBe(12345);
  });

  // ── 声明边界（D-23..D-24）──

  it("D-23 运行期字段不入直出产物：signal/onComplete/engine/engineFallback 不由本函数产出（engine 由 run 调用方追加）", () => {
    const result = agentCallToExecuteOptions(makeFullCall()) as Record<string, unknown>;
    expect("signal" in result).toBe(false);
    expect("onComplete" in result).toBe(false);
    expect("engine" in result).toBe(false);
    expect("engineFallback" in result).toBe(false);
  });

  it("D-24 调用方扩展字段不泄漏进 spawn 参数：scene/timeoutMs/skill/engine/returnMeta/denyTools/permissionMode", () => {
    const result = agentCallToExecuteOptions({
      prompt: "t",
      scene: "coding",
      timeoutMs: 5000,
      skill: "code-review",
      engine: "pi",
      returnMeta: true,
      denyTools: ["bash"],
      permissionMode: "yolo",
    }) as Record<string, unknown>;
    expect("scene" in result).toBe(false);
    expect("timeoutMs" in result).toBe(false);
    expect("skill" in result).toBe(false);
    expect("engine" in result).toBe(false);
    expect("returnMeta" in result).toBe(false);
    expect("denyTools" in result).toBe(false);
    expect("permissionMode" in result).toBe(false);
  });
});
