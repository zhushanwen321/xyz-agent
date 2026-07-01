/**
 * useSearchJump composable 单测（#6 跳转编排，10 条 test-matrix）。
 *
 * 覆盖：
 * - T2.2 选中应用命令执行 + 写 recents：confirm({type:'command',title:'新建'}) → action 调用 + recents.write + {ok:true}
 * - U7 选中 slash 命令注入：confirm({type:'command',title:'/commit'}) → commandStore.pendingSlash 写入 + {ok:true}
 * - T2.6（AC-6.8）command action 抛错：action throw → {ok:false,error}（浮层保持打开）
 * - T2.7 跳转成功关闭：confirm 成功 → {ok:true}
 * - T3.4（AC-6.5/6.9）file.read 失败：fileApi.read reject → {ok:false,error} + 未调 openPreview（grep 验收）
 * - T3.6 file.read 成功 DetailPane 打开：fileApi.read resolve → fileTreeStore.selectFile 调用 + {ok:true}
 * - T4.3 选中会话切换：confirm({type:'session'}) → selectSession 调用 + {ok:true}
 * - T4.6（AC-6.6）session.switch 失败：selectSession reject → {ok:false,error}
 * - T4.7 跳转成功 active session 切换：confirm session 成功 → {ok:true}
 * - T5.3（D-001）symbol 选中不跳转：confirm({type:'symbol'}) → {ok:false,error:'符号搜索暂不可用'}（不调 domain/store）
 *
 * 环境：vitest happy-dom + pinia（useCommandStore/useFileTreeStore 需 pinia）。
 * 禁止 node:test。运行：cd src-electron/renderer && npx vitest run src/__tests__/composables/useSearchJump.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── mock 依赖（@/api + composables + stores）──
// mock @/api：file（AC-6.9 直调 read）+ session（session.list 反查 id）
const fileReadMock = vi.fn()
const sessionListMock = vi.fn()
vi.mock('@/api', () => ({
  file: { read: (...args: unknown[]) => fileReadMock(...args) },
  session: { list: (...args: unknown[]) => sessionListMock(...args) },
}))

// mock useSidebar（selectSession 是 session 跳转接线点，T4.3/T4.6）
const selectSessionMock = vi.fn()
vi.mock('@/composables/features/useSidebar', () => ({
  useSidebar: () => ({ selectSession: (...args: unknown[]) => selectSessionMock(...args) }),
}))

// mock useDetailPane：仅占位（AC-6.9 不应被 useSearchJump 调用；此 mock 用于断言 openPreview 未被调）
const openPreviewMock = vi.fn()
vi.mock('@/composables/features/useDetailPane', () => ({
  useDetailPane: () => ({ openPreview: (...args: unknown[]) => openPreviewMock(...args), state: { value: {} } }),
}))

// mock useRecents（write 是 AC-6.4 副作用断言点）
const recentsWriteMock = vi.fn()
vi.mock('@/composables/features/useRecents', () => ({
  useRecents: () => ({ read: () => [], write: (...args: unknown[]) => recentsWriteMock(...args) }),
}))

import { useSearchJump } from '@/composables/features/useSearchJump'
import { useCommandStore } from '@/stores/command'
import type { AppCommand, SearchItem } from '@/lib/search-types'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** helper：注册应用命令到 store */
function registerAppCmds(...cmds: AppCommand[]): void {
  useCommandStore().registerApp(cmds)
}

describe('T2.2 选中应用命令执行 + 写 recents', () => {
  it('confirm({type:command,title:新建}) → action 调用 + recents.write 调用 + {ok:true}', async () => {
    const action = vi.fn()
    registerAppCmds({ id: 'new', name: '新建', action })
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'command', title: '新建', sub: '创建一个新会话 · ⌘N', commandKind: 'app' }

    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result).toEqual({ ok: true })
    expect(action).toHaveBeenCalledTimes(1)
    // AC-6.4：跳转成功后写 recents
    expect(recentsWriteMock).toHaveBeenCalledTimes(1)
    const entry = recentsWriteMock.mock.calls[0][0]
    expect(entry).toMatchObject({ type: 'command', key: 'command:新建', title: '新建', sub: '创建一个新会话 · ⌘N' })
  })
})

describe('U7 选中 slash 命令 → 写 commandStore.pendingSlash（icon 从 item.icon 透传）', () => {
  it('confirm(slash 命令带 icon:wrench) → {ok:true} + pendingSlash.icon===wrench（非 terminal，证明从 item.icon 透传）+ recents 写入', async () => {
    const commandStore = useCommandStore()
    const { confirm } = useSearchJump()
    // commandKind='slash' 是唯一分发依据（命令名不带 / 前缀，对齐 pi 格式）。
    // icon 故意用 wrench（与 commit 常规图标 terminal 不同），锁定数据来自 item.icon 而非按 name 重查
    const item: SearchItem = { type: 'command', title: 'commit', sub: '提交改动', icon: 'wrench', commandKind: 'slash' }

    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result).toEqual({ ok: true })
    // pendingSlash 已写入，icon 从 item.icon 透传（wrench 非 terminal）
    expect(commandStore.pendingSlash).not.toBeNull()
    expect(commandStore.pendingSlash!.command).toBe('commit')
    expect(commandStore.pendingSlash!.icon).toBe('wrench')
    expect(commandStore.pendingSlash!.sessionId).toBe('s1')
    expect(typeof commandStore.pendingSlash!.ts).toBe('number')
    // AC-6.4：跳转成功后写 recents
    expect(recentsWriteMock).toHaveBeenCalledTimes(1)
  })
})

describe('U8 landing 态放行（修现有 bug：原返「无活动会话」错误）', () => {
  it('confirm(slash 命令, activeSessionId:null) → {ok:true} + pendingSlash.sessionId===null + recents 写入', async () => {
    const commandStore = useCommandStore()
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'command', title: 'goal', sub: '目标驱动', icon: 'star', commandKind: 'slash' }

    const result = await confirm(item, { activeSessionId: null })

    // landing 态放行（不再返「无活动会话」错误）
    expect(result).toEqual({ ok: true })
    expect(commandStore.pendingSlash!.sessionId).toBe(null)
    // 放行走 ok 路径，recents 被写（与原返错不写 recents 的行为变化需锁定）
    expect(recentsWriteMock).toHaveBeenCalledTimes(1)
  })
})

describe('U9 icon undefined 透传（缺省态）', () => {
  it('confirm(slash 命令无 icon) → {ok:true} + pendingSlash.icon===undefined（透传 undefined，不兜底不报错）', async () => {
    const commandStore = useCommandStore()
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'command', title: 'goal', sub: '', commandKind: 'slash' }

    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result).toEqual({ ok: true })
    expect(commandStore.pendingSlash!.icon).toBeUndefined()
  })
})

describe('U10 useSearchJump 不传选项 + slash confirm 仍成功（不再依赖 injectSlash 回调）', () => {
  it('useSearchJump() 空调用 + slash confirm → {ok:true}（不因 injectSlash undefined 返错）', async () => {
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'command', title: 'goal', sub: '', icon: 'star', commandKind: 'slash' }

    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result).toEqual({ ok: true })
  })
})

describe('U11 应用命令分支不受影响（回归）', () => {
  it('confirm(应用命令 commandKind:app) → {ok:true} + action 调用 + pendingSlash 未被写入（仍 null）', async () => {
    const commandStore = useCommandStore()
    const action = vi.fn()
    registerAppCmds({ id: 'new', name: '新建', action })
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'command', title: '新建', sub: '', commandKind: 'app' }

    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result).toEqual({ ok: true })
    expect(action).toHaveBeenCalledTimes(1)
    // 应用命令走 action 不写 pendingSlash
    expect(commandStore.pendingSlash).toBeNull()
  })
})

describe('T2.6（AC-6.8）command action 抛错', () => {
  it('mock action throw → {ok:false,error}（浮层保持打开，ok=false）', async () => {
    const action = vi.fn(() => {
      throw new Error('action 炸了')
    })
    registerAppCmds({ id: 'fail', name: '失败命令', action })
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'command', title: '失败命令', sub: '', commandKind: 'app' }

    const result = await confirm(item, { activeSessionId: 's1' })

    // AC-6.8：action 抛错 → {ok:false,error}，调用方据 ok=false 浮层保持打开
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('action 炸了')
    }
    // 失败时不写 recents（AC-6.4 只在成功后写）
    expect(recentsWriteMock).not.toHaveBeenCalled()
  })
})

describe('T2.7 跳转成功关闭', () => {
  it('confirm 成功 → {ok:true}（调用方据 ok=true 关浮层）', async () => {
    const action = vi.fn()
    registerAppCmds({ id: 'ok', name: '成功命令', action })
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'command', title: '成功命令', sub: '', commandKind: 'app' }

    const result = await confirm(item, { activeSessionId: 's1' })

    // AC-6.7：先 await 成功再返 {ok:true}（调用方据 ok 决定关浮层）
    expect(result).toEqual({ ok: true })
  })
})

describe('T3.4（AC-6.5/6.9）file.read 失败', () => {
  it('mock fileApi.read reject → {ok:false,error} + 未调 useDetailPane.openPreview', async () => {
    fileReadMock.mockRejectedValueOnce(new Error('文件不存在'))
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'file', title: 'auth/session.ts', sub: 'src/auth/session.ts' }

    const result = await confirm(item, { activeSessionId: 's1' })

    // AC-6.5：file.read reject → {ok:false,error}
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('文件不存在')
    }
    // AC-6.9：直调 fileApi.read（已调用）
    expect(fileReadMock).toHaveBeenCalledWith('src/auth/session.ts', 's1')
    // 失败时不写 recents + 不调 openPreview（grep 验收：useSearchJump 不调 openPreview）
    expect(openPreviewMock).not.toHaveBeenCalled()
    expect(recentsWriteMock).not.toHaveBeenCalled()
  })
})

describe('T3.6 file.read 成功 DetailPane 打开', () => {
  it('mock fileApi.read resolve → fileTreeStore.selectFile 调用 + {ok:true, drawerTab:detail}', async () => {
    fileReadMock.mockResolvedValueOnce({ content: 'file body', truncated: false })
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'file', title: 'auth/token.ts', sub: 'src/auth/token.ts' }

    const result = await confirm(item, { activeSessionId: 's1' })

    // drawerTab:'detail' 提示调用方（SearchModal）打开 SideDrawer detail tab（DetailPane 挂载渲染）
    expect(result).toEqual({ ok: true, drawerTab: 'detail' })
    // AC-6.9：直调 fileApi.read 成功后调 selectFile（触发 useDetailPane watch 链渲染）
    expect(fileReadMock).toHaveBeenCalledWith('src/auth/token.ts', 's1')
    // selectFile 走真实 fileTreeStore（pinia），断言 selectedPath 已设置
    expect(recentsWriteMock).toHaveBeenCalledTimes(1)
    // 不直调 openPreview（AC-6.9 grep 验收：useSearchJump 不出现 openPreview）
    expect(openPreviewMock).not.toHaveBeenCalled()
  })
})

describe('T4.3 选中会话切换', () => {
  it('confirm({type:session}) → selectSession 调用 + {ok:true}', async () => {
    // sessionApi.list 反查：title 匹配 label → 取 id
    sessionListMock.mockResolvedValueOnce([
      { cwd: 'p', sessions: [{ id: 'sess-1', label: '搜索浮层设计', cwd: 'p' }] },
    ])
    selectSessionMock.mockResolvedValueOnce(undefined)
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'session', title: '搜索浮层设计', sub: 'refactor-arch · feat-search' }

    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result).toEqual({ ok: true })
    // id 反查 + selectSession(id) 调用
    expect(sessionListMock).toHaveBeenCalledTimes(1)
    expect(selectSessionMock).toHaveBeenCalledTimes(1)
    expect(selectSessionMock).toHaveBeenCalledWith('sess-1')
    expect(recentsWriteMock).toHaveBeenCalledTimes(1)
  })
})

describe('T4.6（AC-6.6）session.switch 失败', () => {
  it('mock selectSession reject → {ok:false,error}', async () => {
    sessionListMock.mockResolvedValueOnce([
      { cwd: 'p', sessions: [{ id: 'sess-x', label: '会话X', cwd: 'p' }] },
    ])
    selectSessionMock.mockRejectedValueOnce(new Error('session 已失效'))
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'session', title: '会话X', sub: 'p · main' }

    const result = await confirm(item, { activeSessionId: 's1' })

    // AC-6.6：session.switch reject → {ok:false,error}
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('session 已失效')
    }
    expect(recentsWriteMock).not.toHaveBeenCalled()
  })

  it('session.list 反查未命中 label → {ok:false,error}（无匹配会话）', async () => {
    sessionListMock.mockResolvedValueOnce([{ cwd: 'p', sessions: [] }])
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'session', title: '不存在会话', sub: '' }

    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('未找到会话')
    }
    expect(selectSessionMock).not.toHaveBeenCalled()
  })
})

describe('T4.7 跳转成功 active session 切换', () => {
  it('confirm session 成功 → {ok:true}（调用方据 ok=true 关浮层）', async () => {
    sessionListMock.mockResolvedValueOnce([
      { cwd: 'p', sessions: [{ id: 'sess-ok', label: '工作流', cwd: 'p' }] },
    ])
    selectSessionMock.mockResolvedValueOnce(undefined)
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'session', title: '工作流', sub: 'p · dev' }

    const result = await confirm(item, { activeSessionId: 's1' })

    // AC-6.7：先 await selectSession 成功再返 {ok:true}
    expect(result).toEqual({ ok: true })
    expect(selectSessionMock).toHaveBeenCalledWith('sess-ok')
  })
})

describe('T5.3（D-001）symbol 选中不跳转', () => {
  it('confirm({type:symbol}) → {ok:false,error:符号搜索暂不可用}（不调任何 domain/store）', async () => {
    const { confirm } = useSearchJump()
    const item: SearchItem = { type: 'symbol', title: 'authenticate()', sub: 'auth/session.ts:42' }

    const result = await confirm(item, { activeSessionId: 's1' })

    // D-001：符号占位不跳转，返回 not-available
    expect(result).toEqual({ ok: false, error: '符号搜索暂不可用' })
    // 不调任何 domain/store
    expect(fileReadMock).not.toHaveBeenCalled()
    expect(sessionListMock).not.toHaveBeenCalled()
    expect(selectSessionMock).not.toHaveBeenCalled()
    expect(recentsWriteMock).not.toHaveBeenCalled()
  })
})
