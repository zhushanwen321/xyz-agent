// review-fix-loop-utils.cjs 行为测试（MF-5）
//
// 覆盖 review-fix-loop.js 的可测纯函数：参数校验（normalizeBool/normalizeInt）、
// 批次解析（缺号/重复/agents 冲突/batchNames 数量）、fallow-scan 类型限制、
// 审查指令构建、结果解析（parseResult/normalizeAggregatorResult/parseAggregatedMd 回退）。
// 这些逻辑原本全部内联在 workflow 脚本里零测试，抽到 utils 模块后与 worker 运行时共用
//（review-fix-loop.js 经 workerData.scriptPath 定位 require），测试的不是死代码副本。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  TARGET_TYPES,
  normalizeBool,
  normalizeInt,
  parseBatches,
  resolveBatchNames,
  validateFallowScan,
  buildReviewInstruction,
  lockReviewBase,
  buildScopedRecheckPrompt,
  parseResult,
  normalizeAggregatorResult,
  parseAggregatedMd,
  shouldRetryWithReviewPrefix,
  parseAgentMd,
  loadAgentMd,
  resolveAgentDefs,
  recordAgentClean,
  recordAgentDirty,
  shouldSkipAgent,
  updateStuckState,
  resolveBatchTerminated,
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

// ── base 锁定（RC-6，5.6）：git-diff 场景 run 启动锁定 base commit hash ──

describe("lockReviewBase", () => {
  it("git-diff + rev-parse 成功 → 返回锁定 hash（TC1）", () => {
    const run = (cmd: string) => { expect(cmd).toBe("git rev-parse main"); return "abc1234\n"; };
    const r = lockReviewBase("git-diff", "main", run);
    expect(r).toEqual({ base: "abc1234", hash: "abc1234" });
  });
  it("rev-parse 失败 → 降级原 ref、hash 空串（TC2）", () => {
    const run = () => { throw new Error("fatal: not a git repository"); };
    const r = lockReviewBase("git-diff", "main", run);
    expect(r).toEqual({ base: "main", hash: "" });
  });
  it("非 git-diff 类型 → 不锁定，原样返回", () => {
    expect(lockReviewBase("file", "/a/b.md")).toEqual({ base: "/a/b.md", hash: "" });
    expect(lockReviewBase("dir", "/src")).toEqual({ base: "/src", hash: "" });
  });
});

// ── recheck 限定 prompt（5.5 可选强回归模式）：clean agent 重派只审 fix 改动文件 ──

describe("buildScopedRecheckPrompt", () => {
  const args = {
    header: "Batch 1 Round 2/5 — reviewer",
    round: 2,
    max: 5,
    roundDir: "/tmp/run/batch-1/round-2",
    reportFile: "reviewer",
    modifiedFiles: ["src/a.ts", "docs/b.md"],
  };
  it("含 modifiedFiles 列表与限定声明（TC4）", () => {
    const p = buildScopedRecheckPrompt(args);
    expect(p).toContain("Scoped recheck (round 2/5)");
    expect(p).toContain("Modified files: src/a.ts, docs/b.md");
    expect(p).toContain("Review ONLY these files");
    expect(p).toContain("Do NOT do a full re-scan");
    expect(p).toContain("output 路径：/tmp/run/batch-1/round-2/reviewer.md");
  });
  it("无 modifiedFiles → (none detected via git) 占位", () => {
    const p = buildScopedRecheckPrompt({ ...args, modifiedFiles: [] });
    expect(p).toContain("(none detected via git)");
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

// ── 自定义 agent frontmatter 解析：parseAgentMd / loadAgentMd（MF：loadAgentMd 零测试） ──

describe("parseAgentMd", () => {
  const full = [
    "---",
    'name: "custom-reviewer"',
    "model: glm-5.1",
    "description: 自定义审查 agent",
    "---",
    "",
    "Review everything carefully.",
  ].join("\n");

  it("完整 frontmatter → name/model/description + 正文（report/title/isCustom 派生）", () => {
    const r = parseAgentMd(full, "fallback-name");
    expect(r.name).toBe("custom-reviewer");
    expect(r.model).toBe("glm-5.1");
    expect(r.description).toBe("自定义审查 agent");
    expect(r.systemPrompt).toBe("Review everything carefully.");
    expect(r.report).toBe("custom-reviewer");
    expect(r.title).toBe("自定义审查 agent");
    expect(r.isCustom).toBe(true);
  });

  it("无 frontmatter → basename 兜底 + 全文作正文", () => {
    const r = parseAgentMd("just body text", "my-agent");
    expect(r.name).toBe("my-agent");
    expect(r.model).toBeUndefined();
    expect(r.description).toBeUndefined();
    expect(r.systemPrompt).toBe("just body text");
    expect(r.report).toBe("my-agent");
    expect(r.title).toBe("my-agent");
  });

  it("frontmatter 未闭合（无第二个 ---）→ 全文当正文，basename 兜底", () => {
    const r = parseAgentMd("---\nname: x\nbody continues", "fallback");
    expect(r.name).toBe("fallback");
    expect(r.model).toBeUndefined();
    expect(r.systemPrompt).toBe("---\nname: x\nbody continues");
  });

  it("引号包裹的值 → 剥引号（双引号与单引号）；非成对引号保留", () => {
    const r = parseAgentMd(
      ['---', 'name: "quoted-name"', "model: 'x-model'", 'description: mixed"quote', "---", "body"].join("\n"),
      "fb",
    );
    expect(r.name).toBe("quoted-name");
    expect(r.model).toBe("x-model");
    // 起止引号不成对 → 不剥
    expect(r.description).toBe('mixed"quote');
  });

  it("空值字段（name:/model: 后无内容或仅空串）→ undefined 回退，name 用 basename", () => {
    // name: 空值且后跟内容行：不能把下一行误当 name 值（\s* 跨行防护）
    const r = parseAgentMd(['---', "name:", "model: x", 'description: ""', "---", "body"].join("\n"), "empty-fields");
    expect(r.name).toBe("empty-fields");
    expect(r.model).toBe("x");
    expect(r.description).toBeUndefined(); // 引号包裹的空串 → 剥引号后 || undefined
    expect(r.systemPrompt).toBe("body");
  });
});

describe("loadAgentMd", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rfl-md-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("读取文件 + 无 frontmatter 时 basename 兜底（custom-reviewer.md → custom-reviewer）", () => {
    const p = join(dir, "custom-reviewer.md");
    writeFileSync(p, "---\nname: \"X\"\n---\nbody");
    const r = loadAgentMd(p, fail);
    expect(r.name).toBe("X");
    expect(r.systemPrompt).toBe("body");
    const plain = join(dir, "plain.md");
    writeFileSync(plain, "no frontmatter body");
    const noFm = loadAgentMd(plain, fail);
    expect(noFm.name).toBe("plain");
    expect(noFm.systemPrompt).toBe("no frontmatter body");
  });

  it("文件不存在 → fail 回调报错（fail-fast）", () => {
    expect(() => loadAgentMd(join(dir, "missing.md"), fail)).toThrow("agent 文件读取失败");
  });
});

// ── Agent defs 解析：resolveAgentDefs（MF：三分支零测试） ────────────

describe("resolveAgentDefs", () => {
  const stubLoader = (p: string) => ({ name: "loaded:" + p, isCustom: true });

  it("fallow-scan → 内置 FALLOW_DEF 常量（不进 loader）", () => {
    expect(resolveAgentDefs(["fallow-scan"], stubLoader)[0]).toEqual({
      name: "fallow-scan",
      title: "FALLOW STATIC ANALYSIS",
      report: "fallow-scan",
      isFallow: true,
    });
  });

  it("含 / 或 .md 后缀 → 走 loader（相对路径与绝对路径）", () => {
    expect(resolveAgentDefs([".agents/agents/reviewer.md"], stubLoader)[0].name).toBe("loaded:.agents/agents/reviewer.md");
    expect(resolveAgentDefs(["/tmp/agents/x.md"], stubLoader)[0].name).toBe("loaded:/tmp/agents/x.md");
    expect(resolveAgentDefs(["custom-reviewer.md"], stubLoader)[0].name).toBe("loaded:custom-reviewer.md");
  });

  it("内置 agent 名 → review- 前缀剥离（report 名）+ 大写 title", () => {
    const r = resolveAgentDefs(["reviewer", "review-business-logic"], stubLoader);
    expect(r[0]).toEqual({ name: "reviewer", report: "reviewer", title: "REVIEWER" });
    expect(r[1]).toEqual({ name: "review-business-logic", report: "business-logic", title: "REVIEW-BUSINESS-LOGIC" });
  });

  it("review-reviewer 双重前缀 → 只剥一层（report=reviewer）", () => {
    expect(resolveAgentDefs(["review-reviewer"], stubLoader)[0].report).toBe("reviewer");
  });

  it("默认 loader = loadAgentMd（不传 loader 时 .md 项经 fs 读取）", () => {
    const dir = mkdtempSync(join(tmpdir(), "rfl-resolve-"));
    try {
      const p = join(dir, "a.md");
      writeFileSync(p, "---\nname: \"FromFile\"\n---\nbody");
      expect(resolveAgentDefs([p])[0].name).toBe("FromFile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Clean 快照 / 跨批跳过判定：recordAgentClean / recordAgentDirty / shouldSkipAgent ──
// （MF：cross-batch skip 核心状态机零测试）

describe("recordAgentClean / recordAgentDirty / shouldSkipAgent", () => {
  function freshState() {
    return { agentStatus: {} as Record<string, { lastCleanBatch: number; lastCleanFixCount: number; lastActiveRound: number; lastMustFix: number | undefined }>, fixCount: 0 };
  }

  it("recordAgentClean 写入 lastCleanBatch + 当时 fixCount 快照", () => {
    const state = freshState();
    state.fixCount = 3;
    recordAgentClean(state, "reviewer", 2);
    expect(state.agentStatus["reviewer"]).toEqual({
      lastCleanBatch: 2,
      lastCleanFixCount: 3,
      lastActiveRound: 2,
      lastMustFix: undefined,
    });
  });

  it("recordAgentDirty 写入 lastActiveRound + lastMustFix，不动 clean 快照", () => {
    const state = freshState();
    recordAgentClean(state, "reviewer", 1);
    recordAgentDirty(state, "reviewer", 4, 2);
    const s = state.agentStatus["reviewer"];
    expect(s.lastActiveRound).toBe(2);
    expect(s.lastMustFix).toBe(4);
    expect(s.lastCleanBatch).toBe(1);
    expect(s.lastCleanFixCount).toBe(0); // 快照保持 clean 记录时点的 fixCount，不被 dirty 覆盖
  });

  it("shouldSkipAgent：clean 快照后无 fix（fixCount 相等）→ 跳过；更晚批次同样跳过", () => {
    const status = { lastCleanBatch: 1, lastCleanFixCount: 2, lastActiveRound: 1, lastMustFix: undefined };
    expect(shouldSkipAgent(status, 2, 2)).toBe(true);
    expect(shouldSkipAgent(status, 2, 3)).toBe(true);
  });

  it("shouldSkipAgent：clean 后发生 fix（fixCount 变化）→ 不跳过（agent 可能受影响）", () => {
    const status = { lastCleanBatch: 1, lastCleanFixCount: 2, lastActiveRound: 1, lastMustFix: undefined };
    expect(shouldSkipAgent(status, 3, 2)).toBe(false);
  });

  it("shouldSkipAgent：无记录 / lastCleanBatch=0（从未 clean）/ 同批 clean → 不跳过", () => {
    expect(shouldSkipAgent(undefined, 0, 2)).toBe(false);
    expect(shouldSkipAgent({ lastCleanBatch: 0, lastCleanFixCount: 0, lastActiveRound: 0, lastMustFix: undefined }, 0, 2)).toBe(false);
    expect(shouldSkipAgent({ lastCleanBatch: 2, lastCleanFixCount: 0, lastActiveRound: 2, lastMustFix: undefined }, 0, 2)).toBe(false);
  });

  it("clean→dirty→fix→clean 生命周期：快照与跳过判定协同", () => {
    const state = freshState();
    recordAgentClean(state, "r", 1); // batch1 clean，快照 fixCount=0
    state.fixCount = 1; // fix 发生
    expect(shouldSkipAgent(state.agentStatus["r"], state.fixCount, 2)).toBe(false); // 不跳过
    recordAgentDirty(state, "r", 5, 2); // batch2 dirty
    state.fixCount = 2;
    recordAgentClean(state, "r", 2); // batch2 末 clean，快照 fixCount=2
    expect(shouldSkipAgent(state.agentStatus["r"], state.fixCount, 3)).toBe(true); // batch3 跳过
  });
});

// ── Stuck 检测 / terminated 判定纯函数（MF-5）──────────────────────
// 原内联在 review-fix-loop.js 主循环里零测试（MF-1/MF-2/MF-3 事故高发区）。
// 抽为纯函数后与 worker 运行时共用：updateStuckState 只跟踪 must_fix（MF-2 决策），
// resolveBatchTerminated 是批结束后 5 种 terminated 终态中 max-rounds 分支的判定。

describe("updateStuckState（stuck 检测纯函数）", () => {
  it("must_fix 连续不降 stuckThreshold 轮 → 第 stuckThreshold 轮 stuck", () => {
    let s = updateStuckState(-1, 0, 5, 3);
    expect(s.stuck).toBe(false);
    expect(s.stuckCount).toBe(0); // 首轮只记基线，不计数
    expect(s.prevMustFix).toBe(5);

    s = updateStuckState(s.prevMustFix, s.stuckCount, 5, 3);
    expect(s.stuck).toBe(false);
    expect(s.stuckCount).toBe(1);

    s = updateStuckState(s.prevMustFix, s.stuckCount, 5, 3);
    expect(s.stuck).toBe(false);
    expect(s.stuckCount).toBe(2);

    s = updateStuckState(s.prevMustFix, s.stuckCount, 5, 3);
    expect(s.stuck).toBe(true);
    expect(s.stuckCount).toBe(3);
  });

  it("must_fix 下降 → 计数重置；之后回升不降 → 重新累计（[5,4,4,4] 第 4 轮 stuck）", () => {
    let s = updateStuckState(-1, 0, 5, 3);
    s = updateStuckState(s.prevMustFix, s.stuckCount, 4, 3); // 5→4 下降
    expect(s.stuckCount).toBe(0);
    expect(s.prevMustFix).toBe(4);

    s = updateStuckState(s.prevMustFix, s.stuckCount, 4, 3); // 4→4 不降
    expect(s.stuckCount).toBe(1);
    s = updateStuckState(s.prevMustFix, s.stuckCount, 4, 3);
    expect(s.stuckCount).toBe(2);
    s = updateStuckState(s.prevMustFix, s.stuckCount, 4, 3);
    expect(s.stuck).toBe(true);
  });

  it("suggestion 变化不触发 stuck（MF-2 回归：签名刻意不含 suggestion）", () => {
    // 函数签名只接受 must_fix——MF-2 决策是 suggestion 是固定噪声（fix agent 只修
    // must-fix，suggestion 单调不降），计入 total 会把合法推进误判为 stuck 提前终止。
    // 若误把 suggestion 计入（suggestion 单调下降会无限重置计数），stuck 永不触发。
    let s = updateStuckState(-1, 0, 5, 3);
    s = updateStuckState(s.prevMustFix, s.stuckCount, 5, 3);
    s = updateStuckState(s.prevMustFix, s.stuckCount, 5, 3);
    s = updateStuckState(s.prevMustFix, s.stuckCount, 5, 3);
    expect(s.stuck).toBe(true);
  });

  it("stuckThreshold=1：单轮不降即 stuck；must_fix 下降则不触发", () => {
    expect(updateStuckState(5, 0, 5, 1).stuck).toBe(true);
    expect(updateStuckState(5, 0, 4, 1).stuck).toBe(false);
  });

  it("prevMustFix 负数（首轮基线）永不触发 stuck", () => {
    expect(updateStuckState(-1, 999, 0, 1).stuck).toBe(false);
    expect(updateStuckState(-1, 999, 0, 1).stuckCount).toBe(0);
  });
});

describe("resolveBatchTerminated（批结束后 terminated 判定）", () => {
  it("批未 clean（round >= maxRounds 自然退出）→ max-rounds（fail-fast 不进入后续批）", () => {
    expect(resolveBatchTerminated(false, "clean")).toBe("max-rounds");
  });

  it("批 clean → 保持原 terminated（clean）", () => {
    expect(resolveBatchTerminated(true, "clean")).toBe("clean");
  });

  it("5 种 terminated 终态中，其余 4 种（review-failure/aggregator-failure/stuck/fix-failure）由更早路径设置并同步 break，不经本判定", () => {
    // 本判定只在批循环自然结束后调用（此时 terminated 恒为 "clean"）；
    // 结构化终止路径的 terminated 值在到达这里之前已 break 外层循环。
    expect(resolveBatchTerminated(true, "clean")).toBe("clean");
  });
});
