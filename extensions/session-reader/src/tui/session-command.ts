import type { AutocompleteItem } from '@earendil-works/pi-tui'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent'
import { listGlobalSessionIds } from '../discovery/roots.js'
import { toCandidate } from './hash-provider.js'

/**
 * M4 TUI 层：/session-pick 命令（design 附录 P-hash-trigger 降级兜底 + 非 # 场景入口）。
 *
 * 两条用途：
 * 1. # autocomplete provider 在真实 TUI 触发失败（⛔ P-hash-trigger）时的降级入口——
 *    用户输入 /session-pick 走列表选择，选中后插入 # 片段
 * 2. 非 # 主动查找场景（用户明确想浏览 session 列表）
 *
 * 显示数据源与 # 弹窗统一（2026-08-10 重构）：`SessionManager.listAll(cwdSessionDir)`，
 * limit 对齐 10（design G6），cwd-scoped + uuid 片段过滤（design G1）。
 *
 * **insertText 唯一前缀作用域（O5 修复）**：与 hash-provider 一致，命令参数 value（剥 #）
 * 和 handler 选中后插入的 # 片段都用全局同前缀 id 集算唯一前缀——findSessions 全局扫
 * agentDir，per-cwd 唯一在全局 find 时会跨 cwd 多匹配。
 *
 * cwdSessionDir + agentDir 注入（同 hash-provider，零 pi 依赖核心逻辑，可单测）。
 */

/** /session-pick 列表上限（对齐 # 弹窗 DEFAULT_LIMIT，design G6）。 */
const PICK_LIMIT = 10

/**
 * 算全局同前缀 session id 集（O5：insertText 唯一前缀的全局作用域）。
 *
 * trimmed 空（recent 浏览态）→ 返回 null：调用方据此退化为 8 字符片段（toCandidate
 * siblings 传空），接受可能的跨 cwd 碰撞——浏览态用户看 label 区分候选，不直接 find。
 * trimmed 非空 → 返回全局含该片段的 id 集，保证 findSessions 全局命中唯一。
 */
async function getGlobalSiblings(
  agentDir: string,
  trimmed: string,
): Promise<string[] | null> {
  if (trimmed === '') return null
  const globalAll = await listGlobalSessionIds(agentDir)
  return globalAll.filter((id) => id.includes(trimmed))
}

/** /session-pick 命令配置（Omit<RegisteredCommand, 'name' | 'sourceInfo'>）。 */
export function createSessionCommand(
  getCwdSessionDir: () => string,
  getAgentDir: () => string,
): {
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
      // O5：value 用全局唯一前缀（剥 # 后，命令参数位置不带 #）
      const siblings = await getGlobalSiblings(getAgentDir(), trimmed)
      return top.map((s) => {
        const c = toCandidate(s, siblings ?? [])
        return { value: c.insertText.slice(1), label: c.label }
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
      // O5：选中后插入 # + 全局唯一前缀（剥 # 算片段，再补 # 插入编辑器）
      const siblings = await getGlobalSiblings(getAgentDir(), trimmed)
      const frag = toCandidate(top[idx], siblings ?? []).insertText.slice(1)
      // /session-pick 提交后编辑器已清空，直接 set # 片段供用户补完指令再发送
      ctx.ui.setEditorText(`#${frag}`)
    },
  }
}

/** select 列表单行格式：直接用 toCandidate 的 label（已含 `时间 预览`，满宽，不含片段）。 */
function formatSessionLabel(s: SessionInfo): string {
  return toCandidate(s).label
}
