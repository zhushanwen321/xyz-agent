// agent-opts-resolver schema prompt wording lock (suggestion #4).
//
// M2 修正后 resolveAgentOpts 把 schema structured-output 指令内容直传进
// appendSystemPrompt（不再写临时文件、不再 push 路径）。本测试锁死 SO 指令措辞 +
// 验证 agent 正文不经此通道（防双重注入回归）。
//
// 覆盖 design.json TC1（措辞）/ TC2（无 schema）/ TC3（不处理 agent ref）。

import { describe, expect, it } from "vitest";

import type { AgentCallOpts } from "../orchestration/models/types.ts";
import { resolveAgentOpts } from "../orchestration/agent-opts-resolver.ts";

describe("resolveAgentOpts schema prompt wording + M2 content passthrough", () => {
  it("schema 提供时 appendSystemPrompt 含 SO 指令内容（TC1 措辞锁）", () => {
    const opts: AgentCallOpts = {
      prompt: "do the thing",
      schema: { type: "object" },
      agent: "/abs/path/worker.md",
    };
    const result = resolveAgentOpts(opts);

    expect(result.error).toBeUndefined();
    expect(result.opts.appendSystemPrompt).toBeDefined();
    expect(result.opts.appendSystemPrompt!.length).toBe(1);

    const content = result.opts.appendSystemPrompt![0];
    // 措辞锁（suggestion #4）：LLM 只传 data、不传 schema 参数
    expect(content).toContain("ONLY the `data` parameter");
    expect(content).toContain("do NOT pass a `schema` parameter");
    expect(content).toContain("schema is enforced by the system");
    // 内容直传（M2 fix）：非路径
    expect(content).not.toMatch(/\/tmp\/|\/var\/folders\//);
    expect(content).not.toMatch(/\.md$/);
  });

  it("无 schema 无 skill 时 appendSystemPrompt undefined（TC2）", () => {
    const opts: AgentCallOpts = {
      prompt: "x",
      agent: "/abs/path/worker.md",
      description: "test",
      slug: "test",
    };
    const result = resolveAgentOpts(opts);

    expect(result.error).toBeUndefined();
    expect(result.opts.appendSystemPrompt).toBeUndefined();
    // agent ref 原样保留（交 resolveIdentity 处理）
    expect(result.opts.agent).toBe("/abs/path/worker.md");
  });

  it("resolveAgentOpts 不处理 agent ref——不存在路径不报错（TC3）", () => {
    const opts: AgentCallOpts = {
      prompt: "x",
      agent: "/nonexistent/agent.md",
    };
    const result = resolveAgentOpts(opts);

    // resolveAgentOpts 不校验 agent 路径（已移交 resolveIdentity）
    expect(result.error).toBeUndefined();
    expect(result.opts.agent).toBe("/nonexistent/agent.md");
    // model/thinkingLevel 不被 resolveAgentOpts 修改（agent 层级提升已消除）
    expect(result.opts.model).toBeUndefined();
    expect(result.opts.thinkingLevel).toBeUndefined();
  });

  it("sets schemaEnv from the provided schema (PI_WORKFLOW_SCHEMA contract)", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { n: { type: "number" } },
    };
    const opts: AgentCallOpts = { prompt: "x", schema };
    const result = resolveAgentOpts(opts);

    expect(result.opts.schemaEnv).toBe(JSON.stringify(schema));
  });

  it("无 schema 时 schemaEnv undefined", () => {
    const opts: AgentCallOpts = { prompt: "x" };
    const result = resolveAgentOpts(opts);

    expect(result.opts.schemaEnv).toBeUndefined();
  });
});
