/**
 * actionGenerate 行为测试（m0 wave / TC1-TC7 + [P-generate-roundtrip]）
 *
 * mock node:fs（mkdirSync/writeFileSync）避免真实落盘 .pi/workflows/.tmp/。
 * parseResourceMetaDetailed 真实调用（不 mock m1）——round-trip 探针必须用真实 IF2。
 *
 * 框架：vitest（禁 node:test）。
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { actionGenerate, type ScriptParams, type TextContent } from "../tool-workflow-script.ts";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

function gen(script: string, name = "test-wf"): ScriptParams {
  return { action: "generate", name, script } as ScriptParams;
}

/** TextContent.text 在 content[0].text。 */
function textOf(r: TextContent): string {
  return r.content[0]?.text ?? "";
}

const PI_META_VALID = `/* @pi-meta
name: test-wf
description: 合法新格式
phases: [a, b]
parameters:
  type: object
  properties:
    task: { type: string }
  required: [task]
*/
const agent = require("./agent");
agent("worker", { task: $ARGS.task });
`;

const PI_META_MALFORMED = `/* @pi-meta
name: test-wf
description: bad
  broken: indent
phases: [a]
*/
const agent = require("./agent");
agent("w");
`;

const PI_META_REGEX_SINGLE_BS = `/* @pi-meta
name: test-wf
description: regex
phases: [A]
parameters:
  type: object
  patternProperties:
    "^batch\\d+$": { type: string }
*/
const agent = require("./agent");
agent("w");
`;

const LEGACY_CONST_META = `const meta = {
  name: test-wf,
  description: legacy,
  phases: ["a"]
};
const agent = require("./agent");
agent("w");
`;

const NO_META = `const agent = require("./agent");
agent("w");
`;

const ESM_IMPORT = `/* @pi-meta
name: x
description: d
phases: [a]
*/
import { foo } from "bar";
const agent = require("./agent");
agent("w");
`;

const NO_AGENT = `/* @pi-meta
name: x
description: d
phases: [a]
*/
const x = 1;
`;

describe("actionGenerate (m0: @pi-meta 认可 + round-trip)", () => {
  beforeEach(() => {
    mockedWriteFileSync.mockClear();
    mockedMkdirSync.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("TC1: 合法 @pi-meta → ready + writeFileSync 被调用", () => {
    const r = actionGenerate(gen(PI_META_VALID), undefined);
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/ready|generated|test-wf/i);
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it("TC2: malformed @pi-meta YAML → error + writeFileSync 未调用 [P-generate-roundtrip]", () => {
    const r = actionGenerate(gen(PI_META_MALFORMED), undefined);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/cannot be parsed|无法解析|line/i);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("TC3: legacy const meta（过渡期）→ ready + writeFileSync 被调用", () => {
    const r = actionGenerate(gen(LEGACY_CONST_META), undefined);
    expect(r.isError).toBeFalsy();
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it("TC4: 无 meta → error 提及 @pi-meta 新格式", () => {
    const r = actionGenerate(gen(NO_META), undefined);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/meta declaration/i);
    expect(textOf(r)).toMatch(/pi-meta/i);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("TC5: @pi-meta 单反斜杠正则 → error（LLM 高频错）[P-generate-roundtrip]", () => {
    const r = actionGenerate(gen(PI_META_REGEX_SINGLE_BS), undefined);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/escape|cannot be parsed|无法解析|line/i);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("TC6: ESM import → reject（保留现有行为）", () => {
    const r = actionGenerate(gen(ESM_IMPORT), undefined);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/ESM|import/i);
  });

  it("TC7: 无 agent() → reject（保留现有行为）", () => {
    const r = actionGenerate(gen(NO_AGENT), undefined);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/agent\(\)/i);
  });

  it("TC8: signal aborted → reject（保留现有行为）", () => {
    const controller = new AbortController();
    controller.abort();
    const r = actionGenerate(gen(PI_META_VALID), controller.signal);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/abort/i);
  });
});
