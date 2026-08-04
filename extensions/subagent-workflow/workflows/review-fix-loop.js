// review-fix-loop.js — 通用多批审查-修复循环（内置 workflow）
//
// 模式：多批（batch）串行，批内循环（round）：并行 review → aggregate → fix → 重审。
// 批次用于表达前置依赖（fallow 静态分析等前置检查必须先完成，后续审查才有意义）。
// 批内某 agent 已无 must-fix（critical/major）则后续轮跳过，优化 token 效率。
//
// 用法：
//   workflow run review-fix-loop --args targetType=git-diff target=main \
//     batch1=fallow-scan batch2=reviewer autoCommit=true
//   workflow run review-fix-loop --args targetType=file target=/path/to/doc.md \
//     batch1=reviewer autoCommit=false
//
// ⚠️ 唯一带写操作的内置 workflow：fix 阶段会修改文件（autoCommit=true 时 commit）。
// ⚠️ lintScript 约束（本脚本已遵守）：含 parallel() 入口，禁止 bare IIFE；
//    agent() 调用顺序确定（批次按配置顺序稳定排序，callId 重放安全）。

const meta = {
  name: "review-fix-loop",
  description: "审查-修复循环：多批串行（批内并行 review → aggregate → fix → 重审直到 clean）。必填 targetType（git-diff/file/dir/text）+ target。批次由 batch1..batchN 控制（如 batch1=fallow-scan batch2=reviewer），用于前置检查先行的场景。注意：唯一带写操作/commit 副作用的内置 workflow，autoCommit 默认 false；skipCleanAgents 默认 true + recheckAfterFix 默认 true（fix 后重派全批做回归防护），传 recheckAfterFix=false 会跳过 clean agent 复查，存在回归风险。",
  phases: ["Review", "Fix"],
};

// ── 参数解析 + 白名单校验（fail-fast） ────────────────────────────

function fail(msg) {
  throw new Error("review-fix-loop: " + msg);
}

// ── 可测纯函数模块 ────────────────────────────────────────────────
// 参数校验（normalizeBool/normalizeInt/白名单）/批次解析/聚合结果解析/审查指令构建
// 的纯函数在 review-fix-loop-utils.cjs（与 recursive-split-utils.cjs 同款模式，
// vitest 单测见 src/__tests__/review-fix-loop-utils.test.ts）。
// worker 运行时经 workerData.scriptPath 定位自身目录——内置 workflow 在 npm 包内，
// process.cwd() 是用户项目目录，不能作为锚点；其他引擎无 workerData 时回退 cwd。
const {
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
  resolveAgentDefs,
  recordAgentClean,
  recordAgentDirty,
  shouldSkipAgent,
} = require(
  (typeof workerData !== "undefined" && workerData && typeof workerData.scriptPath === "string"
    ? require("path").dirname(workerData.scriptPath)
    : process.cwd()) + "/review-fix-loop-utils.cjs"
);

// 白名单校验：未知参数名（防 batchX 拼错如 batchl）→ 报错
for (const key of Object.keys($ARGS)) {
  if (VALID_ARG_KEYS.has(key)) continue;
  if (/^batch\d+$/.test(key)) continue;
  fail("未知参数: " + key + "（合法参数: targetType/target/batch1..batchN/agents/batchNames/reviewPrompt/fixPrompt/autoCommit/maxRounds/stuckThreshold/model/skipCleanAgents/recheckAfterFix）");
}

const targetType = $ARGS.targetType;
if (!TARGET_TYPES.includes(targetType)) {
  fail("targetType 必填且必须是枚举之一: " + TARGET_TYPES.join("/") + "（实际: " + JSON.stringify(targetType) + "）");
}
const target = typeof $ARGS.target === "string" ? $ARGS.target.trim() : "";
if (!target) fail("target 必填（git-diff 时传 base ref 如 main；file 传路径；dir 传目录；text 传描述）");

const reviewPrompt = typeof $ARGS.reviewPrompt === "string" && $ARGS.reviewPrompt.trim()
  ? $ARGS.reviewPrompt.trim()
  : "审查变更/目标是否存在：逻辑错误、边界条件、类型不安全、遗漏、回归风险、代码规范问题。发现问题分三级：critical（严重，必须修）/ major（重要，应当修）/ minor（轻微，建议修）。critical+major 计入 must_fix。";
const fixPrompt = typeof $ARGS.fixPrompt === "string" && $ARGS.fixPrompt.trim()
  ? $ARGS.fixPrompt.trim()
  : "修复全部 must-fix 问题（critical/major）。最小正确修复，不做重构、不做风格改动。";
const autoCommit = normalizeBool($ARGS.autoCommit, "autoCommit", false, fail);
const maxRounds = normalizeInt($ARGS.maxRounds, "maxRounds", 10, fail);
const stuckThreshold = normalizeInt($ARGS.stuckThreshold, "stuckThreshold", 3, fail);
const skipCleanAgents = normalizeBool($ARGS.skipCleanAgents, "skipCleanAgents", true, fail);
// 默认 recheckAfterFix=true：fix 后重派全批做回归防护（任何 fix 重新启用全部 agent，含此前 clean 的）。
// 注意：传 recheckAfterFix=false 时，clean agent 在后续轮不再复查——若修复在其审查维度引入回归（如
// type-safety clean、business-logic 修复改了类型）则永不暴露。默认组合（skipCleanAgents=true +
// recheckAfterFix=true）保证每轮 fix 后全维度复查，等价旧定制版 S1 语义。
const recheckAfterFix = normalizeBool($ARGS.recheckAfterFix, "recheckAfterFix", true, fail);
const MODEL = typeof $ARGS.model === "string" && $ARGS.model.trim() ? $ARGS.model.trim() : undefined;

const reviewInstruction = buildReviewInstruction(targetType, target);

// 批次解析：batch1..batchN（缺号报错）/ agents 简写 / 默认单批 [reviewer]
const BATCHES = parseBatches($ARGS, fail);

// batchNames（数量校验）
const rawBatchNames = typeof $ARGS.batchNames === "string" && $ARGS.batchNames.trim()
  ? $ARGS.batchNames.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
const BATCH_NAMES = resolveBatchNames(rawBatchNames, BATCHES, fail);

// fallow-scan 只在 git-diff 类型下有意义
validateFallowScan(BATCHES, targetType, fail);

// ── Schemas ─────────────────────────────────────────────────────────

const reviewerSchema = {
  type: "object",
  properties: {
    report_file: { type: "string", description: "Absolute path to the written review report (.md)" },
    must_fix: { type: "number", description: "Number of must-fix (critical+major) issues found" },
    suggestion: { type: "number", description: "Number of suggestion-level (minor) issues found" },
  },
  required: ["report_file", "must_fix", "suggestion"],
};

const aggregatorSchema = {
  type: "object",
  properties: {
    report_file: { type: "string", description: "Absolute path to aggregated.md" },
    must_fix: { type: "number", description: "Total must-fix after dedup across all dimensions" },
    suggestion: { type: "number", description: "Total suggestions after dedup across all dimensions" },
  },
  required: ["report_file", "must_fix", "suggestion"],
};

// ── Per-run isolation: runId-scoped directories ─────────────────────

const fs = require("fs");
const path = require("path");
const os = require("os");

const RUN_ID = ($ARGS._runId && typeof $ARGS._runId === "string") ? $ARGS._runId : "run-" + Date.now();
const RUN_ROOT = path.join(os.tmpdir(), "review-fix-loop", RUN_ID);
const STATE_FILE = RUN_ROOT + "/state.json";

fs.mkdirSync(RUN_ROOT, { recursive: true });
log("Run directory: " + RUN_ROOT);

// ── State management (persistent, atomic writes) ────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {
      meta: {
        runId: RUN_ID, workspace: $WORKSPACE || "", model: MODEL || "(default)",
        targetType, target, batches: BATCHES, startedAt: new Date().toISOString(),
      },
      agentStatus: {},
      fixCount: 0,
      batches: [],
    };
  }
}

function saveState(state) {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// clean 记录（recordAgentClean/recordAgentDirty 与跨批跳过判定 shouldSkipAgent
// 在 review-fix-loop-utils.cjs，vitest 单测见 src/__tests__/review-fix-loop-utils.test.ts）

// ── Agent defs（loadAgentMd/resolveAgentDefs 在 review-fix-loop-utils.cjs） ──

// ── Build review calls ──────────────────────────────────────────────

function buildReviewCall(def, round, max, batchIndex, roundDir) {
  const header = "Batch " + batchIndex + " Round " + round + "/" + max + " — " + BATCH_NAMES[batchIndex - 1];
  const prevBatchesHint = batchIndex > 1
    ? "\nPrior batch reports (optional context): " + RUN_ROOT + "/batch-*/  (use read)"
    : "";
  const base = {
    model: MODEL || def.model,
    schema: reviewerSchema,
    description: def.name,
    timeoutMs: 1_800_000,
  };

  if (def.isFallow) {
    return {
      ...base,
      prompt: [
        header,
        "",
        "Fallow static-analysis pre-scan (tool-based, NOT a git-diff review).",
        "",
        "Steps:",
        "1. Check if fallow is installed: `which fallow`",
        "2. If NOT installed: write the report with a one-line note, must_fix=0, suggestion=0.",
        "3. If installed, run: `fallow audit --base " + target + " --format json --quiet`",
        "4. Extract: complexity hotspots, dead code, unused exports, circular deps",
        "5. Classify findings: critical/major count into must_fix; minor into suggestion.",
        "",
        "output 路径：" + roundDir + "/" + def.report + ".md",
        "Write report to: " + roundDir + "/" + def.report + ".md",
      ].join("\n"),
    };
  }

  const spec = def.isCustom
    ? "\n\nReviewer specification (from agent file):\n" + def.systemPrompt
    : "";
  return {
    ...base,
    prompt: [
      header,
      "",
      reviewInstruction + prevBatchesHint,
      "",
      "Review requirements:",
      reviewPrompt + spec,
      "",
      "output 路径：" + roundDir + "/" + def.report + ".md",
      "Write report to: " + roundDir + "/" + def.report + ".md",
    ].join("\n"),
    agent: def.isCustom ? undefined : def.name,
  };
}

// agent 名解析失败（AgentRegistry not found，报错文案 `Agent "${name}" not found.`）时，尝试 review- 前缀兜底
async function runReviewAgent(call) {
  let raw = await agent(call);
  if (raw && typeof raw === "object" && raw.error
      && shouldRetryWithReviewPrefix(raw.error, call.agent)) {
    log("Agent not found: " + call.agent + " — retrying with review- prefix");
    raw = await agent({ ...call, agent: "review-" + call.agent });
  }
  return raw;
}

// ── Main loop: batches (serial) × rounds (per-batch) ────────────────

const state = loadState();
let totalFixed = 0;
let terminated = "clean";
let finalMessage = "";

for (let batchIndex = 1; batchIndex <= BATCHES.length; batchIndex++) {
  const defs = resolveAgentDefs(BATCHES[batchIndex - 1]);
  const cleanNames = new Set();
  let round = 0;
  let prevMustFix = -1;
  let stuckCount = 0;
  let batchClean = false;
  let roundHasFix = false; // recheckAfterFix 用：上轮是否有 fix
  const batchRounds = [];

  // 跨批跳过：agent 在更早批 clean 且此后无 fix → 本批不派发
  if (batchIndex > 1) {
    for (const def of defs) {
      const s = state.agentStatus[def.name];
      if (shouldSkipAgent(s, state.fixCount, batchIndex)) {
        cleanNames.add(def.name);
        log("Cross-batch skip: " + def.name + " (clean in batch " + s.lastCleanBatch + ", no fix since)");
      }
    }
  }

  while (round < maxRounds) {
    round++;
    log("--- Batch " + batchIndex + "/" + BATCHES.length + " (" + BATCH_NAMES[batchIndex - 1] + ") Round " + round + "/" + maxRounds + " ---");

    phase("Review");
    const roundDir = RUN_ROOT + "/batch-" + batchIndex + "/round-" + round;
    fs.mkdirSync(roundDir, { recursive: true });

    let active = defs.filter((def) => !(skipCleanAgents && cleanNames.has(def.name)));
    if (recheckAfterFix && round > 1 && roundHasFix) {
      active = defs; // fix 后重派全批（回归防护）
      cleanNames.clear();
    }

    if (active.length === 0) {
      log("All agents clean/skipped — batch " + batchIndex + " done.");
      batchClean = true;
      break;
    }

    log("Review: " + active.map((d) => d.name).join(", ") + " (" + active.length + " agent(s) in parallel)...");
    const calls = active.map((def) => buildReviewCall(def, round, maxRounds, batchIndex, roundDir));
    const allRaw = await parallel(calls.map(runReviewAgent));

    // per-agent 结果区分：parallel 结果与 calls 一一对应
    const reviewResults = [];
    const agentRoundResults = [];
    for (let i = 0; i < allRaw.length; i++) {
      const raw = allRaw[i];
      if (raw && typeof raw === "object" && raw.error) {
        // 审查 agent 调用失败（含 AgentRegistry not found / 超时）。不裸 throw——与
        // aggregator-failure/stuck/fix-failure 路径一致：saveState + terminated 结构化终止，
        // 保证 state.json 有记录、调用方拿到结构化结果而非裸异常（MF-3）。
        state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
        saveState(state);
        terminated = "review-failure";
        finalMessage = "Batch " + batchIndex + " round " + round + ": 审查 agent 调用失败 " + active[i].name + " — " + raw.error;
        batchIndex = BATCHES.length + 1; // 终止外层循环
        break;
      }
      const parsed = parseResult(raw);
      if (parsed && typeof parsed.must_fix === "number") {
        reviewResults.push(parsed);
        const def = active[i];
        if (parsed.must_fix === 0) {
          recordAgentClean(state, def.name, batchIndex);
          cleanNames.add(def.name);
        } else {
          recordAgentDirty(state, def.name, parsed.must_fix, batchIndex);
        }
        agentRoundResults.push({ name: def.name, must_fix: parsed.must_fix, suggestion: parsed.suggestion ?? 0, clean: parsed.must_fix === 0 });
      } else {
        // tools 受限的 agent（如 tools: read）会过滤掉 structured-output → schema 失效，
        // 结果缺 must_fix。结构化终止（MF-3），raw 完整 dump 便于定位。
        state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
        saveState(state);
        terminated = "review-failure";
        finalMessage = "Batch " + batchIndex + " round " + round + ": 审查 agent 结果无效（缺 must_fix） " + active[i].name + " raw=" + JSON.stringify(raw).slice(0, 400);
        batchIndex = BATCHES.length + 1; // 终止外层循环
        break;
      }
    }

    if (terminated === "review-failure") break; // 已结构化终止，退出 round 循环（MF-3）

    if (reviewResults.every((r) => r.must_fix === 0)) {
      log("Batch " + batchIndex + " round " + round + ": all agents clean.");
      batchRounds.push({ round, mustFix: 0, suggestion: reviewResults.reduce((a, r) => a + (r.suggestion ?? 0), 0), agents: agentRoundResults, modifiedFiles: [] });
      saveState(state);
      batchClean = true;
      break;
    }

    // ── Aggregate（内置 prompt，不依赖任何 agent.md） ─────────
    const aggRaw = await agent({
      prompt: [
        "Batch " + batchIndex + "/" + BATCHES.length + " Round " + round + "/" + maxRounds + " — AGGREGATE REVIEWS",
        "",
        "You have TWO outputs: (1) a markdown report file and (2) a JSON return value.",
        "",
        "Sub-review results: " + JSON.stringify(reviewResults, null, 2),
        "outputDir: " + roundDir,
        "",
        "─── PART 1: WRITE FILE ───────────────────────────────────",
        "Write the human-readable aggregated report to:",
        roundDir + "/aggregated.md",
        "",
        "Top section MUST be:",
        "```",
        "## Summary",
        "- Must-fix: <N>",
        "- Suggestions: <N>",
        "- Infos: <N>",
        "- Dimensions reviewed: <comma-separated>",
        "- Dedup: <N> duplicates removed",
        "```",
        "",
        "Followed by tables of Must-Fix Issues, Suggestions, Infos, and a Conclusion section.",
        "The format `- Must-fix: N` and `- Suggestions: N` is critical: a fallback parser depends on it.",
        "",
        "─── PART 2: RETURN JSON (CRITICAL — loop reads THIS) ─────",
        "Your FINAL response MUST be a single JSON object and NOTHING ELSE.",
        "",
        "Required shape (exact field names, no aliases, no extras):",
        "{",
        '  "report_file": "' + roundDir + '/aggregated.md",',
        '  "must_fix": <integer>,',
        '  "suggestion": <integer>',
        "}",
        "",
        "STRICT RULES:",
        "- Field names MUST be exactly: report_file, must_fix, suggestion",
        "- must_fix and suggestion MUST be integers — NOT strings, NOT null, NOT undefined",
        "- The JSON object MUST be the ONLY thing in your final response",
        "- DO NOT wrap in markdown code fences, DO NOT add prose before/after",
        "",
        "─── SELF-CHECK before returning ──────────────────────────",
        "1. Did you write " + roundDir + "/aggregated.md? If not, do it first.",
        "2. Is must_fix in your JSON equal to the 'Must-fix: N' in your markdown?",
        "3. Is your final response the bare JSON object, no fences, no prose?",
      ].join("\n"),
      model: MODEL,
      schema: aggregatorSchema,
      description: "aggregate",
      timeoutMs: 1_800_000,
    });

    let agg = normalizeAggregatorResult(aggRaw);

    if (!agg || typeof agg.must_fix !== "number") {
      const rawPreview = (typeof aggRaw === "string" ? aggRaw : JSON.stringify(aggRaw)).slice(0, 200);
      log("Aggregator JSON invalid (len=" + (aggRaw?.length ?? 0) + "): " + rawPreview);
      const fallbackPath = (agg && agg.report_file) || (roundDir + "/aggregated.md");
      try {
        const content = fs.readFileSync(fallbackPath, "utf-8");
        const parsed = parseAggregatedMd(content);
        if (parsed && typeof parsed.must_fix === "number") {
          agg = { report_file: fallbackPath, must_fix: parsed.must_fix, suggestion: parsed.suggestion ?? 0 };
          log("Fallback parsed from " + fallbackPath + ": must_fix=" + agg.must_fix);
        }
      } catch { /* fallback read failed */ }

      if (!agg || typeof agg.must_fix !== "number") {
        log("Aggregator failed and fallback failed, stopping.");
        state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
        saveState(state);
        terminated = "aggregator-failure";
        finalMessage = "Batch " + batchIndex + " round " + round + ": aggregator 失败且 fallback 解析失败";
        batchIndex = BATCHES.length + 1; // 终止外层循环
        break;
      }
    }

    const mustFix = agg.must_fix;
    const suggestion = agg.suggestion ?? 0;
    log("Aggregated: " + mustFix + " must-fix + " + suggestion + " suggestion(s).");

    // ── Stuck detection ─────────────────────────────────────
    // 只跟踪 must_fix：suggestion 是固定噪声（fix agent 只修 must-fix，suggestion 单调不降），
    // 计入 total 会把合法推进（must_fix 每轮在降）误判为 stuck 提前终止（MF-2）。
    const total = mustFix;
    if (prevMustFix >= 0 && total >= prevMustFix) {
      stuckCount++;
      if (stuckCount >= stuckThreshold) {
        log("Stuck: must-fix count not decreasing for " + stuckThreshold + " rounds. Stopping.");
        batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [] });
        state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
        saveState(state);
        terminated = "stuck";
        finalMessage = "Batch " + batchIndex + " round " + round + ": must_fix 数连续 " + stuckThreshold + " 轮不下降";
        batchIndex = BATCHES.length + 1;
        break;
      }
    } else {
      stuckCount = 0;
    }
    prevMustFix = total;

    // ── Fix ─────────────────────────────────────────────────
    phase("Fix");
    let reportContent;
    try {
      reportContent = fs.readFileSync(agg.report_file, "utf-8");
    } catch {
      reportContent = "(could not read aggregated report)";
    }

    let prevHead = "";
    try {
      prevHead = require("child_process").execSync(
        "git rev-parse HEAD", { encoding: "utf-8", timeout: 10_000 }
      ).trim();
    } catch {
      // 非 git 项目（如纯文档目录）：prevHead 为空，跳过 modifiedFiles 统计
    }

    const commitInstr = autoCommit
      ? "- After all fixes, stage ONLY the files you modified: `git add <file1> <file2> ...` (explicit paths).\n" +
        "- NEVER use `git add -A` or `git add .` — the workspace may contain unrelated untracked files.\n" +
        "- Commit with message: `fix: review batch " + batchIndex + " round " + round + " — " + mustFix + " must-fix`"
      : "- Do NOT commit. Leave the fixes in the working tree (autoCommit=false).";

    const fxRaw = await agent({
      prompt: [
        "Fix round " + round + " (batch " + batchIndex + "): Fix ALL must-fix issues from the aggregated review report below.",
        "",
        "## Aggregated Review Report",
        reportContent,
        "",
        "## Instructions",
        "- Fix every must-fix issue listed in the report",
        "- Apply the MINIMAL correct fix (no refactoring, no style changes)",
        "- Verify each fix by reading the changed file afterwards",
        fixPrompt,
        commitInstr,
        "",
        "Return the count of issues fixed.",
      ].join("\n"),
      schema: {
        type: "object",
        properties: {
          fixed_count: { type: "number", description: "Number of issues fixed" },
          fixes: { type: "array", items: { type: "string" }, description: "One-line description of each fix" },
        },
        required: ["fixed_count"],
      },
      model: MODEL,
      description: "fix",
    });

    const fx = parseResult(fxRaw);
    if (!fx) {
      log("Fix agent failed, stopping.");
      batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [] });
      state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
      saveState(state);
      terminated = "fix-failure";
      finalMessage = "Batch " + batchIndex + " round " + round + ": fix agent 结果无效";
      batchIndex = BATCHES.length + 1;
      break;
    }

    const fixedCount = fx.fixed_count ?? mustFix;
    totalFixed += fixedCount;
    state.fixCount++;
    roundHasFix = true;

    let modifiedFiles = [];
    if (prevHead) {
      try {
        const out = require("child_process").execSync(
          "git diff --name-only " + prevHead, { encoding: "utf-8", timeout: 10_000 }
        ).trim();
        modifiedFiles = out ? out.split("\n") : [];
      } catch { /* empty */ }
    }
    batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles });
    saveState(state);

    log("Fixed " + fixedCount + " issue(s). Total: " + totalFixed + ". Modified " + modifiedFiles.length + " file(s). Continuing...");
  }

  if (batchIndex > BATCHES.length) break; // 已终止

  state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });

  if (!batchClean) {
    // 该批达到 maxRounds 仍残留 must-fix → fail-fast，不进入后续批
    terminated = "max-rounds";
    finalMessage = "Batch " + batchIndex + " (" + BATCH_NAMES[batchIndex - 1] + ") 达到 maxRounds=" + maxRounds + " 仍有 must-fix，终止整个 workflow";
    log(finalMessage);
    saveState(state);
    batchIndex = BATCHES.length + 1;
    break;
  }
  saveState(state);
  log("=== Batch " + batchIndex + " (" + BATCH_NAMES[batchIndex - 1] + ") CLEAN ===");
}

log("\n=== Loop Complete ===");
saveState(state);

return {
  batches: BATCHES.length,
  totalFixed,
  terminated,
  targetType,
  target,
  runDir: RUN_ROOT,
  message: terminated === "clean"
    ? "All batches clean. " + totalFixed + " issue(s) fixed total. State: " + STATE_FILE
    : finalMessage + ". State: " + STATE_FILE,
};
