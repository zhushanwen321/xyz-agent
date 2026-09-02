// src/tui/format.ts
//
// 纯格式化函数.零 Pi 依赖、零 runtime 依赖,可单测.
//
// 分隔符语义体系(tui-format.md §1,impeccable 审查裁定):
//   `·` 同级并列字段/thinking 图标;`()` 元数据分组;`›` 工具;`>` 输出;`·` thinking.
//   禁用 `│` 做 stats 分隔、`├─`/`└─` 做 eventLog 前缀.
//
// 截断(tui-format.md §5):truncLine 是 ANSI 安全的——追踪 active SGR,省略号前重应用,
// 否则背景色在省略号处断裂(contentBox 的 applyBg 被 `\x1b[0m` 抹掉).
// 移植自 pi-subagents render.ts:44-89.

import os from "node:os";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { AgentEventLogEntry, DisplayItem, ExecutionStatus } from "@zhushanwen/subagent-core/execution/types.ts";
import { DEFAULT_AGENT_NAME } from "@zhushanwen/subagent-core/execution/types.ts";
import type {
  DoneReason,
  ExecutionTraceNode,
  RunStatus,
  ToolCallEntry,
} from "@zhushanwen/subagent-core/orchestration/models/types.ts";
import { displayAgentName } from "@zhushanwen/subagent-core/shared/agent-ref.ts";

/**
 * ThemeLike:TUI 语义 token 着色接口(duck-typed,兼容 Pi Theme).
 *
 * 注意:Pi Theme **没有 `dim` 方法**——"dim" 是颜色 token,走 `fg("dim", text)`.
 * 故本接口只声明 fg/bg/bold/underline,dim 文本一律 `fg("dim", ...)`.
 */
export interface ThemeLike {
  bg(color: string, text: string): string;
  fg(color: string, text: string): string;
  bold(text: string): string;
  underline(text: string): string;
}

// ============================================================
// 模块级常量(复用,勿在热路径 new)
// ============================================================

/** spinner 帧序列(Braille),seed-frame 驱动,不用 setInterval. */
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** grapheme 切分器(Unicode/emoji 安全).模块级共享,勿热路径 new. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// formatTokens 阈值(三段式,与 demo 一致)
/** < 此值显示原值. */
const TOKEN_PLAIN_MAX = 1000;
/** < 此值显示 "N.Nk";≥ 此值显示 "Nk"(四舍五入). */
const TOKEN_DECIMAL_K_MAX = 10000;

// formatElapsedSeconds 阈值
const SECS_PER_MINUTE = 60;
const SECS_PER_HOUR = 3600;

// ============================================================
// Token / 时长格式化
// ============================================================

/**
 * 格式化 token 数(三段式,与 demo 一致).
 *
 *   < 1000  → 原值("820")
 *   < 10000 → "N.Nk"(8200 → "8.2k")
 *   ≥ 10000 → "Nk" 四舍五入(23000 → "23k")
 */
export function formatTokens(n: number): string {
  if (n < TOKEN_PLAIN_MAX) return String(n);
  if (n < TOKEN_DECIMAL_K_MAX) return `${(n / TOKEN_PLAIN_MAX).toFixed(1)}k`;
  return `${Math.round(n / TOKEN_PLAIN_MAX)}k`;
}

/**
 * 格式化整数秒时长(对话流 block + list overlay 共用).
 * 数据源 details.elapsedSeconds 已是 Math.floor 过的整数秒.
 *
 *   < 60   → "Xs"(12 → "12s")
 *   < 3600 → "Xm Ys"(72 → "1m12s")
 *   ≥ 3600 → "Xh Ym"
 */
export function formatElapsedSeconds(seconds: number): string {
  if (seconds < SECS_PER_MINUTE) return `${seconds}s`;
  if (seconds < SECS_PER_HOUR) {
    const m = Math.floor(seconds / SECS_PER_MINUTE);
    const s = seconds % SECS_PER_MINUTE;
    return `${m}m${s}s`;
  }
  const h = Math.floor(seconds / SECS_PER_HOUR);
  const m = Math.floor((seconds % SECS_PER_HOUR) / SECS_PER_MINUTE);
  return `${h}h${m}m`;
}

/** sync id 的段数（run-${seq}）。≤ 此值原样返回。 */
const SHORT_ID_SYNC_SEGMENTS = 2;
/** background id 取前 N 段（bg/${tag}/${seq}）。 */
const SHORT_ID_BG_SEGMENTS = 3;
/** subagent record id 的 `sa-` 前缀（前缀后接 UUID）。 */
const SA_ID_PREFIX = "sa-";
/** formatToolCall bash 分支 command 预览截断长度（字符）。 */
const BASH_PREVIEW_MAX_CHARS = 60;
/** formatToolCall default 分支 args JSON 预览截断长度（字符）。 */
const ARGS_PREVIEW_MAX_CHARS = 50;

/**
 * 从完整 record id 提取短编号用于列表展示.
 *
 * id 格式:
 *   - subagent:   `sa-<uuid>`                   (如 sa-550e8400-e29b-41d4-a716-446655440000)
 *                 → sa- 前缀 + UUID 前 3 段（sa-550e8400-e29b-41d4）
 *   - workflow:   `wf-<ts>-<rand>`               (如 wf-1719500000000-a1b2c3，3 段)
 *                 → 3 段 ≤ 2 不成立，取前 3 段 = 原样
 *   - sync:       `run-${seq}`                   (如 run-1，2 段) → 原样返回
 *   - 旧纯 UUID:  `<uuid>`                       (5 段) → 取前 3 段（向后兼容）
 */
export function shortId(id: string): string {
  // sa- 前缀的 subagent ID：保留前缀 + UUID 前 3 段（与纯 UUID 的 3 段信息量等价）
  if (id.startsWith(SA_ID_PREFIX)) {
    return SA_ID_PREFIX + id.slice(SA_ID_PREFIX.length).split("-").slice(0, SHORT_ID_BG_SEGMENTS).join("-");
  }
  const segments = id.split("-");
  if (segments.length <= SHORT_ID_SYNC_SEGMENTS) return id;
  return segments.slice(0, SHORT_ID_BG_SEGMENTS).join("-");
}

/**
 * 把文本 pad 到指定**可见**宽度(grapheme/emoji/CJK 安全).
 *
 * 用 visibleWidth 而非 `.length`——避免 ANSI 转义、emoji、宽字符(CJK 占 2 列)
 * 把列对齐算错(dev guide §2.4 警告的坑).
 *
 *   - 已 ≥ width → 原样返回(调用方负责先 truncLine 截断)
 *   - < width → 末尾补空格到可见宽度对齐
 *
 * 与 truncLine 配对:左/右列对齐时先 `truncLine(s, colWidth)` 再 `padToVisible(s, colWidth)`.
 */
export function padToVisible(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + " ".repeat(width - w);
}

/**
 * 分段着色版 segFill:title 和 fill 都已着色(含 ANSI),拼接时各自 ANSI 延续.
 *
 * 解决 ANSI 嵌套失色问题:若用 `t.fg("c1", fill(title, "─", n))`,
 * title 内的 `\x1b[0m` 会重置外层 c1,导致 title 之后的 `─` 失去 c1.
 * 本函数改成 `title + fill.repeat(后)`,fill 整段保持着自己的 ANSI,不依赖外层包裹 → 全线着色一致.
 *
 *   segFillColored(t.fg("accent"," Subagents "), t.fg("borderMuted","─"), 20)
 *   → accent(" Subagents ") + borderMuted(─×N),无嵌套
 *
 * 注意:fill 必须是「单字符着色」(如 `t.fg("borderMuted","─")`),visibleWidth=1.
 * 调用方负责 title/fill 着色;本函数不接 theme.标题在前、填充在后.
 */
export function segFillColored(titleStyled: string | undefined, fillStyled: string, width: number): string {
  if (width <= 0) return "";
  const fillW = visibleWidth(fillStyled);
  if (!titleStyled || fillW === 0) {
    // 纯填充线:fillStyled.visibleWidth 应为 1,按 width 次重复
    return fillStyled.repeat(width);
  }
  const tw = visibleWidth(titleStyled);
  if (tw >= width) return truncLine(titleStyled, width);
  const fillCount = width - tw;
  return titleStyled + fillStyled.repeat(fillCount);
}

// ============================================================
// 状态图标
// ============================================================

/**
 * status → 图标 + 颜色 token.
 *
 *   running → { icon: undefined, color: "accent" }
 *     icon 留空是因为 running 的 spinner 需 seed 驱动,
 *     调用方用 detailsSeed(details) 算 seed 后调 spinnerGlyph(seed).
 *   done      → { "✓", "success" }
 *   failed    → { "✗", "error" }
 *   cancelled → { "■", "muted" }
 */
export function statusGlyph(status: ExecutionStatus): { icon: string | undefined; color: string } {
  switch (status) {
    case "running":
      return { icon: undefined, color: "accent" };
    case "closed":
      // v4 B-1: closed 统一终态（含 cancelled）。默认 ✓ success 色。
      return { icon: "✓", color: "success" };
  }
}

/**
 * 生成 spinner 字形(seed 驱动,非定时器).
 *
 * 每次 onUpdate(真实事件)→ seed 单调增长 → 换帧;
 * 静默期 seed 不变 → 冻结 → 换取滚动体验(修复 viewport 锚定 bug).
 */
export function spinnerGlyph(seed: number): string {
  // 防御:seed 可能是 NaN(details 字段缺失时),回退首帧
  if (!Number.isFinite(seed)) return RUNNING_FRAMES[0]!;
  return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

// ============================================================
// eventLog 单行格式化
// ============================================================

/**
 * 压平 label 到单行(防 LLM 输出的 \r\n/\t 把单行展开成多行,破坏布局).
 * 两层防御之一(另一层在 tool-render 的 buildRenderLines).
 */
export function sanitizeLabel(label: string): string {
  return label.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
}

// ============================================================
// 共享文本/参数提取 helper(tool-render / list-view / bg-notify-render / subagent-tool 复用)
// ============================================================

/**
 * 取文本首个非空行(多行压成首行).
 *
 * 仅做"取首行"——不 sanitize.三处调用方的 sanitize 末步不同
 * (tool-render 调 sanitizeLabel、bg-notify-render 压 \r\t、list-view 不处理),
 * 故共享此基础函数,各自按需 wrap.
 *
 *   firstLine("a\nb\nc") → "a"
 *   firstLine("\n\nb") → "b"
 *   firstLine("") → ""
 */
export function firstLine(text?: string): string {
  if (!text) return "";
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}

/**
 * 从 renderCall/execute 的 unknown args 安全提取 agent 名.
 * 类型守卫窄化(替代 `as { agent?: string }` 全可选断言).
 * 无 agent 字段或非空字符串时兜底 DEFAULT_AGENT_NAME(与 service 层 resolveIdentity 一致,
 * 保证 block 标题显示的名与实际加载的 agent.md 相符).
 */
export function extractAgentName(args: unknown): string {
  if (typeof args === "object" && args !== null && "agent" in args) {
    const v = (args as { agent: unknown }).agent;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return DEFAULT_AGENT_NAME;
}

/**
 * 格式化单条 eventLog 条目(带类型图标 + 着色,不含 `⎿` 前缀——前缀由调用方加).
 *
 * 标签语义(tui-conversation.md §7):
 *   tool:    tool_start/tool_end(尾部追加 ✓/✗)
 *   ── turn ──  turn_end(仅 expanded)
 *   error:   tool label + ✗
 *
 * text_output / thinking 类型已移除——完整内容收口在 record.turns[]，
 * eventLog 只承载离散语义事件。实时 text/thinking 进度由 currentActivity 行展示。
 *
 * 预处理统一用 sanitizeLabel(换行→空格、tab→2空格).
 * 不做预截断——宽度截断全部交给外层调用点的 `truncLine(formatEventLine(...), width)`.
 */
export function formatEventLine(entry: AgentEventLogEntry, theme: ThemeLike): string {
  const label = sanitizeLabel(entry.label);

  switch (entry.type) {
    case "tool_start":
      return `tool: ${label}`;

    case "tool_end": {
      const mark = entry.status === "failed"
        ? ` ${theme.fg("error", "✗")}`
        : ` ${theme.fg("success", "✓")}`;
      return `tool: ${label}${mark}`;
    }

    case "turn_end": {
      // label = turn.text 摘要（getEventLog 派生，TURN_SUMMARY_MAX=80），无 text 时为 "turn"。
      // 若丢弃 label 只显 "── turn ──"，流式 text 在 turn 结束后完全消失（currentActivity
      // 随 turn 闭合转为 undefined），用户无法回顾 subagent 说了什么。这里显示摘要保留可见性。
      const summary = sanitizeLabel(entry.label);
      if (!summary || summary === "turn") {
        return theme.fg("dim", "── turn ──");
      }
      return theme.fg("toolOutput", summary);
    }

    case "error":
      // 错误条目:标签 + label + ✗
      return `tool: ${label} ${theme.fg("error", "✗")}`;

    default:
      return label;
  }
}

/**
 * [STEP3] 格式化单个 toolCall 为展示行（对齐 nicobailon formatToolCall）。
 *
 * 返回不含前缀（`→ ` 由调用方加）。根据 toolName 提取关键参数格式化：
 *   bash → `$ <command 预览>`
 *   read → `read <~路径:offset-limit>`
 *   edit/write → `<op> <~路径>`
 *   grep/find/ls → 对应格式
 *   default → `<toolName> <argsJSON 预览>`
 */
export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  theme: ThemeLike,
): string {
  const shortenPath = (p: string): string => {
    // 仅用于显示层路径缩写（~ 替换 home 前缀），不读取 pi 目录（TC9 合法命中）
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > BASH_PREVIEW_MAX_CHARS ? `${command.slice(0, BASH_PREVIEW_MAX_CHARS)}...` : command;
      return theme.fg("muted", "$ ") + theme.fg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = theme.fg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return theme.fg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = theme.fg("muted", "write ") + theme.fg("accent", shortenPath(rawPath));
      if (lines > 1) text += theme.fg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return theme.fg("muted", "edit ") + theme.fg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return theme.fg("muted", "ls ") + theme.fg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return theme.fg("muted", "find ") + theme.fg("accent", pattern) + theme.fg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return theme.fg("muted", "grep ") + theme.fg("accent", `/${pattern}/`) + theme.fg("dim", ` in ${shortenPath(rawPath)}`);
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > ARGS_PREVIEW_MAX_CHARS ? `${argsStr.slice(0, ARGS_PREVIEW_MAX_CHARS)}...` : argsStr;
      return theme.fg("accent", toolName) + theme.fg("dim", ` ${preview}`);
    }
  }
}

/**
 * [STEP3] 格式化单个 displayItem 为展示行（含 `→ ` 前缀）。
 *
 * toolCall：`→ <formatToolCall>` + 尾部 ✓/✗（done/failed 才加）。
 * text：assistant 正文（compact 时调用方自行截断，这里返回原文）。
 */
export function formatDisplayItem(item: DisplayItem, theme: ThemeLike): string {
  if (item.type === "text") {
    return theme.fg("toolOutput", item.text ?? "");
  }
  const name = item.name ?? "unknown";
  const args = item.args ?? {};
  const base = `${theme.fg("muted", "→ ")}${formatToolCall(name, args, theme)}`;
  if (item.status === "done") return `${base} ${theme.fg("success", "✓")}`;
  if (item.status === "failed") return `${base} ${theme.fg("error", "✗")}`;
  return base;
}

// ============================================================
// ANSI 安全截断
// ============================================================

/**
 * SGR 序列 sticky regex（truncLine 专用）。
 *
 * lastIndex 置位后 exec/test 只在该位置匹配（等价 `flat.slice(pos).match(/^\x1b\[[0-9;]*m/)`，
 * 但零子串分配）。同步代码内「设 lastIndex → 立即用」，无跨调用残留。
 */
const SGR_STICKY_RE = /\x1b\[[0-9;]*m/y;

/** 判断 s 在 pos 处是否开始一个 SGR 序列（非 SGR ESC——OSC/非 SGR CSI/裸 ESC——返回 false）。 */
function isSgrStart(s: string, pos: number): boolean {
  SGR_STICKY_RE.lastIndex = pos;
  return SGR_STICKY_RE.test(s);
}

/**
 * 截断文本到 maxWidth 可见宽度(带省略号 `…`,ANSI 安全).
 *
 * 问题:pi-tui 的 truncateToWidth 在省略号前插 `\x1b[0m`(全局 reset),
 * 导致 contentBox 施加的背景色在省略号处断裂.
 *
 * 解决:遍历追踪 active SGR styles,遇 `\x1b[0m` 清空、遇其他 `\x1b[..m` push,
 * 截断时 `result + activeStyles.join("") + "…"`——重应用 active 样式,背景不断裂.
 * 用 Intl.Segmenter grapheme 切分,正确处理 emoji/CJK/组合字符.
 *
 * 性能（IF12/#18）：旧实现逐字符 `flat.slice(end).match(...)` 是 O(n²)（每字符
 * 一次子串分配 + 正则扫描）；现改为 `indexOf("\x1b", ...)` 跳到下一 ESC，仅在 ESC
 * 位置做一次 sticky 判定——纯文本段零分配零正则。
 *
 * **非 SGR ESC 行为（等价关键，逐字节等价的定义点）**：OSC（\x1b]0;..\x07）、
 * 非 SGR CSI（\x1b[K）、裸 \x1b 后跟非 [ 字符——均不构成文本段边界，作为纯文本
 * 并入 textPortion 被 segmenter 消费（占 currentWidth、进 result），与旧实现
 * 「while 停点集合 = SGR 序列起点」完全一致。输出由 __fixtures__/truncline.snapshot.json
 * （改造前实现生成）逐字节锚定。
 *
 * 移植自 pi-subagents render.ts:44-89.
 */
export function truncLine(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  // 剥离换行符（\n / \r）：text 可能含多行 prompt / turn.text，\n 不占可见宽度
  // 但在终端会换行，导致单行渲染意外变成多行，破坏行对齐（list overlay 左右列错位、
  // tool block 行数跳变）。单行渲染入口必须保证无 \n。用空格替代（保留词边界可读性）。
  const flat = text.replace(/[\r\n]+/g, " ");
  if (visibleWidth(flat) <= maxWidth) return flat;

  const targetWidth = Math.max(0, maxWidth - 1);
  let result = "";
  let currentWidth = 0;
  let activeStyles: string[] = [];
  let i = 0;

  while (i < flat.length) {
    // 捕获 ANSI SGR 序列（sticky：只在 i 处匹配，等价旧 slice(i).match(/^.../m)）
    SGR_STICKY_RE.lastIndex = i;
    const ansiMatch = SGR_STICKY_RE.exec(flat);
    if (ansiMatch) {
      const code = ansiMatch[0];
      result += code;

      if (code === "\x1b[0m" || code === "\x1b[m") {
        activeStyles = []; // reset → 清空栈
      } else {
        activeStyles.push(code);
      }
      i += code.length;
      continue;
    }

    // 找到下一段纯文本(非 ANSI)的边界：下一处 SGR 序列起点（或串尾）。
    // indexOf 跳到 ESC 候选位，仅对 ESC 位置做一次 sticky 判定；非 SGR ESC
    // （OSC/\x1b[K/裸 \x1b）不构成边界、并入文本段（end 推进到该 ESC 之后继续找），
    // 与旧逐字符 while 的停点集合逐字节一致。
    let end = flat.length;
    for (
      let escPos = flat.indexOf("\x1b", i);
      escPos !== -1;
      escPos = flat.indexOf("\x1b", escPos + 1)
    ) {
      if (isSgrStart(flat, escPos)) {
        end = escPos;
        break;
      }
    }

    // 按 grapheme 迭代这段文本,累加到 targetWidth
    const textPortion = flat.slice(i, end);
    for (const seg of segmenter.segment(textPortion)) {
      const grapheme = seg.segment;
      const graphemeWidth = visibleWidth(grapheme);

      if (currentWidth + graphemeWidth > targetWidth) {
        // 截断:重应用 active 样式 + 省略号 + reset。
        // reset 不可省——否则行尾颜色渗透到 padToVisible 的填充空格、乃至下一帧行，
        // 视觉上表现为颜色重影（被截断的着色延伸到行尾之外）。
        // 但纯文本输入（activeStyles 为空）不发 reset——\x1b[0m 是全局重置，
        // 会清除 theme.bg 施加的外层背景色（背景框内省略号后失去背景的根因）。
        return result + activeStyles.join("") + "…" + (activeStyles.length ? "\x1b[0m" : "");
      }

      result += grapheme;
      currentWidth += graphemeWidth;
    }
    i = end;
  }

  // 理论上 visibleWidth 检查已提前返回,此行兜底
  return result + activeStyles.join("") + "…" + (activeStyles.length ? "\x1b[0m" : "");
}

/**
 * 把长文本按指定可见宽度拆成多行（word-wrap），完整展示不截断。
 *
 * 用于 detail 模式完整展示长内容（task / output text）。detail 有翻屏能力，
 * 不应像预览那样截断成一行省略号——信息完整性优先。
 *
 * 输入为纯文本（不含 ANSI 颜色）。调用方对返回的每行单独着色，
 * 这样避免对 ANSI 文本做复杂 wrap（SGR 状态跨行续重应用）。
 *
 * grapheme 迭代（CJK/emoji 安全）：逐字素累加可见宽度，超 maxWidth 即断行。
 * CJK 可在任意字素间断（每个汉字占 2 列但可断），拉丁文不强制保留词边界
 * （detail 场景优先完整性，width 足够宽时自然在空格附近断）。
 *
 * 原始 \n 保留为段落分隔（split 后每段独立 wrap，空行保留为 ""）。
 * 与 truncLine 的扁平化不同：wrapText 的产物是多行，\n 是有意的段落边界。
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const result: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const trimmed = para.trim();
    if (!trimmed) {
      result.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const seg of segmenter.segment(trimmed)) {
      const g = seg.segment;
      const gw = visibleWidth(g);
      if (lineWidth + gw > maxWidth && line.length > 0) {
        result.push(line);
        line = g;
        lineWidth = gw;
      } else {
        line += g;
        lineWidth += gw;
      }
    }
    if (line.length > 0) result.push(line);
  }
  return result;
}

// ============================================================
// Workflow view 格式化（WorkflowsView / detail-content 专用差异段）
//
// 自 views/format.ts 并入（D7-① 双轨合并）：workflow 视图特有的 badge/phase/
// trace 行格式化在此作差异段保留。并入时收敛的同构构件——ThemeLike、
// formatElapsedSeconds（本文件版含小时分支，>1h 显示 "1h15m" 而非 "75m30s"）、
// segFillColored、padToVisible——直接复用上方单定义，views 版副本不再存在。
// ============================================================

// ── Workflow view 布局常量 ────────────────────────────────────

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

/** formatElapsed 的毫秒→秒换算。 */
const MS_PER_SEC = 1000;

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

// ── Workflow status helpers ──────────────────────────────────

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

// ── Workflow 时间 / 统计格式化 ────────────────────────────────

/**
 * Format elapsed time string from startedAt. Three tiers, output shape kept
 * identical to formatElapsedSeconds（U-1 修复：>1h 显示 "1h15m"，消灭 "75m30s" 漂移形态）:
 *
 *   < 1s    → "0s"
 *   < 60s   → "Xs"
 *   < 3600s → "XmYs" ("45m30s")
 *   ≥ 3600s → "XhYm" ("1h15m")
 */
export function formatElapsed(startedAt?: string, now: number = Date.now()): string {
  if (!startedAt) return "-";
  const ms = now - new Date(startedAt).getTime();
  if (ms < MS_PER_SEC) return "0s";
  const secs = Math.floor(ms / MS_PER_SEC);
  if (secs < SECS_PER_MINUTE) return `${secs}s`;
  if (secs < SECS_PER_HOUR) {
    const mins = Math.floor(secs / SECS_PER_MINUTE);
    const remSecs = secs % SECS_PER_MINUTE;
    return `${mins}m${remSecs}s`;
  }
  // 小时分支计算形态照抄 formatElapsedSeconds，保证两函数同输入同输出
  const hours = Math.floor(secs / SECS_PER_HOUR);
  const mins = Math.floor((secs % SECS_PER_HOUR) / SECS_PER_MINUTE);
  return `${hours}h${mins}m`;
}

/**
 * Format a live eventLog entry（live 路径 Activity 区用）。
 *
 *   tool_start → "→ {label}"
 *   tool_end   → "← {label}"（done）/ "✗ {label}"（failed）
 *   turn_end   → "∘ {label}"（turn 摘要）
 *   error      → "✗ {label}"
 *
 * 对齐上方 subagents formatEventLine 的视觉风格，但语义域是 workflow trace
 * （前缀符号不同、label 不 sanitize）——与 formatEventLine 是两个概念域的实现，
 * 同文件共存故以 Trace 前缀区分命名。
 */
export function formatTraceEventLine(entry: AgentEventLogEntry, theme: ThemeLike): string {
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

// ── Workflow phase group（filters empty phases）──────────────

export interface PhaseGroup {
  name: string;
  nodes: ExecutionTraceNode[];
  doneCount: number;
}

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

// ── Workflow sidebar phase line formatter ────────────────────

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

// ── Workflow agent one-liner for overview right panel ────────

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
