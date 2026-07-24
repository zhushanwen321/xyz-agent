/**
 * useBrowserFocusSync 单测（Browser Drawer Wave 4）。
 *
 * 覆盖：
 * - focusedSessionId 变化时调 browserFocus(newSid)
 * - immediate: true 首次挂载时（已有 session）触发一次
 * - null sid（无 session）时不调 browserFocus
 *
 * mock 策略：vi.mock('@/lib/ipc') 捕获 browserFocus；vi.mock('@/stores/panel') 提供可控的
 * focusedSessionId computed。usePanelStore 返回的 panels/activePanelId 可直接 mutate 模拟切 session。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useBrowserFocusSync.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock lib/ipc：捕获 browserFocus ──
const mockBrowserFocus = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/ipc', () => ({
  browserFocus: (sid: string) => mockBrowserFocus(sid),
}))

// ── mock panel store：模拟 Pinia store 的 ref 自动 unwrap 行为 ──
// composable 内部读 panel.panels（数组）+ panel.activePanelId（string|null），
// 算 focusedSessionId = panels.find(p => p.id === activePanelId)?.sessionId。
// Pinia store 把 state ref 挂在 store 实例上时自动 unwrap，composable 读 panel.xxx 得到的是值不是 ref。
// mock 用 getter 模拟 unwrap：每次访问 panel.panels 返回 ref.value（响应式依赖追踪正常）。
const panelsRef = ref<Array<{ id: string; sessionId: string }>>([])
const activePanelIdRef = ref<string | null>(null)

vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({
    get panels() {
      return panelsRef.value
    },
    get activePanelId() {
      return activePanelIdRef.value
    },
  }),
}))

import { useBrowserFocusSync } from '@/composables/features/useBrowserFocusSync'

import { afterEach } from 'vitest'

/** 当前测试的 effectScope（beforeEach 时 stop 上一轮的，防 watch 泄漏到下一个测试） */
let currentScope: ReturnType<typeof effectScope> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  // stop 上一轮 scope，确保上一个测试的 watch 不响应本轮 ref 重置（否则 mock 被多调）
  currentScope?.stop()
  currentScope = null
  vi.clearAllMocks()
  panelsRef.value = []
  activePanelIdRef.value = null
})

afterEach(() => {
  currentScope?.stop()
  currentScope = null
})

/**
 * 在 effectScope 内调 composable。composable 内部用 watch，跟随 active scope 生命周期。
 * scope 在 beforeEach/afterEach 自动 stop，测试内无需手动清理。
 */
function setupFocusSync(): void {
  const scope = effectScope()
  scope.run(() => {
    useBrowserFocusSync()
  })
  currentScope = scope
}

describe('useBrowserFocusSync（Wave 4）', () => {
  it('immediate: 首次挂载时已有 session → 立即调 browserFocus(sid)', async () => {
    panelsRef.value = [{ id: 'panel-1', sessionId: 'sess-A' }]
    activePanelIdRef.value = 'panel-1'

    setupFocusSync()
    // watch immediate 回调是同步的，但 browserFocus 返回 Promise（void），flush 后断言
    await Promise.resolve()

    expect(mockBrowserFocus).toHaveBeenCalledWith('sess-A')
  })

  it('focusedSessionId 变化 → 调 browserFocus(newSid)', async () => {
    panelsRef.value = [
      { id: 'panel-1', sessionId: 'sess-A' },
      { id: 'panel-2', sessionId: 'sess-B' },
    ]
    activePanelIdRef.value = 'panel-1'

    setupFocusSync()
    await Promise.resolve()
    expect(mockBrowserFocus).toHaveBeenCalledTimes(1)

    // 切到 panel-2（sess-B）
    activePanelIdRef.value = 'panel-2'
    await Promise.resolve()

    expect(mockBrowserFocus).toHaveBeenCalledWith('sess-B')
    expect(mockBrowserFocus).toHaveBeenCalledTimes(2)
  })

  it('focusedSessionId 变 null（无 session）→ 不调 browserFocus', async () => {
    panelsRef.value = [{ id: 'panel-1', sessionId: 'sess-A' }]
    activePanelIdRef.value = 'panel-1'

    setupFocusSync()
    await Promise.resolve()
    expect(mockBrowserFocus).toHaveBeenCalledTimes(1)

    // 切到不存在的 panel（focusedSessionId 变 null）
    activePanelIdRef.value = 'panel-nonexistent'
    await Promise.resolve()

    // null sid 时 watch 回调跳过，不调 browserFocus
    expect(mockBrowserFocus).toHaveBeenCalledTimes(1)
  })

  it('首次挂载时无 session（focusedSessionId=null）→ 不调 browserFocus', async () => {
    setupFocusSync()
    await Promise.resolve()

    expect(mockBrowserFocus).not.toHaveBeenCalled()
  })
})
