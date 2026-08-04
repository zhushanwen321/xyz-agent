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
//
// ⚠️ 与 main 的 4.0.0 版分叉（merge 时 add/add 冲突，刻意决策记录）：
//    本版（feat-recursive-optimize）保留——纯函数拆到 review-fix-loop-utils.cjs（vitest 覆盖）、
//    支持 fallow-scan 前置批次、无默认批次（batch1..batchN/agents 必传）、recheckAfterFix 默认 false。
//    main 4.0.0 版自包含 677 行、缺批次参数时默认单批 ["reviewer"]、recheckAfterFix 默认 false。
//    merge 时保留本版（功能更全），详见 .changeset/tidy-waves-description-phase-lint.md。

const meta = {
  name: "review-fix-loop",
  description: "审查-修复循环：多批串行（批内并行 review → aggregate → fix → 重审直到 clean）。必填 targetType（git-diff/file/dir/text）+ target。批次由 batch1..batchN 控制（如 batch1=fallow-scan batch2=reviewer），用于前置检查先行的场景。注意：唯一带写操作/commit 副作用的内置 workflow，autoCommit 默认 false；skipCleanAgents 默认 true + recheckAfterFix 默认 false（clean agent 下轮跳过，与字面语义一致）；传 recheckAfterFix=true 启用可选强回归模式（fix 后重派全批，clean agent 走限定 prompt 只审改动文件）。",
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
  lockReviewBase,
  buildScopedRecheckPrompt,
  wrapUntrusted,
  buildFixPrompt,
  buildR2ReviewPrompt,
  buildAggregatorPrompt,
  resolveReviewReportPath,
  normalizeFixResult,
  validateFixResult,
  reconcileIssues,
  normalizeReviewResult,
  checkConvergence,
  findNeedsRedesign,
  parseResult,
  normalizeAggregatorResult,
  parseAggregatedMd,
  shouldRetryWithReviewPrefix,
  resolveAgentDefs,
  recordAgentClean,
  recordAgentDirty,
  shouldSkipAgent,
  updateStuckState,
  resolveBatchTerminated,
} = require(
  (typeof workerData !== "undefined" && workerData && typeof workerData.scriptPath === "string"
    ? require("path").dirname(workerData.scriptPath)
    : process.cwd()) + "/review-fix-loop-utils.cjs"
);

// 白名单校验：未知参数名（防 batchX 拼错如 batchl）→ 报错
for (const key of Object.keys($ARGS)) {
  if (VALID_ARG_KEYS.has(key)) continue;
  if (/^batch\d+$/.test(key)) continue;
  fail("未知参数: " + key + "（合法参数: targetType/target/batch1..batchN/agents/batchNames/reviewPrompt/fixPrompt/autoCommit/maxRounds/stuckThreshold/model/skipCleanAgents/recheckAfterFix/fixAgent/maxFixAttempts/convergeNewIssues/convergeRounds）");
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
// 默认 recheckAfterFix=false：clean agent 下轮跳过（与 skipCleanAgents=true 字面语义一致），
// RC-5（fix 后全批全量重审放大 token）在默认场景消失。传 true 启用可选强回归模式：fix 后重派
// 全批，clean agent 走限定 prompt（buildScopedRecheckPrompt，只审 modifiedFiles，5.5）。
const recheckAfterFix = normalizeBool($ARGS.recheckAfterFix, "recheckAfterFix", false, fail);
// fixAgent（5.3）：值语义同 batchN 的 agent 项（内置名 / agent.md 路径），解析复用
// resolveAgentDefs 白名单与加载逻辑。传入时 fix 阶段用 agent({agent: ...}) 派发（代码场景
// 的 verify 命令写在该 agent.md 内）；未传保持现状（通用 subagent + 内联 prompt）。
const FIX_AGENT_RAW = typeof $ARGS.fixAgent === "string" && $ARGS.fixAgent.trim()
  ? $ARGS.fixAgent.trim() : undefined;
const FIX_DEF = FIX_AGENT_RAW ? resolveAgentDefs([FIX_AGENT_RAW])[0] : null;
// 5.7 收敛终止参数：maxFixAttempts（needs-redesign 阈值，RC-7）/ convergeNewIssues +
// convergeRounds（新发现率收敛阈值）
const maxFixAttempts = normalizeInt($ARGS.maxFixAttempts, "maxFixAttempts", 2, fail);
const convergeNewIssues = normalizeInt($ARGS.convergeNewIssues, "convergeNewIssues", 1, fail);
const convergeRounds = normalizeInt($ARGS.convergeRounds, "convergeRounds", 2, fail);
const MODEL = typeof $ARGS.model === "string" && $ARGS.model.trim() ? $ARGS.model.trim() : undefined;

// base 锁定（RC-6，5.6）：git-diff 场景 run 启动时锁定 base commit，全程用锁定 hash 构造
// diff 指令，防止 run 期间 base ref 被更新导致各轮 diff 范围不一致。rev-parse 失败（非 git
// 目录 / ref 不存在）降级用原 ref 并 warn，锁定结果随 state.meta.baseHash 记录。
const lockedBase = lockReviewBase(targetType, target);
if (targetType === "git-diff") {
  if (lockedBase.hash) {
    log("Locked review base: " + target + " -> " + lockedBase.hash);
  } else {
    log("WARN: git rev-parse " + target + " failed, falling back to ref for diff base: " + target);
  }
}
const reviewInstruction = buildReviewInstruction(targetType, lockedBase.base);

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
    report_content: { type: "string", description: "Full markdown report body (for schema-only agents without write tool; workflow writes it to <roundDir>/<report>.md)" },
    must_fix: { type: "number", description: "Number of must-fix (critical+major) issues found" },
    suggestion: { type: "number", description: "Number of suggestion-level (minor) issues found" },
    reconciliation: {
      type: "array",
      items: {
        type: "object",
        properties: {
          prev_id: { type: "string", description: "Issue id from the previous round (reconciliation continuation)" },
          status: { type: "string", description: "fixed / not-fixed / regressed — only fixed counts as resolved; fix result claiming fixed is NOT evidence" },
          evidence: { type: "string", description: "What was read/confirmed (file + what changed)" },
        },
        required: ["prev_id", "status"],
      },
      description: "R2+ reconciliation table (structured): MANDATORY for R2+ rounds, optional for R1",
    },
  },
  required: ["report_file", "must_fix", "suggestion"],
};

const aggregatorSchema = {
  type: "object",
  properties: {
    report_file: { type: "string", description: "Absolute path to aggregated.md" },
    must_fix: { type: "number", description: "Total must-fix after dedup across all dimensions" },
    suggestion: { type: "number", description: "Total suggestions after dedup across all dimensions" },
    must_fix_ids: {
      type: "array",
      items: { type: "string" },
      description: "Issue ids of the deduplicated must-fix list (MF-1..N), matching the first column of the markdown table",
    },
    fixes_caution: {
      type: "array",
      items: { type: "string" },
      description: "Caution entries for weak-evidence or high-risk claims (passed to fix stage)",
    },
  },
  required: ["report_file", "must_fix", "suggestion"],
};

// fix schema（5.3）：object[]（issue_id/description/self_check/affected_files）+ deferred。
// 兼容性：normalizeFixResult 对旧格式（fixes string[]、无 deferred）兜底解析。
const fixSchema = {
  type: "object",
  properties: {
    fixed_count: { type: "number", description: "Number of issues fixed" },
    fixes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "Issue identifier from the aggregated report" },
          description: { type: "string", description: "One-line description of the fix" },
          self_check: { type: "string", description: "grep command + hit count + sync action proving the fix is complete" },
          affected_files: { type: "array", items: { type: "string" }, description: "Files touched by this fix + files checked/synced as reference points" },
        },
      },
    },
    deferred: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issue_id: { type: "string" },
          severity: { type: "string", description: "Must be minor — critical/major must not be deferred" },
          reason: { type: "string", description: "Concrete cost description: which files/mechanisms involved, why high cost, suggested follow-up" },
        },
      },
    },
  },
  required: ["fixed_count"],
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
      fixResults: [],
      issues: undefined,
      knownRemaining: [],
      convergeStreak: 0,
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

// 上一轮 fix 的 modifiedFiles（git diff 实测，fix 阶段写入 batchRounds）。
// recheck 限定 prompt（scoped）的 scope 来源（初版 = modifiedFiles）。
function lastModifiedFiles() {
  const b = state.batches[state.batches.length - 1];
  const r = b && b.rounds && b.rounds[b.rounds.length - 1];
  return (r && Array.isArray(r.modifiedFiles)) ? r.modifiedFiles : [];
}

function buildReviewCall(def, round, max, batchIndex, roundDir, scoped) {
  const header = "Batch " + batchIndex + " Round " + round + "/" + max + " — " + BATCH_NAMES[batchIndex - 1];
  const prevBatchesHint = batchIndex > 1
    ? "\nPrior batch reports (optional context): " + RUN_ROOT + "/batch-*/  (use read)"
    : "";
  const base = {
    model: MODEL || def.model,
    schema: reviewerSchema,
    description: def.name,
    timeoutMs: 1_800_000,
    // returnMeta: true — 与 recursive-split 脚本的 executeActionAgent 对齐：失败时 resolve
    // {value, error}，raw.error 可检测（review- 前缀兜底/结构化终止可达）；成功时
    // value = parsedOutput ?? content，parseResult 作用于 raw.value（MF-1）。
    returnMeta: true,
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
        "3. If installed, run: `fallow audit --base " + lockedBase.base + " --format json --quiet`",
        "4. Extract: complexity hotspots, dead code, unused exports, circular deps",
        "5. Classify findings: critical/major count into must_fix; minor into suggestion.",
        "",
        "output 路径：" + roundDir + "/" + def.report + ".md",
        "Write report to: " + roundDir + "/" + def.report + ".md",
      ].join("\n"),
    };
  }

  // R2+ 三段式分支（5.2）：round>1 且非 scoped → verify-first 对账 + known-remaining + 收敛 hunt。
  // scoped 分支（recheck 限定）在下方单独处理（含对账段）。
  if (round > 1 && !scoped) {
    const prevRoundDir = RUN_ROOT + "/batch-" + batchIndex + "/round-" + (round - 1);
    return {
      ...base,
      prompt: buildR2ReviewPrompt({
        header, round, max, roundDir,
        reportFile: def.report,
        aggPath: prevRoundDir + "/aggregated.md",
        fixResult: state.fixResults && state.fixResults.length
          ? state.fixResults[state.fixResults.length - 1]
          : null,
        knownRemaining: (state.knownRemaining && Array.isArray(state.knownRemaining)) ? state.knownRemaining : [],
      }),
      agent: def.isCustom ? undefined : def.name,
    };
  }

  // recheck 限定分支（5.5）：clean agent 重派时只审 fix 改动文件 + 自检关联点
  // （scope = modifiedFiles ∪ affected_files，后者来自 state.fixImpactFiles），不诱导全量重扫。
  if (scoped) {
    return {
      ...base,
      prompt: buildScopedRecheckPrompt({
        header, round, max, roundDir,
        reportFile: def.report,
        modifiedFiles: lastModifiedFiles(),
        affectedFiles: (state.fixImpactFiles && Array.isArray(state.fixImpactFiles)) ? state.fixImpactFiles : [],
        aggPath: RUN_ROOT + "/batch-" + batchIndex + "/round-" + (round - 1) + "/aggregated.md",
        fixResult: state.fixResults && state.fixResults.length
          ? state.fixResults[state.fixResults.length - 1]
          : null,
      }),
      agent: def.isCustom ? undefined : def.name,
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
// 5.6 锁定结果落 state.meta.baseHash（commit 1 声称与实现一致化，run 后可从 state.json 追溯审查基线）
state.meta = state.meta || {};
state.meta.baseHash = lockedBase.hash || "";
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
    let scopedClean = new Set(); // recheckAfterFix 重派时：上一轮 clean 的 agent 本轮走限定 prompt
    if (recheckAfterFix && round > 1 && roundHasFix) {
      scopedClean = new Set(cleanNames); // 重派前快照上一轮 clean 集合
      active = defs; // fix 后重派全批（强回归模式）
      cleanNames.clear();
    }

    if (active.length === 0) {
      log("All agents clean/skipped — batch " + batchIndex + " done.");
      batchClean = true;
      break;
    }

    log("Review: " + active.map((d) => d.name).join(", ") + " (" + active.length + " agent(s) in parallel)...");
    const calls = active.map((def) => buildReviewCall(def, round, maxRounds, batchIndex, roundDir, scopedClean.has(def.name)));
    const allRaw = await parallel(calls.map(runReviewAgent));

    // per-agent 结果区分：parallel 结果与 calls 一一对应
    const reviewResults = [];
    const agentRoundResults = [];
    const reconSeen = new Set(); // R2+ reconciliation 声明的上轮 ID（status !== fixed）——stuck ID 驱动数据源（5.1）
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
      const parsed = normalizeReviewResult(raw.value);
      if (parsed) {
        // 5.8 通用落盘：schema-only agent（report_content 无 report_file，如 doc-reviewer）→
        // workflow 写盘到 <roundDir>/<def.report>.md 并填入 report_file（aggregator 读取路径不变）。
        const reportPath = resolveReviewReportPath(parsed, roundDir, active[i].report);
        if (reportPath && !(parsed.report_file && parsed.report_file.trim())) {
          try {
            fs.writeFileSync(reportPath, parsed.report_content || "", "utf-8");
            parsed.report_file = reportPath;
          } catch (e) {
            log("WARN: failed to write report_content to " + reportPath + " — " + e.message);
          }
        }
        reviewResults.push(parsed);
        for (const r of parsed.reconciliation) {
          if (r.status !== "fixed") reconSeen.add(r.prev_id);
        }
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
        finalMessage = "Batch " + batchIndex + " round " + round + ": 审查 agent 结果无效（缺 must_fix） " + active[i].name + " raw=" + JSON.stringify(raw.value).slice(0, 400);
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
      prompt: buildAggregatorPrompt({
        header: "Batch " + batchIndex + "/" + BATCHES.length + " Round " + round + "/" + maxRounds + " — AGGREGATE REVIEWS",
        round, max: maxRounds, roundDir,
        reviewResults,
      }),
      model: MODEL,
      schema: aggregatorSchema,
      description: "aggregate",
      timeoutMs: 1_800_000,
      returnMeta: true,
    });

    // returnMeta 下 aggRaw = {value, error}；失败时 value 为空串、error 在 finalMessage 透出（MF-1）
    const aggValue = aggRaw?.value ?? aggRaw;
    let agg = normalizeAggregatorResult(aggValue);

    if (!agg || typeof agg.must_fix !== "number") {
      const rawPreview = (aggValue === undefined ? "undefined" : typeof aggValue === "string" ? aggValue : JSON.stringify(aggValue)).slice(0, 200);
      log("Aggregator JSON invalid (len=" + (typeof aggValue === "string" ? aggValue.length : 0) + "): " + rawPreview);
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
        finalMessage = "Batch " + batchIndex + " round " + round + ": aggregator 失败且 fallback 解析失败"
          + (aggRaw && typeof aggRaw === "object" && aggRaw.error ? " — " + aggRaw.error : "");
        batchIndex = BATCHES.length + 1; // 终止外层循环
        break;
      }
    }

    const mustFix = agg.must_fix;
    const suggestion = agg.suggestion ?? 0;
    log("Aggregated: " + mustFix + " must-fix + " + suggestion + " suggestion(s).");

    // 5.1：R1 的 aggregator must_fix_ids 初始化 state.issues（数字 ID 起点）
    if (round === 1 && agg.must_fix_ids && agg.must_fix_ids.length > 0) {
      if (!state.issues) state.issues = {};
      for (const id of agg.must_fix_ids) {
        if (!state.issues[id]) {
          state.issues[id] = {
            firstSeen: 1, severity: "must-fix", status: "open",
            history: [{ round: 1, status: "open" }], fixAttempts: 0,
          };
        }
      }
    }

    // ── Stuck detection ─────────────────────────────────────
    // 5.1 ID 驱动：R2+ 用 reconciliation 声明的 seenIds + reconcileIssues（同一 ID 连续 N 轮
    // open/regressed）；无 reconciliation 数据（R1 或 reviewer 未填）降级计数式 updateStuckState
    // （现状语义，MF-2 注释保留）。needs-redesign（fixAttempts>=2）在 wave 5 接入。
    let stuck = { stuck: false };
    if (round > 1 && reconSeen.size > 0) {
      const rec = reconcileIssues(state.issues || {}, { seenIds: reconSeen, round, stuckThreshold });
      state.issues = rec.issues;
      state.knownRemaining = rec.knownRemaining;
      stuck = { stuck: rec.stuck, stuckIds: rec.stuckIds };
      log("Reconcile: " + Object.keys(rec.issues).length + " tracked issue(s), known-remaining: " + rec.knownRemaining.length);

    } else {
      const s = updateStuckState(prevMustFix, stuckCount, mustFix, stuckThreshold);
      stuckCount = s.stuckCount;
      prevMustFix = s.prevMustFix;
      stuck = { stuck: s.stuck };
    }
    if (stuck.stuck) {
      const stuckIds = (stuck.stuckIds || []).join(", ");
      log("Stuck: issue(s) not converging for " + stuckThreshold + " rounds: " + stuckIds + ". Stopping.");
      batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [] });
      state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
      saveState(state);
      terminated = "stuck";
      finalMessage = "Batch " + batchIndex + " round " + round + ": 问题 " + stuckIds + " 连续 " + stuckThreshold + " 轮未收敛";
      batchIndex = BATCHES.length + 1;
      break;
    }

    // 5.7 needs-redesign（RC-7）：fixAttempts >= maxFixAttempts 且 regressed → 终止。
    // 顺序在 stuck 之后：stuck（一直在）信息更宏观，needs-redesign（修不好）更具体，先 stuck 后 redesign。
    if (round > 1 && state.issues) {
      const redesign = findNeedsRedesign(state.issues, maxFixAttempts);
      if (redesign.length > 0) {
        const ids = redesign.map((r) => r.issue_id).join(", ");
        log("Needs redesign: " + ids + " not converging after " + maxFixAttempts + " fix attempts. Stopping.");
        batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [] });
        state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
        saveState(state);
        terminated = "needs-redesign";
        finalMessage = "Batch " + batchIndex + " round " + round + ": 问题 " + ids + " 经 " + maxFixAttempts
          + " 次修复仍未收敛，属于需要重新设计而非继续补丁的结构性问题，请人工介入。残留: "
          + (state.knownRemaining && state.knownRemaining.length ? state.knownRemaining.join("; ") : "无 deferred");
        batchIndex = BATCHES.length + 1;
        break;
      }

      // 5.7 新发现率收敛：连续 convergeRounds 轮新发现 <= convergeNewIssues → converged
      const newFindings = Object.values(state.issues).filter((i) => i.firstSeen === round).length;
      const conv = checkConvergence({
        prevStreak: state.convergeStreak || 0, newFindings,
        convergeNewIssues, convergeRounds,
      });
      state.convergeStreak = conv.streak;
      if (conv.converged) {
        log("Converged: new findings <= " + convergeNewIssues + " for " + convergeRounds + " rounds. Stopping.");
        batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [] });
        state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
        saveState(state);
        terminated = "converged";
        finalMessage = "Batch " + batchIndex + " round " + round + ": 新发现率收敛（连续 " + convergeRounds
          + " 轮新问题 ≤" + convergeNewIssues + "）。残留: "
          + (state.knownRemaining && state.knownRemaining.length ? state.knownRemaining.join("; ") : "无 deferred");
        batchIndex = BATCHES.length + 1;
        break;
      }
    }

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
      prompt: buildFixPrompt({
        header: "Fix round " + round + " (batch " + batchIndex + ")",
        reportContent,
        fixPrompt: FIX_DEF && FIX_DEF.isCustom
          ? fixPrompt + "\n\nFixer specification (from agent file):\n" + FIX_DEF.systemPrompt
          : fixPrompt,
        commitInstr,
        caution: agg.fixes_caution && agg.fixes_caution.length ? agg.fixes_caution : [],
      }),
      schema: fixSchema,
      model: MODEL,
      description: "fix",
      returnMeta: true,
      ...(FIX_DEF && !FIX_DEF.isCustom ? { agent: FIX_DEF.name } : {}),
    });

    // returnMeta 下 fxRaw = {value, error}：先查 error（失败分支可达，MF-1），再对 value 做 parseResult
    if (fxRaw && typeof fxRaw === "object" && fxRaw.error) {
      // fix agent 调用失败（AgentRegistry not found / 超时等）。
      // 与 review 路径（raw.error → review-failure）对齐：结构化终止而非静默当成功——
      // 否则 fixed_count 缺失被 `?? mustFix` 回退，totalFixed 虚增且 must_fix 不降白跑轮次（MF-1）。
      log("Fix agent failed, stopping.");
      batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [] });
      state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
      saveState(state);
      terminated = "fix-failure";
      finalMessage = "Batch " + batchIndex + " round " + round + ": fix agent 调用失败 — " + fxRaw.error;
      batchIndex = BATCHES.length + 1;
      break;
    }
    const fx = parseResult(fxRaw.value);
    const fixResult = fx ? normalizeFixResult(fx) : null;
    if (!fixResult) {
      log("Fix agent failed, stopping.");
      batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [] });
      state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
      saveState(state);
      terminated = "fix-failure";
      finalMessage = "Batch " + batchIndex + " round " + round + ": fix agent 结果无效";
      batchIndex = BATCHES.length + 1;
      break;
    }

    // ES3 硬校验（5.3 红线）：deferred 只允许 minor，显式非 minor → fix-failure（结构化终止）
    const es3Violations = validateFixResult(fixResult);
    if (es3Violations.length > 0) {
      log("ES3 violation: deferred contains non-minor severity — " + JSON.stringify(es3Violations));
      batchRounds.push({ round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [] });
      state.batches.push({ index: batchIndex, name: BATCH_NAMES[batchIndex - 1], rounds: batchRounds });
      saveState(state);
      terminated = "fix-failure";
      finalMessage = "Batch " + batchIndex + " round " + round + ": deferred 含非 minor 条目（must-fix 不得 defer）— "
        + es3Violations.map((v) => v.issue_id + "(" + v.severity + ")").join(", ");
      batchIndex = BATCHES.length + 1;
      break;
    }

    // ES2 软校验（5.3 证据标准）：defer 理由过短/无实质 → warning 日志（不终止）
    for (const d of fixResult.deferred) {
      const reason = typeof d.reason === "string" ? d.reason : "";
      if (reason.trim().length < 20) {
        log("WARN: deferred reason too short / no concrete cost description: " + JSON.stringify(d));
      }
    }

    // affected_files 并入 state.fixImpactFiles（5.3/5.5）：recheck scope = modifiedFiles ∪ fixImpactFiles
    const impactFiles = [];
    for (const f of fixResult.fixes) {
      if (Array.isArray(f.affected_files)) {
        for (const af of f.affected_files) {
          if (typeof af === "string" && af.trim() && !impactFiles.includes(af.trim())) impactFiles.push(af.trim());
        }
      }
    }
    state.fixImpactFiles = impactFiles;

    // 5.1：fix 结果标记 fix-attempted（ID 对账驱动）+ fixResults 落库（R2+ prompt 输入）
    if (state.issues) {
      for (const f of fixResult.fixes) {
        if (f && typeof f.issue_id === "string" && state.issues[f.issue_id]) {
          state.issues[f.issue_id].status = "fix-attempted";
          state.issues[f.issue_id].history.push({ round, status: "fix-attempted" });
        }
      }
    }
    if (!state.fixResults) state.fixResults = [];
    state.fixResults.push(fixResult);

    const fixedCount = fixResult.fixed_count ?? mustFix;
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

  terminated = resolveBatchTerminated(batchClean, terminated);
  if (terminated === "max-rounds") {
    // 该批达到 maxRounds 仍残留 must-fix → fail-fast，不进入后续批
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
  // 5.9 terminated 透出：非 clean 时 message 含终止原因 + 残留 ID 清单 + deferred 理由
  // （stuck/needs-redesign/converged/max-rounds/*-failure 均由 finalMessage 承载）。
  // 渲染层特判（launcher 对 terminated 非 clean 的视觉区分）留 TODO：当前 tool 结果
  // 已含完整 message，主 agent 可直接感知差异。
  message: terminated === "clean"
    ? "All batches clean. " + totalFixed + " issue(s) fixed total. State: " + STATE_FILE
    : finalMessage + ". State: " + STATE_FILE,
};
