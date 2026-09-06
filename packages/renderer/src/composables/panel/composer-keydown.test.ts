/**
 * composer-keydown 单测——test-coverage-r1 MUST_FIX #1 修复（U02 从 Composer.vue onKeydown
 * 拆出后键盘决策分支零测试触达）。
 *
 * useComposerKeydown 是纯事件分派器（deps 全只读注入、无自有状态、无 DOM 依赖），
 * 直接注入 fake deps 单测返回的 handler。断言到依赖调用层面（哪个 dep 被调/未被调 +
 * preventDefault 次数），非「不抛错」式弱断言。
 *
 * 覆盖矩阵（与源文件头部分发语义逐条对应）：
 *   bare-arrow：裸 ↑/↓ → preventDefault + moveCaretVertical；moved 不翻历史；
 *   at-edge ↑/↓ 翻历史；修饰键 + ↑/↓ 放行原生。
 *   Enter：staging 优先（⏎/Alt+⏎ 均提交 staging）；Alt+⏎ compacting → onSend 入队；
 *   Alt+⏎ 非 compacting → onFollowUp；裸 ⏎ active → steer / idle → send；⇧⏎ 放行换行。
 */
import { describe, it, expect, vi } from 'vitest'
import { computed, ref } from 'vue'
import type { StagingAction } from '@xyz-agent/core/domain/composer'
import { useComposerKeydown, type ComposerKeydownDeps } from './composer-keydown'
import type { ShellInputInstance } from './composer-shell'

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
  active?: boolean
  compacting?: boolean
  stagingActive?: boolean
} = {}) {
  const moveCaretVertical = vi.fn(() => overrides.caret ?? 'at-edge')
  const handleArrowUp = vi.fn()
  const handleArrowDown = vi.fn()
  const onSteer = vi.fn()
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
    isActive: computed(() => overrides.active ?? false),
    isCompacting: computed(() => overrides.compacting ?? false),
    handleArrowUp,
    handleArrowDown,
    onSteer,
    onFollowUp,
    onSend,
  }
  return { deps, moveCaretVertical, handleArrowUp, handleArrowDown, onSteer, onFollowUp, onSend }
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

  describe('Enter 分发矩阵', () => {
    it('staging 活跃：裸 Enter → onSend（staging 提交优先），不走 steer', () => {
      const { deps, onSteer, onFollowUp, onSend } = makeDeps({ stagingActive: true, active: true })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onSteer).not.toHaveBeenCalled()
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('staging 活跃：Alt+Enter → onSend（staging 优先于 followUp）', () => {
      const { deps, onSteer, onFollowUp, onSend } = makeDeps({ stagingActive: true })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
      expect(onSteer).not.toHaveBeenCalled()
    })

    it('Alt+Enter + compacting → onSend（入队待重放），不走 onFollowUp（无 isActive 守卫直通会留陈旧 followUp 队列）', () => {
      const { deps, onSteer, onFollowUp, onSend } = makeDeps({ compacting: true })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
      expect(onSteer).not.toHaveBeenCalled()
    })

    it('Alt+Enter + 非 compacting → onFollowUp（followUp RPC 队列语义），不走 onSend/onSteer', () => {
      const { deps, onSteer, onFollowUp, onSend } = makeDeps()
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onFollowUp).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled()
      expect(onSteer).not.toHaveBeenCalled()
    })

    it('裸 Enter + active → onSteer（追加 steer 不打断当前回合），不走 onSend', () => {
      const { deps, onSteer, onSend } = makeDeps({ active: true })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSteer).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled()
    })

    it('裸 Enter + idle → onSend', () => {
      const { deps, onSteer, onFollowUp, onSend } = makeDeps({ active: false })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onSteer).not.toHaveBeenCalled()
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('⇧⏎ 放行原生换行：不 preventDefault、不分派任何动作', () => {
      const { deps, onSteer, onFollowUp, onSend } = makeDeps()
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { shift: true })

      onKeydown(e)

      expect(preventDefault).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(onSteer).not.toHaveBeenCalled()
      expect(onFollowUp).not.toHaveBeenCalled()
    })
  })
})
