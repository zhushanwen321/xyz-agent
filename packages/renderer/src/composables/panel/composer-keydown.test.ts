/**
 * composer-keydown 单测——test-coverage-r1 MUST_FIX #1 修复（U02 从 Composer.vue onKeydown
 * 拆出后键盘决策分支零测试触达）。
 *
 * useComposerKeydown 是纯事件分派器（deps 全只读注入、无自有状态、无 DOM 依赖），
 * 直接注入 fake deps 单测返回的 handler。断言到依赖调用层面（哪个 dep 被调/未被调 +
 * preventDefault 次数），非「不抛错」式弱断言。
 *
 * 覆盖矩阵（与源文件头部分发语义逐条对应，u5b D6 改造后）：
 *   bare-arrow：裸 ↑/↓ → preventDefault + moveCaretVertical；moved 不翻历史；
 *   at-edge ↑/↓ 翻历史；修饰键 + ↑/↓ 放行原生。
 *   Enter：staging 优先（⏎/Alt+⏎ 均提交 staging）；Alt+⏎ steer 路由行 → onFollowUp；
 *   Alt+⏎ defer/direct 行 → onSend（经统一分发器）；裸 ⏎ 恒 onSend（路由判定收口在
 *   core dispatch/send，keydown 层不分流）；⇧⏎ 放行换行。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SendRoute, StagingAction } from '@xyz-agent/core/domain/composer'
import { useComposerKeydown, type ComposerKeydownDeps } from './composer-keydown'
import type { ShellInputInstance } from './composer-shell'
import CommandPopover from '@/components/panel/CommandPopover.vue'

// useCommandSync（useCommandPopoverDelivery 内）挂载即可能拉 session.getCommands：
// mock '@/api' 避免依赖真实通道（与 command-popover-registry-merge.test.ts 同款）
vi.mock('@/api', () => ({
  session: { getCommands: vi.fn().mockResolvedValue({ sessionId: '', commands: [] }) },
}))

// open-fetch 的 landing cwd 路 import composer domain（u5 re-anchor 后实现的 import 是 core
// 子路径）——mock 之隔离真实 WS 通路。「浮层可见但候选为空」用例必须走真实 open 边沿拉取回写
// 空结果（fileNoResultsVisible ⇒ fileFallbackVisible），mock specifier 必须与实现一致否则 mock 失效
// （与 composer-file-popover.test.ts 同款）
const getFileCandidatesByCwdMock = vi.hoisted(() => vi.fn())
vi.mock('@xyz-agent/core/transport/api/domains/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyz-agent/core/transport/api/domains/composer')>()
  return {
    ...actual,
    getFileCandidatesByCwd: (...args: unknown[]) => getFileCandidatesByCwdMock(...args),
  }
})

type KeyMods = { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean }

/** 构造带 preventDefault spy 的键盘事件（happy-dom KeyboardEvent，isComposing 默认 false） */
function makeKeyEvent(key: string, mods: KeyMods = {}) {
  const e = new KeyboardEvent('keydown', {
    key,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    cancelable: true,
  })
  const preventDefault = vi.fn()
  e.preventDefault = preventDefault
  return { e, preventDefault }
}

/** fake deps：仅覆盖 keydown 分发路径实际消费的契约面（多余方法对测试无意义） */
function makeDeps(overrides: {
  /** moveCaretVertical 返回值（默认 at-edge → 触发翻历史路径） */
  caret?: 'moved' | 'at-edge'
  /** D6 发送路由（默认 direct） */
  route?: SendRoute
  stagingActive?: boolean
} = {}) {
  const moveCaretVertical = vi.fn(() => overrides.caret ?? 'at-edge')
  const handleArrowUp = vi.fn()
  const handleArrowDown = vi.fn()
  const onFollowUp = vi.fn()
  const onSend = vi.fn()
  const staging = {
    // Esc 路由默认不消费（消费与否属于 staging.action 自身测试，不在本矩阵）
    handleEsc: vi.fn(() => false),
    // 分派器只读 activeStaging.value 真值；staging action 行为契约由 staging 域测试覆盖
    activeStaging: computed(() =>
      overrides.stagingActive ? ({ type: 'fork' } as unknown as StagingAction) : null,
    ),
  }
  const deps: ComposerKeydownDeps = {
    cmdOpen: ref(false),
    commandPopoverRef: ref(null),
    inputRef: ref({ moveCaretVertical } as unknown as ShellInputInstance),
    staging,
    sendRoute: computed(() => overrides.route ?? 'direct'),
    handleArrowUp,
    handleArrowDown,
    onFollowUp,
    onSend,
  }
  return { deps, moveCaretVertical, handleArrowUp, handleArrowDown, onFollowUp, onSend }
}

describe('useComposerKeydown', () => {
  describe('bare-arrow 导航矩阵', () => {
    it('裸 ↑：preventDefault + moveCaretVertical(up)；caret moved 不翻历史', () => {
      const { deps, moveCaretVertical, handleArrowUp, handleArrowDown } = makeDeps({ caret: 'moved' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('ArrowUp')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(moveCaretVertical).toHaveBeenCalledWith('up')
      expect(handleArrowUp).not.toHaveBeenCalled()
      expect(handleArrowDown).not.toHaveBeenCalled()
    })

    it('裸 ↓：preventDefault + moveCaretVertical(down)；caret moved 不翻历史', () => {
      const { deps, moveCaretVertical, handleArrowUp, handleArrowDown } = makeDeps({ caret: 'moved' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('ArrowDown')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(moveCaretVertical).toHaveBeenCalledWith('down')
      expect(handleArrowUp).not.toHaveBeenCalled()
      expect(handleArrowDown).not.toHaveBeenCalled()
    })

    it('裸 ↑：caret at-edge → 翻上一条历史（handleArrowUp），不走下一条', () => {
      const { deps, moveCaretVertical, handleArrowUp, handleArrowDown } = makeDeps({ caret: 'at-edge' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('ArrowUp')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(moveCaretVertical).toHaveBeenCalledTimes(1)
      expect(handleArrowUp).toHaveBeenCalledTimes(1)
      expect(handleArrowDown).not.toHaveBeenCalled()
    })

    it('裸 ↓：caret at-edge → 翻下一条历史（handleArrowDown），不走上一条', () => {
      const { deps, handleArrowUp, handleArrowDown } = makeDeps({ caret: 'at-edge' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('ArrowDown')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(handleArrowDown).toHaveBeenCalledTimes(1)
      expect(handleArrowUp).not.toHaveBeenCalled()
    })

    it('修饰键 + ↑/↓ 放行原生（选区扩展/按词移动/段首段尾跳转）：不拦截不分派', () => {
      const cases: Array<{ key: string; mods: KeyMods }> = [
        { key: 'ArrowUp', mods: { shift: true } },
        { key: 'ArrowUp', mods: { alt: true } },
        { key: 'ArrowUp', mods: { ctrl: true } },
        { key: 'ArrowUp', mods: { meta: true } },
        { key: 'ArrowDown', mods: { shift: true } },
      ]
      for (const { key, mods } of cases) {
        const { deps, moveCaretVertical, handleArrowUp, handleArrowDown } = makeDeps()
        const onKeydown = useComposerKeydown(deps)
        const { e, preventDefault } = makeKeyEvent(key, mods)

        onKeydown(e)

        expect(preventDefault, `${key} + ${JSON.stringify(mods)} 应放行`).not.toHaveBeenCalled()
        expect(moveCaretVertical, `${key} + ${JSON.stringify(mods)} 应放行`).not.toHaveBeenCalled()
        expect(handleArrowUp).not.toHaveBeenCalled()
        expect(handleArrowDown).not.toHaveBeenCalled()
      }
    })
  })

  describe('Enter 分发矩阵（u5b D6：路由判定收口在 core dispatch/send）', () => {
    it('staging 活跃：裸 Enter → onSend（staging 提交优先）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ stagingActive: true, route: 'steer' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('staging 活跃：Alt+Enter → onSend（staging 优先于 followUp）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ stagingActive: true })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('Alt+Enter + steer 路由行 → onFollowUp（turn 活跃保留下一轮投递语义），不走 onSend', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ route: 'steer' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onFollowUp).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled()
    })

    it('Alt+Enter + defer 路由行 → onSend（占用期经统一分发器入队待重放）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ route: 'defer' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('Alt+Enter + direct → onSend（followUp 非活跃退化路径的语义收口）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ route: 'direct' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('裸 Enter + steer 路由行 → onSend（统一分发器：steer 路由并入当前回合，[HISTORICAL] isActive→onSteer 直调退役）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ route: 'steer' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('裸 Enter + idle（direct）→ onSend', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ route: 'direct' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('⇧⏎ 放行原生换行：不 preventDefault、不分派任何动作', () => {
      const { deps, onFollowUp, onSend } = makeDeps()
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { shift: true })

      onKeydown(e)

      expect(preventDefault).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(onFollowUp).not.toHaveBeenCalled()
    })
  })

  /**
   * D2 时序锁（composer-chip-insertion-semantics 设计 §3.3 D2 + P5）：浮层 open 时 Enter
   * 经 CommandPopover window capture 消费（preventDefault + stopPropagation 截断）后，
   * 事件不得到达 composer 的 onKeydown/onSend——这是删除 defaultPrevented 防御层后的
   * 唯一防线，用真实 DOM 事件派发锁 capture/bubble 全链路（happy-dom 支持传播 + stopPropagation
   * 语义；真机链路另有设计 §4 场景表签收）。
   *
   * 链路模拟与产线同构：window（capture，CommandPopover onWindowKeydown）→ target
   * （bubble，useComposerKeydown 产物 onKeydown，cmdOpen/commandPopoverRef 按产线接线）。
   */
  describe('D2 时序锁：浮层 open 时 Enter 选中候选、不触发发送（capture/bubble 全链路）', () => {
    let target: HTMLElement
    let removeTarget: () => void
    let popoverWrapper: ReturnType<typeof mount> | null = null
    let onSelect: ReturnType<typeof vi.fn>
    let onSend: ReturnType<typeof vi.fn>

    beforeEach(() => {
      setActivePinia(createPinia())
      onSelect = vi.fn()
      onSend = vi.fn()
      // target 模拟 composer contenteditable：keydown 冒泡链上挂 useComposerKeydown 产物
      target = document.createElement('div')
      target.setAttribute('contenteditable', 'true')
      document.body.appendChild(target)
      removeTarget = () => target.remove()
    })

    afterEach(() => {
      vi.useRealTimers()
      popoverWrapper?.unmount()
      popoverWrapper = null
      removeTarget()
      document.body.innerHTML = ''
    })

    /** target（composer contenteditable）挂 composer keydown 分发器，cmdOpen/commandPopoverRef
     *  按产线接线指向已挂载的浮层实例。 */
    function wireComposerKeydown(open: boolean): void {
      const deps: ComposerKeydownDeps = {
        cmdOpen: ref(open),
        commandPopoverRef: ref(popoverWrapper!.vm as never),
        inputRef: ref(null),
        staging: { handleEsc: vi.fn(() => false), activeStaging: computed(() => null) },
        sendRoute: computed(() => 'direct' as SendRoute),
        handleArrowUp: vi.fn(),
        handleArrowDown: vi.fn(),
        onFollowUp: vi.fn(),
        onSend,
      }
      target.addEventListener('keydown', useComposerKeydown(deps))
    }

    /** 挂真 CommandPopover（panel 态无 sid → compact 一项保底非空）+ 接线 composer keydown。
     *  propsOverride 供可见性矩阵用例换 type/query/variant（query 无匹配即可造「open 但空候选」）。 */
    function setupChain(open: boolean, propsOverride: Record<string, unknown> = {}): void {
      popoverWrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open, type: 'slash', variant: 'panel', onSelect, ...propsOverride } as never,
      })
      wireComposerKeydown(open)
    }

    /**
     * 浮层「可见但候选为空」的生产形态：landing `$` 空结果态——fileNoResultsVisible 为真
     * ⇒ fileFallbackVisible 为真 ⇒ 模板 v-if 渲染 PopoverContent（空态行），但 items 为空。
     * 必须走真实链路造态：挂载时 open=false，再 setProps 打开触发 open false→true 边沿拉取
     * （getFileCandidatesByCwd 回空 files 且 truncated=false）+ flush 回写 success。
     * 节流是模块级真实时钟，fake Date 使各用例互不撞窗口（flushPromises 依赖的
     * setImmediate/setTimeout 保持真实）。
     */
    async function setupLandingFileEmptyChain(): Promise<void> {
      vi.useFakeTimers({ toFake: ['Date'] })
      getFileCandidatesByCwdMock.mockResolvedValueOnce({ files: [], truncated: false })
      popoverWrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open: false, type: 'file', variant: 'landing', cwd: '/tmp/empty-dir', onSelect } as never,
      })
      wireComposerKeydown(true)
      await nextTick()
      await popoverWrapper.setProps({ open: true })
      await flushPromises()
      await nextTick()
      // 造态自检：浮层确实渲染（空态行在 DOM 中），否则下方「可见态消费」断言会假绿
      expect(document.body.querySelector('[data-testid="cmd-file-empty"]')).not.toBeNull()
    }

    /** 真实 DOM 派发（cancelable 保证 preventDefault 生效；bubbles 走完整 capture→target→bubble） */
    function dispatchEnter(isComposing = false): KeyboardEvent {
      const e = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing,
      })
      target.dispatchEvent(e)
      return e
    }

    it('浮层 open：Enter 被浮层 capture 消费（onSelect 一次）且 stopPropagation 截断——onSend 不触发、事件 defaultPrevented', () => {
      setupChain(true)

      const e = dispatchEnter()

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'slash', name: '/compact' }))
      expect(onSend).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    it('浮层不可见（行首 `/` + 无匹配 query，候选为空且非 landing file 空态）→ Enter 放行：onSend 被调用、浮层不消费（RC-A-1 回归锁）', () => {
      // 生产复现：会话内行首输入 `/zzz`（无匹配命令）或 `/usr/local/bin`——open=true 但
      // items=[]（仅剩的前端注入 compact 被 query 过滤掉），slash 路的 fileFallbackVisible
      // 恒假 ⇒ 模板 v-if 不渲染 PopoverContent。修复前（S-1）Enter/Tab 在此被无条件消费
      // ⇒ 消息发不出去且无任何提示。故本用例锁「不可见 → 不消费」。
      setupChain(true, { query: 'zzz' })

      const e = dispatchEnter()

      expect(onSend).toHaveBeenCalledTimes(1) // Enter 抵达 composer 分发器：消息可发送
      expect(onSelect).not.toHaveBeenCalled()
      // 浮层确实未渲染（不可见态自检，防「可见态误当不可见态」假绿）
      expect(document.body.querySelectorAll('.cmd-row')).toHaveLength(0)
      expect(document.body.querySelector('[data-testid="cmd-file-empty"]')).toBeNull()
      // 注：defaultPrevented 此刻为 true 是 composer 自身 Enter 处理（composer-keydown.ts:133）
      // 的既有行为，不是浮层消费——浮层消费的判据是 onSend 是否可达（本断言）与 Tab 放行。
    })

    it('浮层不可见：Tab 同样放行、不 preventDefault（不可见时全部键同口径放行，非仅 Enter）', () => {
      setupChain(true, { query: 'zzz' })

      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      target.dispatchEvent(tab)

      // 修复前：浮层 capture 无条件 preventDefault + stopPropagation ⇒ defaultPrevented=true
      expect(tab.defaultPrevented).toBe(false)
    })

    // 可见性矩阵（RC-A-1）：四条路的浮层渲染条件同源（items.length > 0 || fileFallbackVisible），
    // 而 fileFallbackVisible 仅 landing `$` 路为真 ⇒ 四条路空候选时浮层都不渲染，Enter 必须放行。
    it.each(['slash', 'session', 'subagent', 'skill'])(
      '浮层不可见（type=%s 空候选源）：Enter 放行不消费（可见性矩阵）',
      (type) => {
        setupChain(true, { type, query: 'zzz' })
        const handleKeydown = popoverWrapper!.vm.handleKeydown as (e: KeyboardEvent) => boolean

        const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
        expect(handleKeydown(enter)).toBe(false)
        expect(enter.defaultPrevented).toBe(false)
        expect(document.body.querySelectorAll('.cmd-row')).toHaveLength(0) // 浮层确实未渲染
      },
    )

    it('浮层可见但候选为空（landing `$` 空结果态）：Enter 仍被消费——defaultPrevented、不选中、不得到达 onSend、不自动关闭浮层', async () => {
      await setupLandingFileEmptyChain()

      const e = dispatchEnter()

      expect(e.defaultPrevented).toBe(true) // 事件被浮层消费（preventDefault），未被放行
      expect(onSend).not.toHaveBeenCalled() // 未落到 composer 分发器（stopPropagation 截断）
      expect(onSelect).not.toHaveBeenCalled() // 无候选可选中
      // 不改变 open 状态：不自动关闭（否则用户下一次 Enter 会在无浮层可感知下意外发送）
      expect(popoverWrapper!.emitted('update:open')).toBeFalsy()
    })

    it('浮层可见但候选为空：↑↓ 仍无害放行（现状行为不变），仅 Enter/Tab 被消费', async () => {
      await setupLandingFileEmptyChain()
      const handleKeydown = popoverWrapper!.vm.handleKeydown as (e: KeyboardEvent) => boolean

      // 方向键无项可移 → 返回 false 且不 preventDefault（行为与修复前一致，未被本次重排改变）
      const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true })
      expect(handleKeydown(down)).toBe(false)
      expect(down.defaultPrevented).toBe(false)

      const up = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true })
      expect(handleKeydown(up)).toBe(false)
      expect(up.defaultPrevented).toBe(false)

      // Enter/Tab 例外：可见空态也消费（返回 true + preventDefault），但不选中任何项
      const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
      expect(handleKeydown(enter)).toBe(true)
      expect(enter.defaultPrevented).toBe(true)

      const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
      expect(handleKeydown(tab)).toBe(true)
      expect(tab.defaultPrevented).toBe(true)

      expect(onSelect).not.toHaveBeenCalled()
    })

    it('浮层可见但候选为空：Escape 由浮层 DismissableLayer 兜底关闭（不被提前返回拦死）', async () => {
      await setupLandingFileEmptyChain()
      const handleKeydown = popoverWrapper!.vm.handleKeydown as (e: KeyboardEvent) => boolean

      const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      // 本层不消费（方向键/其他键在无候选项时放行）——浮层已渲染，Escape 交 reka DismissableLayer
      expect(handleKeydown(esc)).toBe(false)
      expect(esc.defaultPrevented).toBe(false)
    })

    it('IME composing 态（compositionstart 置 composingRef）：Enter 不选中浮层候选（只锁「浮层不选中」）', () => {
      // 本用例只锁浮层侧行为（composingRef 真值时 handleKeydown 不消费 Enter → 不选中候选）。
      // 不加 onSend 断言的原因：本用例的 target 是纯 div 直挂 composer 分发器，绕过产线上
      // 真正的 IME 防线——dom-core contenteditable.ts:242 的元素级 composing 守卫（事件根本
      // 不会转发到 composer-keydown）。「IME 场景不发送」的有效锁在 dom-core contenteditable.test.ts
      // 「onKeydown IME 守卫」用例；事件属性路径（e.isComposing=true）见下方用例。
      setupChain(true)
      // 组合发生在 composer 输入区（target），compositionstart 冒泡到 window capture 置 composingRef
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))

      dispatchEnter()

      expect(onSelect).not.toHaveBeenCalled()
    })

    it('IME composing 态（事件属性 isComposing）：Enter 不选中浮层候选、到达 composer 被 IME 守卫放行不发送', () => {
      setupChain(true)

      dispatchEnter(true)

      expect(onSelect).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
    })

    it('浮层关闭：Enter 正常到达 composer → onSend（防截断误伤正常发送）', () => {
      setupChain(false)

      dispatchEnter()

      expect(onSelect).not.toHaveBeenCalled()
      expect(onSend).toHaveBeenCalledTimes(1)
    })
  })
})
