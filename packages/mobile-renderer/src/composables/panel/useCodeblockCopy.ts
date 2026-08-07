/**
 * useCodeblockCopy —— 代码块复制按钮反馈（从 MarkdownRenderer.vue 拆出，单一变化轴「事件委托复制反馈」）。
 *
 * 与 effects/useCopy 的差异（为何不复用它）：useCopy 是 ref-based（copied key + Vue 响应式，
 * 供模板 :class/v-if 切换 Copy/Check 图标）。代码块复制走**事件委托**——按钮在 markdown-it
 * 产出的 v-html 内，Vue 无法绑定事件/无响应式节点，反馈态只能用 DOM class（.is-copied）切换。
 * ref→DOM 桥接（watch copied → 找元素 toggle class）徒增 watcher 且无收益，故独立封装此
 * DOM-imperative 版本。剪贴板写入语义与 useCopy 一致（失败静默，非关键路径）。
 *
 * 职责：
 * - copyButton(btn, code)：写剪贴板 + 该按钮加 .is-copied（同时只一个按钮处于反馈态，后者覆盖前者）。
 * - dispose：清定时器（调用方 onBeforeUnmount）。
 */
/** 复制反馈持续时长（ms）—— 与 effects/useCopy 的 COPIED_FEEDBACK_MS 保持一致 */
const COPY_FEEDBACK_MS = 1200
/** 复制反馈态 class（CSS .is-copied 切换 Copy→Check icon + 成功色） */
const COPIED_CLASS = 'is-copied'

export function useCodeblockCopy(): {
  /** 写剪贴板 + 给 btn 加反馈态（覆盖前一个反馈态按钮）；code 为空时 noop */
  copyButton: (btn: HTMLElement, code: string) => void
  /** 清反馈态 + 清定时器（onBeforeUnmount 调用） */
  dispose: () => void
  } {
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null
  /** 当前处于"已复制"反馈态的按钮（同时只有一个） */
  let copiedBtn: HTMLElement | null = null

  function clearCopiedState(): void {
    if (copiedBtn) {
      copiedBtn.classList.remove(COPIED_CLASS)
      copiedBtn = null
    }
  }

  function copyButton(btn: HTMLElement, code: string): void {
    navigator.clipboard.writeText(code).catch(() => {
      /* 剪贴板失败静默：非关键路径 */
    })
    clearCopiedState()
    btn.classList.add(COPIED_CLASS)
    copiedBtn = btn
    if (copyResetTimer) clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(clearCopiedState, COPY_FEEDBACK_MS)
  }

  function dispose(): void {
    if (copyResetTimer) clearTimeout(copyResetTimer)
  }

  return { copyButton, dispose }
}
