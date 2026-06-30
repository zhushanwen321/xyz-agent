/**
 * useSearchJump（#6）—— 选中项跳转编排（type switch 分发）。
 *
 * 接线层级：跨模块（type switch 调 commandStore + file/session domain + useDetailPane + useSidebar + useRecents）。
 * 依赖方向：api（file/composer/session domain）+ composables（useDetailPane/useSidebar/useRecents）+ stores/command。
 *
 * 数据流：SearchModal.confirmSel → confirm(item, ctx) → type switch →
 *   command: commandStore 取 action 执行 / slash 注入 composer
 *   file: 直调 fileApi.read（AC-6.9 不经 useDetailPane.openPreview 吞错层）→ 成功后渲染
 *   session: useSidebar.selectSession
 *   symbol: 占位不跳转（D-001）
 * → useRecents.write + 返回 JumpResult（AC-6.7：成功才关浮层，失败浮层保持打开）
 *
 * 失败路径（AC-6.5/6.6/6.8/6.9）：
 *  - command action 抛错 → {ok:false} + toast + 浮层保持打开（AC-6.8）
 *  - file.read reject → {ok:false} + toast + 浮层保持打开（AC-6.5/6.9，直调不经吞错层）
 *  - session.switch reject → {ok:false} + toast + 刷新会话列表 + 浮层保持打开（AC-6.6）
 *
 * 竞态（无）：跳转是用户主动单次操作，非高频。
 */
import type { SearchItem } from '@/api/mock/search-data'
import { file as fileApi } from '@/api'
import { useRecents } from '@/composables/features/useRecents'
import type { JumpCtx, JumpResult, RecentEntry } from '@/lib/search-types'

export function useSearchJump() {
  const recents = useRecents()

  /**
   * 确认跳转（按 item.type switch 分发）。
   * AC-6.7 异常恢复：先 await 成功再关浮层（调用方据 JumpResult.ok 决定关否），失败浮层保持打开让用户重选。
   */
  async function confirm(item: SearchItem, ctx: JumpCtx): Promise<JumpResult> {
    switch (item.type) {
      case 'command':
        return confirmCommand(item)
      case 'file':
        return confirmFile(item, ctx)
      case 'session':
        return confirmSession(item)
      case 'symbol':
        // D-001 占位不跳转
        return { ok: false, error: '符号搜索暂不可用' }
    }
  }

  /** command 分支：commandStore 取 action 执行（应用命令）/ 注入 pi composer（slash 命令） */
  async function confirmCommand(item: SearchItem): Promise<JumpResult> {
    try {
      // 接线：commandStore 取 action 执行 / slash 注入 composer（实现期填，骨架接线到 store/domain）
      // AC-6.8：action 抛错 → {ok:false} + toast
      writeRecent(item)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? '命令执行失败' }
    }
  }

  /**
   * file 分支（AC-6.9 关键约束）：直调 fileApi.read 校验不经 useDetailPane.openPreview 吞错层。
   * useDetailPane.openPreview 现状 try/catch 吞错（设 status='error' 不抛），致 catch 永不触发，AC-6.5 假性 PASS。
   * read 成功后再调 useDetailPane 渲染（绕过其加载态，或用独立 setPreview 方法）。
   */
  async function confirmFile(item: SearchItem, ctx: JumpCtx): Promise<JumpResult> {
    const sid = ctx.activeSessionId
    try {
      // AC-6.9：直调 fileApi.read（不经 useDetailPane.openPreview 吞错层）
      await fileApi.read(item.sub, sid ?? undefined)
      // 接线：read 成功后调 useDetailPane 渲染（绕过 openPreview 加载态）——实现期填
      writeRecent(item)
      return { ok: true }
    } catch (e) {
      // AC-6.5：file.read reject → {ok:false}（直调使 reject 真冒泡，不经吞错层）
      return { ok: false, error: (e as Error)?.message ?? '文件打开失败' }
    }
  }

  /** session 分支：useSidebar.selectSession（接线在实现期，骨架标调用点） */
  async function confirmSession(item: SearchItem): Promise<JumpResult> {
    try {
      // 接线：useSidebar.selectSession(item.id) —— 实现期填
      // AC-6.6：switch reject → {ok:false} + 刷新会话列表
      writeRecent(item)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? '会话切换失败' }
    }
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
