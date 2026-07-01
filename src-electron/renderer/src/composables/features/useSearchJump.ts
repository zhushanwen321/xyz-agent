/**
 * useSearchJump（#6）—— 选中项跳转编排（type switch 分发）。
 *
 * 接线层级：跨模块（type switch 调 commandStore + file/session domain + useDetailPane + useSidebar + useRecents）。
 * 依赖方向：api（file/session domain）+ composables（useSidebar/useRecents）+ stores/command + stores/fileTree。
 *
 * 数据流：SearchModal.confirmSel → confirm(item, ctx) → type switch →
 *   command: AppCommand（name 不以 / 开头）→ commandStore 取 action 执行；
 *            slash 命令（name 以 / 开头）→ injectSlash 注入 composer（DOM 层 chip，由调用方接线 insertSlashChip）
 *   file: 直调 fileApi.read（AC-6.9 不经 useDetailPane 的预览加载吞错层）→ 成功后 selectFile 触发 useDetailPane watch 链渲染
 *   session: useSidebar.selectSession（id 经 sessionApi.list 按 title 反查，因 SearchItem 无 id 字段）
 *   symbol: 占位不跳转（D-001）
 * → useRecents.write + 返回 JumpResult（AC-6.7：成功才关浮层，失败浮层保持打开）
 *
 * 失败路径（AC-6.5/6.6/6.8/6.9）：
 *  - command action 抛错 / injectSlash 抛错 → {ok:false} + toast + 浮层保持打开（AC-6.8）
 *  - file.read reject → {ok:false} + toast + 浮层保持打开（AC-6.5/6.9，直调不经吞错层）
 *  - session.switch reject / id 反查失败 → {ok:false} + toast + 浮层保持打开（AC-6.6）
 *
 * 职责分离：本 composable 只返 JumpResult，不直接 toast（toast 由 SearchModal 据 ok===false 触发）。
 *
 * 竞态（无）：跳转是用户主动单次操作，非高频。
 */
import type { SearchItem, JumpCtx, JumpResult, RecentEntry } from '@/lib/search-types'
import { file as fileApi, session as sessionApi } from '@/api'
import { useRecents } from '@/composables/features/useRecents'
import { useSidebar } from '@/composables/features/useSidebar'
import { useCommandStore } from '@/stores/command'
import { useFileTreeStore } from '@/stores/fileTree'

/**
 * slash 注入器（将 slash 命令名注入 pi composer）。
 *
 * 接线约束：composer domain（api/domains/composer.ts）无 inject 方法（只有 getFileCandidates），
 * slash 注入的唯一路径是 useComposerChipCommands.insertSlashChip——DOM 层 contenteditable chip 操作，
 * 需 ComposerInput 的元素 ref（features/composable 层无法访问）。故以回调注入：调用方（SearchModal）
 * 接线 ComposerInput ref.insertSlashChip(command, icon)，本编排层只持有「注入动作」接口，不耦合 DOM。
 * 无 injectSlash 时（未接线）→ 视为注入失败返 {ok:false}，让调用方据 ok 决定关浮层（安全降级）。
 */
export interface UseSearchJumpOptions {
  injectSlash?: (command: string) => void
}

export function useSearchJump(options: UseSearchJumpOptions = {}) {
  const recents = useRecents()
  const commandStore = useCommandStore()
  const fileTreeStore = useFileTreeStore()

  /**
   * 确认跳转（按 item.type switch 分发）。
   * AC-6.7 异常恢复：先 await 成功再关浮层（调用方据 JumpResult.ok 决定关否），失败浮层保持打开让用户重选。
   */
  async function confirm(item: SearchItem, ctx: JumpCtx): Promise<JumpResult> {
    switch (item.type) {
      case 'command':
        return confirmCommand(item, ctx)
      case 'file':
        return confirmFile(item, ctx)
      case 'session':
        return confirmSession(item)
      case 'symbol':
        // D-001 占位不跳转（不调任何 domain/store）
        return { ok: false, error: '符号搜索暂不可用' }
    }
  }

  /**
   * command 分支：区分 AppCommand（应用命令，name 不以 / 开头）vs slash 命令（name 以 / 开头）。
   * - 应用命令：commandStore.appCommands 找 name 匹配项，调 cmd.action()（AC-6.8 action 抛错→{ok:false}）
   * - slash 命令：injectSlash 注入 composer（注入需 activeSessionId——slash 是 session 级命令）
   */
  async function confirmCommand(item: SearchItem, ctx: JumpCtx): Promise<JumpResult> {
    try {
      const isSlash = item.title.startsWith('/')
      if (isSlash) {
        // slash 命令注入 composer（需 active session，slash 是 per-session 命令）
        if (!ctx.activeSessionId) {
          return { ok: false, error: '无活动会话，无法注入 slash 命令' }
        }
        if (!options.injectSlash) {
          return { ok: false, error: 'slash 命令注入未接线' }
        }
        options.injectSlash(item.title)
      } else {
        // 应用命令：commandStore.appCommands 取 action 执行
        const cmd = commandStore.appCommands.find((c) => c.name === item.title)
        if (!cmd) {
          return { ok: false, error: `未找到命令: ${item.title}` }
        }
        cmd.action() // AC-6.8：action 抛错由 catch 捕获
      }
      writeRecent(item)
      return { ok: true }
    } catch (e) {
      // AC-6.8：action 抛错 / injectSlash 抛错 → {ok:false,error}
      return { ok: false, error: (e as Error)?.message ?? '命令执行失败' }
    }
  }

  /**
   * file 分支（AC-6.9 关键约束）：直调 fileApi.read 校验，不经 useDetailPane 的预览加载吞错层。
   * useDetailPane 的预览加载方法现状 try/catch 吞错（设 status='error' 不抛），致本编排层 catch 永不触发，
   * AC-6.5 假性 PASS。read 成功后调 fileTreeStore.selectFile(path) 触发 useDetailPane 的
   * watch([selectedPath, sessionId]) 链自动渲染（渲染靠 store 响应式驱动，错误已由直调 read 捕获）。
   */
  async function confirmFile(item: SearchItem, ctx: JumpCtx): Promise<JumpResult> {
    const sid = ctx.activeSessionId
    try {
      // AC-6.9：直调 fileApi.read（不经 useDetailPane 预览吞错层），reject 真冒泡
      await fileApi.read(item.sub, sid ?? undefined)
      // read 成功后：selectFile(path) 设置 selectedPath → useDetailPane watch 链自动渲染（绕过吞错层直调）
      fileTreeStore.selectFile(item.sub)
      writeRecent(item)
      // drawerTab:'detail' 提示调用方（SearchModal）打开 SideDrawer detail tab——
      // DetailPane 只在 activeTab==='detail' 时挂载，selectFile 单独设置 selectedPath 无法触发渲染。
      // 对比 FileTreeRow.onSelectFile：selectFile(path) + drawer.open('detail') 双步，此处同构。
      return { ok: true, drawerTab: 'detail' }
    } catch (e) {
      // AC-6.5：file.read reject → {ok:false}（直调使 reject 真冒泡，不经吞错层）
      return { ok: false, error: (e as Error)?.message ?? '文件打开失败' }
    }
  }

  /**
   * session 分支：useSidebar.selectSession(id)。
   *
   * id 反查（SearchItem 无 id 字段，DTO 映射时丢了）：session 跳转需 session id，
   * 但 SearchItem 只有 title/sub。优先复用 sessionApi.list() 按 title（session.label）反查 id，
   * 命中后调 selectSession(id)。反查未命中 / switch reject → {ok:false}（AC-6.6）。
   *
   * 备注：useSidebar.selectSession 内部已对 switchSession reject 抛错（mock id 不存在时），错误在此 catch。
   */
  async function confirmSession(item: SearchItem): Promise<JumpResult> {
    try {
      const id = await resolveSessionId(item.title)
      if (!id) {
        return { ok: false, error: `未找到会话: ${item.title}` }
      }
      const { selectSession } = useSidebar()
      await selectSession(id) // AC-6.6：switchSession reject 抛错由 catch 捕获
      writeRecent(item)
      return { ok: true }
    } catch (e) {
      // AC-6.6：session.switch reject → {ok:false,error}
      return { ok: false, error: (e as Error)?.message ?? '会话切换失败' }
    }
  }

  /**
   * 按 title（session.label）反查 session id。
   * sessionApi.list() 返回 SessionGroup[]，扁平化后按 label 匹配取 id。
   */
  async function resolveSessionId(label: string): Promise<string | null> {
    const groups = await sessionApi.list()
    for (const g of groups) {
      for (const s of g.sessions) {
        if (s.label === label) return s.id
      }
    }
    return null
  }

  /** 写 recents（AC-6.4 副作用，跳转成功后） */
  function writeRecent(item: SearchItem): void {
    const entry: RecentEntry = {
      type: item.type,
      key: `${item.type}:${item.title}`, // AC-3.5 key 规则
      timestamp: Date.now(), // useRecents.write 内部会做 Math.max+1 兜底（AC-3.6）
      title: item.title,
      sub: item.sub,
    }
    recents.write(entry)
  }

  return { confirm }
}
