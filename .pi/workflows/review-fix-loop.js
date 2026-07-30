const meta = {
  name: "review-fix-loop",
  description: "xyz-agent review-fix loop: optional fallow pre-scan → parallel review (all 5 dimension agents in one batch) → aggregate → fix → re-review until clean or max rounds. Per-run isolation via runId, state.json tracking, S1 conservative per-agent disable (2 consecutive clean → skip; any fix reactivates all). Agents: arch-boundary / business-logic / type-safety / electron-build / test-coverage.",
  phases: [
    { title: "Scan", detail: "Optional fallow static analysis pre-scan (runs alone before review)" },
    { title: "Review", detail: "Run all 5 dimension agents (skipping disabled ones) in parallel + aggregate" },
    { title: "Fix", detail: "Fix all must-fix issues from aggregated review report" },
  ],
};

// ── Constants & schemas ────────────────────────────────────────────

const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000; // 30 min — 大 diff / 多文件审查时 10 min 不够
// MODEL 不硬编码：优先用 $ARGS.model，否则 undefined（pi 自行解析当前会话模型）。
// 适配点：原 xyz-pi-extensions 版硬编码 "zhipu-coding-plan-router/glm-5.2"，本版改为可选传入。
const MODEL = $ARGS.model;
const CLEAN_THRESHOLD = 2; // S1: 连续 clean 的轮数阈值，达到后 disable 该 agent

const reviewerSchema = {
  type: "object",
  properties: {
    report_file: { type: "string", description: "Absolute path to the written review report (.md)" },
    must_fix: { type: "number", description: "Number of must-fix issues found" },
    suggestion: { type: "number", description: "Number of suggestion-level issues found" },
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

// 适配点：AGENT_DEFS 换为 xyz-agent 的 5 维度（对齐 .agents/agents/review-*.md 实体）。
// 全并行单批 parallel——顺序不影响执行（无批次），按重要性排列便于日志阅读。
// focus 文本是给 agent 的审查焦点提示（与各 agent .md 的 description 对齐，不重复完整 checklist）。
const AGENT_DEFS = [
  { name: "review-arch-boundary", title: "ARCH BOUNDARY REVIEW", report: "arch-boundary",
    focus: "Electron 分层（main/preload/renderer/shared）、runtime 三层（transport/services/infra）、WS session 隔离、IPC/emit 规范、数据目录隔离、路径白名单动态化、ENV SSOT、Extension vs Plugin 边界、v3 视图拓扑。" },
  { name: "review-business-logic", title: "BUSINESS LOGIC REVIEW", report: "business-logic",
    focus: "业务逻辑正确性、边界条件（空/null/极大极小）、异常路径、回归风险、错误状态重置（isGenerating/streamingMessage）、emit 单 payload、Promise.allSettled、streaming message 生命周期、session 双状态、文件持久化与 Store 同步。" },
  { name: "review-type-safety", title: "TYPE SAFETY REVIEW", report: "type-safety",
    focus: "完整类型标注、禁止 any（显式/隐式/Record<string,any>）、类型守卫替代 as any、运行 tsc/vue-tsc、Pi* 类型分层约束（仅 infra 层可见，services/transport 不应出现）。" },
  { name: "review-electron-build", title: "ELECTRON BUILD REVIEW", report: "electron-build",
    focus: "tsup 配置（platform/target/noExternal 覆盖 dependencies/Worker entry 独立打包/CJS 兼容）、electron-builder（files 显式含 dist/runtime、asarUnpack、无外部 symlink）、子进程启动（process.execPath + ELECTRON_RUN_AS_NODE、resourcesPath 而非 getAppPath）、打包验证三阶段、打包改动逐 commit。" },
  { name: "review-test-coverage", title: "TEST COVERAGE REVIEW", report: "test-coverage",
    focus: "新增逻辑有对应测试、边缘情况覆盖（空/null/边界/错误路径）、vitest 框架合规（禁 node:test、禁 tsx --test、fake timers）、xyz-agent 领域测试点（session 双状态/Extension vs Plugin/ports 接口/Pi 类型翻译）。" },
];

// ── Per-run isolation: runId-scoped directories ────────────────────

const fs = require("fs");

const RUN_ID = ($ARGS._runId && typeof $ARGS._runId === "string")
  ? $ARGS._runId
  : "run-" + Date.now();
const RUN_ROOT = `/tmp/review-fix-loop/${RUN_ID}`;
const STATE_FILE = `${RUN_ROOT}/state.json`;

fs.mkdirSync(RUN_ROOT, { recursive: true });
log(`Run directory: ${RUN_ROOT}`);

// ── State management (persistent, atomic writes) ───────────────────

/**
 * state.json shape:
 * {
 *   meta: { runId, workspace, model, startedAt },
 *   agentStatus: { [agentName]: { consecutiveClean, disabled, lastActiveRound, lastMustFix } },
 *   rounds: [ { round, mustFix, suggestion, modifiedFiles?, agents: [ {name, must_fix, suggestion, clean} ] } ]
 * }
 */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {
      meta: { runId: RUN_ID, workspace: $WORKSPACE || "", model: MODEL || "(default)", startedAt: new Date().toISOString() },
      agentStatus: {},
      rounds: [],
    };
  }
}

function saveState(state) {
  // Atomic write: tmp + rename to avoid partial reads mid-write.
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function recordAgentRound(state, agentName, mustFix, suggestion, round) {
  const clean = mustFix === 0;
  const status = state.agentStatus[agentName] || { consecutiveClean: 0, disabled: false, lastActiveRound: 0, lastMustFix: undefined };
  status.consecutiveClean = clean ? status.consecutiveClean + 1 : 0;
  status.disabled = status.consecutiveClean >= CLEAN_THRESHOLD;
  status.lastActiveRound = round;
  status.lastMustFix = mustFix;
  state.agentStatus[agentName] = status;
  return { ...status, cleanThisRound: clean };
}

function reactivateAll(state) {
  // S1 conservative: any fix reactivates all disabled agents.
  for (const name of Object.keys(state.agentStatus)) {
    const s = state.agentStatus[name];
    s.disabled = false;
    // Note: consecutiveClean is NOT reset — only re-disabled on next 2 consecutive cleans.
    // But since fix happened, the next review round's result will reset it naturally.
  }
}

function saveRoundSnapshot(state, round, mustFix, suggestion, agentResults, modifiedFiles) {
  state.rounds.push({
    round, mustFix, suggestion,
    agents: agentResults.map((a) => ({ name: a.name, must_fix: a.must_fix, suggestion: a.suggestion, clean: a.clean })),
    modifiedFiles: modifiedFiles || [],
  });
  saveState(state);
}

// ── Helpers ────────────────────────────────────────────────────────

function parseResult(raw) {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw === "string") {
    // Strip markdown code fences (```json ... ```) — common LLM failure mode.
    let s = raw.trim();
    const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i);
    if (fence) s = fence[1].trim();
    // If surrounded by prose, extract the outermost JSON object.
    if (!s.startsWith("{") && !s.startsWith("[")) {
      const first = s.indexOf("{");
      const last = s.lastIndexOf("}");
      if (first !== -1 && last > first) s = s.slice(first, last + 1);
    }
    try { return JSON.parse(s); } catch { /* fall through */ }
  }
  return null;
}

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

// Fallback: aggregator agent sometimes writes aggregated.md correctly but
// returns malformed JSON. Recover must_fix/suggestion counts from the file
// so the loop can still reach the clean gate. Format produced by aggregator:
//   "## Summary\n- Must-fix: 0\n- Suggestions: 12\n- Infos: 17"
function parseAggregatedMd(content) {
  const mustFixMatch = content.match(/[-*]\s*Must[-_]fix\s*[:：]\s*(\d+)/i);
  if (!mustFixMatch) return null;
  const suggestionMatch = content.match(/[-*]\s*Suggestions?\s*[:：]\s*(\d+)/i);
  return {
    must_fix: parseInt(mustFixMatch[1], 10),
    suggestion: suggestionMatch ? parseInt(suggestionMatch[1], 10) : 0,
  };
}

// ── Build review agent calls (respecting disabled agents) ─────────

// 适配点：BASE_REF 可配（bare repo workspace 可能需要），diffCmd 用模板拼接。
// 适配点：prompt 同时给 `output 路径：` 和 `Write report to:` 两个信息源，
// 兼容现有 agent .md 里「task prompt 中必须包含 output」的约定。
function buildReviewCalls(round, max, roundDir, baseRef, fallowSummary, disabledSet) {
  const header = `Round ${round}/${max}`;
  const diffCmd = "Review \`git diff " + baseRef + "...HEAD\` for all changes against " + baseRef + ".";
  const fallowCtx = fallowSummary ? "\nFallow pre-scan context: " + fallowSummary : "";

  const baseCall = (def) => ({
    prompt: [header + " — " + def.title, "", diffCmd,
      "Focus: " + def.focus,
      "output 路径：" + roundDir + "/" + def.report + ".md",
      "Write report to: " + roundDir + "/" + def.report + ".md" + fallowCtx].join("\n"),
    agent: def.name,
    model: MODEL,
    schema: reviewerSchema,
    description: def.name + "-round-" + round,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
  });

  return AGENT_DEFS
    .filter((def) => !disabledSet.has(def.name))
    .map(baseCall);
}

// ── Main Loop ──────────────────────────────────────────────────────

const MAX = $ARGS.maxRounds ?? 10;
const STUCK_THRESHOLD = 3;
// 适配点：默认 skipFallow=true（xyz-agent 未确认装 fallow，保守跳过；原 xyz-pi-extensions 版默认 false）
const SKIP_FALLOW = $ARGS.skipFallow ?? true;
// 适配点：baseRef 可配（默认 main，bare repo workspace / 非 main 主分支场景可覆盖）
const BASE_REF = $ARGS.baseRef || "main";
const state = loadState();
let totalFixed = 0;
let round = 0;
let clean = false;
let stuckCount = 0;
let prevTotal = -1;

// Optional fallow scan (once before first round)
let fallowSummary = "";
if (!SKIP_FALLOW) {
  phase("Scan");
  try {
    const fallowRaw = await agent({
      prompt: [
        "Fallow pre-scan for review-fix-loop.",
        "",
        "Steps:",
        "1. Check if fallow is installed: `which fallow`",
        "2. If installed, run: `fallow audit --base " + BASE_REF + " --format json --quiet`",
        "3. Extract: complexity hotspots, dead code, unused exports, circular deps",
        "4. Write summary to " + RUN_ROOT + "/fallow-scan.md",
        "5. If fallow not installed, write a one-line note and skip",
      ].join("\n"),
      description: "fallow-prescan",
      model: MODEL,
    });
    const fr = parseResult(fallowRaw);
    if (fr) fallowSummary = fr.summary || fr.output || "";
    if (fallowSummary) log("Fallow scan: " + fallowSummary);
  } catch {
    log("Fallow scan skipped.");
  }
}

while (round < MAX) {
  round++;
  log(`--- Round ${round}/${MAX} ---`);

  // ── Determine disabled agents (S1 conservative) ──────────
  const disabledSet = new Set(
    Object.entries(state.agentStatus)
      .filter(([, s]) => s.disabled)
      .map(([name]) => name)
  );
  if (disabledSet.size > 0) {
    log("Disabled agents (clean ≥ " + CLEAN_THRESHOLD + " consecutive): " + [...disabledSet].join(", "));
  }

  // ── Phase: Review (all active agents in parallel) ───────
  // 不分批：review agent 不带 cwd、不写 worktree、只读 git diff，无 worktree 池约束。
  // execute-full-workflow.js 的 review 阶段也是单批 parallel 全并行（line 643）；
  // 只有 dev wave（带 cwd、受 worktree 池上限约束）才分 sub-batch。
  phase("Review");
  const roundDir = `${RUN_ROOT}/round-${round}`;
  fs.mkdirSync(roundDir, { recursive: true });
  const allCalls = buildReviewCalls(round, MAX, roundDir, BASE_REF, fallowSummary, disabledSet);

  if (allCalls.length === 0) {
    log("All agents disabled but code not clean — reactivating all for safety.");
    reactivateAll(state);
    saveState(state);
    continue; // restart this round with all agents active
  }

  // 全并行：所有 active agent 单批 parallel（原 xyz-pi-extensions 版分 3+2 两批串行，
  // 那是过度照搬 dev wave 的 worktree 约束——review 无此约束，全并行更高效）
  log("Review: " + allCalls.length + " agent(s) in parallel...");
  const allRaw = await parallel(allCalls);

  // Parse results, tolerate individual failures
  // allRaw 来自上面 parallel(allCalls)，顺序与 allCalls 一一对应
  const reviewResults = [];
  const agentRoundResults = [];
  for (let i = 0; i < allRaw.length; i++) {
    const parsed = parseResult(allRaw[i]);
    if (parsed && typeof parsed.must_fix === "number") {
      reviewResults.push(parsed);
      const def = allCalls[i]; // allCalls[i] corresponds to allRaw[i] via baseCall mapping
      const recorded = recordAgentRound(state, def.agent, parsed.must_fix, parsed.suggestion ?? 0, round);
      agentRoundResults.push({ name: def.agent, must_fix: parsed.must_fix, suggestion: parsed.suggestion ?? 0, clean: recorded.cleanThisRound });
    } else {
      log("  ⚠ " + allCalls[i].description + " failed, skipping.");
    }
  }
  log(`Reviews: ${reviewResults.length}/${allCalls.length} succeeded.`);

  if (reviewResults.length === 0) {
    log("All review agents failed, stopping.");
    saveState(state);
    break;
  }

  // ── Aggregate ────────────────────────────────────────────
  const aggRaw = await agent({
    prompt: [
      `Round ${round}/${MAX} — AGGREGATE REVIEWS`,
      "",
      "You have TWO outputs to produce: (1) a markdown report file and (2) a JSON return value.",
      "",
      "Sub-review results: " + JSON.stringify(reviewResults, null, 2),
      "outputDir: " + roundDir,
      "",
      "─── PART 1: WRITE FILE ────────────────────────────────────",
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
      `  "report_file": "${roundDir}/aggregated.md",`,
      '  "must_fix": <integer>,',
      '  "suggestion": <integer>',
      "}",
      "",
      "STRICT RULES:",
      "- Field names MUST be exactly: report_file, must_fix, suggestion",
      "  (NOT mustFix, totalMustFix, count, totalMustFixCount, etc.)",
      "- must_fix and suggestion MUST be integers (0, 3, 12) — NOT strings, NOT null, NOT undefined",
      "- The JSON object MUST be the ONLY thing in your final response",
      "- DO NOT wrap in markdown code fences (no ```json blocks)",
      "- DO NOT add prose before/after the JSON (no 'Here is the report:', no explanation)",
      "- DO NOT add fields beyond the three listed",
      "",
      "─── SELF-CHECK before returning ──────────────────────────",
      "1. Did you write " + roundDir + "/aggregated.md? If not, do it first.",
      "2. Is must_fix in your JSON equal to the 'Must-fix: N' in your markdown?",
      "3. Is suggestion in your JSON equal to the 'Suggestions: N' in your markdown?",
      "4. Is your final response the bare JSON object, no fences, no prose?",
      "If any check fails, fix and re-output. The loop breaks on malformed JSON.",
    ].join("\n"),
    agent: "review-aggregator",
    model: MODEL,
    schema: aggregatorSchema,
    description: `aggregate-round-${round}`,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
  });

  let agg = normalizeAggregatorResult(aggRaw);

  // Defense-in-depth: aggregator prompt now enforces JSON shape strictly
  // and parseResult strips code fences, so this fallback should rarely fire.
  // Kept as belt-and-suspenders against LLM regression.
  if (!agg || typeof agg.must_fix !== "number") {
    const rawPreview = (typeof aggRaw === "string" ? aggRaw : JSON.stringify(aggRaw)).slice(0, 200);
    log("Aggregator JSON invalid (len=" + (aggRaw?.length ?? 0) + "): " + rawPreview);

    const fallbackPath = (agg && agg.report_file) || (roundDir + "/aggregated.md");
    try {
      const content = fs.readFileSync(fallbackPath, "utf-8");
      const parsed = parseAggregatedMd(content);
      if (parsed && typeof parsed.must_fix === "number") {
        agg = { report_file: fallbackPath, must_fix: parsed.must_fix, suggestion: parsed.suggestion ?? 0 };
        log("Fallback parsed from " + fallbackPath + ": must_fix=" + agg.must_fix + ", suggestion=" + agg.suggestion);
      } else {
        log("Fallback parse: no Must-fix line in " + fallbackPath);
      }
    } catch (e) {
      log("Fallback read failed: " + e.message);
    }

    if (!agg || typeof agg.must_fix !== "number") {
      log("Aggregator failed and fallback failed, stopping.");
      saveState(state);
      break;
    }
  }

  const mustFix = agg.must_fix;
  const suggestion = agg.suggestion ?? 0;
  log(`Aggregated: ${mustFix} must-fix + ${suggestion} suggestion(s).`);

  // Save snapshot (before fix; modifiedFiles filled after fix)
  const currentRoundSnapshot = { round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [] };

  // ── Gate: clean? ─────────────────────────────────────────
  if (mustFix === 0) {
    clean = true;
    log("Code is clean!");
    state.rounds.push(currentRoundSnapshot);
    saveState(state);
    break;
  }

  // ── Stuck detection ──────────────────────────────────────
  const total = mustFix + suggestion;
  if (prevTotal >= 0 && total >= prevTotal) {
    stuckCount++;
    if (stuckCount >= STUCK_THRESHOLD) {
      log(`Stuck: total issues not decreasing for ${STUCK_THRESHOLD} rounds. Stopping.`);
      state.rounds.push(currentRoundSnapshot);
      saveState(state);
      break;
    }
  } else {
    stuckCount = 0;
  }
  prevTotal = total;

  // ── Phase: Fix ───────────────────────────────────────────
  phase("Fix");

  let reportContent;
  try {
    reportContent = fs.readFileSync(agg.report_file, "utf-8");
  } catch {
    reportContent = "(could not read aggregated report)";
  }

  // Snapshot HEAD before fix: the fix agent commits its changes, so
  // `git diff HEAD` reads empty afterwards. Compare prevHead → working
  // tree afterwards to capture both the new fix commit and any uncommitted edits.
  const prevHead = require("child_process").execSync(
    "git rev-parse HEAD", { encoding: "utf-8", timeout: 10_000 }
  ).trim();

  const fxRaw = await agent({
    prompt: [
      `Fix round ${round}: Fix ALL must-fix issues from the aggregated review report below.`,
      "",
      "## Aggregated Review Report",
      reportContent,
      "",
      "## Instructions",
      "- Fix every must-fix issue listed in the report",
      "- Apply the MINIMAL correct fix (no refactoring, no style changes)",
      "- Verify each fix by reading the changed file afterwards",
      "- After all fixes, commit with message: `fix: review round " + round + " — " + mustFix + " must-fix`",
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
    description: `fix-round-${round}`,
  });

  const fx = parseResult(fxRaw);
  if (!fx) {
    log("Fix agent failed, stopping.");
    state.rounds.push(currentRoundSnapshot);
    saveState(state);
    break;
  }

  const fixedCount = fx.fixed_count ?? mustFix;
  totalFixed += fixedCount;

  // S1: any fix reactivates all agents (conservative — fix may have introduced regressions)
  let modifiedFiles = [];
  try {
    const out = require("child_process").execSync(
      "git diff --name-only " + prevHead, { encoding: "utf-8", timeout: 10_000 }
    ).trim();
    modifiedFiles = out ? out.split("\n") : [];
  } catch { /* empty */ }
  currentRoundSnapshot.modifiedFiles = modifiedFiles;
  state.rounds.push(currentRoundSnapshot);
  reactivateAll(state);
  saveState(state);

  log(`Fixed ${fixedCount} issue(s). Total: ${totalFixed}. Modified ${modifiedFiles.length} file(s). Continuing...`);
}

log("\n=== Loop Complete ===");
saveState(state);

return {
  rounds: round,
  maxRounds: MAX,
  totalFixed,
  clean,
  runDir: RUN_ROOT,
  message: clean
    ? `Code clean after ${round} round(s). ${totalFixed} issue(s) fixed total. State: ${STATE_FILE}`
    : `Stopped after ${round} round(s). ${totalFixed} issue(s) fixed. State: ${STATE_FILE}`,
};
