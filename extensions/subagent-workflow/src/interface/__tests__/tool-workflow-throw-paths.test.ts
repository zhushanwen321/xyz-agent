/**
 * W4b：workflow tool 错误路径 throw 语义（代表路径）。
 *
 * pi 只对 execute throw 置 isError:true——返回值里的 isError 被 agent-loop 丢弃
 * （agent-loop.js:453-483），故错误路径必须 throw。本文件抽 4 个代表路径
 * （W4b 验收交付物 3）：
 * - not_found（abort 目标 runId 不存在）
 * - reentry-busy（guard 占用，throw 前未 acquire）
 * - 平铺检测（args 子字段平铺到顶层，LLM 常见错误）
 * - slug 护栏（schema maxLength 之后的运行时第二道）
 * generate 校验族（第 5 代表路径）见 tool-workflow-script-generate.test.ts。
 *
 * 经 registerWorkflowTool 注册层测（capture tool + 最小 deps stub），
 * 与 W4 save/delete 测试同范式。框架：vitest。
 */
import { describe, expect, it, vi } from "vitest";

import { SLUG_MAX_LENGTH } from "../../execution/execute-options-mapper.ts";
import { REENTRY_BUSY_MESSAGE, type ReentryGuardRef } from "../reentry-guard.ts";
import { registerWorkflowTool } from "../tool-workflow.ts";

// ── capture helper ──

interface CapturedTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
}

function captureTool(deps: unknown, reentryRef: ReentryGuardRef): CapturedTool {
  const tools: CapturedTool[] = [];
  const pi = { registerTool: (t: unknown) => tools.push(t as CapturedTool) };
  registerWorkflowTool(pi as never, deps as never, reentryRef);
  if (!tools[0] || tools[0].name !== "workflow") {
    throw new Error("registerWorkflowTool did not register the workflow tool");
  }
  return tools[0];
}

/** 最小 LauncherDeps stub：被测路径只触 registry / runs。 */
function makeDeps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runs: new Map(),
    registry: {
      getPath: vi.fn().mockResolvedValue(undefined),
      loadAll: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

/** 平铺检测 / slug 护栏路径的 registry script stub（meta.parameters 驱动已知键集）。 */
function makeScript(parameters?: object): Record<string, unknown> {
  return {
    name: "demo-wf",
    path: "/abs/demo-wf.js",
    available: true,
    sourceCode: "// demo",
    meta: { description: "demo workflow", parameters },
    toExecutable: () => "// demo",
  };
}

// ── 代表路径 ──

describe("W4b: workflow tool 错误路径 throw 语义", () => {
  it("not_found：abort 目标 runId 不存在 → throw（pi catch 后置 isError:true）", async () => {
    const tool = captureTool(makeDeps(), { isProcessing: false });
    await expect(
      tool.execute("id", { action: "abort", runId: "no-such-run" }, undefined, undefined, {}),
    ).rejects.toThrow(
      "Workflow 'no-such-run' not found. Use action:status to list active runs and their runIds.",
    );
  });

  it("reentry-busy：guard 占用 → throw REENTRY_BUSY_MESSAGE，且 guard 状态不被污染", async () => {
    const guard: ReentryGuardRef = { isProcessing: true };
    const tool = captureTool(makeDeps(), guard);
    await expect(
      tool.execute("id", { action: "status" }, undefined, undefined, {}),
    ).rejects.toThrow(REENTRY_BUSY_MESSAGE);
    // throw 发生在 acquire 之前——占用方语义保持，不产生双重 release
    expect(guard.isProcessing).toBe(true);
  });

  it("平铺检测：args 子字段提到顶层 → throw 'Detected ... at top level'（含 Correct 正例）", async () => {
    const deps = makeDeps({
      registry: {
        getPath: vi.fn().mockResolvedValue(
          makeScript({
            type: "object",
            properties: { task: { type: "string" }, items: { type: "array" } },
            required: ["task"],
          }),
        ),
      },
    });
    const tool = captureTool(deps, { isProcessing: false });
    await expect(
      tool.execute(
        "id",
        { action: "run", name: "/abs/demo-wf.js", task: "do work" },
        undefined,
        undefined,
        {},
      ),
    ).rejects.toThrow(
      /Detected task at top level — they belong inside 'args'\. Correct: \{"action":"run","name":"\/abs\/demo-wf\.js","args":\{"task": "<value>"\}\}/,
    );
  });

  it("slug 护栏：slug 超 SLUG_MAX_LENGTH → throw 'slug exceeds ...'（运行时第二道）", async () => {
    const deps = makeDeps({
      registry: {
        getPath: vi.fn().mockResolvedValue(
          makeScript({
            type: "object",
            properties: { task: { type: "string" } },
            required: ["task"],
          }),
        ),
      },
    });
    const tool = captureTool(deps, { isProcessing: false });
    const longSlug = "a".repeat(SLUG_MAX_LENGTH + 1);
    await expect(
      tool.execute(
        "id",
        { action: "run", name: "/abs/demo-wf.js", slug: longSlug, args: {} },
        undefined,
        undefined,
        {},
      ),
    ).rejects.toThrow(
      `slug exceeds ${SLUG_MAX_LENGTH} chars (got ${longSlug.length}). Shorten to a kebab-case label, e.g. "fix-login", "extract-urls".`,
    );
  });

  it("throw 后 reentry guard 经 finally 正常释放（成功路径回归）", async () => {
    // abort not_found throw 穿透 execute try/finally：guard 必须复位，否则后续命令全部 busy
    const guard: ReentryGuardRef = { isProcessing: false };
    const tool = captureTool(makeDeps(), guard);
    await expect(
      tool.execute("id", { action: "abort", runId: "no-such-run" }, undefined, undefined, {}),
    ).rejects.toThrow(/not found/);
    expect(guard.isProcessing).toBe(false);
  });
});
