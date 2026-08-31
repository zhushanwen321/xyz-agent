/**
 * Workflow View — Pure formatting functions (FR-4)
 *
 * Stateless functions extracted from WorkflowsView for testability.
 * All functions are pure: no Pi runtime, no side effects.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { AgentEventLogEntry } from "@zhushanwen/subagent-core/execution/types.ts";
import type { ExecutionTraceNode, ToolCallEntry } from "@zhushanwen/subagent-core/orchestration/models/types.ts";
import type { DoneReason, RunStatus } from "@zhushanwen/subagent-core/orchestration/models/types.ts";
import { displayAgentName } from "@zhushanwen/subagent-core/shared/agent-ref.ts";

import type { ThemeLike as BaseThemeLike } from "../format.ts";

// ── Constants ─────────────────────────────────────────────────

export const SIDEBAR_WIDTH = 24;
export const PROMPT_FOLD_LINES = 3;
export const OUTPUT_TRUNCATE_BYTES = 100_000;
export const ELLIPSIS = "\u2026"; // U+2026

// L2 详情滚动常量（对齐 subagents list-view.ts）。
/** terminal.rows 读不到时的翻页兜底步长（防 NaN）。 */
export const PAGE_SCROLL_DEFAULT = 10;
/** tui.terminal.rows 兜底行数（duck-type 失败时，对齐 subagents TERM_ROWS_FALLBACK）。 */
export const TERM_ROWS_FALLBACK = 24;

// 跨 view 共享的布局常量（WorkflowsView + detail-content 都用）。
/** box 左右边框字符宽度（│ x 2），用于内容行截断预算。 */
export const BOX_BORDER_CHARS = 2;
/** token 数 → k 单位的除数。 */
export const BUDGET_TOKENS_DIVISOR = 1000;
/** Activity 区最多显示的 tool call 条数。 */
export const MAX_TOOL_CALLS_DISPLAY = 3;

// 时间换算（模块私有常量）。
const MS_PER_SEC = 1000;
const SECS_PER_MIN = 60;

/**
 * 可显示的状态文本集合。
 *
 * 包含 RunStatus（"running"|"done" 不直接显示，转 reason）+ DoneReason
 * （completed/failed/aborted/budget_limited/time_limited）+ ExecutionTraceNode.status
 * （含 "pending"——trace 节点的初始态）。
 *
 * 收窄自 string → 显式联合，编译器会在新增 status 时强制 switch 补齐分支。
 */
type StatusText =
  | RunStatus
  | DoneReason
  | "pending";

// ── Theme interface (avoids importing Pi runtime) ─────────────

/**
 * views 侧主题形状：仅 fg/bold——本文件所有函数只消费这两个方法。
 * 单源派生自 src/interface/format.ts 的 ThemeLike（Pick 收窄），不再独立声明；
 * 保留窄形状是为了让只有 fg/bold 的 duck-typed theme（含测试 stub）可直接传入。
 */
export type ThemeLike = Pick<BaseThemeLike, "fg" | "bold">;

// ── Status helpers ────────────────────────────────────────────

/** status → 语义颜色 token（用于给任意文本染色，不含符号）。 */
function statusColorToken(
  status: StatusText,
): "success" | "warning" | "error" | "muted" {
  switch (status) {
    case "completed": return "success";
    case "running": return "warning";
    case "failed": case "aborted": return "error";
    default: return "muted";
  }
}

export function statusDotStr(
  status: StatusText,
  theme: ThemeLike,
): string {
  return theme.fg(statusColorToken(status), "●");
}

/** Format a status badge with color for the header area. */
export function formatStatusBadge(
  status: StatusText,
  theme: ThemeLike,
): string {
  switch (status) {
    case "running": return theme.fg("warning", "\u25CF running");
    case "completed": return theme.fg("success", "\u2713 completed");
    case "failed": return theme.fg("error", "\u2717 failed");
    case "aborted": return theme.fg("error", "\u2717 aborted");
    case "budget_limited": return theme.fg("error", "\u26A0 budget");
    case "time_limited": return theme.fg("error", "\u26A0 timeout");
    default: return theme.fg("muted", status);
  }
}

// ── Pure formatting functions ─────────────────────────────────

/** Group trace nodes by phase. Nodes without phase go to "(no phase)". */
function groupByPhase(nodes: ExecutionTraceNode[]): Map<string, ExecutionTraceNode[]> {
  const map = new Map<string, ExecutionTraceNode[]>();
  for (const node of nodes) {
    const phase = node.phase || "(default)";
    let arr = map.get(phase);
    if (!arr) {
      arr = [];
      map.set(phase, arr);
    }
    arr.push(node);
  }
 // Sort within each phase by stepIndex ascending (FR-3.2)
  for (const arr of map.values()) {
    arr.sort((a, b) => a.stepIndex - b.stepIndex);
  }
  return map;
}

/** Format elapsed time string from startedAt. */
export function formatElapsed(startedAt?: string, now: number = Date.now()): string {
  if (!startedAt) return "-";
  const ms = now - new Date(startedAt).getTime();
  if (ms < MS_PER_SEC) return "0s";
  const secs = Math.floor(ms / MS_PER_SEC);
  if (secs < SECS_PER_MIN) return `${secs}s`;
  const mins = Math.floor(secs / SECS_PER_MIN);
  const remSecs = secs % SECS_PER_MIN;
  return `${mins}m${remSecs}s`;
}

// formatElapsedSeconds 单源自 src/interface/format.ts（见文末「单源折叠垫片」）。

/**
 * Format a live eventLog entry（live 路径 Activity 区用）。
 *
 *   tool_start → "→ {label}"
 *   tool_end   → "← {label}"（done）/ "✗ {label}"（failed）
 *   turn_end   → "∘ {label}"（turn 摘要）
 *   error      → "✗ {label}"
 *
 * 对齐 subagents formatEventLine 的视觉风格，但用 workflow 的 ThemeLike（无 spinner）。
 */
export function formatEventLine(entry: AgentEventLogEntry, theme: ThemeLike): string {
  switch (entry.type) {
    case "tool_start":
      return `→ ${entry.label}`;
    case "tool_end":
      return entry.status === "failed"
        ? theme.fg("error", `✗ ${entry.label}`)
        : `✓ ${entry.label}`;
    case "turn_end":
      return theme.fg("dim", `∘ ${entry.label}`);
    case "error":
      return theme.fg("error", `✗ ${entry.label}`);
    default:
      return entry.label;
  }
}

/** Format token + tool call statistics. */
export function formatTokenStat(
  usage?: { input: number; output: number },
  toolCalls?: ToolCallEntry[],
  elapsed?: string,
): string {
  const tokens = usage ? usage.input + usage.output : 0;
  const tools = toolCalls?.length ?? 0;
  const base = `${tokens} tok · ${tools} tool calls`;
  return elapsed ? `${base} · ${elapsed}` : base;
}

/**
 * renderResult 的文本兜底：从 result.content[0] 提取纯文本。
 * 多处 tool 的 renderResult 曾各自内联此逻辑，提取后统一调用。
 */
export function renderTextFallback(
  result: { content?: Array<{ type: string; text?: string }> },
): string {
  const first = result.content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

/** Format a single activity line: ToolName(argsPreview). */
export function formatActivityLine(entry: ToolCallEntry, maxWidth: number): string {
 // 语义阈值与开销：低于此宽度只显名称；括号占 2 字符 (name)。
  const MIN_ACTIVITY_WIDTH = 10;
  const PARENS_OVERHEAD = 2;
  if (maxWidth < MIN_ACTIVITY_WIDTH) return entry.name;
  const argsBudget = maxWidth - entry.name.length - PARENS_OVERHEAD;
  if (argsBudget <= 0) return truncateToWidth(entry.name, maxWidth);
  const truncated = entry.input.length > argsBudget
    ? entry.input.slice(0, argsBudget - 1) + ELLIPSIS
    : entry.input;
  return `${entry.name}(${truncated})`;
}

// ── 单源折叠垫片（设计 U11 宿主内合并）─────────────────────────
// 通用文本 helper 已折叠单源到 src/interface/format.ts——truncLine 为自研
// ANSI 安全实现（pi-tui truncateToWidth 会在省略号处插 \x1b[0m 断裂背景色，
// 见 interface/format.ts truncLine 注释），统一取 interface 侧实现。
// 此处按原名 re-export：WorkflowsView / detail-content（本 wave 只读）的
// import 面不变即完成单源切换。segFillColored 无 views 侧消费方，直接删除。
export { formatElapsedSeconds } from "../format.ts";
export { padToVisible as padVisible } from "../format.ts";
export { visibleWidth as visibleLen } from "@earendil-works/pi-tui";

// ── Phase group (filters empty phases) ────────────────────────

export interface PhaseGroup {
  name: string;
  nodes: ExecutionTraceNode[];
  doneCount: number;
}

/** The fallback phase name when node has no explicit phase. */
const NO_PHASE = "(default)";

/** Build phase groups. Nodes without a phase are placed in an unnamed group. */
export function buildPhaseGroups(nodes: ExecutionTraceNode[]): PhaseGroup[] {
  const map = groupByPhase(nodes);
  const result: PhaseGroup[] = [];
  for (const [name, phaseNodes] of map) {
    if (phaseNodes.length > 0) {
      result.push({
        name: name === NO_PHASE ? "" : name,
        nodes: phaseNodes,
        doneCount: phaseNodes.filter((n) => n.status === "completed").length,
      });
    }
  }
  return result;
}

// ── Sidebar phase line formatter ─────────────────────────────

export function formatPhaseLine(
  pg: PhaseGroup,
  idx: number,
  isSelected: boolean,
  theme: ThemeLike,
  maxWidth: number,
): string {
  const pointer = isSelected ? "❯ " : "  ";
  const dot = statusDotStr(pg.doneCount === pg.nodes.length ? "completed" : "running", theme);
  const name = pg.name || "(unnamed)";
  const label = `${idx + 1} ${name} ${pg.doneCount}/${pg.nodes.length}`;
 // pointer(2) + dot(1) + space(1)
  const PHASE_PREFIX_WIDTH = 4;
  const budget = maxWidth - PHASE_PREFIX_WIDTH;
  const truncated = visibleWidth(label) > budget
    ? truncateToWidth(label, budget - 1) + ELLIPSIS
    : label;
  return `${pointer}${dot} ${truncated}`;
}

// ── Agent one-liner for overview right panel ──────────────────

const TOKEN_K = 1000;

export function formatAgentOneLiner(node: ExecutionTraceNode, theme: ThemeLike): string {
  const dot = statusDotStr(node.status, theme);
  const elapsed = formatElapsed(
    node.startedAt,
    node.completedAt ? new Date(node.completedAt).getTime() : Date.now(),
  );
  const tok = node.result?.usage;
  const tokStr = tok
    ? `${Math.round((tok.input + tok.output) / TOKEN_K)}k tok`
    : "";
  const tcCount = node.result?.toolCalls?.length ?? 0;
  const parts = [dot, displayAgentName(node.agent), node.model];
  if (tokStr) parts.push(`${tokStr} · ${tcCount} tools`);
  parts.push(elapsed);
  return parts.join("    ");
}


