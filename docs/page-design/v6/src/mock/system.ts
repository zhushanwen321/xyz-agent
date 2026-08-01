/** Mock 数据层 — 系统设置页（SystemPage）静态数据 + 故障注入开关 */

/** 系统设置字段（对齐真实项目 SystemSettings 的字段语义） */
export interface SystemSettings {
  locale: string
  theme: string
  fontSize: string
  completionSound: boolean
  successSound: string
  errorSound: string
  themePreset: string
}

/** 默认系统设置（mock 拉取初值 = 快照初值 → 首屏 clean） */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  locale: 'zh-CN',
  theme: 'dark',
  fontSize: 'medium',
  completionSound: true,
  successSound: '',
  errorSound: '',
  themePreset: 'cold-blue',
}

/** 语言选项（value → 显示名） */
export const LOCALE_OPTIONS: { value: string; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
]

/** 外观模式选项 */
export const THEME_OPTIONS: { value: string; label: string }[] = [
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
  { value: 'system', label: '跟随系统' },
]

/** 字体大小选项 */
export const FONT_SIZE_OPTIONS: { value: string; label: string }[] = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
]

/** 声音清单项（id=播放标识，name=显示名；真实实现经 IPC 拉取平台系统声音） */
export interface SoundInfo {
  id: string
  name: string
}

/** 平台系统声音清单（macOS 精选。置空数组可演示空态：下拉只剩「系统默认」） */
export const SYSTEM_SOUNDS: SoundInfo[] = [
  { id: 'Glass', name: 'Glass' },
  { id: 'Ping', name: 'Ping' },
  { id: 'Basso', name: 'Basso' },
  { id: 'Funk', name: 'Funk' },
  { id: 'Pop', name: 'Pop' },
  { id: 'Purr', name: 'Purr' },
  { id: 'Sosumi', name: 'Sosumi' },
  { id: 'Tink', name: 'Tink' },
]

/** 试听合成音参数（demo 无系统声音，用 Web Audio 按 id 合成近似音色：频率/时值） */
export const SOUND_TONES: Record<string, { freq: number; dur: number }> = {
  __default__: { freq: 880, dur: 0.18 },
  Glass: { freq: 1046, dur: 0.35 },
  Ping: { freq: 1318, dur: 0.22 },
  Basso: { freq: 220, dur: 0.4 },
  Funk: { freq: 494, dur: 0.16 },
  Pop: { freq: 740, dur: 0.12 },
  Purr: { freq: 330, dur: 0.3 },
  Sosumi: { freq: 587, dur: 0.25 },
  Tink: { freq: 1568, dur: 0.15 },
}

/** 配色主题预设（低饱和组；swatch 圆点色值为产品数据，非 UI token） */
export interface Swatch {
  id: string
  label: string
  color: string
}

export const MUTED_SWATCHES: Swatch[] = [
  { id: 'warm-teal', label: 'Warm Teal', color: 'oklch(55% 0.08 195)' },
  { id: 'cold-teal', label: 'Cold Teal', color: 'oklch(62% 0.10 190)' },
  { id: 'neutral', label: 'Neutral', color: 'oklch(40% 0 0)' },
  { id: 'sharp', label: 'Sharp', color: 'oklch(10% 0 0)' },
  { id: 'warm-neutral', label: 'Warm Neutral', color: 'oklch(45% 0.04 80)' },
]

/** 配色主题预设（彩色组） */
export const COLORFUL_SWATCHES: Swatch[] = [
  { id: 'cold-blue', label: 'Cold Blue', color: '#4f8ef7' },
  { id: 'terracotta', label: 'Terracotta', color: 'oklch(64% 0.13 28)' },
  { id: 'rose', label: 'Rose', color: 'oklch(65% 0.14 350)' },
  { id: 'amber', label: 'Amber', color: 'oklch(67% 0.15 65)' },
  { id: 'blue', label: 'Blue', color: 'oklch(62% 0.15 250)' },
  { id: 'violet', label: 'Violet', color: 'oklch(62% 0.15 280)' },
]

/** 可重录命令（对齐真实组件 DEFAULT_KEYS：key 为存储格式，显示时补平台修饰键） */
export const SHORTCUT_DEFAULT_KEYS: Record<string, string> = {
  'new-session': 'n',
  'toggle-sidebar': 'b',
}

/** 快捷键行显示名 */
export const SHORTCUT_LABELS: Record<string, string> = {
  'new-session': '新建会话',
  'toggle-sidebar': '显示或隐藏侧栏',
}

/** 故障注入开关：置 true 演示「保存失败」分支（成功后不会刷新快照，可重试） */
export const SIMULATE_SAVE_FAILURE = false
/** 故障注入开关：置 true 演示「自动重命名保存失败」（回滚 + 行内错误） */
export const SIMULATE_AUTO_RENAME_FAILURE = false
