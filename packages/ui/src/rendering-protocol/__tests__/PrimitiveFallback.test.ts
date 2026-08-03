/**
 * PrimitiveFallback 组件测试（W1 · TC2）。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/PrimitiveFallback.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { PrimitiveFallback } from '../primitive-render-key'
import type { GuiComponent } from '@xyz-agent/extension-protocol'

describe('PrimitiveFallback', () => {
  it('未知类型组件 → 渲染 JSON 序列化 props，不抛错', () => {
    // 脏数据场景：type 不在协议枚举内，整体断言绕过联合类型收窄（测试意图即验证降级）
    const component = {
      type: 'unknown-type',
      props: { foo: 'bar', nested: { a: 1 } },
    } as unknown as GuiComponent
    const wrapper = mount(PrimitiveFallback, { props: { component } })
    expect(wrapper.find('[data-testid="primitive-fallback"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('"foo": "bar"')
    expect(wrapper.text()).toContain('"nested"')
  })

  it('空 props 渲染 {}', () => {
    const component = {
      type: 'unknown-type',
      props: {},
    } as unknown as GuiComponent
    const wrapper = mount(PrimitiveFallback, { props: { component } })
    expect(wrapper.text()).toContain('{}')
  })
})
