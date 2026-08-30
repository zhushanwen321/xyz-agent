/**
 * useAppUpdate · 手动通道衔接测试（update-network-resilience renderer 侧 D2/D9）。
 *
 * 覆盖：
 *  - D9 suggestion 追加：四类网络/代理错误码（UPDATE_PROXY_UNREACHABLE /
 *    UPDATE_PROXY_ERROR / UPDATE_NETWORK_FAILED / UPDATE_NETWORK_TIMEOUT）→
 *    errorSuggestion 末尾追加手动下载指引；非网络类错误码 / 无错误码不追加
 *  - D2 交错缓解：performInstall 返回实装 version ≠ latestRelease.version →
 *    版本显示对齐（其他字段保留）；version 相同/缺失 → 不动 latestRelease
 *
 * Mock 策略（同 useAppUpdate.w3-acceptance.test.ts 结构）：
 *  - vi.mock('@/lib/ipc') 桩 update 方法，onUpdateError 捕获 cb 供手动触发
 *  - vi.mock('@/i18n') t 返回 key（追加文案断言 key 本身即可，文案正确性由
 *    update-manual-channel.test.ts 的真实 zh-CN 文案断言守卫）
 *  - effectScope 包 useAppUpdate（onScopeDispose 依赖活跃 scope）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.manual-channel.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { LatestReleaseInfo, UpdateInstallResult } from '@xyz-agent/shared'

// vi.mock 被 hoist，factory 内不能引用顶层变量，用 vi.hoisted 拿稳定引用
const hoisted = vi.hoisted(() => {
  let errorCb: ((e: { stage: string; message: string; errorCode?: string; suggestion?: string }) => void) | null = null
  return {
    updateInstall: vi.fn<() => Promise<UpdateInstallResult>>(),
    onUpdateProgress: vi.fn(() => () => {}),
    onUpdateError: vi.fn((cb: typeof errorCb) => {
      errorCb = cb
      return () => {
        errorCb = null
      }
    }),
    fireError: (e: { stage: string; message: string; errorCode?: string; suggestion?: string }) => {
      if (errorCb) errorCb(e)
    },
  }
})

vi.mock('@/lib/ipc', () => ({
  checkForUpdate: vi.fn(() => Promise.resolve({ info: null, rateLimited: false })),
  updateDownload: vi.fn(() => Promise.resolve({ downloaded: false })),
  updateInstall: hoisted.updateInstall,
  getPreloaded: vi.fn(() => Promise.resolve(null)),
  getPendingUpdate: vi.fn(() => Promise.resolve(null)),
  getLaunchResult: vi.fn(() => Promise.resolve(null)),
  getUpdateSettings: vi.fn(() => Promise.resolve({ preDownload: false, autoUpdate: false })),
  openUpdateFallbackUrl: vi.fn(() => Promise.resolve()),
  onUpdateProgress: hoisted.onUpdateProgress,
  onUpdateError: hoisted.onUpdateError,
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdown: vi.fn(() => Promise.resolve('<p>test</p>')),
}))

// mock t 返回 key：追加段断言 key 本身（真实文案断言在 update-manual-channel.test.ts）
vi.mock('@/i18n', () => ({
  getLocale: vi.fn(() => 'zh-CN'),
  default: { global: { t: (key: string) => key } },
}))

/** 构造带完整字段的 release（断言「其他字段保留」用） */
function makeRelease(version: string): LatestReleaseInfo {
  return {
    version,
    tagName: `v${version}`,
    releaseNotes: `notes for ${version}`,
    publishedAt: '2026-08-30T00:00:00Z',
    htmlUrl: `https://github.com/zhushanwen321/xyz-agent/releases/tag/v${version}`,
    assets: {},
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  const { _resetForTest } = await import('@/composables/features/settings/useAppUpdate')
  _resetForTest()
})

describe('D9 suggestion 追加手动下载指引', () => {
  it.each([
    'UPDATE_PROXY_UNREACHABLE',
    'UPDATE_PROXY_ERROR',
    'UPDATE_NETWORK_FAILED',
    'UPDATE_NETWORK_TIMEOUT',
  ])(
    '%s → errorSuggestion 末尾追加手动下载指引',
    async (code) => {
      const scope = effectScope()
      await scope.run(async () => {
        const { useAppUpdate } = await import('@/composables/features/settings/useAppUpdate')
        const { state } = useAppUpdate()
        hoisted.fireError({
          stage: 'downloading',
          message: '下载失败',
          errorCode: code,
          suggestion: '基础恢复指引',
        })
        expect(state.state).toBe('error')
        expect(state.errorSuggestion).toBe('基础恢复指引\nsidebar.update.manualDownloadHint')
      })
      scope.stop()
    },
  )

  it('网络类错误无 suggestion → errorSuggestion 仅含手动下载指引（无前导换行）', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const { useAppUpdate } = await import('@/composables/features/settings/useAppUpdate')
      const { state } = useAppUpdate()
      hoisted.fireError({ stage: 'downloading', message: '下载失败', errorCode: 'UPDATE_NETWORK_TIMEOUT' })
      expect(state.errorSuggestion).toBe('sidebar.update.manualDownloadHint')
    })
    scope.stop()
  })

  it('非网络类错误码（UPDATE_INTEGRITY_FAILED）→ 不追加', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const { useAppUpdate } = await import('@/composables/features/settings/useAppUpdate')
      const { state } = useAppUpdate()
      hoisted.fireError({
        stage: 'downloading',
        message: '校验失败',
        errorCode: 'UPDATE_INTEGRITY_FAILED',
        suggestion: '重新下载更新',
      })
      expect(state.errorSuggestion).toBe('重新下载更新')
    })
    scope.stop()
  })

  it('无 errorCode → 不追加', async () => {
    const scope = effectScope()
    await scope.run(async () => {
      const { useAppUpdate } = await import('@/composables/features/settings/useAppUpdate')
      const { state } = useAppUpdate()
      hoisted.fireError({ stage: 'downloading', message: '未知错误', suggestion: '基础指引' })
      expect(state.errorSuggestion).toBe('基础指引')
    })
    scope.stop()
  })
})

describe('D2 performInstall 实装版本对齐', () => {
  it('install 返回 version ≠ latestRelease.version → 版本显示对齐且其他字段保留', async () => {
    hoisted.updateInstall.mockResolvedValue({ triggerRestart: true, version: '0.9.12' })
    const scope = effectScope()
    await scope.run(async () => {
      const { useAppUpdate } = await import('@/composables/features/settings/useAppUpdate')
      const { state, performInstall } = useAppUpdate()
      state.latestRelease = makeRelease('0.9.11')
      await performInstall()
      // 实装 0.9.12 覆写显示（认领 0.9.11 → 后台预下载 0.9.12 交错场景）
      expect(state.state).toBe('restarting')
      expect(state.latestRelease?.version).toBe('0.9.12')
      // 其他字段保留（旧 release 的 notes/url，app 即将重启，生命周期以秒计）
      expect(state.latestRelease?.htmlUrl).toContain('v0.9.11')
      expect(state.latestRelease?.releaseNotes).toBe('notes for 0.9.11')
    })
    scope.stop()
  })

  it('install 返回 version 与显示一致 → 不触发对齐（版本保持不变）', async () => {
    hoisted.updateInstall.mockResolvedValue({ triggerRestart: true, version: '0.9.11' })
    const scope = effectScope()
    await scope.run(async () => {
      const { useAppUpdate } = await import('@/composables/features/settings/useAppUpdate')
      const { state, performInstall } = useAppUpdate()
      state.latestRelease = makeRelease('0.9.11')
      await performInstall()
      // reactive 读回是 proxy，引用断言不可用；版本未变即证明对齐分支未执行
      expect(state.latestRelease?.version).toBe('0.9.11')
      expect(state.latestRelease?.htmlUrl).toContain('v0.9.11')
    })
    scope.stop()
  })

  it('install 返回无 version（读取失败容错）→ latestRelease 不动', async () => {
    hoisted.updateInstall.mockResolvedValue({ triggerRestart: true })
    const scope = effectScope()
    await scope.run(async () => {
      const { useAppUpdate } = await import('@/composables/features/settings/useAppUpdate')
      const { state, performInstall } = useAppUpdate()
      state.latestRelease = makeRelease('0.9.11')
      await performInstall()
      expect(state.state).toBe('restarting')
      expect(state.latestRelease?.version).toBe('0.9.11')
      expect(state.latestRelease?.htmlUrl).toContain('v0.9.11')
    })
    scope.stop()
  })
})
