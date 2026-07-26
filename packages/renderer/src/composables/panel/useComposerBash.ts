/**
 * Composer bash 命令模式（composer-bash-execute）。
 *
 * 从 draft 派生 isBashMode（`!` 前缀触发），并在 onSend 提交时提供 trySendBash
 * 分流入口：命中 `!`/`!!` 前缀时执行 bash（不经 LLM turn），返回 true 表示已处理
 * （调用方不再走普通 send / compact 分支）。
 *
 * bash 不走 segment 提取（原始 shell 文本透传 pi bash RPC），失败时仅恢复 draft 纯文本
 * （无 image/skill/file chip 可丢）。错误 toast 由 useChat.sendBash 内部处理。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import { useChat } from '@/composables/features/useChat'

/** `!` 与 `!!` 前缀长度（单/双感叹号） */
const BANG_SINGLE = 1
const BANG_DOUBLE = 2

export interface ComposerBashOptions {
  /** draft 文本（双向：trySendBash 失败时 restoreInput 写回） */
  draft: Ref<string>
  /** 清空输入（乐观 UI：提交前先清） */
  clearInput: () => void
  /** 恢复纯文本草稿（失败时回填） */
  restoreInput: (text: string) => void
  /** 发送中状态（trySendBash 期间置 true） */
  isSending: Ref<boolean>
  /** session id（landing 态为 null，调用方需保证 trySendBash 在非 landing 分支调用） */
  sessionId: () => string | null
}

export interface UseComposerBash {
  /** bash 模式（draft 以 `!` 开头）—— 供 useComposerModeVisual 视觉派生 */
  isBashMode: ComputedRef<boolean>
  /**
   * 尝试 bash 分流。命中 `!`/`!!` 前缀时执行 bash 并返回 true（调用方 return）；
   * 否则返回 false（调用方继续走 compact / send 分支）。
   *
   * 空命令（`!` 或 `!!` 后无内容）不提交，返回 true 保持 bash 模式（保留前缀供继续输入）。
   */
  trySendBash: (rawText: string) => Promise<boolean>
}

export function useComposerBash(opts: ComposerBashOptions): UseComposerBash {
  const { sendBash } = useChat()

  const isBashMode = computed(() => opts.draft.value.trimStart().startsWith('!'))

  async function trySendBash(rawText: string): Promise<boolean> {
    const trimmed = rawText.trim()
    if (!trimmed.startsWith('!')) return false

    const isExcluded = trimmed.startsWith('!!')
    const cmd = trimmed.slice(isExcluded ? BANG_DOUBLE : BANG_SINGLE).trim()
    // 空命令：不提交但视为已处理（保持 bash 模式，保留前缀供继续输入）
    if (!cmd) return true

    const sid = opts.sessionId()
    if (!sid) return false

    opts.clearInput()
    opts.isSending.value = true
    try {
      await sendBash(sid, cmd, isExcluded)
    } catch {
      // sendBash 内部已 toast（与 send 同策略），此处恢复草稿避免输入丢失
      opts.restoreInput(rawText)
    } finally {
      opts.isSending.value = false
    }
    return true
  }

  return { isBashMode, trySendBash }
}
