// review-fix-loop.js workflow 脚本内纯函数直测（W2 移交 CRAP 240/110 最高项）。
//
// 测试方法（限制见文末 import 用例）：review-fix-loop.js 是 pi worker 模板脚本——
// 顶层执行 + 顶层 return，不可作为 ES module import（vite/esbuild 直接 SyntaxError）。
// 因此用 vm.Script 对源码文本做「函数段抽取求值」：从源文件按函数名定位 + brace
// 配平截取 normUsage / warnTelemetryMissingOnce / buildCallRecord 三段，在注入
// log/Buffer 的沙箱里求值后取回引用。抽取定位失败（函数改名/移动）会显式 throw，
// 不会静默测到旧副本。
//
// 回归锚点（对照修复史，断言在旧实现上会红）：
//   - W1：失败调用（returnMeta={value,error}）不得触发 telemetry-missing WARN
//         （旧实现不排除 error 分支，agent 失败被误诊为引擎透传未上线并烧掉 once 名额）
//   - A11：model 缺省回退 "(default)"（请求时参数语义）
//   - A12：promptMode=null（aggregator/fixer）必须保持 null，不被 || 误转 "full"
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

const WORKFLOW_SOURCE = readFileSync(
  join(__dirname, "..", "..", "workflows", "review-fix-loop.js"),
  "utf8",
);

/** 按函数名从源码文本截取完整函数段（参数括号配平后 brace 配平函数体）。
 *  抽取不到 → 显式报错（防漂移）。buildCallRecord 的解构参数含花括号，
 *  函数体起点必须从参数列表闭合括号之后找，不能直接 indexOf("{")。 */
function extractFn(name: string): string {
  const marker = "function " + name + "(";
  const start = WORKFLOW_SOURCE.indexOf(marker);
  if (start < 0) {
    throw new Error("extraction guard failed: " + marker + " not found — function renamed/moved?");
  }
  // 参数列表括号配平（解构参数内嵌的 () {} 不影响外层括号深度）
  const paramOpen = start + marker.length - 1;
  let parenDepth = 0;
  let paramClose = -1;
  for (let i = paramOpen; i < WORKFLOW_SOURCE.length; i++) {
    if (WORKFLOW_SOURCE[i] === "(") parenDepth++;
    else if (WORKFLOW_SOURCE[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) { paramClose = i; break; }
    }
  }
  if (paramClose < 0) throw new Error("extraction guard failed: unbalanced params for " + name);
  // 函数体 brace 配平
  const open = WORKFLOW_SOURCE.indexOf("{", paramClose);
  let depth = 0;
  for (let i = open; i < WORKFLOW_SOURCE.length; i++) {
    if (WORKFLOW_SOURCE[i] === "{") depth++;
    else if (WORKFLOW_SOURCE[i] === "}") {
      depth--;
      if (depth === 0) return WORKFLOW_SOURCE.slice(start, i + 1);
    }
  }
  throw new Error("extraction guard failed: unbalanced braces for " + name);
}

interface NormUsage {
  input: number; output: number;
  cacheRead: number; cacheWrite: number; cost: number;
}

interface CallRecord {
  batch: number; round: number; role: string; name: string;
  model: string;
  durationMs: number | null;
  usage: NormUsage | undefined;
  promptMode: string | null;
  promptBytes: number;
  sessionId: string | undefined;
}

interface ScriptFns {
  normUsage: (meta: unknown) => NormUsage | undefined;
  buildCallRecord: (args: {
    batch: number; round: number; role: string; name?: string;
    model?: string; prompt: unknown; promptMode?: string | null;
    meta?: unknown;
  }) => CallRecord;
  /** 重置 once-WARN 名额（模块级 warnedTelemetryMissing 是闭包状态，逐用例归零） */
  resetWarnFlag: () => void;
}

/** 求值抽取段：注入 log（数组记录）与 Buffer（buildCallRecord 的 promptBytes 依赖）。 */
function loadScriptFns(logs: string[]): ScriptFns {
  const src = [
    "let warnedTelemetryMissing = false;",
    extractFn("normUsage"),
    extractFn("warnTelemetryMissingOnce"),
    extractFn("buildCallRecord"),
    "({ normUsage, buildCallRecord, resetWarnFlag: () => { warnedTelemetryMissing = false; } })",
  ].join("\n");
  const sandbox: vm.Context = {
    Buffer,
    log: (msg: string) => { logs.push(String(msg)); },
  };
  return vm.runInNewContext(src, sandbox) as ScriptFns;
}

const FULL_USAGE: NormUsage = { input: 1200, output: 340, cacheRead: 5600, cacheWrite: 800, cost: 0.042 };

describe("review-fix-loop.js normUsage（usage 归一）", () => {
  it("meta 缺失/非对象 → undefined", () => {
    const { normUsage } = loadScriptFns([]);
    expect(normUsage(undefined)).toBeUndefined();
    expect(normUsage(null)).toBeUndefined();
    expect(normUsage("string")).toBeUndefined();
    expect(normUsage(42)).toBeUndefined();
  });

  it("meta.usage 缺失/非对象 → undefined（旧引擎无 usage 键）", () => {
    const { normUsage } = loadScriptFns([]);
    expect(normUsage({})).toBeUndefined();
    expect(normUsage({ durationMs: 100 })).toBeUndefined();
    expect(normUsage({ usage: null })).toBeUndefined();
    expect(normUsage({ usage: "1200" })).toBeUndefined();
  });

  it("usage 空对象（字段全缺）→ 五分量全部补 0，不产生 undefined 字段", () => {
    const { normUsage } = loadScriptFns([]);
    expect(normUsage({ usage: {} })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });

  it("usage 分量缺失 → 缺省分量 0，给定分量原值（部分维度）", () => {
    const { normUsage } = loadScriptFns([]);
    expect(normUsage({ usage: { input: 500, output: 20 } })).toEqual({
      input: 500, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0,
    });
  });

  it("usage 分量为 null → ?? 0 兜底（null 维度不计 NaN）", () => {
    const { normUsage } = loadScriptFns([]);
    expect(normUsage({ usage: { input: null, output: 10, cacheRead: null, cacheWrite: null, cost: null } })).toEqual({
      input: 0, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0,
    });
  });

  it("usage 完整 → 五分量精确透传", () => {
    const { normUsage } = loadScriptFns([]);
    expect(normUsage({ usage: { ...FULL_USAGE } })).toEqual(FULL_USAGE);
  });
});

describe("review-fix-loop.js buildCallRecord（calls[] 十字段条目）", () => {
  it("完整 returnMeta → 十字段精确形状（promptBytes 按 utf8 字节计）", () => {
    const { buildCallRecord } = loadScriptFns([]);
    const rec = buildCallRecord({
      batch: 2, round: 3, role: "reviewer", name: "code-reviewer",
      model: "x/y", prompt: "审查 a√", promptMode: "scoped",
      meta: { durationMs: 12345, usage: { ...FULL_USAGE }, sessionId: "sess-1" },
    });
    // "审查 a√" = 审(3B)+查(3B)+空格(1B)+a(1B)+√(3B) = 11 字节（utf8 多字节验证）
    expect(rec).toEqual({
      batch: 2, round: 3, role: "reviewer", name: "code-reviewer",
      model: "x/y", durationMs: 12345, usage: FULL_USAGE,
      promptMode: "scoped", promptBytes: 11, sessionId: "sess-1",
    });
  });

  it("多批多角色连续构造 → 各条目独立（批/角色/usage 互不污染）", () => {
    const { buildCallRecord } = loadScriptFns([]);
    const r1 = buildCallRecord({
      batch: 1, round: 1, role: "reviewer", name: "a", model: "m",
      prompt: "p1", meta: { durationMs: 1, usage: { input: 10 }, sessionId: "s1" },
    });
    const r2 = buildCallRecord({
      batch: 2, round: 1, role: "aggregator", model: "m2",
      prompt: "p2", promptMode: null, meta: { durationMs: 2, usage: { input: 20 } },
    });
    expect(r1.batch).toBe(1);
    expect(r1.usage?.input).toBe(10);
    expect(r2.batch).toBe(2);
    expect(r2.usage?.input).toBe(20);
    expect(r1.promptMode).toBe("full"); // 缺省回退（reviewer 全量模式）
  });

  it("W1 回归：失败调用（returnMeta={value,error}）不触发 telemetry-missing WARN", () => {
    const logs: string[] = [];
    const { buildCallRecord } = loadScriptFns(logs);
    const rec = buildCallRecord({
      batch: 1, round: 1, role: "reviewer", name: "a", model: "m",
      prompt: "p", meta: { value: "", error: "agent timeout" },
    });
    // 旧实现不排除 error 分支：失败调用被误诊「透传未上线」并 WARN（本断言会红）
    expect(logs).toEqual([]);
    // 失败调用天然无 usage/durationMs——降级形态如实记录
    expect(rec.usage).toBeUndefined();
    expect(rec.durationMs).toBeNull();
  });

  it("W1 之后真正缺 usage 的成功调用仍能 WARN（once 名额未被失败调用烧掉）", () => {
    const logs: string[] = [];
    const { buildCallRecord } = loadScriptFns(logs);
    buildCallRecord({
      batch: 1, round: 1, role: "reviewer", name: "a", model: "m",
      prompt: "p", meta: { value: "ok", error: "agent timeout" },
    });
    buildCallRecord({
      batch: 1, round: 1, role: "reviewer", name: "a", model: "m",
      prompt: "p", meta: { durationMs: 5 }, // returnMeta 在但 usage 缺失
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("returnMeta usage/durationMs missing");
  });

  it("A10 回归：多次降级调用只 WARN 一次（不逐调用刷屏）", () => {
    const logs: string[] = [];
    const { buildCallRecord } = loadScriptFns(logs);
    for (let i = 0; i < 3; i++) {
      buildCallRecord({
        batch: 1, round: 1, role: "reviewer", name: "a", model: "m",
        prompt: "p", meta: { durationMs: 5 }, // usage 缺失
      });
    }
    expect(logs).toHaveLength(1);
  });

  it("A11 回归：model 空/缺省 → \"(default)\"（请求时参数语义，非实际运行模型）", () => {
    const { buildCallRecord } = loadScriptFns([]);
    const rec = buildCallRecord({
      batch: 1, round: 1, role: "fixer", model: undefined, prompt: "p",
      meta: { durationMs: 1 },
    });
    expect(rec.model).toBe("(default)");
    expect(buildCallRecord({ batch: 1, round: 1, role: "fixer", model: "", prompt: "p", meta: {} }).model).toBe("(default)");
  });

  it("A12 回归：promptMode=null（aggregator/fixer）保持 null，不被误转 \"full\"", () => {
    const { buildCallRecord } = loadScriptFns([]);
    // 旧实现 `promptMode || \"full\"` 会把 null 转成 "full"（本断言会红）
    expect(buildCallRecord({ batch: 1, round: 1, role: "aggregator", prompt: "p", promptMode: null, meta: {} }).promptMode).toBeNull();
  });

  it("A12 边界：promptMode 空串保持空串（空串 ≠ 缺省，不回退 full）", () => {
    const { buildCallRecord } = loadScriptFns([]);
    expect(buildCallRecord({ batch: 1, round: 1, role: "reviewer", prompt: "p", promptMode: "", meta: {} }).promptMode).toBe("");
  });

  it("promptMode 缺省（undefined）→ \"full\"（reviewer 默认全量模式）", () => {
    const { buildCallRecord } = loadScriptFns([]);
    expect(buildCallRecord({ batch: 1, round: 1, role: "reviewer", prompt: "p", meta: {} }).promptMode).toBe("full");
  });

  it("name 缺省/空 → role 兜底", () => {
    const { buildCallRecord } = loadScriptFns([]);
    expect(buildCallRecord({ batch: 1, round: 1, role: "fixer", name: undefined, prompt: "p", meta: {} }).name).toBe("fixer");
    expect(buildCallRecord({ batch: 1, round: 1, role: "fixer", name: "", prompt: "p", meta: {} }).name).toBe("fixer");
  });

  it("durationMs 非数（字符串/null）→ 条目记 null + WARN", () => {
    const logs: string[] = [];
    const { buildCallRecord } = loadScriptFns(logs);
    expect(buildCallRecord({ batch: 1, round: 1, role: "reviewer", prompt: "p", meta: { durationMs: "1200", usage: {} } }).durationMs).toBeNull();
    expect(buildCallRecord({ batch: 1, round: 1, role: "reviewer", prompt: "p", meta: { durationMs: null, usage: {} } }).durationMs).toBeNull();
    expect(logs).toHaveLength(1);
  });

  it("meta 缺失（旧引擎无 returnMeta）→ 降级条目且不触发 WARN（判定前提是 metaObj 存在）", () => {
    const logs: string[] = [];
    const { buildCallRecord } = loadScriptFns(logs);
    const rec = buildCallRecord({ batch: 1, round: 1, role: "reviewer", prompt: "p", meta: undefined });
    expect(rec.durationMs).toBeNull();
    expect(rec.usage).toBeUndefined();
    expect(rec.sessionId).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("prompt 非字符串 → promptBytes 0；sessionId 非字符串 → undefined", () => {
    const { buildCallRecord } = loadScriptFns([]);
    const rec = buildCallRecord({
      batch: 1, round: 1, role: "reviewer", prompt: undefined,
      meta: { durationMs: 1, sessionId: 12345 },
    });
    expect(rec.promptBytes).toBe(0);
    expect(rec.sessionId).toBeUndefined();
  });
});

describe("review-fix-loop.js 模块形态约束", () => {
  it("顶层 return 使其不可作为 ES module import（pi worker 脚本，非可导入模块）", async () => {
    // 本 import 语句同时是静态依赖边：让依赖分析把该 workflow 文件纳入测试可达域
    // （CRAP 覆盖估算）。顶层 return / require 决定了 import 必然 reject——这是
    // workflow 脚本的固有形态，抽取测试法（本文件）因此是唯一可行的直测途径。
    await expect(import("../../workflows/review-fix-loop.js")).rejects.toThrow();
  });
});
