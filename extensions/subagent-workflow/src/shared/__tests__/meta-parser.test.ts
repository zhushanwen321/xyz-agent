/**
 * meta-parser 测试（v5 §11.1 / TC1-TC10 + 边界）
 *
 * [P-yaml] 探针由 TC5/TC10 承载：验证 eemeli/yaml 真实抛错对象有 linePos 字段且结构为
 * {line,col}（取自 linePos[0]）。不 mock parseYaml——必须用真实库验证此运行时断言。
 *
 * 框架：vitest（项目规范：禁 node:test，import from "vitest"）。
 */
import { describe, expect, it } from "vitest";

import {
  parseResourceMeta,
  parseResourceMetaDetailed,
} from "../meta-parser.ts";
import type { AgentMeta, WorkflowMeta } from "../resource-meta.ts";

// ── 固定 content fixtures ────────────────────────────────────

const VALID_WORKFLOW = `// 顶部可有任意代码注释
/* @pi-meta
name: chain
description: 通用编排三步链
when: 用户要顺序编排
phases: [analyze, transform, synthesize]
parameters:
  type: object
  properties:
    task: { type: string }
  required: [task]
usage: |
  ## 使用说明
  - task 必填
*/
const agent = require("./agent");
`;

const VALID_AGENT = `---
name: code-review
description: 审查代码变更
when: 用户要求 review
notFor: 非 xyz-agent 项目
examples:
  - match: "帮我 review 一下"
    action: 调用 code-review
    positive: true
  - match: 今天天气
    action: 不调用
    positive: false
tools: [read, bash, grep]
model: claude-3.5
---
# code-review agent 正文
`;

const MALFORMED_INDENT = `/* @pi-meta
name: x
  description: bad indent
phases: [a]
*/`;

const REGEX_SINGLE_BACKSLASH = `/* @pi-meta
name: rfl
description: 测试正则转义
phases: [Review, Fix]
parameters:
  type: object
  patternProperties:
    "^batch\\d+$": { type: string }
*/`;

const LEGACY_CONST_META = `const meta = {
  name: chain,
  description: 旧格式,
  phases: ["a"]
};
const agent = require("./agent");
`;

const NO_META_BLOCK = `const agent = require("./agent");
// 纯代码，无 @pi-meta
`;

const EMPTY_PI_META = `/* @pi-meta
*/
const x = 1;
`;

const EMPTY_PHASES = `/* @pi-meta
name: x
description: 空 phases
phases: []
*/`;

// ── parseResourceMeta（IF1，discovery）──────────────────────

describe("parseResourceMeta (discovery, fail-safe null)", () => {
  it("TC1: 合法 workflow @pi-meta 返 WorkflowMeta", () => {
    const meta = parseResourceMeta(VALID_WORKFLOW, "workflow");
    expect(meta).not.toBeNull();
    expect((meta as WorkflowMeta).kind).toBe("workflow");
    expect((meta as WorkflowMeta).name).toBe("chain");
    expect((meta as WorkflowMeta).phases).toEqual(["analyze", "transform", "synthesize"]);
    expect((meta as WorkflowMeta).when).toBe("用户要顺序编排");
    expect((meta as WorkflowMeta).parameters).toBeDefined();
    expect((meta as WorkflowMeta).usage).toContain("task 必填");
  });

  it("TC2: 合法 agent frontmatter 返 AgentMeta", () => {
    const meta = parseResourceMeta(VALID_AGENT, "agent");
    expect(meta).not.toBeNull();
    const a = meta as AgentMeta;
    expect(a.kind).toBe("agent");
    expect(a.name).toBe("code-review");
    expect(a.notFor).toBe("非 xyz-agent 项目");
    expect(a.examples).toHaveLength(2);
    expect(a.examples![0]).toEqual({ match: "帮我 review 一下", action: "调用 code-review", positive: true });
    expect(a.examples![1]!.positive).toBe(false);
    expect(a.tools).toEqual(["read", "bash", "grep"]);
    expect(a.model).toBe("claude-3.5");
  });

  it("TC3: malformed YAML（缩进错）返 null，不抛 [P-yaml]", () => {
    expect(() => parseResourceMeta(MALFORMED_INDENT, "workflow")).not.toThrow();
    expect(parseResourceMeta(MALFORMED_INDENT, "workflow")).toBeNull();
  });

  it("TC4: 缺 meta 块返 null", () => {
    expect(parseResourceMeta(NO_META_BLOCK, "workflow")).toBeNull();
  });

  it("TC8: typecheck kind 不匹配（workflow 块用 agent kind 解析）返 null", () => {
    // VALID_WORKFLOW 是 workflow meta（有 phases），用 'agent' kind 解析应失败（agent 无 phases）
    expect(parseResourceMeta(VALID_WORKFLOW, "agent")).toBeNull();
  });

  it("TC9: legacy const meta（无 @pi-meta 块）返 null（无 adapter）[D1]", () => {
    expect(parseResourceMeta(LEGACY_CONST_META, "workflow")).toBeNull();
  });

  it("TC10: patternProperties 单反斜杠正则致 YAML 解析失败返 null [P-yaml]", () => {
    expect(parseResourceMeta(REGEX_SINGLE_BACKSLASH, "workflow")).toBeNull();
  });

  it("边界：空 @pi-meta 块（内容为空）返 null", () => {
    expect(parseResourceMeta(EMPTY_PI_META, "workflow")).toBeNull();
  });

  it("边界：phases: [] 空数组合法（workflow 可无 phase）", () => {
    const meta = parseResourceMeta(EMPTY_PHASES, "workflow");
    expect(meta).not.toBeNull();
    expect((meta as WorkflowMeta).phases).toEqual([]);
  });
});

// ── parseResourceMetaDetailed（IF2，generate 闭环）──────────

describe("parseResourceMetaDetailed (generate, linePos)", () => {
  it("TC6: 合法返 {ok:true, meta}", () => {
    const r = parseResourceMetaDetailed(VALID_WORKFLOW, "workflow");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.name).toBe("chain");
  });

  it("TC5: malformed YAML 返 {ok:false, error, linePos:{line,col}} [P-yaml]", () => {
    const r = parseResourceMetaDetailed(MALFORMED_INDENT, "workflow");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeTruthy();
      expect(r.linePos).toBeDefined();
      expect(typeof r.linePos!.line).toBe("number");
      expect(typeof r.linePos!.col).toBe("number");
      expect(r.linePos!.line).toBeGreaterThan(0);
    }
  });

  it("TC7: 缺块返 {ok:false, error} 无 linePos", () => {
    const r = parseResourceMetaDetailed(NO_META_BLOCK, "workflow");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.linePos).toBeUndefined();
  });

  it("TC10: 单反斜杠正则返 {ok:false, error 含 Invalid escape, linePos} [P-yaml]", () => {
    const r = parseResourceMetaDetailed(REGEX_SINGLE_BACKSLASH, "workflow");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("escape");
      expect(r.linePos).toBeDefined();
      expect(r.linePos!.line).toBeGreaterThan(0);
    }
  });

  it("边界：空 @pi-meta 块返 {ok:false}（parseYaml 空串→ null→ typecheck 失败）", () => {
    const r = parseResourceMetaDetailed(EMPTY_PI_META, "workflow");
    expect(r.ok).toBe(false);
  });
});
