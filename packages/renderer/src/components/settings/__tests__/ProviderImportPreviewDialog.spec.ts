/**
 * ProviderImportPreviewDialog 组件测试（W2 · cw-2026-07-26-migration-other-agents）。
 *
 * 覆盖：
 * - T11：mount 对话框，preview 含 3 项（1 key 缺失 / 1 冲突 / 1 正常）
 *   → 断言 3 个 preview-provider-item；含 key-warning；含 conflict-badge；
 *   正常项 Checkbox checked，冲突项 Checkbox 不 checked 且 disabled
 * - T12：勾选 2 项后点 confirm-import-btn → emit('confirm') 含勾选的 id
 * - T12c：warnings 折叠交互（用 div toggle 替代原生 <details>）——初始 <ul> 不渲染，点击 toggle 后渲染
 * - T12d：error 态显示——props 传 error → [data-testid="preview-error"] 渲染含消息
 *
 * 注意：DialogContent 走 DialogPortal/Teleport 渲染到 document.body，
 * 故断言用 document.body.querySelectorAll 而非 wrapper.findAll。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/__tests__/ProviderImportPreviewDialog.spec.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { ProviderImportPreview } from '@xyz-agent/shared'
import ProviderImportPreviewDialog from '@/components/settings/ProviderImportPreviewDialog.vue'

// ── fixture：3 项 preview（正常 + key 缺失 + 冲突）──
const FIXTURE: ProviderImportPreview = {
  source: 'claude',
  providers: [
    {
      id: 'openai', name: 'OpenAI', protocol: 'openai-completions', modelCount: 3,
      apiKeyExtracted: true, conflict: 'none', warnings: [],
    },
    {
      id: 'azure', name: 'Azure', protocol: 'openai-completions', modelCount: 2,
      apiKeyExtracted: false, conflict: 'none', warnings: ['env_key 未设置'],
    },
    {
      id: 'anthropic', name: 'Anthropic', protocol: 'anthropic-messages', modelCount: 5,
      apiKeyExtracted: true, conflict: 'duplicate-id', warnings: [],
    },
  ],
}

let wrapper: ReturnType<typeof mount> | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ProviderImportPreviewDialog', () => {
  it('T11: 渲染 3 项 preview，含 key-warning / conflict-badge，正常项默认勾选、冲突项不勾且禁用', async () => {
    wrapper = mount(ProviderImportPreviewDialog, {
      props: { open: true, importId: 'imp-1', preview: FIXTURE },
    })
    await flushPromises()

    // 3 个 provider 项（Teleport 到 body）
    const items = document.body.querySelectorAll('[data-testid="preview-provider-item"]')
    expect(items).toHaveLength(3)

    // key-warning：azure 项（apiKeyExtracted=false）
    expect(document.body.querySelector('[data-testid="key-warning"]')).toBeTruthy()

    // conflict-badge：anthropic 项（conflict=duplicate-id）
    expect(document.body.querySelector('[data-testid="conflict-badge"]')).toBeTruthy()

    // Checkbox：openai（正常）checked，anthropic（冲突）disabled + unchecked
    const checkboxes = document.body.querySelectorAll('[data-testid="preview-provider-item"] button[role="checkbox"]')
    expect(checkboxes).toHaveLength(3)
    // openai 项（第 0 个）默认勾选
    expect(checkboxes[0].getAttribute('data-state')).toBe('checked')
    // anthropic 项（第 2 个）冲突：disabled + unchecked
    expect(checkboxes[2].getAttribute('disabled')).toBeDefined()
    expect(checkboxes[2].getAttribute('data-state')).toBe('unchecked')
  })

  it('T12: 取消勾选 1 项后点 confirm-import-btn → emit confirm 含剩余勾选 id', async () => {
    wrapper = mount(ProviderImportPreviewDialog, {
      props: { open: true, importId: 'imp-1', preview: FIXTURE },
    })
    await flushPromises()

    // 默认勾选 openai + azure（conflict=none），anthropic（冲突）不勾
    const checkboxes = document.body.querySelectorAll('[data-testid="preview-provider-item"] button[role="checkbox"]')
    // 取消勾选 azure（第 1 个），剩 openai
    ;(checkboxes[1] as HTMLElement).click()
    await flushPromises()

    // 点确认按钮
    const confirmBtn = document.body.querySelector('[data-testid="confirm-import-btn"]') as HTMLElement
    expect(confirmBtn).toBeTruthy()
    confirmBtn.click()
    await flushPromises()

    const emitted = wrapper!.emitted('confirm')
    expect(emitted).toBeTruthy()
    // 剩 1 个勾选（openai）
    expect(emitted![0][0]).toEqual(['openai'])
  })

  it('T12b: 全部取消勾选后 confirm 按钮 disabled，点不触发 emit', async () => {
    wrapper = mount(ProviderImportPreviewDialog, {
      props: { open: true, importId: 'imp-1', preview: FIXTURE },
    })
    await flushPromises()

    // 取消勾选所有默认勾选项（openai + azure）
    const checkboxes = document.body.querySelectorAll('[data-testid="preview-provider-item"] button[role="checkbox"]')
    ;(checkboxes[0] as HTMLElement).click() // openai off
    await flushPromises()
    const checkboxes2 = document.body.querySelectorAll('[data-testid="preview-provider-item"] button[role="checkbox"]')
    ;(checkboxes2[1] as HTMLElement).click() // azure off
    await flushPromises()

    const confirmBtn = document.body.querySelector('[data-testid="confirm-import-btn"]') as HTMLElement
    expect(confirmBtn.getAttribute('disabled')).toBeDefined()
    // 即使点了也不应 emit
    confirmBtn.click()
    await flushPromises()
    expect(wrapper!.emitted('confirm')).toBeFalsy()
  })

  it('T12c: warnings 默认折叠（无 <ul>），点 warnings-toggle 后展开渲染 <ul>', async () => {
    wrapper = mount(ProviderImportPreviewDialog, {
      props: { open: true, importId: 'imp-1', preview: FIXTURE },
    })
    await flushPromises()

    // azure 项含 1 条 warning（FIXTURE 中唯一带 warnings 的项）
    const toggle = document.body.querySelector('[data-testid="warnings-toggle"]') as HTMLElement | null
    expect(toggle).toBeTruthy()
    // 初始折叠：无 warnings <ul>
    const providerItems = document.body.querySelectorAll('[data-testid="preview-provider-item"]')
    const azureItem = providerItems[1]
    expect(azureItem.querySelector('ul')).toBeNull()

    // 点击 toggle 展开
    toggle!.click()
    await flushPromises()

    // 展开后：<ul> 渲染，含 1 个 warning <li>
    const azureItemAfter = document.body.querySelectorAll('[data-testid="preview-provider-item"]')[1]
    const ul = azureItemAfter.querySelector('ul')
    expect(ul).toBeTruthy()
    expect(ul!.querySelectorAll('li')).toHaveLength(1)
    expect(ul!.textContent).toContain('env_key 未设置')
  })

  it('T12d: error 态——props 传 error → [data-testid="preview-error"] 渲染含消息', async () => {
    wrapper = mount(ProviderImportPreviewDialog, {
      props: { open: true, importId: 'imp-1', preview: FIXTURE, error: 'preview 已过期，请重新检测' },
    })
    await flushPromises()

    const errorEl = document.body.querySelector('[data-testid="preview-error"]')
    expect(errorEl).toBeTruthy()
    expect(errorEl!.textContent).toContain('preview 已过期')
  })
})
