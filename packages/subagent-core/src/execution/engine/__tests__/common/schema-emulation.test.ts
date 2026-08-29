// schema-emulation.test.ts —— 三级容错提取逐级用例 + ajv 校验 + tail 载体。
//
// 三视角：①构建者——三级容错每级有独立触达用例（直接 parse / fence / 括号扫描）；
// ②使用者——ok:false 时 error 简述 + tail 足以构造重试 prompt；③观察者——prompt
// 注入段含 schema 声明与输出约定（emulated 引擎拼进 prompt 后模型可遵循）。

import { describe, expect, it } from "vitest";

import {
  buildSchemaEmulationSegment,
  extractAndValidateStructuredOutput,
  SCHEMA_EMULATION_TAIL_CHARS,
} from "../../common/schema-emulation.ts";

const objectSchema = {
  type: "object",
  properties: { verdict: { type: "string" }, issues: { type: "array", items: { type: "string" } } },
  required: ["verdict"],
} as const;

describe("buildSchemaEmulationSegment", () => {
  it("注入段含 schema JSON 声明 + 输出格式约定（用户可见 prompt 断言）", () => {
    const segment = buildSchemaEmulationSegment(objectSchema);
    expect(segment).toContain("## Structured Output Requirement");
    expect(segment).toContain(JSON.stringify(objectSchema));
    expect(segment).toMatch(/```json/);
    expect(segment).toMatch(/ONLY the JSON value/);
    expect(segment).toMatch(/JSON Schema \(draft-07\)/);
  });
});

describe("extractAndValidateStructuredOutput 三级容错", () => {
  it("第 1 级：输出整体即合法 JSON → 直接 parse 通过 + ajv 通过", () => {
    const text = JSON.stringify({ verdict: "pass", issues: [] });
    const result = extractAndValidateStructuredOutput(text, objectSchema);
    expect(result).toEqual({ ok: true, parsed: { verdict: "pass", issues: [] } });
  });

  it("第 2 级：markdown code fence 包裹 → 剥 fence 后 parse 通过", () => {
    const text = "Here is my answer:\n```json\n{\"verdict\": \"fail\", \"issues\": [\"a\", \"b\"]}\n```\n";
    const result = extractAndValidateStructuredOutput(text, objectSchema);
    expect(result).toEqual({ ok: true, parsed: { verdict: "fail", issues: ["a", "b"] } });
  });

  it("第 2 级：无语言标注的裸 fence 也能剥", () => {
    const text = "```\n{\"verdict\": \"pass\"}\n```";
    const result = extractAndValidateStructuredOutput(text, objectSchema);
    expect(result).toEqual({ ok: true, parsed: { verdict: "pass" } });
  });

  it("第 3 级：前后杂文本包裹 → 首尾括号扫描提取", () => {
    const text = "Sure! The review result is:\n\n{\"verdict\": \"fail\", \"issues\": [\"x\"]}\n\nHope this helps.";
    const result = extractAndValidateStructuredOutput(text, objectSchema);
    expect(result).toEqual({ ok: true, parsed: { verdict: "fail", issues: ["x"] } });
  });

  it("第 3 级：array 根也支持（首个 '[' 到末个 ']'）", () => {
    const arraySchema = { type: "array", items: { type: "string" } };
    const result = extractAndValidateStructuredOutput("prefix [\"a\",\"b\"] suffix", arraySchema);
    expect(result).toEqual({ ok: true, parsed: ["a", "b"] });
  });

  it("提取成功但 ajv 校验失败 → ok:false 含 ajv 错误明细与原始尾部", () => {
    // verdict 缺失（required）+ issues 类型错
    const text = '{"issues": "not-an-array"}';
    const result = extractAndValidateStructuredOutput(text, objectSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Schema validation failed");
      expect(result.error).toContain("verdict");
      expect(result.tail).toBe(text);
    }
  });

  it("三级提取全失败（无任何 JSON）→ ok:false 且 error 指明三级路径", () => {
    const result = extractAndValidateStructuredOutput("no json here at all", objectSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("3-stage");
      expect(result.error).toContain("code-fence");
      expect(result.error).toContain("bracket scan");
    }
  });

  it("提取成功但 JSON 语法损坏（括号扫描后仍 parse 失败）→ ok:false", () => {
    const result = extractAndValidateStructuredOutput("result: {verdict: pass}", objectSchema);
    expect(result.ok).toBe(false);
  });

  it("ajv 编译失败（非法 schema）→ ok:false 指明 host 侧编译失败", () => {
    // type: "foo" 是 ajv 编译期拒绝的非法类型值
    const result = extractAndValidateStructuredOutput('{"a":1}', { type: "foo" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("compilation failed");
    }
  });
});

describe("tail 载体（错误展示）", () => {
  it(`tail 截断到原始输出尾部 ${SCHEMA_EMULATION_TAIL_CHARS} 字`, () => {
    const head = "H".repeat(300);
    const tailPart = "T".repeat(400);
    const text = `${head}${tailPart}`; // 700 字，尾部 500 = 末段（100H + 400T）
    const result = extractAndValidateStructuredOutput(text, objectSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tail.length).toBe(SCHEMA_EMULATION_TAIL_CHARS);
      expect(result.tail).toBe("H".repeat(100) + "T".repeat(400));
    }
  });

  it("短输出 tail 为原文（不截断）", () => {
    const text = "short broken output";
    const result = extractAndValidateStructuredOutput(text, objectSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tail).toBe(text);
    }
  });
});

describe("D4 硬分流守护（静态断言）", () => {
  it("本模块的 ajv 只在 emulated 路径——native 引擎（pi-env 链路）不 import 本模块（由全仓 grep 守护，见任务报告）", () => {
    // 占位用例：硬分流是 import 约束，运行时无对应断言点；保留用例记录守护方式
    expect(typeof extractAndValidateStructuredOutput).toBe("function");
  });
});
