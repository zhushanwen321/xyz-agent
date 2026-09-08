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
import { computed, ref } from 'vue'
import { mount } from '@vue/test-utils'
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
      popoverWrapper?.unmount()
      popoverWrapper = null
      removeTarget()
      document.body.innerHTML = ''
    })

    /** 挂真 CommandPopover（panel 态无 sid → compact 一项保底非空）+ 接线 composer keydown */
    function setupChain(open: boolean): void {
      popoverWrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open, type: 'slash', variant: 'panel', onSelect } as never,
      })
      const deps: ComposerKeydownDeps = {
        cmdOpen: ref(open),
        commandPopoverRef: ref(popoverWrapper.vm as never),
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

    it('IME composing 态（compositionstart 置 composingRef）：Enter 不选中浮层候选', () => {
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
