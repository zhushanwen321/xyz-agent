/**
 * composer 发送后清空 / 失败恢复的输入区状态操作 —— core/domain/composer/input/restore.ts（W2）。
 *
 * 定位：迁自 renderer useComposerRestore.ts。职责单一：操作 draft ref + inputRef，完成三类副作用：
 * - clearInput：发送成功后清空（DOM + draft + 持久化草稿）
 * - restoreInput：发送失败恢复纯文本草稿
 * - restoreSegments：发送失败恢复 text + 各类 chip（W8 修复）
 *
 * 不含：发送 / steer / fork / 输入编辑（留 dispatch 模块 / 其他 composable）。
 * 纯逻辑编排，零 DOM 直连，零 renderer import。
 */
import type { Segment } from '@xyz-agent/shared'
import type { ComposerRestoreDeps } from './types'

/**
 * @param deps draft / inputRef / drafts / sessionId 四项依赖（Composer.vue 内定义后注入）
 */
export function useComposerRestore(deps: ComposerRestoreDeps) {
  /** 发送成功后清空输入区（DOM + draft + 持久化草稿） */
  function clearInput(): void {
    deps.draft.value = ''
    const sid = deps.sessionId.value
    // ADR-0049：drafts 窄化为 DraftStore（不再持有 Map 引用），deleteDraft 经工厂 cleanup 移除分区
    if (sid) deps.drafts.deleteDraft(sid)
    deps.inputRef.value?.clear()
  }

  /** 发送失败恢复草稿到输入区 */
  function restoreInput(text: string): void {
    deps.draft.value = text
    deps.inputRef.value?.setText(text)
  }

  /**
   * 发送失败后恢复 text + 各类 chip（W8 修复；U2b 补 session/subagent 两类）。
   *
   * 方案 A（无重复）：先从 segments 中只取 type==='text' 段重建纯文本，restoreInput 恢复文字；
   * 再调 insertImageBadge/insertSlashChip/insertFileChip/insertSessionChip/insertSubagentChip
   * 把非 text 段还原成真 chip。session/subagent 两类经 ?. 调用（ComposerInputInstance 可选
   * 契约——低配壳层缺省时静默跳过该类 chip，文字部分仍恢复，不崩溃）。
   */
  function restoreSegments(segments: Segment[]): void {
    const textOnly = segments
      .filter((s): s is Extract<Segment, { type: 'text' }> => s.type === 'text')
      .map((s) => s.text)
      .join('')
    restoreInput(textOnly)
    for (const seg of segments) {
      if (seg.type === 'image') {
        deps.inputRef.value?.insertImageBadge(seg.path, seg.fileName, seg.displayName, seg.needsMigrate ?? false)
      } else if (seg.type === 'skill') {
        deps.inputRef.value?.insertSlashChip(`/skill:${seg.name}`)
      } else if (seg.type === 'file') {
        deps.inputRef.value?.insertFileChip(seg.path, seg.lineRange)
      } else if (seg.type === 'session') {
        // session 引用 chip 恢复（# session，U1）：label 展示 + sessionId 落 dataset（getSegments 重建 segment 用）
        deps.inputRef.value?.insertSessionChip?.(seg.sessionId, seg.label)
      } else if (seg.type === 'subagent') {
        // subagent 定向 chip 恢复（@ subagent，U2b）：subagentId/slug 原样回填（占位新建
        // chip subagentId 为空串，回填后再次发送仍走 start 分流，语义不变）
        deps.inputRef.value?.insertSubagentChip?.(seg.subagentId, seg.slug)
      }
    }
  }

  return { clearInput, restoreInput, restoreSegments }
}
