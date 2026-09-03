// src/__tests__/builtin-agents-assets.test.ts
//
// 壳包 agents/*.md 资产合规测试。u-5c 自 agent-registry.test.ts 拆出留壳：
// 被测 subject 是壳内 agents/*.md 资产（core 无 agents 资产，跨包文件系统触达
// 违反 core 闭包红线），agent-registry 解析行为的其余 describe 已迁
// packages/subagent-core/src/execution/__tests__/agent-registry.test.ts
// （设计 §2.2 C6 / §1 目标 6）。
//
// S2：内置 agent = 包内路径文件（loadByPath 直接加载，无名字查找）。

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { lintAgentMeta } from "@zhushanwen/subagent-core/orchestration/script-lint.ts";
import { parseResourceMeta } from "@zhushanwen/subagent-core";
import { AgentRegistry } from "@zhushanwen/subagent-core/execution/agent-registry.ts";

// ============================================================
// 包内 agents/*.md 数据合规（S2：内置 agent = 包内路径文件）
// ============================================================

describe("builtin agents 数据合规", () => {
  const AGENTS_DIR = path.resolve(__dirname, "../../agents");
  const CORE = ["explorer", "coder", "reviewer", "debugger", "analyst", "planner", "researcher", "orchestrator", "general-purpose", "doc-reviewer"];

  it("agents/*.md 全部 IF1 解析成功", () => {
    for (const f of fs.readdirSync(AGENTS_DIR).filter((x) => x.endsWith(".md"))) {
      const meta = parseResourceMeta(fs.readFileSync(path.join(AGENTS_DIR, f), "utf-8"), "agent");
      expect(meta?.kind, `${f} parse 失败`).toBe("agent");
    }
  });

  it("核心 agent 均含 when/notFor/examples 且正反各一（lintAgentMeta 无 finding）", () => {
    for (const name of CORE) {
      const meta = parseResourceMeta(fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), "utf-8"), "agent");
      expect(meta, `${name} 解析失败`).not.toBeNull();
      if (meta?.kind !== "agent") continue;
      expect(meta.when, `${name} 缺 when`).toBeDefined();
      expect(meta.notFor, `${name} 缺 notFor`).toBeDefined();
      expect(meta.examples?.length, `${name} 缺 examples`).toBeGreaterThanOrEqual(2);
      expect(meta.examples?.some((e) => e.positive), `${name} 缺正向样本`).toBe(true);
      expect(meta.examples?.some((e) => !e.positive), `${name} 缺反向样本`).toBe(true);
      expect(lintAgentMeta(meta), `${name} examples 不合规`).toEqual([]);
    }
  });

  it("loadByPath 直接加载包内 agent（内置 = 路径文件，无名字查找）", () => {
    const reg = new AgentRegistry();
    const coder = reg.loadByPath(path.join(AGENTS_DIR, "coder.md"));
    expect(coder?.name).toBe("coder");
    expect(coder?.systemPrompt.length).toBeGreaterThan(0);
    // tools 字段精确匹配：未声明的为 undefined，声明的为具体数组。
    // 改 frontmatter 时这里会立即报错，拦住拼写错误或字段遗漏。
    expect(reg.loadByPath(path.join(AGENTS_DIR, "explorer.md"))?.tools).toEqual(
      ["read", "bash", "grep", "find", "structured-output"],
    );
    expect(reg.loadByPath(path.join(AGENTS_DIR, "researcher.md"))?.tools).toEqual(["read", "bash"]);
    expect(reg.loadByPath(path.join(AGENTS_DIR, "orchestrator.md"))?.tools).toEqual([
      "todo", "goal_control", "workflow", "subagent", "ask_user",
    ]);
    expect(reg.loadByPath(path.join(AGENTS_DIR, "reviewer.md"))?.tools).toEqual(["read", "bash", "grep", "find", "structured-output"]);
    expect(reg.loadByPath(path.join(AGENTS_DIR, "planner.md"))?.tools).toEqual(["read", "bash", "grep", "find", "structured-output"]);
    expect(reg.loadByPath(path.join(AGENTS_DIR, "coder.md"))?.tools).toEqual(["read", "write", "edit", "bash", "grep", "find", "structured-output"]);
    expect(reg.loadByPath(path.join(AGENTS_DIR, "debugger.md"))?.tools).toEqual(["read", "write", "edit", "bash", "grep", "find", "structured-output"]);
    expect(reg.loadByPath(path.join(AGENTS_DIR, "analyst.md"))?.tools).toEqual(["read", "bash", "grep", "find", "structured-output"]);
    expect(reg.loadByPath(path.join(AGENTS_DIR, "doc-reviewer.md"))?.tools).toEqual(["read", "grep", "structured-output"]);
  });
});
