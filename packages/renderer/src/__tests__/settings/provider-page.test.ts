/**
 * ProviderPage 渲染测试（W9）。
 *
 * 覆盖：
 *  - 首屏冒烟：providers=[] → 渲染「添加供应商」按钮 + 空状态。
 *  - 打开 dialog：点击添加按钮 → ProviderEditModal 内容 teleport 到 document.body。
 *
 * mock 策略：
 *  - vi.mock('@/api') 替换 config 门面（setProvider/deleteProvider/listProviders 等动作 + onProviders 订阅），
 *    避免 ProviderEditModal 的 useProviderEdit 调真实 transport 挂起。
 *  - reka-ui DialogContent teleport 到 body，dialog 文本在 document.body 上查询。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/settings/provider-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

/** vi.hoisted 保证 configMock 在 vi.mock 工厂执行前就绪。 */
const configMock = vi.hoisted(() => ({
  onProviders: vi.fn(() => () => {}),
  listProviders: vi.fn(async () => []),
  setProvider: vi.fn(async () => {}),
  deleteProvider: vi.fn(async () => {}),
  testProvider: vi.fn(async () => ({ ok: true })),
  discoverModels: vi.fn(async () => []),
}))

vi.mock('@/api', () => ({
  config: configMock,
  default: { config: configMock },
}))

import ProviderPage from '@/components/settings/ProviderPage.vue'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ProviderPage 首屏冒烟', () => {
  it('providers=[] → 渲染「添加供应商」按钮 + 空状态文案', async () => {
    wrapper = mount(ProviderPage, { props: { providers: [] } })
    await flushPromises()
    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加供应商'))
    expect(addBtn).toBeTruthy()
    expect(wrapper.text()).toContain('还没有供应商')
  })
})

describe('ProviderPage 打开 dialog', () => {
  it('点击添加供应商按钮 → dialog teleport 到 body 含「添加供应商」标题', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()
    // 关闭态：body 无 dialog 标题
    expect(document.body.textContent ?? '').not.toContain('配置供应商凭据与模型清单')

    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加供应商'))!
    await addBtn.trigger('click')
    await flushPromises()

    // ProviderEditModal open=true → DialogContent teleport 到 body，标题为「添加供应商」（provider=null）
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('添加供应商')
    // 模型清单标题也在 dialog 内
    expect(bodyText).toContain('模型清单')
  })
})
