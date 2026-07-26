/**
 * xterm 终端配色主题（硬编码 hex）。
 *
 * 背景/前景/光标对齐 v3 design tokens（style.css :root），
 * 16 色 ANSI 调色板参考 Dracula / Gruvbox Dark 饱和度分布。
 *
 * 为什么用 hex 字面量不用 CSS 变量：
 * canvas 渲染器读不了 var()（TerminalView.vue 注释），theme 必须写死。
 *
 * TODO: 后续升级方案 A 时加 lightTerminalTheme + watch(theme) 联动。
 */
import type { ITheme } from '@xterm/xterm'

export const darkTerminalTheme: ITheme = {
  /* ── 核心色（v3 tokens）────────────────────────────── */
  background: '#1a1b1f',      // --bg
  foreground: '#f7f8fc',      // --fg
  cursor: '#4f8ef7',          // --accent
  cursorAccent: '#1a1b1f',    // block cursor 内文字色（= bg，反差可见）
  selectionBackground: 'rgba(79, 142, 247, 0.30)', // --accent-ring
  selectionInactiveBackground: 'rgba(79, 142, 247, 0.15)',

  /* ── ANSI 16 色 ─────────────────────────────────────── */
  // 标准色（0-7）：色相对齐 v3 状态色，饱和度参考 Dracula/Gruvbox
  black: '#1a1b1f',           // = bg
  red: '#ef4444',             // --danger
  green: '#22c55e',           // --success
  yellow: '#f5a524',          // --warning
  blue: '#4f8ef7',            // --accent
  magenta: '#a78bfa',         // --reasoning（紫）
  cyan: '#38bdf8',            // --info
  white: '#a8a8b5',           // --muted（暗色下 white 视觉=灰）

  // 亮色（8-15）：提亮一档，参考 Dracula/Gruvbox bright 变体
  brightBlack: '#6272a4',     // Dracula comment 色，常用于注释/弱文字
  brightRed: '#f87171',       // red +1 亮度档
  brightGreen: '#4ade80',     // green +1
  brightYellow: '#fbbf24',    // yellow +1
  brightBlue: '#60a5fa',      // blue +1
  brightMagenta: '#c084fc',   // magenta +1（Dracula 洋红方向偏移）
  brightCyan: '#67e8f9',      // cyan +1
  brightWhite: '#f7f8fc',     // = foreground（亮色下真正的白）
}
