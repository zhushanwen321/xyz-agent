/**
 * review-fix-loop E2E（真实 worker thread + 场景化 mock LLM runner）
 *
 * §7.2 行为/E2E 测试（设计文档 7.2 三条）：
 *   1. R2 prompt 对账段断言 + defer 跨轮传递 mock 剧本（E2E-1）
 *   2. skipCleanAgents 语义 + fixAgent 参数接受（E2E-2）
 *   3. 渲染 gate：非 clean 终止 message 的 [UNRESOLVED] 透出 + ES3 硬校验拦截（E2E-3）
 *   4. M2 回归：全 fixed + 新发现 → reconcile 门控（reconCount）+ 新发现 merge 独立执行（E2E-4）
 *
 * 与 workflows-e2e.test.ts 同模式：真实 runAndWait + 真实 worker thread +
 * 唯一 mock 是 deps.runner（AgentRunner）。runner 按调用分流：
 *   - schema 含 must_fix_ids → aggregator
 *   - schema 含 fixed_count → fix
 *   - 其余 → review agent
 * 剧本按调用序返回固定结构化数据；R2 review 会检查 prompt 内容（defer 跨轮传递验证）。
 *
 * 已知限制：parallel 的 review 调用顺序不保证——剧本不依赖具体 agent 顺序
 * （E2E-2 只断言调用总数，R1 中先到者 dirty 后到者 clean 均可）。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonlRunStore } from "../jsonl-run-store.ts";
import { type LauncherDeps, runAndWait } from "../launcher.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import type { AgentRunner } from "../models/ports.ts";
import type { AgentResult, AgentUsage } from "../models/types.ts";
import {
  type WorkflowMeta,
  WorkflowScript,
  type WorkflowSource,
} from "../models/workflow-script.ts";
import type { WorkflowScriptRegistry } from "../models/workflow-script-registry.ts";
import { WorkerHostImpl } from "../worker-host.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, "..", "..", "..", "workflows");

let sessionDir: string;
let createdStores: JsonlRunStore[] = [];

const MOCK_USAGE: AgentUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 15,
  turns: 1,
};

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

/** 按 schema 形状识别调用阶段（review / aggregator / fix）。 */
function classifyCall(opts: { schema?: unknown }): "review" | "aggregate" | "fix" {
  const props = (opts.schema as JsonSchema | undefined)?.properties ?? {};
  if ("must_fix_ids" in props) return "aggregate";
  if ("fixed_count" in props) return "fix";
  return "review";
}

interface Scenario {
  /** review 调用序 → 返回数据生成器；R2+ 回调收到 prompt 文本（可用于对账/传递断言）。 */
  review: Array<(prompt: string) => Record<string, unknown>>;
  aggregate: () => Record<string, unknown>;
  fix: () => Record<string, unknown>;
}

/**
 * 场景化 mock runner：记录每次调用的 prompt 与分类，按剧本返回。
 * R2 review 调用（剧本元素）若返回含 must_fix: 9 表示"断言失败"信号（测试可见）。
 */
function makeScenarioRunner(scenario: Scenario) {
  const reviewCalls: Array<{ prompt: string; result: Record<string, unknown> }> = [];
  const calls: Array<{ kind: "review" | "aggregate" | "fix"; prompt: string; agent?: string }> = [];
  const run = vi.fn(async (opts: { prompt?: string; schema?: unknown; agent?: string }): Promise<AgentResult> => {
    const kind = classifyCall(opts);
    const prompt = opts.prompt ?? "";
    // m5：记录 agent 字段（review/fix 派发验证）。内置名（reviewer/doc-reviewer）走
    // def.name，自定义 .md agent 为 undefined——只断言 fix 调用的（fixAgent 派发）。
    calls.push({ kind, prompt, agent: opts.agent });
    let parsed: unknown = null;
    if (kind === "review") {
      const idx = reviewCalls.length;
      const gen = scenario.review[Math.min(idx, scenario.review.length - 1)];
      const result = gen(prompt);
      reviewCalls.push({ prompt, result });
      parsed = result;
    } else if (kind === "aggregate") {
      parsed = scenario.aggregate();
    } else {
      parsed = scenario.fix();
    }
    return {
      content: "mock",
      parsedOutput: parsed,
      usage: MOCK_USAGE,
      durationMs: 1,
      error: undefined,
    };
  });
  return {
    run,
    stats: () => ({
      reviewCalls,
      kinds: calls.map((c) => c.kind),
      prompts: calls.map((c) => c.prompt),
      agents: calls.map((c) => c.agent),
    }),
  };
}

// ── registry（与 workflows-e2e.test.ts 同模式：读文件构造 WorkflowScript） ──

function extractMeta(source: string, fallbackName: string): WorkflowMeta {
  const metaPattern = /(?:export\s+)?const\s+meta\s*=\s*(\{[^]*?\});?\s*$/m;
  const match = metaPattern.exec(source);
  if (match) {
    try {
      const fn = new Function(`return (${match[1]});`);
      const obj = fn();
      if (obj && typeof obj === "object" && typeof obj.name === "string") {
        return {
          name: obj.name,
          description: typeof obj.description === "string" ? obj.description : "",
          phases: Array.isArray(obj.phases) ? obj.phases : [],
        };
      }
    } catch {
      // 提取失败 → fallback name（非测试关注点）
    }
  }
  return { name: fallbackName, description: "", phases: [] };
}

function loadWorkflowsFromDir(dir: string): Map<string, WorkflowScript> {
  const scripts = new Map<string, WorkflowScript>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    const fullPath = join(dir, file);
    const sourceCode = readFileSync(fullPath, "utf-8");
    const stem = file.replace(/\.js$/, "");
    const meta = extractMeta(sourceCode, stem);
    const source: WorkflowSource = "saved";
    scripts.set(
      meta.name,
      new WorkflowScript({
        name: meta.name,
        source,
        path: fullPath,
        sourceCode,
        meta,
        available: true,
      }),
    );
  }
  return scripts;
}

function makeRegistry(scripts: Map<string, WorkflowScript>): WorkflowScriptRegistry {
  return {
    get: async (name: string) => scripts.get(name),
    loadAll: async () => Array.from(scripts.values()),
    invalidate: () => {},
  };
}

function makeDeps(runner: AgentRunner): LauncherDeps {
  const scripts = loadWorkflowsFromDir(WORKFLOWS_DIR);
  const registry = makeRegistry(scripts);
  const store = new JsonlRunStore({ sessionDir });
  createdStores.push(store);
  const base: LifecycleDeps = {
    store,
    workerHost: new WorkerHostImpl(),
    runner,
    runs: new Map(),
  };
  return { ...base, registry };
}

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "rfl-e2e-"));
  createdStores = [];
});

afterEach(() => {
  try {
    rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响测试结论
  }
  sessionDir = "";
  createdStores = [];
  vi.restoreAllMocks();
});

const RUN_TIMEOUT_MS = 60_000;
const RUN_ID = () => "rfl-e2e-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);

describe("review-fix-loop E2E（真实 worker + 场景化 mock runner）", () => {
  it("sanity: chain 经本文件基础设施可跑（helper 自检）", async () => {
    const runner = makeScenarioRunner({ review: [() => ({})], aggregate: () => ({}), fix: () => ({}) });
    const deps = makeDeps(runner);
    const result = await runAndWait("chain", { task: "x" }, deps, undefined, RUN_TIMEOUT_MS);
    expect(result.reason).toBe("completed");
  });
  it(
    "E2E-1：defer 跨轮传递 + R2 prompt 对账段 + clean 终止（§7.2 1/3）",
    async () => {
      const runner = makeScenarioRunner({
        review: [
          // R1：1 must-fix + 1 suggestion
          () => ({ report_file: "/tmp/r1-reviewer.md", must_fix: 1, suggestion: 1, reconciliation: [] }),
          // R2：known-remaining 必须含 S-1（fix 阶段 deferred 写入 → 同步 knownRemaining）；
          // 对账 MF-1 已修。若 prompt 缺 S-1 → must_fix=9 使测试失败可见。
          (prompt) => {
            if (!prompt.includes("S-1")) {
              return { report_file: "/tmp/r2-reviewer.md", must_fix: 9, suggestion: 0, reconciliation: [] };
            }
            return {
              report_file: "/tmp/r2-reviewer.md", must_fix: 0, suggestion: 0,
              reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read confirmed" }],
            };
          },
        ],
        aggregate: () => ({
          report_file: "/tmp/agg.md", must_fix: 1, suggestion: 1,
          must_fix_ids: [{ id: "MF-1", severity: "major" }], fixes_caution: [],
        }),
        fix: () => ({
          fixed_count: 1,
          fixes: [{ issue_id: "MF-1", description: "mock fix", self_check: "grep: 1 hit; synced", affected_files: ["src/a.ts"] }],
          deferred: [{ issue_id: "S-1", severity: "minor", reason: "needs new mechanism across modules, high cost" }],
        }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        "review-fix-loop",
        { targetType: "file", target: "README.md", agents: "reviewer", _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );


      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = result.scriptResult as { terminated: string; totalFixed: number; message: string };
      expect(outcome.terminated).toBe("clean");
      expect(outcome.totalFixed).toBe(1);
      expect(outcome.message).toContain("All batches clean");

      // prompt 内容断言：R1 全量深挖（Round 1）→ fix 分流段 → R2 对账段 + known-remaining
      const { prompts, kinds, reviewCalls } = runner.stats();
      const reviewPrompts = prompts.filter((_, i) => kinds[i] === "review");
      expect(reviewPrompts[0]).toContain("Round 1");
      expect(reviewPrompts[1]).toContain("RECONCILE PREVIOUS ROUND");
      expect(reviewPrompts[1]).toContain("S-1"); // 5.3-4 deferred 跨轮继承
      // m6：aggregator prompt 裁决段（5.4 ADJUDICATION）——裁决证据/降级保真/采信抽查
      const aggPrompt = prompts[kinds.indexOf("aggregate")];
      expect(aggPrompt).toContain("ADJUDICATION");
      // m6：fix prompt 分流文案（trivial 直接修 / involved 标记 deferred）+ 自检要求
      const fixPrompt = prompts[kinds.indexOf("fix")];
      expect(fixPrompt).toContain("Fix scope");
      expect(fixPrompt).toContain("fix trivial ones");
      expect(fixPrompt).toContain("mark involved ones as deferred");
      expect(fixPrompt).toContain("self_check in each fixes[] entry MUST include");
      expect(fixPrompt).toContain("grep command + hit count + sync action");
      expect(reviewCalls.length).toBe(2);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "E2E-2：skipCleanAgents 语义（clean agent 下轮跳过）+ fixAgent 参数接受（§7.2 2/3）",
    async () => {
      const runner = makeScenarioRunner({
        review: [
          // R1 两个 agent（顺序不定）：reviewer → dirty（2）；doc-reviewer → clean（0）。
          // doc-reviewer 走 schema-only 真实形态（M3 回归）：无 write 工具 → report_file="" +
          // report_content 返回正文，由 workflow 落盘。按 prompt 内的报告路径区分 agent
          // （顺序无关：两 generator 对同一 agent 返回同一结果）。
          (prompt) => prompt.includes("doc-reviewer.md")
            ? { report_content: "# doc-reviewer report\nPass 1 完成", report_file: "", must_fix: 0, suggestion: 0, reconciliation: [] }
            : { report_file: "/tmp/r1a.md", must_fix: 2, suggestion: 0, reconciliation: [] },
          (prompt) => prompt.includes("doc-reviewer.md")
            ? { report_content: "# doc-reviewer report\nPass 1 完成", report_file: "", must_fix: 0, suggestion: 0, reconciliation: [] }
            : { report_file: "/tmp/r1b.md", must_fix: 2, suggestion: 0, reconciliation: [] },
          // R2：仅 dirty agent 被重派（clean 被 skipCleanAgents 过滤）；返回 clean → 终止。
          // 若 skip 失效，会出现第 4 次 review 调用（断言总数=3 拦截）。
          () => ({
            report_file: "/tmp/r2.md", must_fix: 0, suggestion: 0,
            reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read" }, { prev_id: "MF-2", status: "fixed", evidence: "read" }],
          }),
        ],
        aggregate: () => ({
          report_file: "/tmp/agg.md", must_fix: 2, suggestion: 0,
          must_fix_ids: [{ id: "MF-1", severity: "major" }, { id: "MF-2", severity: "major" }], fixes_caution: [],
        }),
        fix: () => ({
          fixed_count: 2,
          fixes: [
            { issue_id: "MF-1", description: "fix1", self_check: "grep: 1 hit", affected_files: [] },
            { issue_id: "MF-2", description: "fix2", self_check: "grep: 1 hit", affected_files: [] },
          ],
          deferred: [],
        }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        "review-fix-loop",
        { targetType: "file", target: "README.md", agents: "reviewer,doc-reviewer", fixAgent: "reviewer", _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = result.scriptResult as { terminated: string; totalFixed: number; runDir: string };
      expect(outcome.terminated).toBe("clean");
      expect(outcome.totalFixed).toBe(2);

      // skipCleanAgents：R1 两 review + R2 一 review = 3；skip 失效则为 4
      const { kinds, reviewCalls, agents } = runner.stats();
      expect(reviewCalls.length).toBe(3);
      expect(kinds.filter((k) => k === "fix").length).toBe(1);
      expect(kinds.filter((k) => k === "aggregate").length).toBe(1);
      // m5：fixAgent 派发验证——fix 调用带 agent: "reviewer"（review 调用只记录不断言：
      // 内置名走 def.name，自定义 .md agent 为 undefined）
      const fixIdx = kinds.indexOf("fix");
      expect(agents[fixIdx]).toBe("reviewer");
      // M3 直接证据：doc-reviewer（schema-only，report_file=""）报告经 report_content
      // 落盘到 <runDir>/batch-1/round-1/doc-reviewer.md（def.report 文件名 = 内置名剥离
      // review- 前缀，resolveAgentDefs 默认分支）。修复前 normalizeReviewResult 丢弃
      // report_content → 落盘内容为空文件，本断言失败。
      const docReportPath = join(outcome.runDir, "batch-1", "round-1", "doc-reviewer.md");
      expect(existsSync(docReportPath)).toBe(true);
      expect(readFileSync(docReportPath, "utf-8")).toContain("doc-reviewer report");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "E2E-3：ES3 硬校验拦截（deferred critical → fix-failure）+ [UNRESOLVED] 渲染 gate（§7.2 3/3）",
    async () => {
      const runner = makeScenarioRunner({
        review: [
          () => ({ report_file: "/tmp/r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
        ],
        aggregate: () => ({
          report_file: "/tmp/agg.md", must_fix: 1, suggestion: 0,
          must_fix_ids: [{ id: "MF-1", severity: "critical" }], fixes_caution: [],
        }),
        // 红线违反：must-fix 被 defer 且标 critical
        fix: () => ({
          fixed_count: 0,
          fixes: [],
          deferred: [{ issue_id: "MF-1", severity: "critical", reason: "cannot fix in this round" }],
        }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        "review-fix-loop",
        { targetType: "file", target: "README.md", agents: "reviewer", _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed"); // 结构化终止而非抛错
      expect(result.error).toBeUndefined();
      const outcome = result.scriptResult as { terminated: string; message: string };
      expect(outcome.terminated).toBe("fix-failure");
      // 渲染 gate（5.9）：非 clean 终止 message 带 [UNRESOLVED] 前缀 + 残留原因
      expect(outcome.message).toContain("[UNRESOLVED]");
      expect(outcome.message).toContain("must-fix 不得 defer");
      expect(outcome.message).toContain("MF-1");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "E2E-4：全 fixed + 新发现（M2：reconcile 门控 reconCount + 新发现 merge 独立执行）",
    async () => {
      // M2 回归场景：R2 所有 prev ID 声明 fixed（reconSeen 空）但仍有新发现 MF-2。
      // 修复前：reconcile 分支整体跳过 → MF-1 停留 fix-attempted（永不转 fixed）、
      // MF-2（新发现 merge 在分支内）不创建 → 残留清单含 MF-1 而非 MF-2。
      // 修复后：reconCount>0 触发 reconcileIssues → MF-1 转 fixed；新发现 merge 独立
      // 于 reconcile 执行 → MF-2 创建 → 残留仅 MF-2（max-rounds 终止）。
      let aggRound = 0;
      let fixRound = 0;
      const runner = makeScenarioRunner({
        review: [
          // R1：1 must-fix
          () => ({ report_file: "/tmp/r1-reviewer.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          // R2：MF-1 声明 fixed（全 fixed → reconSeen 空）+ 1 新发现；走 R2+ 分支
          (prompt) => {
            if (!prompt.includes("RECONCILE PREVIOUS ROUND")) {
              return { report_file: "/tmp/r2-reviewer.md", must_fix: 9, suggestion: 0, reconciliation: [] };
            }
            return {
              report_file: "/tmp/r2-reviewer.md", must_fix: 1, suggestion: 0,
              reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read confirmed" }],
            };
          },
        ],
        aggregate: () => {
          aggRound++;
          return {
            report_file: "/tmp/agg.md", must_fix: 1, suggestion: 0,
            // R1 只含 MF-1；R2 中 MF-1 已被 reconciliation 声明 fixed，must_fix 只剩新发现 MF-2
            must_fix_ids: aggRound === 1 ? [{ id: "MF-1", severity: "major" }] : [{ id: "MF-2", severity: "major" }],
            fixes_caution: [],
          };
        },
        fix: () => {
          fixRound++;
          return {
            fixed_count: 1,
            fixes: [{
              issue_id: fixRound === 1 ? "MF-1" : "MF-2",
              description: "mock fix",
              self_check: "grep: 1 hit; synced",
              affected_files: [],
            }],
            deferred: [],
          };
        },
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        "review-fix-loop",
        { targetType: "file", target: "README.md", agents: "reviewer", maxRounds: 2, _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = result.scriptResult as { terminated: string; totalFixed: number; message: string };
      // R2 后仍有 must-fix（MF-2 新发现）且达到 maxRounds → max-rounds 终止
      expect(outcome.terminated).toBe("max-rounds");
      expect(outcome.totalFixed).toBe(2);
      // M2 直接可观测证据：MF-1 已被 reconcile 转 fixed → 不进残留清单；MF-2 在残留中
      // （修复前：MF-1 停留 fix-attempted 会出现在残留里、MF-2 不创建 → 本断言失败）
      expect(outcome.message).toContain("MF-2");
      expect(outcome.message).not.toContain("MF-1");

      // 两轮 review 各 1 次调用（maxRounds=2 未超轮）；aggregator/fix 各 2 次
      const { reviewCalls, kinds } = runner.stats();
      expect(reviewCalls.length).toBe(2);
      expect(kinds.filter((k) => k === "aggregate").length).toBe(2);
      expect(kinds.filter((k) => k === "fix").length).toBe(2);
    },
    RUN_TIMEOUT_MS,
  );
});
