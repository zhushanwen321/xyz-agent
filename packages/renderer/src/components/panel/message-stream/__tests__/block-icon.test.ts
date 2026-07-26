/**
 * W2TC6 —— block-icon.ts 单测（getBlockIcon 决策 + BLOCK_ICON_LUCIDE 映射 + RUNNING_LOADER_SVG 占位）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/components/panel/message-stream/__tests__/block-icon.test.ts
 */
import { describe, it, expect } from 'vitest'
import { Brain, Bot, Wrench, XCircle, ChevronRight } from '@lucide/vue'
import { getBlockIcon, BLOCK_ICON_LUCIDE, RUNNING_LOADER_SVG } from '@/components/panel/message-stream/block-icon'

describe('W2TC6: block-icon.ts', () => {
  it('getBlockIcon: running 覆盖一切（无论 toolName/isSubagent/isWorkflow）', () => {
    expect(getBlockIcon('bash', 'running', false, false)).toBe('running')
    // 即使是 subagent/workflow，running 态也优先返回 running（loader 动画统一）
    expect(getBlockIcon('subagent', 'running', true, false)).toBe('running')
    expect(getBlockIcon('workflow', 'running', false, true)).toBe('running')
  })

  it('getBlockIcon: error → failed（覆盖 toolName/isSubagent/isWorkflow）', () => {
    expect(getBlockIcon('read', 'error', false, false)).toBe('failed')
    expect(getBlockIcon('subagent', 'error', true, false)).toBe('failed')
  })

  it('getBlockIcon: isSubagent → subagent（非 running/error 时）', () => {
    expect(getBlockIcon('subagent', 'completed', true, false)).toBe('subagent')
  })

  it('getBlockIcon: isWorkflow → workflow（非 running/error/subagent 时）', () => {
    expect(getBlockIcon('workflow', 'completed', false, true)).toBe('workflow')
  })

  it('getBlockIcon: toolName 映射（read→tool-read, bash→tool-bash, edit/write→tool-edit）', () => {
    expect(getBlockIcon('read', 'completed', false, false)).toBe('tool-read')
    expect(getBlockIcon('bash', 'completed', false, false)).toBe('tool-bash')
    expect(getBlockIcon('edit', 'completed', false, false)).toBe('tool-edit')
    expect(getBlockIcon('write', 'completed', false, false)).toBe('tool-edit')
  })

  it('getBlockIcon: 未知 toolName → tool-other', () => {
    expect(getBlockIcon('unknown', 'completed', false, false)).toBe('tool-other')
  })

  it('getBlockIcon: end_not_received 态不触发 failed 分支（非 error，走 toolName 映射）', () => {
    // end_not_received 不是 error，应走正常 toolName 映射（诚实态≠失败）
    expect(getBlockIcon('read', 'end_not_received', false, false)).toBe('tool-read')
  })

  it('BLOCK_ICON_LUCIDE: W2 用现状图标（subagent=Bot, thinking=Brain, failed=XCircle）', () => {
    // W2 阶段映射值是现状图标（W3 才改为 H 最终 lightbulb/users 等）
    expect(BLOCK_ICON_LUCIDE.subagent).toBe(Bot)
    expect(BLOCK_ICON_LUCIDE.thinking).toBe(Brain)
    expect(BLOCK_ICON_LUCIDE.failed).toBe(XCircle)
    expect(BLOCK_ICON_LUCIDE['tool-read']).toBe(Wrench) // W3 换 BookOpen
    expect(BLOCK_ICON_LUCIDE['tool-bash']).toBe(Wrench) // W3 换 Terminal
    expect(BLOCK_ICON_LUCIDE['tool-edit']).toBe(Wrench) // W3 换 Pencil
    expect(BLOCK_ICON_LUCIDE['tool-other']).toBe(Wrench)
    expect(BLOCK_ICON_LUCIDE.workflow).toBe(Wrench) // W3 换 ListChecks
    expect(BLOCK_ICON_LUCIDE.text).toBe(ChevronRight) // W3 保持或换 ArrowRight
  })

  it('RUNNING_LOADER_SVG: W2 占位空串（W3 填双环 loader）', () => {
    expect(RUNNING_LOADER_SVG).toBe('')
  })
})
