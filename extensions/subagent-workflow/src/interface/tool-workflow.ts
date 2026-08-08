/**
 * Workflow Extension — workflow tool（5 actions，FR-5 tool 收口）。
 *
 * 合并原 tool-workflow.ts + tool-workflow-run.ts 为单 tool。
 *
 * Actions:
 * - run: registry.get → runWorkflow（直接启动，无需用户确认）
 * - status: 列出 runs（deps.runs）
 * - pause: 调 pauseRun
 * - resume: 调 resumeRun
 * - abort: 调 abortRun
 *
 * **restart 不包含**（D-9 废弃）。
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

import { SLUG_MAX_LENGTH } from "../execution/execute-options-mapper.ts";
import type { LauncherDeps } from "../orchestration/launcher.ts";
import { ArgsValidationError } from "../orchestration/args-validator.ts";
import { abortRun, pauseRun, resumeRun, runWorkflow } from "../orchestration/lifecycle.ts";
import type { RunStore } from "../orchestration/models/ports.ts";
import type { WorkflowRun } from "../orchestration/models/workflow-run.ts";
import { mapRunIcon, mapRunStatus, toGuiCtx } from "./gui-mappers.ts";
import {
  acquireReentryGuard,
  REENTRY_BUSY_MESSAGE,
  type ReentryGuardRef,
  releaseReentryGuard,
} from "./reentry-guard.ts";
import { formatElapsed, renderTextFallback } from "./views/format.ts";

// ── Parameter schema ─────────────────────────────────────────

/** workflow tool 的全部 action 枚举值（单一真相源）。 */
export type WorkflowAction =
  | "run"
  | "status"
  | "info"
  | "pause"
  | "resume"
  | "abort";

const WORKFLOW_ACTIONS: readonly WorkflowAction[] = [
  "run",
  "status",
  "info",
  "pause",
  "resume",
  "abort",
];

const WorkflowParams = Type.Object({
  action: StringEnum(WORKFLOW_ACTIONS, { description: "Workflow action to execute" }),
  name: Type.Optional(
    Type.String({ description: "Workflow name (run/info action)" }),
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
    Type.String({ description: "Workflow run ID (pause/resume/abort)" }),
  ),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Arguments passed to workflow as key-value pairs (run action)",
    }),
  ),
  tokens: Type.Optional(Type.Number({ description: "Maximum token budget (run action)" })),
  time: Type.Optional(Type.Number({ description: "Maximum time budget in ms (run action)" })),
  error: Type.Optional(
    Type.String({ description: "Error/reason message (optional, used with abort)" }),
  ),
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
  | { action: "info"; name: string; status: "ok" | "not_found"; __gui__?: GuiRenderResult }
  | { action: "status"; runs: RunSummary[]; __gui__?: GuiRenderResult }
  | { action: "pause" | "resume" | "abort"; runId: string; status: string; reason?: string; __gui__?: GuiRenderResult };

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
  if (details.action === "info") {
    // m4：info 无 runId，不能落入通用 runId 分支（details.runId.slice 会 TypeError）
    return guiComponent("stats-line", {
      items: [
        {
          label: "info",
          value: details.status === "not_found" ? `${details.name}: not found` : details.name,
          severity: details.status === "not_found" ? ("danger" as const) : ("ok" as const),
        },
      ],
    });
  }
  if (details.action === "run") {
    // not_found 是脚本未找到的逻辑错误（isError:true），不能走通用 mapper 的 done/check 成功映射。
    // 短路为 danger severity 的 stats-line，与 isError 文案一致。
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
  // pause/resume/abort
  // abort 是破坏性终止、pause 是挂起（非成功完成），用 warn 区分；resume 保留 ok
  const severity = details.action === "abort" || details.action === "pause" ? "warn" as const : "ok" as const;
  return guiComponent("stats-line", {
    items: [{
      label: details.action,
      value: details.runId.slice(0, RUNID_SHORT),
      severity,
    }],
  });
}

// ── Tool registration ────────────────────────────────────────

/**
 * 注册 workflow tool（5 actions: run / status / pause / resume / abort）。
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
      "Execute and control workflows: run (start), status, pause, resume, abort.\n" +
      "Replaces workflow + workflow-run tools.",
    promptSnippet: "Run, pause, resume, abort, or check workflow status",
    promptGuidelines: [
      "PRIORITY: When user says 'workflow', 'run workflow', try run action FIRST.",
      "Built-in workflows run DIRECTLY with action:run — names/descriptions come from " +
      "<available_workflows> (injected each turn); call \"workflow info <name>\" for " +
      "parameters/usage/when (when/notFor routing hints live in info, not the injection list). " +
      "parameter schema and usage before running. Do NOT use workflow-script generate for " +
      "patterns already covered by available workflows.",
      "run: discover by name/description, then start in background (no user confirmation needed).",
      "Do NOT poll status after starting — results appear automatically via notifyDone.",
      "Call shapes (JSON): " +
      "- run: {\"action\":\"run\",\"name\":\"<script>\",\"args\":{...},\"tokens\":N,\"time\":N}. " +
      "- status: {\"action\":\"status\"}. " +
      "- pause/resume/abort: {\"action\":\"pause\",\"runId\":\"<id>\"} (abort optional: ,\"error\":\"<reason>\"}).",
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
        return textResult("Operation aborted before start", true);
      }
 // P1-6: Reentry guard
      if (!acquireReentryGuard(reentryRef)) {
        return textResult(REENTRY_BUSY_MESSAGE, true);
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
          case "info":
            result = await actionInfo(params, deps);
            break;
          case "pause":
            result = await actionLifecycle("pause", params, deps);
            break;
          case "resume":
            result = await actionLifecycle("resume", params, deps);
            break;
          case "abort":
            result = await actionLifecycle("abort", params, deps);
            break;
          default: {
            // Exhaustiveness check — 新增 WorkflowAction 成员时未补 case，tsc 在此报错。
            const _exhaustive: never = action;
            return textResult(`Unknown action: ${String(_exhaustive)}`, true);
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
    return textResult("run requires 'name' parameter. Correct: {\"action\":\"run\",\"name\":\"<script>\",\"args\":{...}}", true);
  }
  // 弱模型常见误用（P0 静默失败）：把 task/items 等 args 子字段平铺到 workflow params
  // 顶层（缺 args 嵌套）。args ?? {} 会静默 args={}，启动缺参 run 不报错——比 subagent
  // 平铺事故更严重。m6：先 registry.get（动态参数集来源——schema 即 SSOT），
  // not_found 优先返回；平铺检测报错带 Correct 正例纠正。
  const script = await deps.registry.get(name);
  if (!script) {
 // 模糊匹配建议
    const all = await deps.registry.loadAll();
    const available = all.filter((wf) => wf.available);
    const suggestions = available
      .map((wf) => `  - ${wf.name}: ${wf.meta.description || "(no description)"}`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Workflow '${name}' not found. Available:\n${suggestions || "  (none)"}`,
        },
      ],
      details: { action: "run", runId: "", status: "not_found", name },
      isError: true,
    };
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
    return textResult(
      `Detected ${flattened.join(", ")} at top level — they belong inside 'args'. ` +
      `Correct: {"action":"run","name":"${name}","args":{${flattened.map((k) => `"${k}": "<value>"`).join(", ")}}}`,
      true,
    );
  }
  // slug 运行时护栏（与 subagent startHandler 对称的纵深防御；schema maxLength 是第一道关卡）
  if (params.slug !== undefined && params.slug.length > SLUG_MAX_LENGTH) {
    return textResult(
      `slug exceeds ${SLUG_MAX_LENGTH} chars (got ${params.slug.length}). Shorten to a kebab-case label, e.g. "fix-login", "extract-urls".`,
      true,
    );
  }
  const args = params.args ?? {};
  const tokens = params.tokens;
  const time = params.time;

 // 构建 RunSpec + 启动（m3：parameters 从 script.meta 拷贝——chokepoint 校验用；
 // 校验失败 → isError ToolResult 带 §5.3 指引，非 ArgsValidationError 保持传播）
  let runId: string;
  try {
    runId = await runWorkflow(
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
      },
      deps,
      signal,
    );
  } catch (err) {
    if (err instanceof ArgsValidationError) {
      return {
        content: [{ type: "text", text: err.message }],
        details: { action: "run", runId: "", status: "invalid_args", name: script.name },
        isError: true,
      };
    }
    throw err;
  }

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

// ── info action ─────────────────────────────────────────────

/** JSON 缩进（info 返回文本可读性）。 */
const INFO_JSON_INDENT = 2;

/** workflow info 返回结构（§5.2：raw schema + friendly + usage，无自动 exampleArgs）。 */
export interface WorkflowInfo {
  name: string;
  description: string;
  when?: string;
  notFor?: string;
  /** raw JSON Schema（机器可校验）。未声明参数契约时显式 null + 提示。 */
  parameters?: Record<string, unknown> | null;
  /** 人/LLM 可读参数表（renderParamTable 产物）。 */
  parametersFriendly?: Array<{
    name: string;
    required: boolean;
    type?: string;
    enum?: string;
    default?: unknown;
    note?: string;
  }>;
  /** 作者手写用法说明（markdown，含真实合法示例）。 */
  usage?: string;
}

/**
 * renderParamTable（IF7）：schema → friendly 参数表。
 *
 * - properties 条目：{ name, required, type?, enum?（'a | b' 展开）, default?, note? }
 * - patternProperties：/^\\^([a-zA-Z]+)\\d\\+\\$$/（匹配字面 \\d+ 转义——真实 key
 *   是 '^batch\\\\d+$'，design-review CRIT-1 探针实测）→ 折叠 '<word>1, <word>2, ...'，
 *   否则保留正则原文
 * - note 派生：value schema 的 description（design-review MAJ-3：batchN 值域语义不能丢）
 * - 已知边界（接受代价）：^x1$ 字面数字误折叠、^batch\\d{2}$ 语义漂移
 */
export function renderParamTable(parameters: Record<string, unknown>): WorkflowInfo["parametersFriendly"] {
  const table: NonNullable<WorkflowInfo["parametersFriendly"]> = [];
  const props = parameters.properties;
  const requiredList = Array.isArray(parameters.required) ? (parameters.required as unknown[]) : [];
  if (props !== null && typeof props === "object") {
    for (const [name, rawProp] of Object.entries(props as Record<string, unknown>)) {
      const prop = rawProp !== null && typeof rawProp === "object" ? (rawProp as Record<string, unknown>) : {};
      const entry: NonNullable<WorkflowInfo["parametersFriendly"]>[number] = {
        name,
        required: requiredList.includes(name),
      };
      if (typeof prop.type === "string") entry.type = prop.type;
      if (Array.isArray(prop.enum)) entry.enum = (prop.enum as unknown[]).map(String).join(" | ");
      if (prop.default !== undefined) entry.default = prop.default;
      if (typeof prop.description === "string") entry.note = prop.description;
      table.push(entry);
    }
  }
  const pp = parameters.patternProperties;
  if (pp !== null && typeof pp === "object") {
    for (const [pattern, rawProp] of Object.entries(pp as Record<string, unknown>)) {
      const prop = rawProp !== null && typeof rawProp === "object" ? (rawProp as Record<string, unknown>) : {};
      const fold = pattern.match(/^\^([a-zA-Z]+)\\d\+\$$/);
      const entry: NonNullable<WorkflowInfo["parametersFriendly"]>[number] = {
        name: fold ? `${fold[1]}1, ${fold[1]}2, ...` : pattern,
        required: false,
      };
      if (typeof prop.type === "string") entry.type = prop.type;
      if (typeof prop.description === "string") entry.note = prop.description;
      table.push(entry);
    }
  }
  return table;
}

/**
 * info action（IF6）：返回 workflow 的 raw schema + friendly 参数表 + usage。
 * 无自动 exampleArgs（schema 外语义约束如 review-fix-loop 至少一 batch 是 footgun——
 * 作者手写 usage 是唯一示例来源）。
 */
export async function actionInfo(
  params: WorkflowToolParams,
  deps: LauncherDeps,
): Promise<ToolResult> {
  const name = params.name;
  if (!name) {
    return textResult(
      "info requires 'name' parameter. Correct: {\"action\":\"info\",\"name\":\"<script>\"}",
      true,
    );
  }
  const script = await deps.registry.get(name);
  if (!script) {
    const all = await deps.registry.loadAll();
    const available = all.filter((wf) => wf.available);
    const suggestions = available
      .map((wf) => `  - ${wf.name}: ${wf.meta.description || "(no description)"}`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Workflow '${name}' not found. Available:\n${suggestions || "  (none)"}`,
        },
      ],
      details: { action: "info", name, status: "not_found" },
      isError: true,
    };
  }
  const info: WorkflowInfo = {
    name: script.meta.name,
    description: script.meta.description,
  };
  if (script.meta.when !== undefined) info.when = script.meta.when;
  if (script.meta.notFor !== undefined) info.notFor = script.meta.notFor;
  if (script.meta.parameters !== undefined) {
    info.parameters = script.meta.parameters;
    info.parametersFriendly = renderParamTable(script.meta.parameters);
  } else {
    // 未声明参数契约：显式标记（LLM 无法区分「无参数」与「自由透传」）
    info.parameters = null;
    info.parametersFriendly = [];
  }
  if (script.meta.usage !== undefined) info.usage = script.meta.usage;
  return {
    content: [{ type: "text", text: JSON.stringify(info, null, INFO_JSON_INDENT) }],
    details: { action: "info", name: script.meta.name, status: "ok" },
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

// ── pause/resume/abort lifecycle actions ─────────────────────

async function actionLifecycle(
  action: "pause" | "resume" | "abort",
  params: WorkflowToolParams,
  deps: LauncherDeps,
): Promise<ToolResult> {
  const runId = params.runId;
  if (!runId) {
    return textResult(`'runId' is required for ${action}. Correct: {"action":"${action}","runId":"<id>"} (use action:"status" to find runId)`, true);
  }
  const run = deps.runs.get(runId);
  if (!run) {
    return textResult(
      `Workflow '${runId}' not found. Use action:status to list active runs and their runIds.`,
      true,
    );
  }
  try {
    const oldStatus = run.state.status;
    if (action === "pause") {
      await pauseRun(runId, deps);
    } else if (action === "resume") {
      await resumeRun(runId, deps);
    } else {
      await abortRun(runId, deps, params.error);
    }
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
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Error: ${msg}`, true);
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

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    isError: isError || undefined,
  };
}
