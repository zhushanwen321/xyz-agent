// src/execution/engine/engines/pi/__tests__/task-spec-mapper.test.ts
//
// AgentTaskSpec ↔ ExecuteOptions 映射测试（P1 验收 3：往返保真）。
// 覆盖：effort/thinkingLevel 双向映射、persona/skillPath 归并还原、
// conversation/idleTimeoutMs 透传、schemaEnv 派生逐字节等值（D-A6 bridge）、
// 运行期字段（signal/ctxModel/onComplete）不入任务声明。

import { describe, expect, it } from "vitest";

import type { ExecuteOptions } from "../../../../types.ts";
import type { AgentTaskSpec } from "../../../types.ts";
import { executeOptionsToTaskSpec, taskSpecToExecuteOptions } from "../task-spec-mapper.ts";

describe("task-spec-mapper（ExecuteOptions ↔ AgentTaskSpec 往返保真）", () => {
  /** 全字段样例（含全部泛化点）。 */
  function makeFullOpts(): ExecuteOptions {
    return {
      task: "review the diff",
      slug: "review-diff",
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

  it("全字段往返恒等（P1 行为零变化的映射层证据）", () => {
    const opts = makeFullOpts();
    const round = taskSpecToExecuteOptions(executeOptionsToTaskSpec(opts));
    // schemaEnv 是派生字段（派生正确性单独断言），其余逐字段恒等
    const { schemaEnv, ...rest } = round;
    expect(rest).toEqual(opts);
    expect(schemaEnv).toBe(JSON.stringify(opts.schema));
  });

  it("effort ↔ thinkingLevel 双向映射（pi 恒等透传，含 7 档外的缺省）", () => {
    for (const level of ["off", "low", "medium", "high", "max", undefined]) {
      const opts: ExecuteOptions = { task: "t", slug: "s", thinkingLevel: level };
      const spec = executeOptionsToTaskSpec(opts);
      expect(spec.effort).toBe(level);
      expect(taskSpecToExecuteOptions(spec).thinkingLevel).toBe(level);
    }
  });

  it("persona 归并：skillPath + appendSystemPrompt 收拢进 persona", () => {
    const spec = executeOptionsToTaskSpec({
      task: "t",
      slug: "s",
      skillPath: "/skills/x/SKILL.md",
      appendSystemPrompt: ["line1", "line2"],
    });
    expect(spec.persona).toEqual({ skillPath: "/skills/x/SKILL.md", appendSystemPrompt: ["line1", "line2"] });
    // 还原
    const back = taskSpecToExecuteOptions(spec);
    expect(back.skillPath).toBe("/skills/x/SKILL.md");
    expect(back.appendSystemPrompt).toEqual(["line1", "line2"]);
  });

  it("persona 缺省：无 skillPath/appendSystemPrompt 时 persona 不存在（无空对象噪声）", () => {
    const spec = executeOptionsToTaskSpec({ task: "t", slug: "s" });
    expect(spec.persona).toBeUndefined();
    expect(taskSpecToExecuteOptions(spec).skillPath).toBeUndefined();
    expect(taskSpecToExecuteOptions(spec).appendSystemPrompt).toBeUndefined();
  });

  it("persona 单字段归并：仅 skillPath（appendSystemPrompt 保持 undefined）", () => {
    const spec = executeOptionsToTaskSpec({ task: "t", slug: "s", skillPath: "/s" });
    expect(spec.persona).toEqual({ skillPath: "/s" });
    const back = taskSpecToExecuteOptions(spec);
    expect(back.skillPath).toBe("/s");
    expect(back.appendSystemPrompt).toBeUndefined();
  });

  it("conversation / idleTimeoutMs 原名透传（interact 控制面的 task 标志）", () => {
    const opts: ExecuteOptions = { task: "t", slug: "s", conversation: true, idleTimeoutMs: 12345 };
    const spec = executeOptionsToTaskSpec(opts);
    expect(spec.conversation).toBe(true);
    expect(spec.idleTimeoutMs).toBe(12345);
    const back = taskSpecToExecuteOptions(spec);
    expect(back.conversation).toBe(true);
    expect(back.idleTimeoutMs).toBe(12345);
  });

  it("schemaEnv 派生：与 agent-opts-resolver 同函数（stringifySchemaCached compact），逐字节等值", () => {
    const schema = { type: "object", properties: { a: { type: "number" } } };
    const spec = executeOptionsToTaskSpec({ task: "t", slug: "s", schema });
    // 无 schema 时 schemaEnv 不设（BC-6：childEnv 不注入）
    expect(taskSpecToExecuteOptions({ task: "t", slug: "s" }).schemaEnv).toBeUndefined();
    // 有 schema 时派生 = JSON.stringify(schema)（resolver 的 compact 形态）
    expect(taskSpecToExecuteOptions(spec).schemaEnv).toBe(JSON.stringify(schema));
    // 原 schemaEnv（resolver 产物）经往返后逐字节保持
    const optsWithEnv: ExecuteOptions = {
      task: "t",
      slug: "s",
      schema,
      schemaEnv: JSON.stringify(schema),
    };
    const round = taskSpecToExecuteOptions(executeOptionsToTaskSpec(optsWithEnv));
    expect(round.schemaEnv).toBe(optsWithEnv.schemaEnv);
  });

  it("解耦形态（有 schemaEnv 无 schema，生产不可达）：经 RunContext 兜底透传，派生优先", () => {
    const spec = executeOptionsToTaskSpec({ task: "t", slug: "s", schemaEnv: '{"type":"object"}' });
    // 声明侧无 schema（schemaEnv 不入任务声明，§3.3.5 删字段去向）
    expect(spec.schema).toBeUndefined();
    // 兜底通道（RunContext.schemaEnv → mapper schemaEnvFallback）
    const back = taskSpecToExecuteOptions(spec, { schemaEnvFallback: '{"type":"object"}' });
    expect(back.schemaEnv).toBe('{"type":"object"}');
    // 派生优先：schema 存在时 fallback 被忽略（派生值 = JSON.stringify(schema)）
    const coupled = { ...spec, schema: { type: "object" } };
    expect(taskSpecToExecuteOptions(coupled, { schemaEnvFallback: "STALE" }).schemaEnv).toBe('{"type":"object"}');
  });

  it("运行期字段不入任务声明：signal/ctxModel/onComplete 从 ExecuteOptions 剥离（移入 RunContext）", () => {
    const ctxModel = { id: "m", name: "Test Model", provider: "p", reasoning: false };
    const opts: ExecuteOptions = {
      task: "t",
      slug: "s",
      ctxModel,
      onComplete: () => {},
    };
    const spec = executeOptionsToTaskSpec(opts);
    expect("ctxModel" in spec).toBe(false);
    expect("onComplete" in spec).toBe(false);
    expect("signal" in spec).toBe(false);
    // ctxModel 从 RunContext 回填（SAR 接线的 D-008 兼底链路）
    expect(taskSpecToExecuteOptions(spec, { ctxModel }).ctxModel).toBe(ctxModel);
    expect(taskSpecToExecuteOptions(spec).ctxModel).toBeUndefined();
  });

  it("中立新字段 denyTools/permissionMode：pi 侧映射回 ExecuteOptions 时忽略（无对应面）", () => {
    const spec: AgentTaskSpec = { task: "t", slug: "s", denyTools: ["bash"], permissionMode: "yolo" };
    const opts = taskSpecToExecuteOptions(spec);
    expect("denyTools" in opts).toBe(false);
    expect("permissionMode" in opts).toBe(false);
    // 声明侧字段保真（不因 pi 不支持而丢弃——P2 公共层消费）
    expect(spec.denyTools).toEqual(["bash"]);
    expect(spec.permissionMode).toBe("yolo");
  });

  it("归一化：appendSystemPrompt: [] 与 undefined 往返后等价（下游 spread 空数组为 no-op）", () => {
    const spec = executeOptionsToTaskSpec({ task: "t", slug: "s", appendSystemPrompt: [] });
    expect(spec.persona).toEqual({ appendSystemPrompt: [] });
    const back = taskSpecToExecuteOptions(spec);
    expect(back.appendSystemPrompt).toEqual([]);
  });

  it("worktree 三态（true/false/handle）往返保持", () => {
    const handle = { path: "/wt", branch: "b", baseCommit: "c", mainCwd: "/repo" };
    for (const wt of [true, false, handle] as const) {
      const opts: ExecuteOptions = { task: "t", slug: "s", worktree: wt };
      expect(taskSpecToExecuteOptions(executeOptionsToTaskSpec(opts)).worktree).toBe(wt);
    }
  });
});
