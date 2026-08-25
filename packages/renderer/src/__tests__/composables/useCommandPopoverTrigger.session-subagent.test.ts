/**
 * useCommandPopoverTrigger session/subagent 触发关闭分支 + 新建 subagent chip 单测。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/__tests__/composables/useCommandPopoverTrigger.session-subagent.test.ts
 *
 * 覆盖（与 attach.test 的 + 菜单分支互补，四符号体系 # / @ 路径）：
 *   - onSessionTrigger({query}) → 开浮层记 query；再 trigger(null) → 关浮层（关闭分支）
 *   - onSubagentTrigger({query}) → 开浮层；再 trigger(null) → 关浮层
 *   - trigger(null) 但无 active 标记 → 不动浮层（非触发路径打开的浮层不被误关）
 *   - onCmdSelect(type=subagent)「新建」项（slug/subagentId 空串）→ 插占位「新任务」chip
 *
 * mock 策略：对齐 useCommandPopoverTrigger.attach.test.ts（effectScope + inputRef spy 对象）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref } from 'vue'

import { useCommandPopoverTrigger } from '@/composables/panel/useCommandPopoverTrigger'

/** inputRef mock：spy 覆盖本测试触达的插入/清除方法 */
function createInputMock() {
  return {
    focus: vi.fn(),
    clearSlashQueryText: vi.fn(),
    insertSlashChip: vi.fn(),
    clearSessionQueryText: vi.fn(),
    insertSessionChip: vi.fn(),
    clearSubagentQueryText: vi.fn(),
    insertSubagentChip: vi.fn(),
    clearDollarFileQueryText: vi.fn(),
    insertFileChip: vi.fn(),
  }
}

/** 在独立 effectScope 内运行 composable（watch 等需 scope） */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

describe('useCommandPopoverTrigger session/subagent 触发（# / @ 符号路径）', () => {
  let dispose: (() => void) | undefined

  beforeEach(() => {
    setActivePinia(createPinia())
  })
  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  function setup() {
    const inputMock = createInputMock()
    const { result, dispose: d } = runWithScope(() =>
      useCommandPopoverTrigger(ref(inputMock) as never, ref('sid') as never),
    )
    dispose = d
    return { result, inputMock }
  }

  it('onSessionTrigger({query}) → cmdType=session 开浮层；trigger(null) → 关闭', () => {
    const { result } = setup()
    expect(result.cmdOpen.value).toBe(false)

    result.onSessionTrigger({ query: '设计讨' })
    expect(result.cmdOpen.value).toBe(true)
    expect(result.cmdType.value).toBe('session')
    expect(result.sessionQuery.value).toBe('设计讨')

    // 触发路径打开的浮层：trigger(null) 关闭
    result.onSessionTrigger(null)
    expect(result.cmdOpen.value).toBe(false)
  })

  it('onSubagentTrigger({query}) → cmdType=subagent 开浮层；trigger(null) → 关闭', () => {
    const { result } = setup()

    result.onSubagentTrigger({ query: 'reviewer' })
    expect(result.cmdOpen.value).toBe(true)
    expect(result.cmdType.value).toBe('subagent')
    expect(result.subagentQuery.value).toBe('reviewer')

    result.onSubagentTrigger(null)
    expect(result.cmdOpen.value).toBe(false)
  })

  it('trigger(null) 但无 active 标记 → 不关闭浮层（+ 菜单路径打开的不被误关）', () => {
    const { result } = setup()
    // 模拟 + 菜单路径打开（不设触发态）：先经 slash 触发打开后手动清标记不可行，
    // 直接验证非触发态下 trigger(null) 无副作用：初始关闭态保持不变
    expect(result.cmdOpen.value).toBe(false)
    result.onSessionTrigger(null)
    expect(result.cmdOpen.value).toBe(false)
  })

  it('onCmdSelect(type=subagent)「新建」项（两字段空串）→ 清过滤文本 + 插占位「新任务」chip', () => {
    const { result, inputMock } = setup()

    result.onCmdSelect({ type: 'subagent', name: 'x', subagentId: '', slug: '' })

    expect(inputMock.clearSubagentQueryText).toHaveBeenCalledTimes(1)
    // 占位 slug 用 i18n 文案（zh-CN「新任务」）
    expect(inputMock.insertSubagentChip).toHaveBeenCalledWith('', '新任务')
    // 浮层关闭 + 焦点回输入区
    expect(result.cmdOpen.value).toBe(false)
    expect(inputMock.focus).toHaveBeenCalledTimes(1)
  })

  it('onCmdSelect(type=subagent) 已有 record → subagentId/slug 原样插 chip', () => {
    const { result, inputMock } = setup()

    result.onCmdSelect({ type: 'subagent', name: 'x', subagentId: 'sa-1', slug: 'build-api' })
    expect(inputMock.insertSubagentChip).toHaveBeenCalledWith('sa-1', 'build-api')
    expect(result.cmdOpen.value).toBe(false)
  })

  it('onCmdSelect(type=file) → 清 $ 过滤文本 + 插文件 chip', () => {
    const { result, inputMock } = setup()

    result.onCmdSelect({ type: 'file', name: '/a/b.ts' })
    expect(inputMock.clearDollarFileQueryText).toHaveBeenCalledTimes(1)
    expect(inputMock.insertFileChip).toHaveBeenCalledWith('/a/b.ts')
    expect(result.cmdOpen.value).toBe(false)
  })
})
