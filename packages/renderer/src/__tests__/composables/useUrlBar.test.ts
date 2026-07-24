/**
 * useUrlBar 单测（地址栏编辑态管理）。
 *
 * 覆盖：
 * - 非编辑态：displayUrl 变化 → urlInput 同步
 * - 编辑态：displayUrl 变化 → urlInput 不覆盖
 * - 回车裸域名 → 补全 https:// + 触发 navigate
 * - 回车完整 URL → 不重复补全
 * - Escape → 回填 displayUrl + 不触发 navigate
 * - 聚焦 → 进入编辑态 + 全选
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useUrlBar.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { useUrlBar } from '@/composables/features/useUrlBar'

describe('useUrlBar', () => {
  let displayUrl: ReturnType<typeof ref<string>>
  let navigateFn: ReturnType<typeof vi.fn>
  let result: ReturnType<typeof useUrlBar>

  beforeEach(() => {
    displayUrl = ref('https://example.com')
    navigateFn = vi.fn()
    result = useUrlBar(displayUrl, navigateFn)
  })

  it('初始 urlInput = displayUrl', () => {
    expect(result.urlInput.value).toBe('https://example.com')
  })

  it('非编辑态：displayUrl 变化 → urlInput 同步', async () => {
    displayUrl.value = 'https://redirected.com'
    await Promise.resolve()
    expect(result.urlInput.value).toBe('https://redirected.com')
  })

  it('编辑态：displayUrl 变化 → urlInput 不覆盖', async () => {
    result.isEditingUrl.value = true
    result.urlInput.value = '用户正在输入'
    displayUrl.value = 'https://redirected.com'
    await Promise.resolve()
    expect(result.urlInput.value).toBe('用户正在输入')
  })

  it('回车裸域名 → 补全 https:// + 触发 navigate', () => {
    result.urlInput.value = 'github.com'
    result.onUrlEnter()
    expect(navigateFn).toHaveBeenCalledWith('https://github.com')
    expect(result.isEditingUrl.value).toBe(false)
  })

  it('回车完整 URL → 不重复补全', () => {
    result.urlInput.value = 'http://foo.bar/baz'
    result.onUrlEnter()
    expect(navigateFn).toHaveBeenCalledWith('http://foo.bar/baz')
  })

  it('回车 https URL → 不重复补全', () => {
    result.urlInput.value = 'HTTPS://UPPER.COM'
    result.onUrlEnter()
    expect(navigateFn).toHaveBeenCalledWith('HTTPS://UPPER.COM')
  })

  it('回车空输入 → 不触发 navigate', () => {
    result.urlInput.value = '   '
    result.onUrlEnter()
    expect(navigateFn).not.toHaveBeenCalled()
  })

  it('Escape → 回填 displayUrl + 不触发 navigate', () => {
    result.urlInput.value = '未确认的输入'
    result.onUrlEscape()
    expect(result.urlInput.value).toBe('https://example.com')
    expect(navigateFn).not.toHaveBeenCalled()
    expect(result.isEditingUrl.value).toBe(false)
  })

  it('聚焦 → 进入编辑态', () => {
    const fakeInput = { select: vi.fn() }
    const fakeEvent = { target: fakeInput } as unknown as FocusEvent
    result.onUrlFocus(fakeEvent)
    expect(result.isEditingUrl.value).toBe(true)
    expect(fakeInput.select).toHaveBeenCalled()
  })
})
