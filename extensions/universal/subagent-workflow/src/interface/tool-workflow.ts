/**
 * Workflow Extension — workflow tool（3 actions，FR-5 tool 收口）。
 *
 * 合并原 tool-workflow.ts + tool-workflow-run.ts 为单 tool。
 *
 * Actions:
 * - run: registry.get → runWorkflow（直接启动，无需用户确认）
 * - status: 列出 runs（deps.runs）
 * - abort: 调 abortRun
 *
 * **restart 不包含**（D-9 废弃）；**pause/resume 不包含**（一次性生命周期——run
 * 不可挂起，提前停止用 abort，要新结果开新 run）。
 *
 * 层归属：Interface。依赖 Pi SDK + Engine lifecycle/launcher + helpers。
 *
 * 参考：domain-models.md §FR-5（tool 收口 4→2）。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("tool-workflow");
import { Text } from "@earendil-works/pi-tui";
import {
  guiComponent,
  type GuiContext,
  type GuiRenderResult,
  guiResult,
  isGuiCapable,
} from "@xyz-agent/extension-protocol";
import { type Static, Type } from "typebox";

import { SLUG_MAX_LENGTH } from "@zhushanwen/subagent-core";
import { THINKING_ORDER } from "@zhushanwen/subagent-core";
import type { LauncherDeps } from "@zhushanwen/subagent-core";
import { abortRun, runWorkflow } from "@zhushanwen/subagent-core";
import type { RunStore } from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import { mapRunIcon, mapRunStatus, toGuiCtx } from "./gui-mappers.ts";
import {
  acquireReentryGuard,
  REENTRY_BUSY_MESSAGE,
  type ReentryGuardRef,
  releaseReentryGuard,
} from "./reentry-guard.ts";
import { formatElapsed, renderTextFallback } from "./format.ts";

// ── Parameter schema ─────────────────────────────────────────

/** workflow tool 的全部 action 枚举值（单一真相源）。 */
export type WorkflowAction =
  | "run"
  | "status"
  | "abort";

const WORKFLOW_ACTIONS: readonly WorkflowAction[] = [
  "run",
  "status",
  "abort",
];

const WorkflowParams = Type.Object({
  action: StringEnum(WORKFLOW_ACTIONS, { description: "Workflow action to execute" }),
  name: Type.Optional(
    Type.String({ description: "Workflow ref: absolute path to the .js script (use <location> from <available_workflows>; run action)" }),
  ),
  slug: Type.Optional(
    Type.String({
      description:
        "Short label (max 35 chars) for this run, shown in the TUI to distinguish concurrent runs. " +
        "If omitted, defaults to the script name.",
      maxLength: SLUG_MAX_LENGTH,
    }),
  ),
  runId: Type.Optional(
    Type.String({ description: "Workflow run ID (abort action)" }),
  ),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Arguments passed to workflow as key-value pairs (run action)",
    }),
  ),
  tokens: Type.Optional(Type.Number({ description: "Max token budget — ONLY set when user explicitly requests a limit; omit = unlimited (default)" })),
  time: Type.Optional(Type.Number({ description: "Max time budget in ms — ONLY set when user explicitly requests a limit; omit = unlimited (default)" })),
  error: Type.Optional(
    Type.String({ description: "Error/reason message (optional, used with abort)" }),
  ),
  model: Type.Optional(Type.String({
    description: "Run-level model override in 'provider/modelId' format. When set, all agents spawned by this run inherit it by default (unless a per-call agent() opts.model is set). Omit to inherit the main agent's model.",
  })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_ORDER, {
    description: "Run-level thinkingLevel override (off/minimal/low/medium/high/xhigh/max). All agents in this run inherit it by default. Omit to default each agent to its model's highest available level.",
  })),
});

type WorkflowToolParams = Static<typeof WorkflowParams>;

// ── Constants ────────────────────────────────────────────────

/** runId 截断长度（显示用）。 */
const RUNID_SHORT = 8;

/**
 * tool 自身顶层键（workflow params schema 键）——workflow 参数名与 tool 键撞名时
 * （如 workflow 声明参数 name），顶层同名键是 tool 参数而非平铺（m6 评审 M-3）。
 * 未来新增 tool 顶层键需同步此集合。
 */
const TOOL_TOP_LEVEL = new Set([
  "action",
  "name",
  "slug",
  "runId",
  "args",
  "tokens",
  "time",
  "error",
  // Run-level overrides (Option B): excluded from flattening detection so a
  // workflow that declares its own `model`/`thinkingLevel` parameter does not
  // trip a false "belongs inside args" warning when the tool's top-level fields
  // are present. They flow via workerData → $MODEL/$THINKING_LEVEL globals.
  "model",
  "thinkingLevel",
]);

/**
 * 从 workflow 参数 schema 动态构建平铺检测的已知键集（m6：schema 即 SSOT——
 * 替代 21 键硬编码 KNOWN_ARG_KEYS，消除与参数定义的漂移面）。
 *
 * - exact：properties keys（精确匹配）
 * - patterns：patternProperties 原样转正则数组（如 /^batch\\d+$/——与旧
 *   KNOWN_ARG_KEY_PREFIXES 语义一致，自动兼容 \\d{2} 等变体；schema pattern 已是
 *   正则源码，直接 new RegExp 即可）
 * - 构建时排除 TOOL_TOP_LEVEL（撞名保护）
 */
export function argKeysFromMeta(
  parameters: Record<string, unknown> | undefined,
): { exact: ReadonlySet<string>; patterns: readonly RegExp[] } {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  if (parameters === undefined || parameters === null || typeof parameters !== "object") {
    return { exact, patterns };
  }
  const props = parameters.properties;
  if (props !== null && typeof props === "object") {
    for (const k of Object.keys(props as Record<string, unknown>)) {
      if (!TOOL_TOP_LEVEL.has(k)) exact.add(k);
    }
  }
  const pp = parameters.patternProperties;
  if (pp !== null && typeof pp === "object") {
    for (const p of Object.keys(pp as Record<string, unknown>)) {
      try {
        const re = new RegExp(p); // schema pattern 已是正则源码
        // S1（m6 exec-review）：跳过能命中 tool 顶层键的 pattern——否则
        // ^run.*$ 类 pattern 会匹配 runId/name 等 tool 键，合法调用恒误报
        if ([...TOOL_TOP_LEVEL].some((tk) => re.test(tk))) continue;
        patterns.push(re);
      } catch (err) {
        // 非法 pattern（schema 校验 m3 已保证合法，双保险）——跳过并记录
        logger.warn(`[tool-workflow] patternProperties 非法正则跳过: ${p}`, {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { exact, patterns };
}

/**
 * 检测弱模型把 args 子字段平铺到 workflow params 顶层（P0 静默失败防护）。
 * 返回被平铺的键名列表（空 = 未平铺）。export 供 behavioral 测试（trigger/no-trigger/edge）。
 * 参数取 unknown 以便测试构造任意对象、并解耦 WorkflowToolParams 的 index-signature 限制。
 *
 * knownKeys/knownPatterns 由 argKeysFromMeta 动态构建（m6）——匹配谓词：
 * knownKeys.has(k) || knownPatterns.some(re => re.test(k))（pattern 自带数字后缀
 * 语义——loose startsWith 会误报 batchl/target1）；保留 args-排除（顶层 + args
 * 内共存不算平铺）。
 */
export function findFlattenedArgKeys(
  params: unknown,
  knownKeys: ReadonlySet<string>,
  knownPatterns: readonly RegExp[],
): string[] {
  if (typeof params !== "object" || params === null) return [];
  const p = params as Record<string, unknown>;
  const args = typeof p.args === "object" && p.args !== null ? p.args : undefined;
  const isKnownKey = (k: string) =>
    knownKeys.has(k) || knownPatterns.some((re) => re.test(k));
  // hasOwnProperty.call 而非 in（原型链——constructor/toString 类参数名不被继承键掩盖）
  return Object.keys(p).filter(
    (k) =>
      isKnownKey(k) &&
      !(args !== undefined && Object.prototype.hasOwnProperty.call(args, k)),
  );
}

// ── Types ────────────────────────────────────────────────────

interface RunSummary {
  runId: string;
  name: string;
  /** Run 级 slug（可选，旧 run 缺失为 undefined）。 */
  slug?: string;
  status: string;
  reason?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** Run 状态快照文件绝对路径（<sessionDir>/workflow-state/<runId>.jsonl）。 */
  stateFile?: string;
}

// ── Tool result types ──

/**
 * Discriminated union of `workflow` tool `details` payloads.
 *
 * Discriminant: `action`. Each action's details shape is explicitly typed so
 * downstream consumers (GUI list-tree renderer, structured-output) can narrow
 * without unsafe casts.
 */
export type WorkflowToolDetails =
  | { action: "run"; runId: string; status: "running" | "not_found" | "invalid_args"; name: string; slug?: string; stateFile?: string; __gui__?: GuiRenderResult }
  | { action: "status"; runs: RunSummary[]; __gui__?: GuiRenderResult }
  | { action: "abort"; runId: string; status: string; reason?: string; __gui__?: GuiRenderResult };

/** Result returned by the `workflow` tool's execute. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: WorkflowToolDetails | undefined;
  isError?: boolean;
}

// ── GUI 协议 helpers ───────────────────────────────────────

/** 为 details 附加 __gui__（RPC 模式下）。union 各成员已声明 __gui__?，无需强转。 */
function withGui(
  details: WorkflowToolDetails | undefined,
  ctx?: GuiContext,
): WorkflowToolDetails | undefined {
  if (!details) return undefined;
  if (ctx && isGuiCapable(ctx)) {
    return { ...details, __gui__: guiResult(buildWorkflowGui(details)) };
  }
  return details;
}

/** 按 WorkflowToolDetails 构造对应的 GuiComponent。 */
export function buildWorkflowGui(details: WorkflowToolDetails) {
  if (details.action === "run") {
    // not_found 曾是「isError:true + not_found details」的错误形态（W4 前返回值 isError 被
    // pi 丢弃）；W4 后该错误改为 throw（details 不再产出此形态），本分支保留消费历史
    // session entry / 防御性渲染，不能走通用 mapper 的 done/check 成功映射。
    if (details.status === "not_found") {
      return guiComponent("stats-line", {
        items: [{ label: "run", value: "not found", severity: "danger" as const }],
      });
    }
    const statusStr = details.status;
    return guiComponent("list-tree", {
      items: [{
        label: [details.name, details.slug, details.runId.slice(0, RUNID_SHORT)].filter(Boolean).join(" "),
        status: mapRunStatus(statusStr),
        icon: mapRunIcon(statusStr),
      }],
    });
  }
  if (details.action === "status") {
    return guiComponent("list-tree", {
      items: details.runs.map((r) => {
        const statusStr = r.reason ? `${r.status} (${r.reason})` : r.status;
        return {
          label: [r.name, r.slug, r.runId.slice(0, RUNID_SHORT)].filter(Boolean).join(" "),
          status: mapRunStatus(statusStr),
          icon: mapRunIcon(statusStr),
        };
      }),
    });
  }
  // abort（唯一 lifecycle action）：破坏性终止非成功完成，用 warn 与成功区分
  return guiComponent("stats-line", {
    items: [{
      label: details.action,
      value: details.runId.slice(0, RUNID_SHORT),
      severity: "warn" as const,
    }],
  });
}

// ── Tool registration ────────────────────────────────────────

/**
 * 注册 workflow tool（3 actions: run / status / abort；pause/resume 已随一次性
 * 生命周期移除——enum 拒绝由 pi 核心校验拦截，见 F3）。
 *
 * @param pi ExtensionAPI
 * @param deps LauncherDeps（LifecycleDeps + registry）
 * @param reentryRef reentry guard。仅 workflow tool 使用——workflow-script tool
 *   有独立的 isScriptRunning flag（见 registerWorkflowScriptTool），不共用此 guard。
 *   注意：reentryRef 是 factory 级单例（index.ts 在 factory 内创建），跨 session 共享。
 *   当前 Pi 运行时单 session 串行（同一时刻只有一个 active session），跨 session
 *   不会并发触发 workflow action，故共享无竞态。若未来支持多 session 并发，需改为
 *   per-session guard。
 */
export function registerWorkflowTool(
  pi: ExtensionAPI,
  deps: LauncherDeps,
  reentryRef: ReentryGuardRef,
): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Execute and control workflows: run (start), status, abort.\n" +
      "Replaces workflow + workflow-run tools.",
    promptSnippet: "Run, abort, or check workflow status",
    promptGuidelines: [
      "PRIORITY: When user says 'workflow', 'run workflow', try run action FIRST.",
      "All listed workflows run DIRECTLY with action:run — refs/descriptions come from " +
      "<available_workflows> (injected each turn). For parameter details, read the <location> " +
      "script file (script header has @pi-meta parameters + usage + phases). Do NOT use " +
      "workflow-script generate for patterns already covered by available workflows.",
      "run: pass the absolute .js path from <available_workflows> <location> as name, then start in background (no user confirmation needed).",
      "Do NOT poll status after starting — results appear automatically via notifyDone.",
      "Runs are one-shot: there is no pause/resume — to stop a run early use abort; for a fresh result start a new run.",
      "Call shapes (JSON): " +
      "- run: {\"action\":\"run\",\"name\":\"<script>\",\"args\":{...},\"tokens\":N,\"time\":N,\"model\":\"<provider/modelId>\",\"thinkingLevel\":\"<level>\"}. " +
      "- status: {\"action\":\"status\"}. " +
      "- abort: {\"action\":\"abort\",\"runId\":\"<id>\"} (optional: {\"error\":\"<reason>\"}).",
      "Budget: Do NOT set tokens/time unless the user explicitly requests a limit. Built-in workflows run unlimited by default.",
      "Model/thinkingLevel: omit by default (inherit main agent's model). Only set model/thinkingLevel when the user explicitly requests a specific model or thinking depth for this run.",
      "Anti-patterns: Flattening args sub-fields (task/items/...) to the top level — they belong inside args. Calling {\"action\":\"run\"} without name.",
      "CRITICAL: For orchestration patterns, ALWAYS use action:run with an existing built-in " +
      "name — NEVER use workflow-script action:generate to recreate patterns already covered " +
      "by available workflows. workflow-script generate is ONLY for novel patterns.",
    ],
    parameters: WorkflowParams,

    async execute(
      _toolCallId: string,
      params: WorkflowToolParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<ToolResult> {
 // P1-2: Honor abort signal up-front
      if (signal?.aborted) {
        // throw（W4b）：pi 只对 execute throw 置 isError:true，返回值里的 isError
        // 被 agent-loop 丢弃（agent-loop.js:453-483）——文案原样进 toolResult。
        throw new Error("Operation aborted before start");
      }
 // P1-6: Reentry guard（acquire 失败时尚未持有 guard，throw 前无需 release）
      if (!acquireReentryGuard(reentryRef)) {
        throw new Error(REENTRY_BUSY_MESSAGE);
      }
      try {
        let result: ToolResult;
        // 断言为 WorkflowAction 联合——typebox Static 推断为 any，显式标注让 default
        // 分支的 never 穷尽检查生效（新增 action 时 tsc 报错强制补 case）。
        const action = params.action as WorkflowAction;
        switch (action) {
          case "run":
            result = await actionRun(params, deps, signal);
            break;
          case "status":
            result = actionStatus(deps);
            break;
          case "abort":
            result = await actionLifecycle("abort", params, deps);
            break;
          default: {
            // Exhaustiveness check — 新增 WorkflowAction 成员时未补 case，tsc 在此报错。
            const _exhaustive: never = action;
            throw new Error(`Unknown action: ${String(_exhaustive)}`);
          }
        }
        // GUI 协议：RPC 模式下附加 __gui__ 到 details
        return {
          ...result,
          details: withGui(result.details, toGuiCtx(_ctx)),
        };
      } finally {
        releaseReentryGuard(reentryRef);
      }
    },

    renderCall(args: Record<string, unknown>, theme: Theme, _context?: unknown) {
      const action = String(args.action ?? "");
      const name = args.name ? ` ${String(args.name)}` : "";
      // run action 可选 slug：在 name 后追加 · slug（accent 色）
      const slug = typeof args.slug === "string" && args.slug.trim()
        ? `${theme.fg("dim", " · ")}${theme.fg("accent", String(args.slug))}`
        : "";
      const runId = args.runId ? ` ${String(args.runId).slice(0, RUNID_SHORT)}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("workflow ")) +
          theme.fg("muted", action) +
          theme.fg("accent", name) +
          slug +
          theme.fg("dim", runId),
        0,
        0,
      );
    },

    renderResult(result: { content?: Array<{ type: string; text?: string }> }, _options: unknown, _theme: Theme, _context?: unknown) {
      return new Text(renderTextFallback(result), 0, 0);
    },
  });
}

// ── run action ───────────────────────────────────────────────

export async function actionRun(
  params: WorkflowToolParams,
  deps: LauncherDeps,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const name = params.name;
  if (!name) {
    throw new Error("run requires 'name' parameter (absolute .js path from <available_workflows> <location>). Correct: {\"action\":\"run\",\"name\":\"<ref>\",\"args\":{...}}");
  }
  // 弱模型常见误用（P0 静默失败）：把 task/items 等 args 子字段平铺到 workflow params
  // 顶层（缺 args 嵌套）。args ?? {} 会静默 args={}，启动缺参 run 不报错——比 subagent
  // 平铺事故更严重。m6：先 registry.getPath（动态参数集来源——schema 即 SSOT），
  // not_found 优先返回；平铺检测报错带 Correct 正例纠正。
  const script = await deps.registry.getPath(name);
  // W4c：config-loader 的 toCachedMeta 对不可读/不存在文件返回 available:false 的
  // stub（非 undefined），仅判 !script 会绕过 not_found → 空 sourceCode 假启动
  //（W4b verifier 探针实测复现）。与下方 suggestions 分支的 wf.available 过滤口径对齐。
  if (!script || !script.available) {
 // 模糊匹配建议。throw（W4）：pi 只对 execute throw 置 isError:true，
 // 返回值里的 isError 被 agent-loop 丢弃（agent-loop.js:453-483）——文案原样进 toolResult。
    const all = await deps.registry.loadAll();
    const available = all.filter((wf) => wf.available);
    const suggestions = available
      .map((wf) => `  - ${wf.name}: ${wf.meta.description || "(no description)"}`)
      .join("\n");
    throw new Error(
      `Workflow '${name}' not found. Available:\n${suggestions || "  (none)"}\nUse <location> from <available_workflows> for the absolute .js path.`,
    );
  }

  // m6：动态参数集（schema 即 SSOT）→ 平铺检测；无 parameters → 单次 warn + 跳过
  // （legacy const-meta 类永久无检测——D1 无 adapter 声明）
  const { exact: knownKeys, patterns: knownPatterns } = argKeysFromMeta(script.meta.parameters);
  if (knownKeys.size === 0 && knownPatterns.length === 0) {
    // M-2 显式信号：无参数契约（未声明/解析空）→ 单次 warn——静默退化变显式
    // （m6 exec-review M1：原实现排除 undefined 与设计相反）
    logger.warn(
      `[tool-workflow] ${script.name}: 未声明参数契约（或解析为空）——平铺检测跳过，args 不校验`,
    );
  }
  const flattened = findFlattenedArgKeys(params, knownKeys, knownPatterns);
  if (flattened.length > 0) {
    throw new Error(
      `Detected ${flattened.join(", ")} at top level — they belong inside 'args'. ` +
      `Correct: {"action":"run","name":"${name}","args":{${flattened.map((k) => `"${k}": "<value>"`).join(", ")}}}`,
    );
  }
  // slug 运行时护栏（与 subagent startHandler 对称的纵深防御；schema maxLength 是第一道关卡）
  if (params.slug !== undefined && params.slug.length > SLUG_MAX_LENGTH) {
    throw new Error(
      `slug exceeds ${SLUG_MAX_LENGTH} chars (got ${params.slug.length}). Shorten to a kebab-case label, e.g. "fix-login", "extract-urls".`,
    );
  }
  const args = params.args ?? {};
  const tokens = params.tokens;
  const time = params.time;

 // 构建 RunSpec + 启动（m3：parameters 从 script.meta 拷贝——chokepoint 校验用；
 // 校验失败 → ArgsValidationError 直接 throw 给 pi（W4：err.message 含 §5.3 指引，
 // pi catch 后原文案进 toolResult content 并置 isError:true），其他错误保持传播）
  const runId = await runWorkflow(
    {
      scriptSource: script.toExecutable(),
      args,
      budgetTokens: tokens,
      budgetTimeMs: time,
      scriptName: script.name,
      slug: params.slug,
      scriptPath: script.path,
      description: script.meta.description,
      parameters: script.meta.parameters,
      model: params.model,
      thinkingLevel: params.thinkingLevel,
    },
    deps,
    signal,
  );

  return {
    content: [
      {
        type: "text",
        text: params.slug
          ? `Started workflow '${script.name}' · ${params.slug} (${runId}). Running in background — do NOT poll status.`
          : `Started workflow '${script.name}' (${runId}). Running in background — do NOT poll status.`,
      },
    ],
    details: { action: "run", runId, status: "running", name: script.name, slug: params.slug, stateFile: deps.store.stateFilePath(runId) },
  };
}


// ── status action ────────────────────────────────────────────

function actionStatus(deps: LauncherDeps): ToolResult {
  const runs = Array.from(deps.runs.values());
  if (runs.length === 0) {
    return {
      content: [{ type: "text", text: "No workflows in current session." }],
      details: { action: "status", runs: [] },
    };
  }
  const summaries = runs.map((r) => toRunSummary(r, deps.store));
  const lines = summaries.map((s) => {
    const duration = s.startedAt ? ` (${formatElapsed(s.startedAt)})` : "";
    const reasonSuffix = s.reason && s.reason !== "completed" ? ` [${s.reason}]` : "";
    return `[${s.status}${reasonSuffix}] ${s.name} (${s.runId.slice(0, RUNID_SHORT)})${duration}${s.error ? ` error: ${s.error}` : ""}`;
  });
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { action: "status", runs: summaries },
  };
}

// ── abort lifecycle action ────────────────────────────────────

// 一次性生命周期：abort 是唯一的提前停止方式（pause/resume 已随 D-2 移除），
// action 参数保留字面量类型与 WorkflowAction 单成员分发对齐。
async function actionLifecycle(
  action: "abort",
  params: WorkflowToolParams,
  deps: LauncherDeps,
): Promise<ToolResult> {
  const runId = params.runId;
  if (!runId) {
    throw new Error(`'runId' is required for ${action}. Correct: {"action":"${action}","runId":"<id>"} (use action:"status" to find runId)`);
  }
  const run = deps.runs.get(runId);
  if (!run) {
    throw new Error(
      `Workflow '${runId}' not found. Use action:status to list active runs and their runIds.`,
    );
  }
  try {
    const oldStatus = run.state.status;
    await abortRun(runId, deps, params.error);
    const newStatus = run.state.status;
    const reasonSuffix = run.state.reason ? ` (${run.state.reason})` : "";
    return {
      content: [
        {
          type: "text",
          text: `Workflow '${run.spec.scriptName}' (${runId}): ${oldStatus} → ${newStatus}${reasonSuffix}`,
        },
      ],
      details: { action, runId, status: newStatus, reason: run.state.reason },
    };
  } catch (err) {
    // throw（W4b）：abortRun 失败改 throw（原 return isError 被 pi 丢弃），"Error: " 前缀保持
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Error: ${msg}`);
  }
}

// ── helpers ──────────────────────────────────────────────────

/** WorkflowRun → 摘要（status action 用）。 */
function toRunSummary(run: WorkflowRun, store: RunStore): RunSummary {
  return {
    runId: run.runId,
    name: run.spec.scriptName,
    slug: run.spec.slug,
    status: run.state.status,
    reason: run.state.reason,
    startedAt: run.meta.startedAt,
    completedAt: run.meta.completedAt,
    error: run.state.error,
    stateFile: store.stateFilePath(run.runId),
  };
}

// W4b：原 textResult(text, isError) helper 已删除——23 处错误路径全部改 throw
// （pi 只对 execute throw 置 isError:true，返回值里的 isError 被 agent-loop 丢弃，
// agent-loop.js:453-483），且本文件无非错误纯文本结果用途，无残留调用方。
