/**
 * W3 红灯测试 —— tool call 展开体统一重构。
 *
 * 防的 bug：
 * - 展开体重复打印 toolName(args)，与 header 完全重复（冗余）
 * - result 区 Check/XCircle 图标与 header 状态指示重复（冗余）
 * - 普通 tool 展开体缺少补充细节（如耗时），信息架构与 subagent 不统一
 *
 * 三视角：
 * - 观察者（形态）：展开后无重复的 toolName(args) 行；result 区无 Check/XCircle 图标
 * - 使用者（黑盒）：展开看到耗时 + 结果，不看到重复信息
 * - 构建者（白盒）：耗时从 startTime+endTime 计算
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/panel/tool-expand-restructure.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Block from '@/components/panel/message-stream/Block.vue'
import type { ToolCall } from '@xyz-agent/shared'

function makeTool(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    toolName: 'edit',
    input: { path: 'src/App.vue' },
    output: 'done',
    status: 'completed',
    startTime: 1000,
    endTime: 2500, // 耗时 1.5s
    ...over,
  }
}

describe('W3: 普通 tool 展开体去重复 + 加补充细节条', () => {
  it('展开后不重复打印 toolName(args) 行（header 已有）', async () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool(), working: false },
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    // 关键断言：展开体内不应再有 "edit(src/App.vue)" 这样的重复行
    // 当前实现 :103-106 会打印 <span>edit</span><span>(src/App.vue)</span>（红灯）
    // 展开 body 的文本里，toolName + ( + argPath 组合不应出现
    const expandText = wrapper.text()
    // "edit(src/App.vue)" 或 "edit (src/App.vue)" 是重复行的特征
    expect(expandText).not.toMatch(/edit\s*\(src\/App\.vue\)/)
  })

  it('展开后 result 区无 Check/XCircle 图标（header 状态指示已覆盖）', async () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ output: 'success result' }), working: false },
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    // 当前实现 :112-113 在 result 前放 Check/XCircle（红灯——改后应移除）
    // 展开 body 内的 svg 图标：header 的 svg 是状态指示（保留），result 区的 svg 是重复（应删）
    // 验证方式：header 外不应有额外的 Check 图标
    const header = wrapper.find('[data-testid="tool-block-header"]')
    const headerSvgs = header.findAll('svg')
    const allSvgs = wrapper.findAll('svg')
    // header 自带 chevron + wrench + status = 3 个 svg
    // 改后展开 body 不应再加 svg（result 区图标删掉）
    // 当前实现 result 区有 1 个 Check svg，所以 allSvgs > headerSvgs（红灯）
    expect(allSvgs.length).toBe(headerSvgs.length)
  })

  it('展开后显示补充细节条（耗时，从 startTime+endTime 计算）', async () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ startTime: 1000, endTime: 3000 }), working: false },
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    // 关键断言：展开后显示耗时（diff=2000ms → formatDuration "2s"）
    // 当前展开体无耗时信息（红灯）
    const expandText = wrapper.text()
    expect(expandText).toContain('2s')
  })

  it('展开后结果文本仍可见（去重复不影响结果展示）', async () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ output: 'file content here' }), working: false },
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    // 结果仍可见
    expect(wrapper.text()).toContain('file content here')
  })

  it('失败 tool 展开后 error 仍直显（红框 + 错误文本，不因重构丢失）', async () => {
    const wrapper = mount(Block, {
      props: {
        type: 'tool',
        tool: makeTool({ status: 'error', output: 'old_string not found', startTime: 1000, endTime: 1200 }),
        working: false,
      },
    })
    // 失败强制展开（无需点击）
    expect(wrapper.text()).toContain('old_string not found')
    // 红框仍在
    expect(wrapper.find('.border-danger').exists()).toBe(true)
    // 无重复 toolName(args) 行
    expect(wrapper.text()).not.toMatch(/edit\s*\(src\/App\.vue\)/)
  })
})
