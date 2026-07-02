/**
 * Panel popover 共享样式常量（架构审查 D4）。
 *
 * ModelSelectPopover / ThinkingLevelPopover / AddMenuPopover 三者 trigger 与列表选中态
 * 类名各自重复，在此统一抽出，避免一字不差地抄写三遍。
 */

/**
 * 文本型 trigger 基础类（ModelSelect / ThinkingLevel 共用）。
 * 紧凑高度 + 小圆角 + 弱化字色 + 悬停加深。AddMenu 是图标型 trigger，不复用此类。
 */
export const TRIGGER_TEXT_CLASS =
  'h-7 rounded-sm px-2 text-[11.5px] text-subtle transition-colors hover:text-muted'

/**
 * 图标型 trigger 基础类（AddMenu 用）。
 * 固定尺寸 + 小圆角 + 弱化字色 + 悬停底色。
 */
export const TRIGGER_ICON_CLASS =
  'size-[28px] shrink-0 rounded-sm text-subtle transition-colors hover:bg-surface-hover hover:text-muted'

/**
 * 列表项「选中态」类名（ModelSelect / ThinkingLevel 列表项共用）。
 * 选中后走 accent 配色，并锁死 hover 不回退，避免选中项悬停闪色。
 */
export const SELECTED_ITEM_CLASS =
  'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'
