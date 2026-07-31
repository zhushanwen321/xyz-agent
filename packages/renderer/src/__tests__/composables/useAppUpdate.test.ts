/**
 * useAppUpdate 单测（自动升级单例 composable · w4 update-frontend）。
 *
 * 覆盖 W4TC1-5：
 * - W4TC1 checkForUpdate 有新版 → state='available' + latestRelease 填充
 * - W4TC2 checkForUpdate 无新版 → state='idle'
 * - W4TC3 performUpdate stage 转换（模拟 onUpdateProgress 回调：downloading→verifying→replacing）
 * - W4TC4 onUpdateError → state='error' + errorMessage
 * - W4TC5 onUpdateError errorCode='UPDATE_UNSUPPORTED_PLATFORM' → state='unsupported'
 *
 * Mock 策略：
 * - vi.mock('@/lib/ipc') 桩 5 个 update 方法；onUpdateProgress/onUpdateError 捕获 cb 供测试手动触发
 * - vi.mock('@/composables/logic/markdown') 桩 renderMarkdown 避免加载 shiki WASM
 * - effectScope 包 useAppUpdate（onScopeDispose 依赖活跃 scope）
 * - _resetForTest 在 beforeEach 重置 module-level 单例 state
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
// vi.waitFor 在 vitest ^4.1.6 可用（见 packages/renderer/package.json），替代固定双 Promise.resolve flush
import { effectScope } from 'vue'
import type { LatestReleaseInfo } from '@xyz-agent/shared'

// vi.mock 被 hoist，factory 内不能引用顶层变量，用 vi.hoisted 拿稳定引用
const hoisted = vi.hoisted(() => {
  // 捕获 onUpdateProgress/onUpdateError 注册的回调，供测试手动触发（模拟 main 推送）
  let progressCb: ((p: { stage: 'downloading' | 'verifying' | 'replacing'; percent: number }) => void) | null = null
  let errorCb: ((e: { stage: string; message: string; errorCode?: string }) => void) | null = null
  return {
    checkForUpdate: vi.fn<(opts?: { force?: boolean }) => Promise<LatestReleaseInfo | null>>(),
    performUpdate: vi.fn<(release: LatestReleaseInfo) => Promise<{ triggerRestart: boolean }>>(),
    openUpdateFallbackUrl: vi.fn<(url: string) => Promise<void>>(),
    onUpdateProgress: vi.fn((cb: typeof progressCb) => {
      progressCb = cb
      return () => {
        progressCb = null
      }
    }),
    onUpdateError: vi.fn((cb: typeof errorCb) => {
      errorCb = cb
      return () => {
        errorCb = null
      }
    }),
    // 暴露给测试：手动触发 main 进程的进度/错误推送
    fireProgress: (p: { stage: 'downloading' | 'verifying' | 'replacing'; percent: number }) => {
      if (progressCb) progressCb(p)
    },
    fireError: (e: { stage: string; message: string; errorCode?: string }) => {
      if (errorCb) errorCb(e)
    },
    renderMarkdown: vi.fn<(md: string) => Promise<string>>(),
  }
})

vi.mock('@/lib/ipc', () => ({
  checkForUpdate: hoisted.checkForUpdate,
  performUpdate: hoisted.performUpdate,
  openUpdateFallbackUrl: hoisted.openUpdateFallbackUrl,
  onUpdateProgress: hoisted.onUpdateProgress,
  onUpdateError: hoisted.onUpdateError,
}))

vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdown: hoisted.renderMarkdown,
}))

import { useAppUpdate, _resetForTest } from '@/composables/features/useAppUpdate'

/** 构造测试用 LatestReleaseInfo */
function makeRelease(version = '0.9.0'): LatestReleaseInfo {
  return {
    version,
    tagName: `v${version}`,
    releaseNotes: '## 新特性\n- 支持 foo',
    publishedAt: '2026-07-01T00:00:00Z',
    htmlUrl: 'https://github.com/example/repo/releases/v' + version,
    assets: {},
  }
}

beforeEach(() => {
  _resetForTest()
  hoisted.checkForUpdate.mockReset()
  hoisted.performUpdate.mockReset()
  hoisted.openUpdateFallbackUrl.mockReset()
  hoisted.onUpdateProgress.mockClear()
  hoisted.onUpdateError.mockClear()
  hoisted.renderMarkdown.mockReset()
  hoisted.renderMarkdown.mockResolvedValue('<h2>新特性</h2>')
})

describe('useAppUpdate', () => {
  it('W4TC1：checkForUpdate 有新版 → state="available" + latestRelease 填充', async () => {
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.9.0'))
    const scope = effectScope()
    let result: ReturnType<typeof useAppUpdate> | undefined
    scope.run(() => {
      result = useAppUpdate()
    })
    await result!.checkForUpdate()
    // renderMarkdown 异步，用 waitFor 等 releaseNotesHtml 填充（比固定两次 Promise.resolve flush 稳健，
    // 不依赖具体微任务调度次数）
    await vi.waitFor(() => {
      expect(result!.state.releaseNotesHtml).toBe('<h2>新特性</h2>')
    })

    expect(result!.state.state).toBe('available')
    expect(result!.state.latestRelease?.version).toBe('0.9.0')
    expect(result!.state.releaseNotesHtml).toBe('<h2>新特性</h2>')
    expect(hoisted.renderMarkdown).toHaveBeenCalledWith('## 新特性\n- 支持 foo')
    scope.stop()
  })

  it('W4TC2：checkForUpdate 无新版 → state="idle"', async () => {
    hoisted.checkForUpdate.mockResolvedValue(null)
    const scope = effectScope()
    let result: ReturnType<typeof useAppUpdate> | undefined
    scope.run(() => {
      result = useAppUpdate()
    })
    await result!.checkForUpdate()
    expect(result!.state.state).toBe('idle')
    expect(result!.state.latestRelease).toBeNull()
    scope.stop()
  })

  it('W4TC3：performUpdate 经 onUpdateProgress 推送做 stage 转换（downloading→verifying→replacing），resolve 后复位 idle', async () => {
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.9.0'))
    // performUpdate 返回未触发重启（模拟流程在 replacing 后无 error 推送、无后续收口）
    hoisted.performUpdate.mockImplementation(async () => {
      // 触发主进程推送：downloading 30% → verifying 70% → replacing 100%
      hoisted.fireProgress({ stage: 'downloading', percent: 30 })
      hoisted.fireProgress({ stage: 'verifying', percent: 70 })
      hoisted.fireProgress({ stage: 'replacing', percent: 100 })
      return { triggerRestart: false }
    })
    const scope = effectScope()
    let result: ReturnType<typeof useAppUpdate> | undefined
    scope.run(() => {
      result = useAppUpdate()
    })
    await result!.checkForUpdate()
    await result!.performUpdate()

    // 推送过程中 percent 累积到 100；performUpdate resolve 后无 triggerRestart、无 error → 复位 idle（修复卡死）
    expect(result!.state.percent).toBe(100)
    expect(result!.state.state).toBe('idle')
    expect(hoisted.performUpdate).toHaveBeenCalled()
    scope.stop()
  })

  it('W4TC3b（Major 1 回归）：performUpdate 在 progress 推到 verifying 后 resolve {triggerRestart:false}，state 复位 idle 不卡在 verifying', async () => {
    const release = makeRelease('0.9.0')
    hoisted.checkForUpdate.mockResolvedValue(release)
    // 模拟：main 只推了一次 verifying 进度，performUpdate 随即 resolve，既无 error 推送也无 triggerRestart
    hoisted.performUpdate.mockImplementation(async () => {
      hoisted.fireProgress({ stage: 'verifying', percent: 50 })
      return { triggerRestart: false }
    })
    const scope = effectScope()
    let result: ReturnType<typeof useAppUpdate> | undefined
    scope.run(() => {
      result = useAppUpdate()
    })
    await result!.checkForUpdate()
    await result!.performUpdate()

    // 修复前：state 永久卡在 'verifying'；修复后：复位到 'idle'（用户可重试），不卡死
    expect(result!.state.state).toBe('idle')
    expect(result!.state.percent).toBe(50)
    scope.stop()
  })

  it('W4TC4：onUpdateError 推送 → state="error" + errorMessage（SSOT）', async () => {
    const release = makeRelease('0.9.0')
    hoisted.checkForUpdate.mockResolvedValue(release)
    hoisted.performUpdate.mockImplementation(async () => {
      // 触发主进程错误推送（SSOT 优先于 performUpdate catch）
      hoisted.fireError({ stage: 'downloading', message: '校验失败：sha256 不匹配' })
      return { triggerRestart: false }
    })
    const scope = effectScope()
    let result: ReturnType<typeof useAppUpdate> | undefined
    scope.run(() => {
      result = useAppUpdate()
    })
    await result!.checkForUpdate()
    await result!.performUpdate()

    expect(result!.state.state).toBe('error')
    expect(result!.state.errorMessage).toBe('校验失败：sha256 不匹配')
    scope.stop()
  })

  it('W4TC5：onUpdateError errorCode="UPDATE_UNSUPPORTED_PLATFORM" → state="unsupported"', async () => {
    const release = makeRelease('0.9.0')
    hoisted.checkForUpdate.mockResolvedValue(release)
    hoisted.performUpdate.mockImplementation(async () => {
      hoisted.fireError({
        stage: 'init',
        message: '当前平台不支持自动升级',
        errorCode: 'UPDATE_UNSUPPORTED_PLATFORM',
      })
      return { triggerRestart: false }
    })
    const scope = effectScope()
    let result: ReturnType<typeof useAppUpdate> | undefined
    scope.run(() => {
      result = useAppUpdate()
    })
    await result!.checkForUpdate()
    await result!.performUpdate()

    expect(result!.state.state).toBe('unsupported')
    scope.stop()
  })

  it('performUpdate triggerRestart=true → state="restarting"', async () => {
    const release = makeRelease('0.9.0')
    hoisted.checkForUpdate.mockResolvedValue(release)
    hoisted.performUpdate.mockResolvedValue({ triggerRestart: true })
    const scope = effectScope()
    let result: ReturnType<typeof useAppUpdate> | undefined
    scope.run(() => {
      result = useAppUpdate()
    })
    await result!.checkForUpdate()
    await result!.performUpdate()

    expect(result!.state.state).toBe('restarting')
    scope.stop()
  })

  it('openFallbackUrl 调 ipc.openUpdateFallbackUrl(latestRelease.htmlUrl)', async () => {
    const release = makeRelease('0.9.0')
    hoisted.checkForUpdate.mockResolvedValue(release)
    hoisted.openUpdateFallbackUrl.mockResolvedValue(undefined)
    const scope = effectScope()
    let result: ReturnType<typeof useAppUpdate> | undefined
    scope.run(() => {
      result = useAppUpdate()
    })
    await result!.checkForUpdate()
    await result!.openFallbackUrl()

    expect(hoisted.openUpdateFallbackUrl).toHaveBeenCalledWith(release.htmlUrl)
    scope.stop()
  })

  it('performUpdate catch 在 !errorHandled 时兜底置 error（去重：onUpdateError 未触发）', async () => {
    const release = makeRelease('0.9.0')
    hoisted.checkForUpdate.mockResolvedValue(release)
    // performUpdate reject 且未触发 onUpdateError → 走兜底 error
    hoisted.performUpdate.mockRejectedValue(new Error('网络中断'))
    const scope = effectScope()
    let result: ReturnType<typeof useAppUpdate> | undefined
    scope.run(() => {
      result = useAppUpdate()
    })
    await result!.checkForUpdate()
    await result!.performUpdate()

    expect(result!.state.state).toBe('error')
    expect(result!.state.errorMessage).toBe('网络中断')
    scope.stop()
  })

  // [HISTORICAL] 回归：传给 ipc 的 release 必须是 plain object，不能是 Vue reactive proxy。
  // 事故：state.latestRelease 存入 reactive(state) 后被 Vue 深度代理化（含嵌套 assets），
  // performUpdate 把 proxy 传给 ipcRenderer.invoke → Electron structured clone 抛
  // "an object could not be cloned" → invoke reject 被 catch 吞成 errorMessage，
  // 用户在 UpdateButton hover 看到英文 clone 报错。现有用例 mock @/lib/ipc 接收的是
  // makeRelease() 返回的普通对象，测不到此问题；本用例在 reactive 上下文（effectScope +
  // useAppUpdate 内部 reactive state）下验证传给 ipc 的对象可被 structuredClone。
  it('performUpdate 传给 ipc 的是 plain object（非 reactive proxy），可过 structured clone', async () => {
    // makeRelease 带嵌套 asset，覆盖「嵌套层也必须 plain」（toRaw 浅解包会漏掉嵌套）
    const releaseWithAsset: LatestReleaseInfo = {
      ...makeRelease('0.9.0'),
      assets: {
        macArm64Zip: {
          name: 'xyz-agent-mac-arm64.zip',
          downloadUrl: 'https://github.com/zhushanwen321/xyz-agent/releases/download/v0.9.0/xyz-agent-mac-arm64.zip',
          size: 100,
          sha256: 'a'.repeat(64),
        },
      },
    }
    hoisted.checkForUpdate.mockResolvedValue(releaseWithAsset)
    // 捕获 performUpdate 实际收到的参数（mock 在 ipc 层，但 useAppUpdate.performUpdate
    // 内部读 state.latestRelease 后透传给 ipc.performUpdate，捕获点即 IPC 入参）
    const received: LatestReleaseInfo[] = []
    hoisted.performUpdate.mockImplementation(async (r) => {
      received.push(r)
      return { triggerRestart: true }
    })
    const scope = effectScope()
    let result: ReturnType<typeof useAppUpdate> | undefined
    scope.run(() => {
      result = useAppUpdate()
    })
    await result!.checkForUpdate()
    await result!.performUpdate()

    expect(received).toHaveLength(1)
    const passed = received[0]!
    // 关键断言 1：原型是 Object.prototype（plain object），不是 reactive proxy 的目标
    // （proxy 的 getPrototypeOf 透传 target，但 structuredClone 对 proxy 本身报错；
    // 配合断言 2 的 structuredClone 不抛错，双重确认）
    expect(Object.getPrototypeOf(passed)).toBe(Object.prototype)
    // 关键断言 2：可被 structuredClone（IPC 用的同款序列化算法），不抛 DataCloneError
    expect(() => structuredClone(passed)).not.toThrow()
    // 关键断言 3：嵌套层也是 plain（assets.macArm64Zip 不能是 reactive proxy）
    expect(Object.getPrototypeOf(passed.assets.macArm64Zip!)).toBe(Object.prototype)
    expect(() => structuredClone(passed.assets.macArm64Zip!)).not.toThrow()
    // 数据完整性：深拷贝后字段保留
    expect(passed.version).toBe('0.9.0')
    expect(passed.assets.macArm64Zip!.sha256).toBe('a'.repeat(64))
    scope.stop()
  })
})
