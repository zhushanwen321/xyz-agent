/**
 * Brand 组件测试（review S-8 补充）。
 *
 * 覆盖：
 *  - versionLabel 正常态（Sidebar 传入的完整文案「v{version} · pi v{piVersion}」）渲染
 *  - versionLabel fallback（未传 / 空串，如 piVersion 未就绪时）版本行不渲染
 *  - 产品名渲染 app.title i18n（zh-CN：太极）
 *  - #trailing slot 内容渲染（Sidebar 注入 UpdateButton）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/Brand.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Brand from '@/components/sidebar/Brand.vue'

describe('Brand', () => {
  it('versionLabel 正常态：渲染完整版本文案（v{version} · pi v{piVersion}）', () => {
    const wrapper = mount(Brand, {
      props: { versionLabel: 'v0.8.40 · pi v0.82.1' },
    })
    // Sidebar 侧 versionLabel 构成：`v${__APP_VERSION__} · pi v${piVersion}`
    expect(wrapper.text()).toContain('v0.8.40 · pi v0.82.1')
  })

  it('versionLabel fallback：未传（piVersion 未就绪）时不渲染版本行', () => {
    const wrapper = mount(Brand)
    // 默认 versionLabel='' → v-if 不渲染版本号行（只留 logo + 产品名）
    const versionLine = wrapper.find('.text-\\[10px\\]')
    expect(versionLine.exists()).toBe(false)
    expect(wrapper.text()).not.toContain('v0.0.0-test')
  })

  it('产品名渲染 app.title i18n（zh-CN：太极）', () => {
    const wrapper = mount(Brand)
    const title = wrapper.find('span.text-\\[13px\\]')
    expect(title.exists()).toBe(true)
    expect(title.text()).toBe('太极')
  })

  it('#trailing slot 内容渲染（Sidebar 注入 UpdateButton）', () => {
    const wrapper = mount(Brand, {
      slots: {
        trailing: '<button data-testid="trailing-stub">升级</button>',
      },
    })
    const trailing = wrapper.find('[data-testid="trailing-stub"]')
    expect(trailing.exists()).toBe(true)
    expect(trailing.text()).toBe('升级')
  })
})
