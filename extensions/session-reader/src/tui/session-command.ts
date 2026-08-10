import type { AutocompleteItem } from '@earendil-works/pi-tui'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { findSessions } from '../discovery/find.js'
import { FRAGMENT_LEN, formatRelativeTime } from './hash-provider.js'

/**
 * M4 TUI 层：/session-pick 命令（design 附录 P-hash-trigger 降级兜底 + 非 # 场景入口）。
 *
 * 两条用途：
 * 1. # autocomplete provider 在真实 TUI 触发失败（⛔ P-hash-trigger）时的降级入口——
 *    用户输入 /session-pick 走列表选择，选中后插入 # 片段
 * 2. 非 # 主动查找场景（用户明确想浏览 session 列表）
 *
 * 实现 RegisteredCommand 的三字段（name/sourceInfo 由 pi.registerCommand 补）：
 * - description：命令说明
 * - getArgumentCompletions：/session-pick <Tab> 补全 session 片段
 * - handler：/session-pick [query] → ctx.ui.select 列表选 → setEditorText 插入 # 片段
 *
 * agentDir 注入（同 hash-provider，零 pi 依赖核心逻辑，可单测）。
 */

/** label 里首消息预览最大长度（select 列表每行宽度有限）。 */
const LIST_PREVIEW_MAX = 40

function truncateForList(s: string | undefined): string {
  if (!s) return '(无预览)'
  return s.length <= LIST_PREVIEW_MAX ? s : s.slice(0, LIST_PREVIEW_MAX) + '…'
}

/** /session-pick 命令配置（Omit<RegisteredCommand, 'name' | 'sourceInfo'>）。 */
export function createSessionCommand(agentDir: string): {
  description: string
  getArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null>
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>
} {
  return {
    description: 'Pick a session and insert a #uuid-fragment reference into the editor.',
    async getArgumentCompletions(argumentPrefix) {
      const trimmed = argumentPrefix.trim()
      const query = trimmed === '' ? 'recent' : trimmed
      const { matches } = await findSessions(query, agentDir, { limit: 10 })
      if (matches.length === 0) return null
      return matches.map((m) => ({
        // value 是补全后替换 argumentPrefix 的文本（纯片段，不带 #——命令参数位置）
        value: m.sessionId.slice(0, FRAGMENT_LEN),
        label: `${m.sessionId.slice(0, FRAGMENT_LEN)} ${truncateForList(m.firstMessagePreview)}`,
        description: formatRelativeTime(m.mtime),
      }))
    },
    async handler(args, ctx) {
      const trimmed = args.trim()
      const query = trimmed === '' ? 'recent' : trimmed
      const { matches } = await findSessions(query, agentDir, { limit: 20 })
      if (matches.length === 0) {
        ctx.ui.notify('未找到匹配的 session。', 'warning')
        return
      }
      // ctx.ui.select 只接受 string[]、返回选中的字符串。用并行数组 + indexOf 还原 session。
      const labels = matches.map(
        (m) =>
          `${m.sessionId.slice(0, FRAGMENT_LEN)}  ${truncateForList(m.firstMessagePreview)}  ${formatRelativeTime(m.mtime)}`,
      )
      const chosen = await ctx.ui.select('选择一个 session 插入 # 引用', labels)
      if (chosen === undefined) return
      const idx = labels.indexOf(chosen)
      if (idx < 0) return
      const frag = matches[idx].sessionId.slice(0, FRAGMENT_LEN)
      // /session-pick 提交后编辑器已清空，直接 set # 片段供用户补完指令再发送
      ctx.ui.setEditorText(`#${frag}`)
    },
  }
}
