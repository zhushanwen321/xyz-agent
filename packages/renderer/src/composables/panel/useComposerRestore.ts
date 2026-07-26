/**
 * Composer 发送后清空 / 失败恢复的输入区状态操作。
 *
 * 职责单一：操作 draft ref + inputRef（ComposerInput expose 的方法集），完成三类副作用：
 * - clearInput：发送成功后清空（DOM + draft + 持久化草稿）
 * - restoreInput：发送失败恢复纯文本草稿
 * - restoreSegments：发送失败恢复 text + 各类 chip（W8 修复）
 *
 * 提取到 composable 以满足 Composer.vue <script setup> 行数上限（300 行）。
 * 行为与原 Composer.vue 内联实现完全等价，仅搬运不改逻辑。
 *
 * 不含：发送 / steer / fork / 输入编辑（留 Composer.vue / 其他 composable）。
 */
import type { Ref } from 'vue'
import type { Segment } from '@xyz-agent/shared'

/**
 * ComposerInput 实例最小契约（clear / setText / insertImageBadge / insertSlashChip /
 * insertFileChip 经 defineExpose 暴露）。用结构类型避免 import .vue 文件（循环依赖 +
 * 类型推断复杂），同 useComposerContextChips / useComposerDragDrop 范式。
 */
interface ComposerInputInstance {
  clear: () => void
  setText: (text: string, caretPosition?: 'end' | 'start') => void
  insertImageBadge: (path: string, fileName: string, displayName: string, needsMigrate?: boolean) => void
  insertSlashChip: (command: string) => void
  insertFileChip: (path: string, lineRange?: [number, number]) => void
}

interface ComposerRestoreDeps {
  /** draft ref（Composer 的 draft.value，纯文本用于发送判断） */
  draft: Ref<string>
  /** inputRef（ComposerInput 实例 ref） */
  inputRef: Ref<ComposerInputInstance | null>
  /** per-session drafts Map（clearInput 时 drafts.delete(sessionId) 用） */
  drafts: Map<string, string>
  /** sessionId ref（clearInput 时 drafts.delete 用） */
  sessionId: Ref<string | null>
}

/**
 * @param deps draft / inputRef / drafts / sessionId 四项依赖（Composer.vue 内定义后注入）
 */
export function useComposerRestore(deps: ComposerRestoreDeps) {
  /** 发送成功后清空输入区（DOM + draft + 持久化草稿） */
  function clearInput(): void {
    deps.draft.value = ''
    const sid = deps.sessionId.value
    if (sid) deps.drafts.delete(sid)
    deps.inputRef.value?.clear()
  }

  /** 发送失败恢复草稿到输入区 */
  function restoreInput(text: string): void {
    deps.draft.value = text
    deps.inputRef.value?.setText(text)
  }

  /**
   * 发送失败后恢复 text + 各类 chip（W8 修复）。
   *
   * 原 onSend catch 只调 restoreInput(text)，而 text = draft.value = getText() =
   * segmentsToText(segments)——chip 内容（/skill:xxx、文件路径、图片路径）已被拍平成纯文本
   * 字面量混进字符串。setText 把整段当纯文本塞回 DOM，image/skill/file chip 的可视化
   * （紫色徽章/× 删除按钮/缩略图）全部丢失，用户粘的图变成一串难看的磁盘路径。
   *
   * 方案 A（无重复）：先从 segments 中只取 type==='text' 段重建纯文本，restoreInput 恢复文字；
   * 再调 insertImageBadge/insertSlashChip/insertFileChip 把非 text 段还原成真 chip。
   * text 段不在此插 chip（已在 restoreInput 恢复），避免 chip 与纯文本字面量重复。
   *
   * skill.location 无法经 insertSlashChip 恢复（其签名 (command, icon?) 不收 location，
   * 且 chipLocation dataset 全仓从未被写入——location 在 chip 重建时本就丢失，非本次回归）。
   */
  function restoreSegments(segments: Segment[]): void {
    // 仅取 text 段拼接（保留段内换行），剥离 image/skill/file 的纯文本形式防重复
    const textOnly = segments
      .filter((s): s is Extract<Segment, { type: 'text' }> => s.type === 'text')
      .map((s) => s.text)
      .join('')
    restoreInput(textOnly)
    // 非 text 段还原成真 chip（image/skill/file）
    for (const seg of segments) {
      if (seg.type === 'image') {
        deps.inputRef.value?.insertImageBadge(seg.path, seg.fileName, seg.displayName, seg.needsMigrate ?? false)
      } else if (seg.type === 'skill') {
        // insertSlashChip 按 /skill: 前缀识别 skill chip（见 useComposerChipCommands.insertSlashChip）
        deps.inputRef.value?.insertSlashChip(`/skill:${seg.name}`)
      } else if (seg.type === 'file') {
        deps.inputRef.value?.insertFileChip(seg.path, seg.lineRange)
      }
    }
  }

  return { clearInput, restoreInput, restoreSegments }
}
