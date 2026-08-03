/**
 * composer input 模块类型 —— core/domain/composer/input/ 的内部类型契约（W2）。
 *
 * 定位：p3-strangler-domains::composer W2 input 模块迁入 core 的类型骨架。
 * 承接 slice 级 design review IF1/IF2/IF9/IF10（ContenteditableCallbacks/ChipCallbacks/
 * ComposerInputInstance/HistoryDeps 等结构契约）+ DM2（ComposerNavState per-session 分区容器）+
 * DM3（HandleImagePasteResult pasteImage 回调返回类型）+ DM4（VerticalMoveResult 内部类型）。
 *
 * deps 注入契约（clarify C1）：core input 模块零 renderer import（零 @/api / 零 electronAPI /
 * 零 @/stores.chat / 零 @/i18n / 零 @/composables/slashIcons），跨域能力与壳层资源全部经
 * deps 回调注入。注入字段：
 * - pasteImage：替代 handleImagePaste（走 writeSessionImage IPC），contenteditable/dragdrop 用
 * - getHistoryEntries：替代 chatStore.getMessages 派生，history 用
 * - getSlashIcon：替代 SLASH_ICON_COMPONENTS 查找，chip-commands 用
 * - t：替代 i18n.global.t，chip-commands 用（× 按钮 aria-label）
 *
 * 零 DOM 约束：本文件只定义类型，不触 DOM。
 */
import type { Component, Ref } from 'vue'

/**
 * HandleImagePasteResult —— pasteImage 回调返回类型（对齐 renderer useImageAttachment）。
 *
 * core 不 import useImageAttachment（它走 IPC），壳层注入的 pasteImage 回调返回此类型，
 * contenteditable/dragdrop 据 kind 决定占位 badge 回填 / 文本降级。
 */
export type HandleImagePasteResult =
  | { kind: 'badge'; path: string; fileName: string; displayName: string; needsMigrate: boolean }
  | { kind: 'text'; text: string }

/**
 * contenteditable 输入触发事件回调（ComposerInput 通过 emit 转发 + 壳层注入 pasteImage）。
 *
 * 原 renderer ContenteditableCallbacks 契约保持（onInput/onSlashTrigger/onFileTrigger/
 * onEnterKeydown/onKeydown/handleBackspaceOnChip/insertImageBadge/getSessionId），
 * 新增 pasteImage（clarify C1 D1：替代直接 import handleImagePaste）。
 */
export interface ContenteditableCallbacks {
  /** 输入文本变更（draft 同步） */
  onInput: (text: string) => void
  /** slash 触发检测：{query} 表示 / 在最左且无 chip；null 表示应关闭浮层 */
  onSlashTrigger: (payload: { query: string } | null) => void
  /** # 文件触发检测：{query} 表示光标前有「空格/行首 + # + 非空白」序列；null 表示应关闭浮层 */
  onFileTrigger: (payload: { query: string } | null) => void
  /** Enter（无 shift）委派：交给 Composer 决定发送/steer/followup */
  onEnterKeydown: (e: KeyboardEvent) => void
  /** 非 Enter 的其他键（Backspace chip 删除以外的）向上转发 */
  onKeydown: (e: KeyboardEvent) => void
  /**
   * Backspace 紧跟 chip 时整体删 chip。返回 true 表示已处理（调用方 preventDefault）。
   * 由 chip-commands 经 callbacks 注入（避免 core 内循环 import）。
   */
  handleBackspaceOnChip: () => boolean
  /**
   * 插入图片 badge（Cmd/Ctrl+V 富呈现通路）。由 chip-commands.insertImageBadge 提供。
   */
  insertImageBadge: (path: string, fileName: string, displayName: string, needsMigrate?: boolean) => void
  /**
   * 取当前会话 id（决定图片持久化目录）；landing 态返回 null。
   */
  getSessionId: () => string | null
  /**
   * [W2 注入] 粘贴/拖入图片处理（替代直接 import handleImagePaste）。
   * 壳层注入真实 handleImagePaste（走 writeSessionImage IPC），core 内 paste 通路仅编排占位/回填。
   */
  pasteImage: (file: File, sessionId: string | null) => Promise<HandleImagePasteResult>
}

/**
 * chip-commands 回调（原 ChipCallbacks 扩展 getSlashIcon/t 注入）。
 *
 * onChanged/restoreSelection 保持原契约；新增 getSlashIcon（替代 import SLASH_ICON_COMPONENTS）
 * + t（替代 import i18n）。createVNode/render 是 vue API，保留在 core 内（非 DOM 直连）。
 */
export interface ChipCallbacks {
  /** chip 变更后同步父组件状态（isEmpty/draft/slash-trigger），即 ComposerInput.onInput */
  onChanged: () => void
  /** 恢复光标到命令浮层夺焦前的位置（insertMentionChip/insertFileChip/insertImageBadge 用） */
  restoreSelection: () => void
  /**
   * [W2 注入] 取 slash 命令对应的图标组件（替代 import SLASH_ICON_COMPONENTS）。
   * @param iconKey 图标 key（如 'terminal'/'star'/'wrench'），由调用方（命令选择）透传
   * @returns 图标 Vue 组件，undefined 表示无图标
   */
  getSlashIcon: (iconKey: string) => Component | undefined
  /**
   * [W2 注入] 国际化文案（替代 import i18n.global.t）。
   * 当前唯一用途：× 按钮 aria-label（composable.removeLabel）。
   */
  t: (key: string) => string
}

/**
 * ComposerInput 实例最小契约（clear/setText/insertImageBadge/insertSlashChip/insertFileChip
 * 经 defineExpose 暴露）。用结构类型避免 import .vue 文件（循环依赖 + 类型推断复杂）。
 */
export interface ComposerInputInstance {
  clear: () => void
  setText: (text: string, caretPosition?: 'end' | 'start') => void
  insertImageBadge: (path: string, fileName: string, displayName: string, needsMigrate?: boolean) => void
  insertSlashChip: (command: string, icon?: string) => void
  insertFileChip: (path: string, lineRange?: [number, number]) => void
}

/** restore 模块依赖（draft/inputRef/drafts/sessionId，原契约保持） */
export interface ComposerRestoreDeps {
  draft: Ref<string>
  inputRef: Ref<ComposerInputInstance | null>
  drafts: Map<string, string>
  sessionId: Ref<string | null>
}

/**
 * history 模块依赖（DOM 操作回调 + getHistoryEntries 派生注入）。
 *
 * getHistoryEntries（clarify C1 D2）：替代 chatStore.getMessages 派生。
 * 返回已派生 + 倒序 + 去重连续相同文本的最终历史数组，core history.ts 不持 chatStore。
 * 壳层注入 `(sid) => deriveHistoryFromChatStore(chatStore, sid)`。
 */
export interface HistoryDeps {
  getText: () => string
  /** 写入纯文本；caretPosition='start' 光标定位首字符前（用于↑连续回溯），默认 'end' */
  setText: (text: string, caretPosition?: 'start' | 'end') => void
  clear: () => void
  /** [W2 注入] 历史条目派生（替代 chatStore.getMessages 派生） */
  getHistoryEntries: (sessionId: string) => string[]
}

/**
 * dragdrop 模块依赖（pasteImage 注入，同 contenteditable）。
 */
export interface DragDropDeps {
  /** [W2 注入] 拖入图片处理（替代直接 import handleImagePaste） */
  pasteImage: (file: File, sessionId: string | null) => Promise<HandleImagePasteResult>
}

/** per-session browsing 导航状态（收进 reactive 经 useSessionScopedState Map 分区） */
export interface ComposerNavState {
  /** 是否正在浏览历史（响应式，暴露给 Composer 跳过视觉行移动） */
  browsing: boolean
  /** browsing 态指针：指向 history[index] */
  index: number
  /** 进 browsing 前保存的草稿 */
  savedDraft: string
}

/**
 * 视觉行上/下移动结果（input-dom.ts moveCaretVerticalOf 返回）。
 * - result: 'moved'（已跨行或行内归位，消费事件）/ 'at-edge'（已在边缘行，调用方翻历史）
 * - preferredX: 更新后的 preferred X（首次垂直移动时记录 caretRect.left，后续保持）
 */
export interface VerticalMoveResult {
  result: 'moved' | 'at-edge'
  preferredX: number | null
}
