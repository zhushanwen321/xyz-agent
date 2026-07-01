/**
 * Mermaid 渲染纯逻辑（R2 logic 层）。
 *
 * 动态 import mermaid（避免首屏加载 ~3MB），按当前应用主题（[data-theme]）配置
 * themeVariables（对齐项目 design-tokens 冷蓝暗色/亮色，而非 design-visual-explainer 的 teal）。
 *
 * 主题机制关键差异（HISTORICAL）：xyz-agent 是应用内 [data-theme] 切换，非系统 prefers-color-scheme。
 * mermaid 的 themeVariables 在 initialize 时固化（颜色 bake 进 SVG path），切主题必须重新 initialize + 重渲染。
 * 故本模块导出 resolveMermaidTheme（按主题取 themeVariables）+ renderMermaid（initialize + render），
 * 供 MermaidRenderer.vue 在主题变化时重新调用。
 *
 * 主题色映射（从 style.css CSS 变量语义 → mermaid themeVariables）：
 *  暗色（:root）  : primaryColor=#151519(--surface) border=#ffffff1f(--border-strong) line=#4f8ef7(--accent)
 *  亮色（[light]）: primaryColor=#ffffff(--surface) border=#00000024(--border-strong) line=#2563eb(--accent)
 */
import type { default as MermaidInstance } from 'mermaid'

/** mermaid 单例类型（default 导出实例的类型） */
type Mermaid = typeof MermaidInstance

/** mermaid 单例（动态 import 后缓存，全应用共享） */
let mermaidPromise: Promise<Mermaid> | null = null
/** 已 initialize 的主题标记——主题变化时需重新 initialize */
let initializedTheme: 'dark' | 'light' | null = null

/**
 * 动态 import mermaid 并缓存单例。
 * 导出供 MermaidRenderer 复用，避免重复加载。
 */
export function getMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    // 动态 import：mermaid ~3MB，首屏不需要时不加载（对话流有 mermaid 块才触发）
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

/**
 * 从 <html data-theme> 读取当前主题。
 * 暗为默认（无 data-theme 或 'dark'），亮为 'light'（style.css ADR-0021-B）。
 */
export function getCurrentTheme(): 'dark' | 'light' {
  const attr = document.documentElement.getAttribute('data-theme')
  return attr === 'light' ? 'light' : 'dark'
}

/**
 * 按主题构建 mermaid themeVariables（对齐项目 design-tokens，非 design-visual-explainer 的 teal）。
 * 色值取自 style.css 的暗/亮 CSS 变量（硬编码等效值——mermaid themeVariables 不支持 CSS 变量引用，
 * 颜色 bake 进 SVG，必须用具体色值；与 shiki 双主题 CSS 变量切换机制不同）。
 */
export function resolveMermaidThemeVariables(theme: 'dark' | 'light'): Record<string, string> {
  if (theme === 'light') {
    return {
      fontFamily: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace",
      fontSize: '14px',
      // 亮色：白底节点 + 深色边框/文字（style.css [data-theme=light]）
      primaryColor: '#ffffff', // --surface
      primaryBorderColor: '#00000024', // --border-strong
      primaryTextColor: '#0d0d0f', // --fg
      secondaryColor: '#f1f3f6', // --surface-2
      secondaryBorderColor: '#3b82f6', // --accent-hover
      secondaryTextColor: '#5a5a65', // --muted
      tertiaryColor: '#f8f9fb', // --bg
      tertiaryBorderColor: '#00000014', // --border
      tertiaryTextColor: '#5a5a65',
      lineColor: '#2563eb', // --accent
      // note（mermaid note 节点）
      noteBkgColor: '#f1f3f6',
      noteTextColor: '#0d0d0f',
      noteBorderColor: '#3b82f6',
    }
  }
  return {
    fontFamily: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace",
    fontSize: '14px',
    // 暗色：深底节点 + 亮色边框/文字（style.css :root）
    primaryColor: '#151519', // --surface
    primaryBorderColor: '#ffffff1f', // --border-strong
    primaryTextColor: '#f0f0f5', // --fg
    secondaryColor: '#1b1b20', // --surface-2
    secondaryBorderColor: '#4f8ef7', // --accent
    secondaryTextColor: '#8a8a95', // --muted
    tertiaryColor: '#0d0d0f', // --bg
    tertiaryBorderColor: '#ffffff0f', // --border
    tertiaryTextColor: '#8a8a95',
    lineColor: '#4f8ef7', // --accent
    noteBkgColor: '#1b1b20',
    noteTextColor: '#f0f0f5',
    noteBorderColor: '#4f8ef7',
  }
}

/**
 * 渲染 mermaid 源码为 SVG 字符串。
 * 主题变化时自动重新 initialize（themeVariables 在 initialize 时固化）。
 *
 * @param source mermaid 源码
 * @param theme 当前主题（调用方传入，主题变化时传新值触发重新 initialize）
 * @returns { svg } mermaid.render 的返回
 * @throws mermaid 解析/渲染失败时抛出（调用方 catch 显示失败态）
 */
export async function renderMermaid(
  source: string,
  theme: 'dark' | 'light',
): Promise<{ svg: string }> {
  const mermaid = await getMermaid()

  // 主题变化（或首次）：重新 initialize
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      look: 'classic',
      themeVariables: resolveMermaidThemeVariables(theme),
      // 不用 layout:'elk'（需额外 @mermaid-js/layout-elk 包）；flowchart 默认 dagre 布局足够
    })
    initializedTheme = theme
  }

  // 唯一 id：mermaid 内部缓存按 id，重复 id 会冲突。
  // toString(RADIX) 用 36 进制（0-9a-z），slice(SKIP_PREFIX, ID_LEN+SKIP_PREFIX) 去掉 "0." 前缀取 6 位
  const ID_RADIX = 36
  const ID_SKIP_PREFIX = 2
  const ID_LEN = 6
  const id = `md-${Date.now()}-${Math.random().toString(ID_RADIX).slice(ID_SKIP_PREFIX, ID_SKIP_PREFIX + ID_LEN)}`
  const { svg } = await mermaid.render(id, source)
  return { svg }
}

/** 重置 mermaid 状态（测试用：清 initializedTheme 强制下次重新 initialize） */
export function __resetMermaidForTest(): void {
  initializedTheme = null
}
