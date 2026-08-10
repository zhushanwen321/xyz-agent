import type { AutocompleteItem } from '@earendil-works/pi-tui'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent'
import { FRAGMENT_LEN, toCandidate } from './hash-provider.js'

/**
 * M4 TUI 层：/session-pick 命令（design 附录 P-hash-trigger 降级兜底 + 非 # 场景入口）。
 *
 * 两条用途：
 * 1. # autocomplete provider 在真实 TUI 触发失败（⛔ P-hash-trigger）时的降级入口——
 *    用户输入 /session-pick 走列表选择，选中后插入 # 片段
 * 2. 非 # 主动查找场景（用户明确想浏览 session 列表）
 *
 * 数据源与 # 弹窗统一（2026-08-10 重构）：`SessionManager.listAll(cwdSessionDir)`，
 * limit 对齐 10（design G6），cwd-scoped + uuid 片段过滤（design G1）。
 *
 * 实现 RegisteredCommand 的三字段（name/sourceInfo 由 pi.registerCommand 补）：
 * - description：命令说明
 * - getArgumentCompletions：/session-pick <Tab> 补全 session 片段
 * - handler：/session-pick [query] → ctx.ui.select 列表选 → setEditorText 插入 # 片段
 *
 * cwdSessionDir 注入（同 hash-provider，零 pi 依赖核心逻辑，可单测）。
 */

/** /session-pick 列表上限（对齐 # 弹窗 DEFAULT_LIMIT，design G6）。 */
const PICK_LIMIT = 10

/** /session-pick 命令配置（Omit<RegisteredCommand, 'name' | 'sourceInfo'>）。 */
export function createSessionCommand(getCwdSessionDir: () => string): {
  description: string
  getArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null>
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>
} {
  return {
    description: 'Pick a session and insert a #uuid-fragment reference into the editor.',
    async getArgumentCompletions(argumentPrefix) {
      const trimmed = argumentPrefix.trim()
      const all = await SessionManager.listAll(getCwdSessionDir())
      // uuid 片段过滤（与 # 弹窗一致）；空 prefix → recent（listAll 已按 modified 倒序）
      const filtered =
        trimmed === '' ? all : all.filter((s) => s.id.includes(trimmed))
      const top = filtered.slice(0, PICK_LIMIT)
      if (top.length === 0) return null
      return top.map((s) => {
        const c = toCandidate(s)
        // value 是补全后替换 argumentPrefix 的文本（纯片段，不带 #——命令参数位置）
        return { value: s.id.slice(0, FRAGMENT_LEN), label: c.label }
      })
    },
    async handler(args, ctx) {
      const trimmed = args.trim()
      const all = await SessionManager.listAll(getCwdSessionDir())
      const filtered =
        trimmed === '' ? all : all.filter((s) => s.id.includes(trimmed))
      const top = filtered.slice(0, PICK_LIMIT)
      if (top.length === 0) {
        ctx.ui.notify('未找到匹配的 session。', 'warning')
        return
      }
      // ctx.ui.select 只接受 string[]、返回选中的字符串。用并行数组 + indexOf 还原 session。
      const labels = top.map((s) => formatSessionLabel(s))
      const chosen = await ctx.ui.select('选择一个 session 插入 # 引用', labels)
      if (chosen === undefined) return
      const idx = labels.indexOf(chosen)
      if (idx < 0) return
      const frag = top[idx].id.slice(0, FRAGMENT_LEN)
      // /session-pick 提交后编辑器已清空，直接 set # 片段供用户补完指令再发送
      ctx.ui.setEditorText(`#${frag}`)
    },
  }
}

/** select 列表单行格式：直接用 toCandidate 的 label（已含 `时间 预览`，满宽）。 */
function formatSessionLabel(s: SessionInfo): string {
  return toCandidate(s).label
}
