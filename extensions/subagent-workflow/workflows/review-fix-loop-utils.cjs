// review-fix-loop-utils.cjs — review-fix-loop.js 的可测纯函数模块
//
// 与 recursive-split-utils.cjs 同款模式：workflow 编排逻辑的纯函数抽到独立 .cjs，
// 供 vitest 单测直接 require（extensions/subagent-workflow/src/__tests__/review-fix-loop-utils.test.ts）
// 与 worker 运行时共用（review-fix-loop.js 经 workerData.scriptPath 定位本文件）。
//
// 本文件不依赖 workflow 全局（$ARGS/agent/parallel/phase/log），所有需要报错的函数
// 通过 fail(msg) 回调注入（调用方抛 "review-fix-loop: <msg>"，与 workflow 内 fail() 一致）。
"use strict";

const fs = require("fs");
const path = require("path");

const TARGET_TYPES = ["git-diff", "file", "dir", "text"];
const VALID_ARG_KEYS = new Set([
  "targetType", "target", "agents", "batchNames", "reviewPrompt", "fixPrompt",
  "autoCommit", "maxRounds", "stuckThreshold", "model", "skipCleanAgents",
  "recheckAfterFix", "_runId",
]);

function normalizeBool(v, name, def, fail) {
  if (v === undefined || v === null || v === "") return def;
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  fail("参数 " + name + " 必须是布尔值（true/false），实际: " + JSON.stringify(v));
}

function normalizeInt(v, name, def, fail) {
  if (v === undefined || v === null || v === "") return def;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n <= 0) fail("参数 " + name + " 必须是正整数，实际: " + JSON.stringify(v));
  return n;
}

/**
 * 批次解析：batch1..batchN（缺号报错）/ agents 简写。两者必传其一，缺省直接报错（无默认 agent）。
 * @param args $ARGS 形状的对象（batchN 键、agents 键）
 * @param fail 报错回调（抛错终止）
 * @returns string[][] 每批的 agent 名/文件路径数组
 */
function parseBatches(args, fail) {
  const batchKeys = Object.keys(args)
    .filter((k) => /^batch\d+$/.test(k))
    .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10));
  const nums = batchKeys.map((k) => parseInt(k.slice(5), 10));
  for (let i = 1; i <= nums.length; i++) {
    if (!nums.includes(i)) fail("批次参数缺号：有 batch" + nums.join("/") + " 但无 batch" + i + "（批次必须连续编号）");
  }
  if (args.agents !== undefined && args.batch1 !== undefined) {
    fail("agents 与 batch1 不能同时传（agents 是单批简写）");
  }

  let rawBatches;
  if (batchKeys.length > 0) {
    rawBatches = batchKeys.map((k) => args[k]);
  } else if (args.agents !== undefined) {
    rawBatches = [args.agents];
  } else {
    fail("缺少批次参数：必须传 batch1..batchN 或 agents 指定审查 agent（无默认 agent）");
  }

  return rawBatches.map((raw, idx) => {
    if (typeof raw !== "string" || !raw.trim()) fail("batch" + (idx + 1) + " 不能为空");
    const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) fail("batch" + (idx + 1) + " 为空（逗号分隔 agent 名/文件路径）");
    if (new Set(names).size !== names.length) fail("batch" + (idx + 1) + " 内存在重复 agent: " + names);
    return names;
  });
}

/** batchNames 数量校验 + 默认名生成（无 batchNames 时 "batch-<i>"）。 */
function resolveBatchNames(rawBatchNames, batches, fail) {
  if (rawBatchNames.length > 0 && rawBatchNames.length !== batches.length) {
    fail("batchNames 数量（" + rawBatchNames.length + "）必须与批数（" + batches.length + "）一致");
  }
  return rawBatchNames.length ? rawBatchNames : batches.map((_, i) => "batch-" + (i + 1));
}

/** fallow-scan 只在 git-diff 类型下有意义。 */
function validateFallowScan(batches, targetType, fail) {
  for (let i = 0; i < batches.length; i++) {
    if (batches[i].includes("fallow-scan") && targetType !== "git-diff") {
      fail("fallow-scan 只支持 targetType=git-diff（它审查 git 变更的静态分析），实际 targetType=" + targetType);
    }
  }
}

/** 审查指令模板（按 targetType 生成，注入每个 review agent 的 prompt）。 */
function buildReviewInstruction(targetType, target) {
  switch (targetType) {
    case "git-diff":
      return "Review `git diff " + target + "...HEAD` for all committed changes against " + target + ".\n" +
        "ALSO run `git status --porcelain` and `git diff` to review uncommitted working-tree changes " +
        "(fixes may be uncommitted when autoCommit=false; uncommitted changes ARE in scope).";
    case "file":
      return "Read and review the file: " + target;
    case "dir":
      return "Explore and review the directory: " + target + " (list files, then read the relevant ones)";
    case "text":
      return "Review target: " + target;
  }
}

/** 结果解析：object 原样返回；字符串剥 fenced json / 提取内嵌 JSON。 */
function parseResult(raw) {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw === "string") {
    let s = raw.trim();
    const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i);
    if (fence) s = fence[1].trim();
    if (!s.startsWith("{") && !s.startsWith("[")) {
      const first = s.indexOf("{");
      const last = s.lastIndexOf("}");
      if (first !== -1 && last > first) s = s.slice(first, last + 1);
    }
    try { return JSON.parse(s); } catch { /* fall through */ }
  }
  return null;
}

/** 聚合结果归一化：must_fix 别名（totalMustFix/mustFix）+ report_file 别名，无 must_fix 数 → null。 */
function normalizeAggregatorResult(raw) {
  const parsed = parseResult(raw);
  if (!parsed) return null;
  const mustFix =
    typeof parsed.must_fix === "number" ? parsed.must_fix :
    typeof parsed.totalMustFix === "number" ? parsed.totalMustFix :
    typeof parsed.mustFix === "number" ? parsed.mustFix : undefined;
  const suggestion =
    typeof parsed.suggestion === "number" ? parsed.suggestion :
    typeof parsed.totalSuggestions === "number" ? parsed.totalSuggestions :
    typeof parsed.suggestions === "number" ? parsed.suggestions : 0;
  if (typeof mustFix !== "number") return null;
  return { report_file: parsed.report_file || parsed.reportFile, must_fix: mustFix, suggestion };
}

/** review- 前缀兜底判定：agent-registry.ts 的报错文案是 `Agent "${name}" not found. ...`
 * （名字夹在 "Agent" 与 "not found" 之间），不能用连续子串 "Agent not found" 匹配。
 * 已带 review- 前缀的 agent 不再重试（防死循环）。 */
function shouldRetryWithReviewPrefix(error, agentName) {
  return typeof error === "string"
    && error.includes("not found")
    && typeof agentName === "string"
    && agentName.length > 0
    && !agentName.startsWith("review-");
}

/** 从 aggregated.md 内容回退解析（JSON 无效时的兜底，依赖 "- Must-fix: N" 固定格式）。 */
function parseAggregatedMd(content) {
  const mustFixMatch = content.match(/[-*]\s*Must[-_]fix\s*[:：]\s*(\d+)/i);
  if (!mustFixMatch) return null;
  const suggestionMatch = content.match(/[-*]\s*Suggestions?\s*[:：]\s*(\d+)/i);
  return {
    must_fix: parseInt(mustFixMatch[1], 10),
    suggestion: suggestionMatch ? parseInt(suggestionMatch[1], 10) : 0,
  };
}

/**
 * 自定义 .md agent frontmatter 解析（纯函数，不碰 fs）。
 * 边界：无 `---` 头时 basename 兜底、frontmatter 未闭合（closeIdx === -1）截断、
 * 引号包裹的值剥引号、空值（`value || undefined`）回退。
 * @param content 文件原文
 * @param fallbackName 无 name 字段时的兜底（通常为 basename）
 * @returns {name, model, description, systemPrompt, report, title, isCustom}
 */
function parseAgentMd(content, fallbackName) {
  let name = fallbackName;
  let model, description;
  let body = content.trim();
  if (content.startsWith("---")) {
    const closeIdx = content.indexOf("---", 3);
    if (closeIdx !== -1) {
      const yaml = content.slice(3, closeIdx);
      body = content.slice(closeIdx + 3).trim();
      const extract = (key) => {
        // 分隔符用 [ \t]* 而非 \s*：\s 含换行，空值 key（如 `name:`）后紧跟的下一行内容
        // 会被 \s* 吞掉换行后捕获成该 key 的值。仅匹配空格/制表符则空值 → .+ 不匹配 → undefined。
        const m = yaml.match(new RegExp("^" + key + ":[ \t]*(.+)$", "m"));
        if (!m) return undefined;
        let v = m[1].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        return v || undefined;
      };
      name = extract("name") || name;
      model = extract("model");
      description = extract("description");
    }
  }
  return { name, model, description, systemPrompt: body, report: name, title: description || name, isCustom: true };
}

/** 自定义 .md agent 加载：fs 读取 + parseAgentMd。读取失败经 fail 回调（缺省时直接抛错）。 */
function loadAgentMd(filePath, fail) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    const msg = "agent 文件读取失败: " + filePath + " (" + e.message + ")";
    if (typeof fail === "function") fail(msg);
    throw new Error("review-fix-loop: " + msg);
  }
  return parseAgentMd(content, path.basename(filePath, ".md"));
}

/** fallow-scan：内置工具型 def（无 .md，跑 fallow audit 静态分析）。 */
const FALLOW_DEF = { name: "fallow-scan", title: "FALLOW STATIC ANALYSIS", report: "fallow-scan", isFallow: true };

/**
 * Agent defs 解析：fallow-scan 常量 / 路径（含 `/` 或 `.md` 后缀）走 loader / 内置 agent 名。
 * 内置名做 `review-` 前缀剥离（与 runReviewAgent 的 review- 前缀兜底重试配对：
 * report 文件名用剥离后的名字，兜底重试才落到同一文件）。
 * @param batchNames 批内 agent 名/文件路径数组
 * @param loader 自定义 loader（测试注入 stub；缺省用 loadAgentMd）
 */
function resolveAgentDefs(batchNames, loader) {
  const loadFn = loader || loadAgentMd;
  return batchNames.map((item) => {
    if (item === "fallow-scan") return FALLOW_DEF;
    if (item.includes("/") || item.endsWith(".md")) return loadFn(item);
    return { name: item, report: item.replace(/^review-/, ""), title: item.toUpperCase() };
  });
}

/** clean 记录：lastCleanBatch + 当时全局 fixCount 快照（跨批跳过判定依据）。 */
function recordAgentClean(state, agentName, batchIndex) {
  const s = state.agentStatus[agentName] || { lastCleanBatch: 0, lastCleanFixCount: 0, lastActiveRound: 0, lastMustFix: undefined };
  s.lastCleanBatch = batchIndex;
  s.lastCleanFixCount = state.fixCount;
  s.lastActiveRound = batchIndex;
  state.agentStatus[agentName] = s;
}

/** dirty 记录：lastActiveRound + 最近 mustFix（不写 clean 快照，保留上次 clean 的 fixCount 基准）。 */
function recordAgentDirty(state, agentName, mustFix, batchIndex) {
  const s = state.agentStatus[agentName] || { lastCleanBatch: 0, lastCleanFixCount: 0, lastActiveRound: 0, lastMustFix: undefined };
  s.lastActiveRound = batchIndex;
  s.lastMustFix = mustFix;
  state.agentStatus[agentName] = s;
}

/**
 * 跨批跳过判定（cross-batch skip 核心状态机）：
 * agent 在更早批 clean（lastCleanBatch < batchIndex）且此后无 fix（fixCount 快照相等）→ 跳过。
 * fixCount 快照比较的相等语义决定是否跳过——clean 后发生过 fix 则不能跳过（该 agent 可能受影响）。
 */
function shouldSkipAgent(status, fixCount, batchIndex) {
  return !!(status && status.lastCleanBatch && status.lastCleanBatch < batchIndex && status.lastCleanFixCount === fixCount);
}

module.exports = {
  TARGET_TYPES,
  VALID_ARG_KEYS,
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
  parseAgentMd,
  loadAgentMd,
  resolveAgentDefs,
  recordAgentClean,
  recordAgentDirty,
  shouldSkipAgent,
};
