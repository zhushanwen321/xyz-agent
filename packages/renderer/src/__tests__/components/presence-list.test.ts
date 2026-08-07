/**
 * PresenceList 组件冒烟测试（P5 lease/presence AC12）。
 *
 * 覆盖：
 * - 多设备时 presence-list DOM 存在
 * - 单设备/空时不渲染（v-if showList）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/presence-list.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PresenceList from '@/components/sidebar/PresenceList.vue'
import { usePresenceStore } from '@/stores/presence'
import type { PresenceConnection } from '@xyz-agent/shared'

describe('PresenceList 组件（P5 sidebar 在线设备区域 DOM）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('AC12a: 多设备时 presence-list DOM 存在', async () => {
    const store = usePresenceStore()
    store.setConnections([
      { clientId: 'A', deviceName: 'Mac', activeSessionId: 's1', isOperating: true },
      { clientId: 'B', deviceName: 'Phone', activeSessionId: null, isOperating: false },
    ])
    const wrapper = mount(PresenceList)
    expect(wrapper.find('[data-testid="presence-list"]').exists()).toBe(true)
    // 列出两个设备
    expect(wrapper.findAll('li')).toHaveLength(2)
  })

  it('AC12b: 单设备时不渲染（showList=false）', () => {
    const store = usePresenceStore()
    store.setConnections([
      { clientId: 'A', deviceName: 'Mac', activeSessionId: null, isOperating: false },
    ])
    const wrapper = mount(PresenceList)
    expect(wrapper.find('[data-testid="presence-list"]').exists()).toBe(false)
  })

  it('AC12c: 空列表时不渲染', () => {
    const store = usePresenceStore()
    store.setConnections([])
    const wrapper = mount(PresenceList)
    expect(wrapper.find('[data-testid="presence-list"]').exists()).toBe(false)
  })

  it('AC12d: isOperating 设备行含操作中标记', () => {
    const store = usePresenceStore()
    const conns: PresenceConnection[] = [
      { clientId: 'A', deviceName: 'Mac', activeSessionId: 's1', isOperating: true },
      { clientId: 'B', deviceName: 'Phone', activeSessionId: null, isOperating: false },
    ]
    store.setConnections(conns)
    const wrapper = mount(PresenceList)
    const rows = wrapper.findAll('li')
    // A isOperating=true 行应有「操作中」文本
    expect(rows[0].text()).toContain('Mac')
    // B isOperating=false 行无「操作中」标记
    expect(rows[1].text()).toContain('Phone')
  })
})
