// review-fix-loop-utils.cjs 行为测试（MF-5）
//
// 覆盖 review-fix-loop.js 的可测纯函数：参数校验（normalizeBool/normalizeInt）、
// 批次解析（缺号/重复/agents 冲突/batchNames 数量）、fallow-scan 类型限制、
// 审查指令构建、结果解析（parseResult/normalizeAggregatorResult/parseAggregatedMd 回退）。
// 这些逻辑原本全部内联在 workflow 脚本里零测试，抽到 utils 模块后与 worker 运行时共用
//（review-fix-loop.js 经 workerData.scriptPath 定位 require），测试的不是死代码副本。

import { describe, it, expect } from "vitest";
import {
  TARGET_TYPES,
  normalizeBool,
  normalizeInt,
  parseBatches,
  resolveBatchNames,
  validateFallowScan,
  buildReviewInstruction,
  parseResult,
  normalizeAggregatorResult,
  parseAggregatedMd,
  shouldRetryWithReviewPrefix,
} from "../../workflows/review-fix-loop-utils.cjs";

/** 测试用 fail：与 workflow 内 fail() 同语义（抛错终止） */
function fail(msg: string): never {
  throw new Error("review-fix-loop: " + msg);
}

// ── review- 前缀兕底判定（MF-1：registry 报错文案锁定） ────────────────
//
// agent-registry.ts 的报错文案是 `Agent "${name}" not found. Discovered: ...`
// （名字夹在 "Agent" 与 "not found" 之间），故匹配条件必须是松散子串 "not found"，
// 连续子串 "Agent not found" 永远不命中。下面用例锁定两端：registry 文案 + 匹配逻辑。

describe("shouldRetryWithReviewPrefix", () => {
  it("registry 文案 `Agent \"X\" not found. Discovered: ...`（名字夹在中间）→ 命中重试", () => {
    expect(
      shouldRetryWithReviewPrefix('Agent "business-logic" not found. Discovered: reviewer, worker', "business-logic"),
    ).toBe(true);
    // 假设性连续子串也命中（防御未来文案变化）
    expect(shouldRetryWithReviewPrefix("Agent not found", "business-logic")).toBe(true);
  });

  it("非 not found 错误 → 不重试", () => {
    expect(shouldRetryWithReviewPrefix("Agent registry failure", "business-logic")).toBe(false);
    expect(shouldRetryWithReviewPrefix("timeout", "business-logic")).toBe(false);
  });

  it("已是 review- 前缀 → 不重试（防死循环）", () => {
    expect(
      shouldRetryWithReviewPrefix('Agent "review-business-logic" not found. Discovered: reviewer', "review-business-logic"),
    ).toBe(false);
  });

  it("agent 名缺失 / 非字符串 → 不重试", () => {
    expect(shouldRetryWithReviewPrefix('Agent "x" not found.', undefined)).toBe(false);
    expect(shouldRetryWithReviewPrefix('Agent "x" not found.', "")).toBe(false);
    expect(shouldRetryWithReviewPrefix(undefined, "x")).toBe(false);
    expect(shouldRetryWithReviewPrefix(null, "x")).toBe(false);
  });
});

// ── 参数校验：normalizeBool / normalizeInt ──────────────────────────

describe("normalizeBool", () => {
  it("缺省值（undefined/null/空串）→ 返回默认值", () => {
    expect(normalizeBool(undefined, "autoCommit", false, fail)).toBe(false);
    expect(normalizeBool(null, "autoCommit", true, fail)).toBe(true);
    expect(normalizeBool("", "autoCommit", false, fail)).toBe(false);
  });

  it("合法布尔值透传", () => {
    expect(normalizeBool(true, "autoCommit", false, fail)).toBe(true);
    expect(normalizeBool(false, "autoCommit", true, fail)).toBe(false);
    expect(normalizeBool("true", "autoCommit", false, fail)).toBe(true);
    expect(normalizeBool("false", "autoCommit", true, fail)).toBe(false);
  });

  it("非法布尔值 → fail（参数校验 fail-fast）", () => {
    expect(() => normalizeBool("yes", "autoCommit", false, fail)).toThrow("必须是布尔值");
    expect(() => normalizeBool(1, "autoCommit", false, fail)).toThrow("必须是布尔值");
    expect(() => normalizeBool("on", "skipCleanAgents", true, fail)).toThrow("skipCleanAgents");
  });
});

describe("normalizeInt", () => {
  it("缺省值 → 返回默认值", () => {
    expect(normalizeInt(undefined, "maxRounds", 10, fail)).toBe(10);
    expect(normalizeInt("", "stuckThreshold", 3, fail)).toBe(3);
  });

  it("合法正整数（number 与数字字符串）", () => {
    expect(normalizeInt(5, "maxRounds", 10, fail)).toBe(5);
    expect(normalizeInt("7", "maxRounds", 10, fail)).toBe(7);
    expect(normalizeInt(" 12 ", "maxRounds", 10, fail)).toBe(12);
  });

  it("非正整数（0/负数/小数/非数字）→ fail", () => {
    expect(() => normalizeInt(0, "maxRounds", 10, fail)).toThrow("必须是正整数");
    expect(() => normalizeInt(-1, "maxRounds", 10, fail)).toThrow("必须是正整数");
    expect(() => normalizeInt(1.5, "maxRounds", 10, fail)).toThrow("必须是正整数");
    expect(() => normalizeInt("abc", "stuckThreshold", 3, fail)).toThrow("stuckThreshold");
  });
});

// ── 批次解析：parseBatches ─────────────────────────────────────────

describe("parseBatches", () => {
  it("无 batchN/agents → 报错（无默认 agent，必须显式指定）", () => {
    expect(() => parseBatches({}, fail)).toThrow("缺少批次参数");
  });

  it("batch1..batchN 按编号排序解析为 agent 名数组", () => {
    const batches = parseBatches({ batch2: "reviewer,code-reviewer", batch1: "fallow-scan" }, fail);
    expect(batches).toEqual([["fallow-scan"], ["reviewer", "code-reviewer"]]);
  });

  it("agents 简写 → 单批", () => {
    expect(parseBatches({ agents: "reviewer,oracle" }, fail)).toEqual([["reviewer", "oracle"]]);
  });

  it("批次缺号（batch1+batch3 无 batch2）→ fail", () => {
    expect(() => parseBatches({ batch1: "reviewer", batch3: "oracle" }, fail))
      .toThrow("批次参数缺号");
  });

  it("agents 与 batch1 同时传 → fail（agents 是单批简写）", () => {
    expect(() => parseBatches({ agents: "reviewer", batch1: "oracle" }, fail))
      .toThrow("agents 与 batch1 不能同时传");
  });

  it("批内重复 agent → fail", () => {
    expect(() => parseBatches({ batch1: "reviewer,reviewer" }, fail))
      .toThrow("内存在重复 agent");
  });

  it("批内容为空（逗号后无名字）→ fail", () => {
    expect(() => parseBatches({ batch1: ", ," }, fail)).toThrow("为空");
    expect(() => parseBatches({ batch1: "" }, fail)).toThrow("不能为空");
  });
});

// ── batchNames 数量校验：resolveBatchNames ─────────────────────────

describe("resolveBatchNames", () => {
  it("无 batchNames → 生成 batch-<i> 默认名", () => {
    expect(resolveBatchNames([], [["a"], ["b"]], fail)).toEqual(["batch-1", "batch-2"]);
  });

  it("batchNames 数量与批数一致 → 原样返回", () => {
    expect(resolveBatchNames(["Review", "Fix"], [["a"], ["b"]], fail)).toEqual(["Review", "Fix"]);
  });

  it("batchNames 数量与批数不符 → fail", () => {
    expect(() => resolveBatchNames(["only-one"], [["a"], ["b"]], fail))
      .toThrow("batchNames 数量（1）必须与批数（2）一致");
  });
});

// ── fallow-scan 类型限制：validateFallowScan ───────────────────────

describe("validateFallowScan", () => {
  it("fallow-scan + targetType=git-diff → 放行", () => {
    expect(() => validateFallowScan([["fallow-scan"]], "git-diff", fail)).not.toThrow();
  });

  it("fallow-scan + 非 git-diff（file）→ fail", () => {
    expect(() => validateFallowScan([["fallow-scan"]], "file", fail))
      .toThrow("fallow-scan 只支持 targetType=git-diff");
  });

  it("非 fallow-scan 批次不受 targetType 限制", () => {
    expect(() => validateFallowScan([["reviewer"]], "text", fail)).not.toThrow();
  });
});

// ── 审查指令构建：buildReviewInstruction ───────────────────────────

describe("buildReviewInstruction", () => {
  it("git-diff → 含 base ref 与未提交改动提示", () => {
    const instr = buildReviewInstruction("git-diff", "main");
    expect(instr).toContain("git diff main...HEAD");
    expect(instr).toContain("git status --porcelain");
  });

  it("file / dir / text → 各类型指令", () => {
    expect(buildReviewInstruction("file", "src/a.ts")).toBe("Read and review the file: src/a.ts");
    expect(buildReviewInstruction("dir", "src/")).toContain("Explore and review the directory: src/");
    expect(buildReviewInstruction("text", "优化登录流程")).toBe("Review target: 优化登录流程");
  });
});

// ── 结果解析：parseResult ──────────────────────────────────────────

describe("parseResult", () => {
  it("object 原样返回", () => {
    const obj = { must_fix: 2 };
    expect(parseResult(obj)).toBe(obj);
  });

  it("fenced JSON 字符串 → 剥 fence 解析", () => {
    expect(parseResult('```json\n{"must_fix": 3}\n```')).toEqual({ must_fix: 3 });
  });

  it("prose 包裹的 JSON → 提取内嵌对象解析", () => {
    expect(parseResult('Here you go: {"must_fix": 1} thanks!')).toEqual({ must_fix: 1 });
  });

  it("无效字符串 / null → null", () => {
    expect(parseResult("not json at all")).toBeNull();
    expect(parseResult(null)).toBeNull();
    expect(parseResult(undefined)).toBeNull();
  });
});

// ── 聚合结果归一化：normalizeAggregatorResult ──────────────────────

describe("normalizeAggregatorResult", () => {
  it("标准字段 must_fix/suggestion → 归一化", () => {
    expect(normalizeAggregatorResult({ report_file: "/r.md", must_fix: 4, suggestion: 2 }))
      .toEqual({ report_file: "/r.md", must_fix: 4, suggestion: 2 });
  });

  it("别名字段（totalMustFix/mustFix/reportFile）→ 归一化", () => {
    expect(normalizeAggregatorResult({ reportFile: "/r.md", totalMustFix: 5, totalSuggestions: 1 }))
      .toEqual({ report_file: "/r.md", must_fix: 5, suggestion: 1 });
  });

  it("must_fix 缺失/非 number（LLM 返回无效 JSON）→ null", () => {
    expect(normalizeAggregatorResult({ report_file: "/r.md", suggestion: 0 })).toBeNull();
    expect(normalizeAggregatorResult({ must_fix: "3" })).toBeNull();
    expect(normalizeAggregatorResult("garbage")).toBeNull();
  });
});

// ── aggregated.md 回退解析：parseAggregatedMd（aggregator JSON 无效时兜底） ──

describe("parseAggregatedMd", () => {
  it("标准 Summary 格式 → 提取 must_fix + suggestion", () => {
    const md = [
      "## Summary",
      "- Must-fix: 6",
      "- Suggestions: 3",
      "- Infos: 2",
      "- Dimensions reviewed: business-logic, type-safety",
      "- Dedup: 15 duplicates removed",
    ].join("\n");
    expect(parseAggregatedMd(md)).toEqual({ must_fix: 6, suggestion: 3 });
  });

  it("无 Suggestions 行 → suggestion 默认 0", () => {
    expect(parseAggregatedMd("- Must-fix: 2")).toEqual({ must_fix: 2, suggestion: 0 });
  });

  it("无 Must-fix 行 → null（无法回退）", () => {
    expect(parseAggregatedMd("## Summary\nno counts here")).toBeNull();
  });
});

// ── TARGET_TYPES 枚举 ──────────────────────────────────────────────

describe("TARGET_TYPES", () => {
  it("合法枚举含 git-diff/file/dir/text", () => {
    expect(TARGET_TYPES).toEqual(["git-diff", "file", "dir", "text"]);
  });
});
