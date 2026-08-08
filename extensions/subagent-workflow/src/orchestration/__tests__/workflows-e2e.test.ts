/**
 * 内置 workflow E2E（真实 worker thread + mock LLM runner）
 *
 * 验证 4 个内置 workflow（parallel/chain/map-reduce/scatter-gather）通过真实的编排
 * 链路执行成功。调用真实的 runAndWait(name, args, deps)（src/orchestration/launcher.ts），
 * 它内部会：
 *   1. deps.registry.get(name) 加载真实 .js 脚本
 *   2. 脚本校验（lintScript）
 *   3. runWorkflow(spec, deps) 起真实的 node:worker_threads Worker 执行脚本
 *   4. 脚本内调 agent()/parallel() → worker postMessage(agent-call) →
 *      主线程 deps.runner.run() → 我们 mock 它返回固定结构化数据
 *   5. 脚本聚合结果 → return outcome → runAndWait 返回 WorkflowRunResult
 *
 * 唯一 mock 的是 deps.runner（AgentRunner 接口）——真实 runner 会 spawn pi 子进程调 LLM，
 * mock runner 根据 opts.schema 生成符合脚本 schema 的假数据。
 *
 * 真实 Infra 实现：
 *   - WorkerHostImpl（真实 node:worker_threads Worker）
 *   - JsonlRunStore（真实持久化，用临时目录）
 *
 * registry 绕过说明（见末尾 notes）：
 *   WorkflowScriptRegistryImpl(config) 的扫描源是固定约定目录（.pi/workflows 等），
 *   无法指向 extensions/subagent-workflow/workflows/。为不改源码，这里直接读 .js 文件
 *   内容 + 手动构造 WorkflowScript 对象，包装为一个满足 WorkflowScriptRegistry 接口
 *   的自定义 registry（loadWorkflowsFromDir）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonlRunStore } from "../jsonl-run-store.ts";
import { type LauncherDeps,runAndWait } from "../launcher.ts";
import { actionInfo, actionRun, type WorkflowInfo } from "../../interface/tool-workflow.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import type { AgentRunner } from "../models/ports.ts";
import type { AgentResult, AgentUsage } from "../models/types.ts";
import {
  type WorkflowMeta,
  WorkflowScript,
  type WorkflowSource,
} from "../models/workflow-script.ts";
import { parseResourceMeta } from "../../shared/meta-parser.ts";
import type { WorkflowScriptRegistry } from "../models/workflow-script-registry.ts";
import { WorkerHostImpl } from "../worker-host.ts";

// ── 路径：定位真实 workflows 目录 ─────────────────────────────────────────
// 本测试文件在 src/orchestration/__tests__/，workflows 目录在 extensions/subagent-workflow/workflows/
// 即 __dirname → ..  (orchestration) → ..  (src) → ..  (subagent-workflow) → workflows
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, "..", "..", "..", "workflows");

// ── 临时 session 目录（RunStore 持久化根），每用例重建 ──────────────────
let sessionDir: string;
let createdStores: JsonlRunStore[] = [];

// ── 通用 mock usage（AgentResult.usage 可选，给一个固定值便于排查） ──────
const MOCK_USAGE: AgentUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 15,
  turns: 1,
};

// ── 根据 JSON schema 递归生成符合 schema 的占位值 ─────────────────────────

type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

/**
 * 从 JSON schema 生成占位值。
 *
 * - string → "mock"（脚本只校验存在性/字符串类型，不校验内容）
 * - number → 7（0-10 评分等都能用）
 * - boolean → true
 * - array → [generate(items)]（至少 1 项；subtasks 这类对象数组给 2 项让脚本有东西可处理）
 * - object → { properties 递归生成 }
 *
 * schema 缺失时回退 null（agent() 在 parsedOutput 为 null 时回退 content，但本测试
 * 每个 agent() 都带 schema，故不会命中）。
 */
function generateFromSchema(schema: JsonSchema | undefined): unknown {
  if (!schema) return null;
  switch (schema.type) {
    case "string":
      return "mock";
    case "number":
    case "integer":
      return 7;
    case "boolean":
      return true;
    case "array": {
      const item = generateFromSchema(schema.items);
      // 对象数组给 2 项（scatter-gather 的 subtasks 需 ≥1 项才能进 process 段；
      // 给 2 项让并行处理有意义），基本类型数组给 1 项。
      return schema.items?.type === "object" ? [item, item] : [item];
    }
    case "object":
    default: {
      const out: Record<string, unknown> = {};
      if (schema.properties) {
        for (const [key, sub] of Object.entries(schema.properties)) {
          out[key] = generateFromSchema(sub);
        }
      }
      return out;
    }
  }
}

/**
 * 构造 mock AgentRunner：根据每次调用的 opts.schema 生成符合 schema 的 AgentResult。
 *
 * runner.run 签名（ports.ts:35）：
 *   run(opts, signal, onEvent?, stream?) => Promise<AgentResult>
 * signal/onEvent/stream 接受但忽略（mock 不消费）。parsedOutput 为符合 schema 的对象，
 * worker 内 agent()/parallel() 取 parsedOutput ?? content 作为脚本可见值。
 */
function makeMockRunner(): AgentRunner & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (opts: { schema?: unknown }): Promise<AgentResult> => {
    const parsed = generateFromSchema(opts.schema as JsonSchema | undefined);
    return {
      content: "mock",
      parsedOutput: parsed,
      usage: MOCK_USAGE,
      durationMs: 1,
      error: undefined,
    };
  });
  // AgentRunner 接口仅含 run 方法（ports.ts:35），{ run } 已满足结构。
  // 额外标注 run 为 vi.fn 返回类型，便于断言调用次数。
  return { run } as AgentRunner & { run: ReturnType<typeof vi.fn> };
}

// ── 自定义 registry：从指定目录加载 .js 脚本为 WorkflowScript ─────────────

/**
 * 从源码用 regex 提取 `const meta = { ... }`（与 config-loader.extractMetaViaRegex
 * 同语义，避免执行用户代码）。失败时回落到 name=文件名 stem 的空 meta。
 */
function extractMeta(source: string, fallbackName: string): WorkflowMeta {
  // m2 exec-review MINOR-1：旧 const meta regex + new Function 随 m2 迁移已失效（恒走空
  // fallback，不再验证真实 meta 提取），改调 IF1 parseResourceMeta（与
  // builtin-workflows-structure.test 一致）。失败时回落到 name=文件名 stem 的空 meta。
  const meta = parseResourceMeta(source, "workflow");
  if (meta && meta.kind === "workflow") return meta;
  return { kind: "workflow", name: fallbackName, description: "", phases: [] };
}

/**
 * 从目录扫描 .js 文件，构造 WorkflowScript 实体 map（按 meta.name 索引）。
 *
 * 不依赖 WorkflowScriptRegistryImpl（其扫描源是固定约定目录，无法指向任意路径）。
 * 直接读文件 + 构造 WorkflowScript（其 validate/toExecutable 是纯函数，可直接用）。
 */
function loadWorkflowsFromDir(dir: string): Map<string, WorkflowScript> {
  const scripts = new Map<string, WorkflowScript>();
  const files = readdirSync(dir);
  for (const file of files) {
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

/**
 * 包装 scripts map 为 WorkflowScriptRegistry 接口实现。
 *
 * get(name) 返回对应 WorkflowScript（undefined 当不存在）；
 * loadAll() 返回全部；invalidate() no-op（内存 map 无缓存概念）。
 */
function makeRegistry(scripts: Map<string, WorkflowScript>): WorkflowScriptRegistry {
  return {
    get: async (name: string) => scripts.get(name),
    loadAll: async () => Array.from(scripts.values()),
    invalidate: () => {},
  };
}

// ── 构造完整 LauncherDeps（真实 WorkerHost + 真实 RunStore + mock runner） ─

function makeDeps(): LauncherDeps {
  const scripts = loadWorkflowsFromDir(WORKFLOWS_DIR);
  const registry = makeRegistry(scripts);
  const store = new JsonlRunStore({ sessionDir });
  createdStores.push(store);
  const runner = makeMockRunner();
  const base: LifecycleDeps = {
    store,
    workerHost: new WorkerHostImpl(),
    runner,
    runs: new Map(),
  };
  return { ...base, registry };
}

// ── setup/teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "wf-e2e-"));
  createdStores = [];
});

afterEach(() => {
  for (const dir of [sessionDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      // 临时目录清理失败（CI 偶发 EBUSY）不影响测试结论
      void e;
    }
  }
  sessionDir = "";
  createdStores = [];
  vi.restoreAllMocks();
});

// ── 断言 helper：对每个 workflow 的 WorkflowRunResult 做统一终态断言 ──────

interface ScriptOutcome {
  status: string;
  message?: string;
  error?: string;
}

/**
 * 断言 runAndWait 返回成功完成的终态。
 *
 * - result.status === "done"（runAndWait 恒 done）
 * - result.reason === "completed"（脚本正常 return，非 failed/aborted/time_limited）
 * - result.scriptResult.status 是 "ok" 或 "partial"（脚本层 outcome，非 "error"）
 * - result.error 为 undefined
 */
function assertCompleted(
  result: { status: string; reason: string; scriptResult?: unknown; error?: string },
  workflowName: string,
): void {
  expect(result.status, `${workflowName}: status 应为 done`).toBe("done");
  expect(result.reason, `${workflowName}: reason 应为 completed`).toBe("completed");
  expect(result.error, `${workflowName}: error 应为 undefined`).toBeUndefined();
  const outcome = result.scriptResult as ScriptOutcome | undefined;
  expect(outcome, `${workflowName}: scriptResult 应存在`).toBeDefined();
  expect(outcome!.status, `${workflowName}: outcome.status 不应为 error`).toMatch(
    /^(ok|partial)$/,
  );
}

// ── 超时：真实 worker 启动 + 多轮 agent mock，30s 足够 ─────────────────────
const RUN_TIMEOUT_MS = 30_000;

// ── tests ────────────────────────────────────────────────────────────────

describe("内置 workflow E2E（真实 worker thread + mock LLM runner）", () => {
  it(
    "parallel workflow：多视角并行分析 → 聚合，reason=completed, outcome.status != error",
    async () => {
      const deps = makeDeps();
      const result = await runAndWait(
        "parallel",
        { target: "src/auth/login.ts" },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );
      assertCompleted(result, "parallel");
      const outcome = result.scriptResult as {
        status: string;
        perspectives_analyzed: number;
        per_perspective: unknown[];
      };
      expect(outcome.perspectives_analyzed).toBe(3); // 默认 3 视角
      expect(outcome.per_perspective).toHaveLength(3);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "chain workflow：analyze → transform → synthesize 顺序三步，reason=completed, outcome.status != error",
    async () => {
      const deps = makeDeps();
      const result = await runAndWait(
        "chain",
        { task: "把这段需求文档拆成技术任务" },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );
      assertCompleted(result, "chain");
      const outcome = result.scriptResult as {
        status: string;
        phases_run: string[];
        final: { summary: string; recommendation: string };
      };
      expect(outcome.phases_run).toEqual(["analyze", "transform", "synthesize"]);
      expect(outcome.final.summary).toBe("mock"); // mock runner 生成 string→"mock"
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "map-reduce workflow：parallel map → reduce 两段，reason=completed, outcome.status != error",
    async () => {
      const deps = makeDeps();
      const result = await runAndWait(
        "map-reduce",
        { operation: "审查代码风格", items: ["file1.ts", "file2.ts"] },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );
      assertCompleted(result, "map-reduce");
      const outcome = result.scriptResult as {
        status: string;
        phases_run: string[];
        items_total: number;
        items_mapped: number;
      };
      expect(outcome.phases_run).toEqual(["map", "reduce"]);
      expect(outcome.items_total).toBe(2);
      expect(outcome.items_mapped).toBe(2);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "scatter-gather workflow：scatter 拆分 → parallel 处理 → gather 合并 三段，reason=completed, outcome.status != error",
    async () => {
      const deps = makeDeps();
      const result = await runAndWait(
        "scatter-gather",
        { task: "重构认证模块，涉及 session/jwt/oauth 三块" },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );
      assertCompleted(result, "scatter-gather");
      const outcome = result.scriptResult as {
        status: string;
        phases_run: string[];
        subtasks_total: number;
        subtasks_processed: number;
      };
      expect(outcome.phases_run).toEqual(["scatter", "process", "gather"]);
      // mock runner 的 subtasks 对象数组给 2 项
      expect(outcome.subtasks_total).toBe(2);
      expect(outcome.subtasks_processed).toBe(2);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "TC10: runAndWait 参数校验失败 → reason=invalid_args + runId='' + info 指引（chokepoint 先拦）",
    async () => {
      // review-fix-loop 有 parameters schema（唯一带 schema 的内置 workflow）——
      // 缺 required targetType/target → chokepoint 在 worker 启动前拦截。
      const deps = makeDeps();
      const result = await runAndWait(
        "review-fix-loop",
        { batch1: "code-reviewer" },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      expect(result.status).toBe("done");
      expect(result.reason).toBe("invalid_args");
      expect(result.runId).toBe("");
      expect(result.error).toContain("Invalid args for workflow 'review-fix-loop'");
      expect(result.error).toContain("targetType");
      expect(result.error).toContain("workflow info review-fix-loop");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "TC12: coerce 结果到达 worker（chokepoint 原地 coerce → $ARGS 收到 boolean false）",
    async () => {
      // fixture 必须过 lint 入口检查（含 agent( 调用）+ typecheckMeta（name/description/phases）
      const fixtureDir = mkdtempSync(join(tmpdir(), "wf-tc12-"));
      try {
        writeFileSync(
          join(fixtureDir, "args-probe.js"),
          [
            "/* @pi-meta",
            "name: args-probe",
            "description: TC12 coerce probe fixture",
            "phases: [a]",
            "parameters:",
            "  type: object",
            "  properties:",
            "    autoCommit: { type: boolean }",
            "  required: [autoCommit]",
            "*/",
            'module.exports.execute = async ({ agent, $ARGS }) => {',
            '  await agent({ prompt: "x" });',
            "  return { t: typeof $ARGS.autoCommit, v: $ARGS.autoCommit };",
            "};",
            "",
          ].join("\n"),
          "utf-8",
        );
        const scripts = loadWorkflowsFromDir(fixtureDir);
        const deps = { ...makeDeps(), registry: makeRegistry(scripts) };

        const result = await runAndWait(
          "args-probe",
          { autoCommit: "false" },
          deps,
          undefined,
          RUN_TIMEOUT_MS,
        );

        expect(result.reason).toBe("completed");
        const outcome = result.scriptResult as { t: string; v: unknown };
        expect(outcome.t).toBe("boolean");
        expect(outcome.v).toBe(false);
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
    RUN_TIMEOUT_MS,
  );

  it("TC4: actionRun 顺序——not_found 优先（平铺 + 不存在名）；slug 护栏保留；chain 平铺 Correct 文案", async () => {
    const deps = makeDeps();
    // 平铺 + 不存在 name → not_found 优先（m6：registry.get 先于平铺检测）
    const notFound = await actionRun(
      { action: "run", name: "nope", task: "x" },
      deps,
      undefined,
    );
    expect(notFound.isError).toBe(true);
    expect(notFound.content![0]!.text).toContain("not found"); // DoD 用户可见断言
    // chain 平铺 task → isError Correct 正例（动态集来自 registry）
    const flat = await actionRun(
      { action: "run", name: "chain", task: "x" },
      deps,
      undefined,
    );
    expect(flat.isError).toBe(true);
    expect(flat.content![0]!.text).toContain("Detected task at top level");
    expect(flat.content![0]!.text).toContain("Correct:");
    // slug 护栏保留（m6 顺序调整后仍在 runWorkflow 前）
    const slug = await actionRun(
      { action: "run", name: "chain", args: { task: "x" }, slug: "a".repeat(40) },
      deps,
      undefined,
    );
    expect(slug.isError).toBe(true);
    expect(slug.content![0]!.text).toContain("slug exceeds");
  });

  it("TC6: 跨 workflow 平铺语义——review-fix-loop 平铺 task（非其参数）走 args-validator", async () => {
    const deps = makeDeps();
    // task 是 chain 参数非 review-fix-loop 参数 → 不报平铺 → args 缺 targetType
    // → m3 chokepoint invalid_args（错误更准——评审 m-5 语义锁定）
    const result = await actionRun(
      { action: "run", name: "review-fix-loop", task: "x" },
      deps,
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.content![0]!.text).toContain("Invalid args for workflow 'review-fix-loop'");
    expect(result.content![0]!.text).toContain("targetType");
  });

  it("TC9: actionRun 参数校验失败 → isError ToolResult + §5.3 指引", async () => {
    const deps = makeDeps();
    const result = await actionRun(
      { action: "run", name: "review-fix-loop", args: { batch1: "code-reviewer" } },
      deps,
      undefined,
    );

    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("Invalid args for workflow 'review-fix-loop'");
    expect(text).toContain("targetType");
    expect(text).toContain("workflow info review-fix-loop");
  });

  it("TC1: info action 返回 raw schema + friendly + usage，content 可 JSON.parse", async () => {
    const deps = makeDeps();
    const result = await actionInfo({ action: "info", name: "review-fix-loop" }, deps);

    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ action: "info", name: "review-fix-loop", status: "ok" });
    const info = JSON.parse(result.content![0]!.text) as WorkflowInfo;
    expect(info.name).toBe("review-fix-loop");
    expect(info.parameters).toBeDefined();
    const params = info.parameters as Record<string, unknown>;
    expect((params.properties as Record<string, unknown>).targetType).toBeDefined();
    expect((params.patternProperties as Record<string, unknown>)["^batch\\d+$"]).toBeDefined();
    expect(info.parametersFriendly).toBeDefined();
    // TC10 折叠断言（exec-review F1 回归：真实 patternProperties key 折叠为 batch1, batch2, ...）
    const friendlyNames = info.parametersFriendly!.map((e) => e.name);
    expect(friendlyNames).toContain("batch1, batch2, ...");
    const batchEntry = info.parametersFriendly!.find((e) => e.name === "batch1, batch2, ...");
    expect(batchEntry!.note).toContain("值语义同 batchN"); // note 派生（MAJ-3）
    expect(info.usage).toContain("workflow run review-fix-loop"); // 手写示例原样
  });

  it("TC2: info 结构精确七字段 + 无自动 exampleArgs", async () => {
    const deps = makeDeps();
    const result = await actionInfo({ action: "info", name: "review-fix-loop" }, deps);
    const info = JSON.parse(result.content![0]!.text) as WorkflowInfo;
    expect(Object.keys(info).sort()).toEqual([
      "description",
      "name",
      "notFor",
      "parameters",
      "parametersFriendly",
      "usage",
      "when",
    ]);
    expect(JSON.stringify(info)).not.toContain("exampleArgs");
  });

  it("TC3: info not_found 与缺 name → isError（镜像 run 行为）", async () => {
    const deps = makeDeps();
    const missing = await actionInfo({ action: "info", name: "nope" }, deps);
    expect(missing.isError).toBe(true);
    expect(missing.details).toMatchObject({ action: "info", status: "not_found" });
    expect(missing.content![0]!.text).toContain("Available");
    const noName = await actionInfo({ action: "info" }, deps);
    expect(noName.isError).toBe(true);
    expect(noName.content![0]!.text).toContain("info requires 'name' parameter");
  });

  it("TC11: 4 内置 workflow info 返回 parameters/usage（参数知识不真空）", async () => {
    const deps = makeDeps();
    const cases: Array<[string, string[]]> = [
      ["chain", ["task"]],
      ["parallel", ["target", "perspectives"]],
      ["scatter-gather", ["task"]],
      ["map-reduce", ["items", "itemsJson", "operation"]],
    ];
    for (const [name, expectedParams] of cases) {
      const result = await actionInfo({ action: "info", name }, deps);
      const info = JSON.parse(result.content![0]!.text) as WorkflowInfo;
      expect(result.isError).toBeUndefined();
      expect(info.parameters).toBeDefined();
      const props = Object.keys(
        ((info.parameters as Record<string, unknown>).properties ?? {}) as Record<string, unknown>,
      );
      expect(props.sort()).toEqual([...expectedParams].sort());
      expect(info.usage).toBeDefined();
      expect(info.usage).toContain("workflow run " + name);
    }
  });
});
