import * as fs from "node:fs";
import { basename } from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";
import { guardStaleCtx, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import type { GoalInitFn } from "@zhushanwen/pi-goal";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import type { PlanSessionMap, PlanState } from "./state.js";
import { getPlanState } from "./state.js";

const logger = getLogger("pi-plan");

export function registerPlanEventHandlers(
  pi: ExtensionAPI,
  sessions: PlanSessionMap,
): void {
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive) return {};

    const prep = event.preparation;

    // Read plan file content for recovery after compact
    const planContent = readPlanFileSafe(state.planFilePath);

    // Include phase info for non-complete phases
    const phaseNote = state.phase !== "complete"
      ? `\nPhase: ${state.phase}. Plan was in progress — review and continue.`
      : "\nAwaiting user decision on execution. Do NOT auto-proceed.";

    return {
      compaction: {
        summary:
          `Plan mode active (${state.phase}). Plan file: ${state.planFilePath}\n\n` +
          `## Plan Content\n${planContent}\n\n` +
          `Requirement: ${state.requirement}` +
          phaseNote,
        firstKeptEntryId: prep?.firstKeptEntryId,
        tokensBefore: prep?.tokensBefore,
      },
    };
  });

  pi.on("session_before_tree", async (_event: SessionBeforeTreeEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getPlanState(sessions, sessionId, ctx);
    if (!state.isActive) return {};

    const planContent = readPlanFileSafe(state.planFilePath);

    return {
      summary: {
        summary:
          `Plan mode active (${state.phase}). Plan file: ${state.planFilePath}\n\n` +
          `## Plan Content\n${planContent}\n\n` +
          `Read the plan file and execute the implementation.`,
      },
    };
  });
}

/** Read plan file, return content or error message */
function readPlanFileSafe(planFilePath: string): string {
  try {
    return fs.readFileSync(planFilePath, "utf-8");
  } catch {
    return "(plan file could not be read)";
  }
}

/** Detect whether goal extension is available via its programming interface */
export function detectGoalCapability(pi: ExtensionAPI): boolean {
  try {
    // 交叉类型单步断言（ExtensionAPI 可赋给 ExtensionAPI & { __goalInit? }）
    const api = pi as ExtensionAPI & { __goalInit?: GoalInitFn };
    return typeof api.__goalInit === "function";
  } catch {
    return false;
  }
}

/**
 * 从 plan 文件路径推导 goal slug（kebab-case；无有效字符时 fallback）。
 * 仅 widget 标题 + history 展示用，不注入 prompt。
 */
function buildPlanSlug(planFilePath: string): string {
  const stem = basename(planFilePath)
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "plan-execution";
}

/** step preview 条数上限（1 条总述 + 3 条 preview，合计 ≤4 条，满足 goal schema maxItems:8） */
const PREVIEW_COUNT = 3;
/** 单条 preview 最大长度（超出部分截断，以 "..." 结尾） */
const PREVIEW_MAX_CHARS = 80;
const ELLIPSIS = "...";

/** 折叠换行为空格：goal 侧 handler 拒绝含 \r\n 的条目 */
function toSingleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_MAX_CHARS) return text;
  return text.slice(0, PREVIEW_MAX_CHARS - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * 从 plan 步骤构造可检查的 successCriteria（plan 完成 = 所有步骤执行并验证）。
 * goal 的 complete 判定会对照本字段逐条做证据审计。
 *
 * 形态固定：1 条总述 `All N steps of <basename> executed and verified`
 * + 前 PREVIEW_COUNT 条 step preview（编号前缀、单条截断 ≤PREVIEW_MAX_CHARS），
 * 合计 ≤4 条（goal schema maxItems:8），每条单行不含 \r\n。
 */
export function buildPlanSuccessCriteria(planFilePath: string, tasks: string[]): string[] {
  const planName = toSingleLine(basename(planFilePath).replace(/\.md$/i, ""));
  const items = [`All ${tasks.length} steps of ${planName} executed and verified`];
  const previews = tasks
    .slice(0, PREVIEW_COUNT)
    .map((step, i) => truncatePreview(toSingleLine(`${i + 1}. ${step}`)));
  items.push(...previews);
  return items;
}

/** Try to initialize goal via programming interface */
function tryGoalInit(pi: ExtensionAPI, planFilePath: string, ctx: ExtensionContext): boolean {
  try {
    const api = pi as ExtensionAPI & { __goalInit?: GoalInitFn };
    const goalInit = api.__goalInit;
    if (typeof goalInit !== "function") return false;

    const planContent = readPlanFileSafe(planFilePath);
    if (planContent.startsWith("(")) return false; // read failed

    const objective = `Execute plan: ${planFilePath}`;
    const tasks = extractPlanSteps(planContent);
    if (tasks.length === 0) return false;

    return goalInit(
      objective,
      undefined,
      ctx,
      buildPlanSlug(planFilePath),
      buildPlanSuccessCriteria(planFilePath, tasks),
    );
  } catch {
    return false;
  }
}

/** Extract numbered steps from plan markdown */
export function extractPlanSteps(planContent: string): string[] {
  const steps: string[] = [];
  let inStepsSection = false;

  for (const line of planContent.split("\n")) {
    // Detect steps section headers
    if (/^##\s*(实现步骤|实施步骤|Implementation|Steps)/i.test(line)) {
      inStepsSection = true;
      continue;
    }
    // Exit on next ## header
    if (inStepsSection && /^##\s/.test(line)) {
      break;
    }
    // Collect numbered list items or checkbox items
    if (inStepsSection) {
      const match = line.match(/^\s*(?:\d+\.|- \[[ x]\])\s+(.+)/);
      if (match && match[1].trim()) {
        steps.push(match[1].trim());
      }
    }
  }

  // Fallback: if no steps section found, look for any numbered items (limit MAX_FALLBACK_STEPS)
  const MAX_FALLBACK_STEPS = 10;
  if (steps.length === 0) {
    for (const line of planContent.split("\n")) {
      const match = line.match(/^\s*\d+\.\s+(.+)/);
      if (match && match[1].trim()) {
        steps.push(match[1].trim());
        if (steps.length >= MAX_FALLBACK_STEPS) break;
      }
    }
  }

  return steps;
}


export function handlePlanComplete(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PlanState,
  isolation: string,
  execMode: string,
): void {
  const planFilePath = state.planFilePath;

  // Build mode-specific steer
  const modeMessages: Record<string, string> = {
    subagent: "Execute via subagent-driven development: delegate each task to an independent subagent for parallel execution.",
    goal: "Execute via /goal: set up tracked task decomposition with budget control using the goal extension.",
    "single-agent": "Execute step by step in the current session.",
  };
  const modeHint = modeMessages[execMode] ?? modeMessages["single-agent"];

  const executeMessage =
    `Plan approved by user. Plan file: ${planFilePath}\n\n` +
    `Execution mode: ${execMode}\n` +
    `${modeHint}\n\n` +
    `Read the plan file and start implementing.`;

  switch (isolation) {
    case "compact": {
      ctx.compact({
        customInstructions: `Plan file: ${planFilePath}. Read plan and execute implementation.`,
        // E1 同构崩溃点（crash-resilience D1）：onComplete/onError 由 compact 内部
        // Promise 链异步调用、不在 pi runner emit() 的 try/catch 内——压缩进行中用户
        // 切换/重载 session 后，回调触碰捕获的 pi/ctx 命中 stale 同步抛错即杀 pi 进程。
        // 守卫 stale 静默降级（执行消息不投递，用户可手动 Read plan 文件执行），非
        // stale 错误原样上抛。plan 未注入代际计数器（低频路径），分诊依赖 PS-30 门禁
        // 守卫的 stale 文案兜底（D1 降级语义声明的合法形态）。
        onComplete: () => {
          guardStaleCtx(() => {
            pi.sendUserMessage(executeMessage, { deliverAs: "steer" });
            tryGoalInit(pi, planFilePath, ctx);
          }, {
            label: "plan:compact-onComplete",
            onStale: (error) => logger.warn("plan execution notice delivery skipped (stale ctx)", { error: toErrorMessage(error) }),
          });
        },
        onError: (_error: Error) => {
          guardStaleCtx(() => {
            ctx.ui.notify("Compact failed, continuing without isolation.", "warning");
            pi.sendUserMessage(executeMessage, { deliverAs: "steer" });
            tryGoalInit(pi, planFilePath, ctx);
          }, {
            label: "plan:compact-onError",
            onStale: (error) => logger.warn("plan execution notice delivery skipped (stale ctx)", { error: toErrorMessage(error) }),
          });
        },
      });
      break;
    }

    case "tree": {
      ctx.ui.notify("Use /tree to manually navigate back. Plan file: " + planFilePath, "info");
      break;
    }

    case "direct":
    default: {
      pi.sendUserMessage(executeMessage, { deliverAs: "steer" });
      tryGoalInit(pi, planFilePath, ctx);
      break;
    }
  }
}
