/**
 * useAppUpdate 单测（自动升级单例 composable · w4 update-frontend · w2 两阶段改造）。
 *
 * 覆盖：
 * - checkForUpdate 有/无新版 → available/idle
 * - performDownload 经 onUpdateProgress 做 stage 转换，downloaded:true → state='downloaded'
 * - performInstall 乐观置 replacing / triggerRestart 置 restarting / 失败置 error
 * - onUpdateError → error/unsupported（SSOT）
 * - restorePreloadedUpdate 有效产物 → downloaded / 无效 no-op
 * - 状态守卫 ES4（downloaded 同版本不覆盖）/ ES5（downloaded 追新版退回 available）
 * - performDownload catch 兜底 / 传给 ipc 的是 plain object（toRaw 解包）
 *
 * w2 改造：旧一键 performUpdate 拆为 performDownload（downloaded 态）+ performInstall（restarting 态）。
 * ipc 层新增 updateDownload/updateInstall/getPreloaded 三导出，本测试同步补 mock。
 *
 * Mock 策略：
 * - vi.mock('@/lib/ipc') 桩 8 个 update 方法；onUpdateProgress/onUpdateError 捕获 cb 供测试手动触发
 * - vi.mock('@/composables/logic/markdown') 桩 renderMarkdown 避免加载 shiki WASM
 * - effectScope 包 useAppUpdate（onScopeDispose 依赖活跃 scope）
 * - _resetForTest 在 beforeEach 重置 module-level 单例 state
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useAppUpdate.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { LatestReleaseInfo } from '@xyz-agent/shared'

// vi.mock 被 hoist，factory 内不能引用顶层变量，用 vi.hoisted 拿稳定引用
const hoisted = vi.hoisted(() => {
  // 捕获 onUpdateProgress/onUpdateError 注册的回调，供测试手动触发（模拟 main 推送）
  let progressCb: ((p: { stage: 'downloading' | 'verifying' | 'replacing'; percent: number }) => void) | null = null
  let errorCb: ((e: { stage: string; message: string; errorCode?: string }) => void) | null = null
  return {
    checkForUpdate: vi.fn<(opts?: { force?: boolean }) => Promise<LatestReleaseInfo | null>>(),
    updateDownload: vi.fn<(release: LatestReleaseInfo) => Promise<{ downloaded: boolean }>>(),
    updateInstall: vi.fn<() => Promise<{ triggerRestart: boolean }>>(),
    getPreloaded: vi.fn<() => Promise<{ release: LatestReleaseInfo; filePath: string } | null>>(),
    getPendingUpdate: vi.fn<() => Promise<LatestReleaseInfo | null>>(),
    getLaunchResult: vi.fn<() => Promise<{ status: string; version: string } | null>>(),
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
  updateDownload: hoisted.updateDownload,
  updateInstall: hoisted.updateInstall,
  getPreloaded: hoisted.getPreloaded,
  getPendingUpdate: hoisted.getPendingUpdate,
  getLaunchResult: hoisted.getLaunchResult,
  openUpdateFallbackUrl: hoisted.openUpdateFallbackUrl,
  onUpdateProgress: hoisted.onUpdateProgress,
  onUpdateError: hoisted.onUpdateError,
}))

vi.mock('@/composables/logic/markdown', () => ({
  renderMarkdown: hoisted.renderMarkdown,
}))

// W4: useToast mock（launch result toast 测试用）
const toastFns = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => toastFns,
}))

import { useAppUpdate, _resetForTest } from '@/composables/features/settings/useAppUpdate'

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

/** 在 effectScope 内运行 useAppUpdate，返回 result + scope.stop 清理函数（与 pending.test.ts 对齐）。
 *  options.initAutoCheck=true 时在 scope 内同步调 initAutoCheck（onScopeDispose 需绑定到活跃 scope）。 */
function setupUseAppUpdate(options?: { initAutoCheck?: boolean }): {
  result: ReturnType<typeof useAppUpdate>
  stop: () => void
} {
  const scope = effectScope()
  let result: ReturnType<typeof useAppUpdate> | undefined
  scope.run(() => {
    result = useAppUpdate()
    if (options?.initAutoCheck) {
      result.initAutoCheck()
    }
  })
  return { result: result!, stop: () => scope.stop() }
}

beforeEach(() => {
  _resetForTest()
  // __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之。
  // 默认 '0.0.0' 让版本守卫不拦截（< 任何 preloaded 版本），保持现有用例意图。
  vi.stubGlobal('__APP_VERSION__', '0.0.0')
  hoisted.checkForUpdate.mockReset()
  hoisted.updateDownload.mockReset()
  hoisted.updateInstall.mockReset()
  hoisted.getPreloaded.mockReset()
  hoisted.openUpdateFallbackUrl.mockReset()
  hoisted.onUpdateProgress.mockClear()
  hoisted.onUpdateError.mockClear()
  hoisted.renderMarkdown.mockReset()
  hoisted.renderMarkdown.mockResolvedValue('<h2>新特性</h2>')
  // 默认值：两阶段 mock 的合理默认（各用例按需覆盖）
  hoisted.updateDownload.mockResolvedValue({ downloaded: true })
  hoisted.updateInstall.mockResolvedValue({ triggerRestart: true })
  hoisted.getPreloaded.mockResolvedValue(null)
  hoisted.getPendingUpdate.mockReset()
  hoisted.getPendingUpdate.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useAppUpdate', () => {
  it('checkForUpdate 有新版 → state="available" + latestRelease 填充', async () => {
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.9.0'))
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    // renderMarkdown 异步，waitFor 等 html 填充
    await vi.waitFor(() => {
      expect(result.state.releaseNotesHtml).toBe('<h2>新特性</h2>')
    })

    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    expect(result.state.releaseNotesHtml).toBe('<h2>新特性</h2>')
    expect(hoisted.renderMarkdown).toHaveBeenCalledWith('## 新特性\n- 支持 foo')
    stop()
  })

  it('checkForUpdate 无新版 → state="idle"', async () => {
    hoisted.checkForUpdate.mockResolvedValue(null)
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    stop()
  })

  it('performDownload 经 onUpdateProgress 推送做 stage 转换（downloading→verifying→replacing），downloaded:true 后置 downloaded', async () => {
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.9.0'))
    hoisted.updateDownload.mockImplementation(async () => {
      // 触发主进程推送：downloading 30% → verifying 70% → replacing 100%
      hoisted.fireProgress({ stage: 'downloading', percent: 30 })
      hoisted.fireProgress({ stage: 'verifying', percent: 70 })
      hoisted.fireProgress({ stage: 'replacing', percent: 100 })
      return { downloaded: true }
    })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    // 推送过程中 percent 累积到 100；downloaded:true → state=downloaded（下载止于此，restart 是 install 阶段）
    expect(result.state.percent).toBe(100)
    expect(result.state.state).toBe('downloaded')
    expect(hoisted.updateDownload).toHaveBeenCalled()
    stop()
  })

  it('performDownload 在 progress 推到 verifying 后 resolve {downloaded:true}，state 置 downloaded 不卡在 verifying', async () => {
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.9.0'))
    // 模拟：main 只推了一次 verifying 进度，updateDownload 随即 resolve
    hoisted.updateDownload.mockImplementation(async () => {
      hoisted.fireProgress({ stage: 'verifying', percent: 50 })
      return { downloaded: true }
    })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    // downloaded:true 覆盖中间态 → state=downloaded（不卡在 verifying）
    expect(result.state.state).toBe('downloaded')
    expect(result.state.percent).toBe(50)
    stop()
  })

  it('performDownload downloaded=true → state="downloaded"（基础成功路径）', async () => {
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.9.0'))
    hoisted.updateDownload.mockResolvedValue({ downloaded: true })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    expect(result.state.state).toBe('downloaded')
    stop()
  })

  it('onUpdateError 推送 → state="error" + errorMessage（SSOT）', async () => {
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.9.0'))
    hoisted.updateDownload.mockImplementation(async () => {
      // 触发主进程错误推送（SSOT 优先于 performDownload catch）
      hoisted.fireError({ stage: 'downloading', message: '校验失败：sha256 不匹配' })
      return { downloaded: false }
    })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('校验失败：sha256 不匹配')
    stop()
  })

  it('onUpdateError errorCode="UPDATE_UNSUPPORTED_PLATFORM" → state="unsupported"', async () => {
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.9.0'))
    hoisted.updateDownload.mockImplementation(async () => {
      hoisted.fireError({
        stage: 'init',
        message: '当前平台不支持自动升级',
        errorCode: 'UPDATE_UNSUPPORTED_PLATFORM',
      })
      return { downloaded: false }
    })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    expect(result.state.state).toBe('unsupported')
    stop()
  })

  it('performDownload catch 在 !errorHandled 时兜底置 error（去重：onUpdateError 未触发）', async () => {
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.9.0'))
    // updateDownload reject 且未触发 onUpdateError → 走兜底 error
    hoisted.updateDownload.mockRejectedValue(new Error('网络中断'))
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('网络中断')
    stop()
  })

  // [HISTORICAL] 回归：传给 ipc 的 release 必须是 plain object，不能是 Vue reactive proxy。
  // 事故：state.latestRelease 存入 reactive(state) 后被 Vue 深度代理化（含嵌套 assets），
  // performDownload 把 proxy 传给 ipcRenderer.invoke → Electron structured clone 抛
  // "an object could not be cloned" → invoke reject 被 catch 吞成 errorMessage，
  // 用户在 UpdateButton hover 看到英文 clone 报错。现有用例 mock @/lib/ipc 接收的是
  // makeRelease() 返回的普通对象，测不到此问题；本用例在 reactive 上下文（effectScope +
  // useAppUpdate 内部 reactive state）下验证传给 ipc 的对象可被 structuredClone。
  it('performDownload 传给 ipc 的是 plain object（非 reactive proxy），可过 structured clone', async () => {
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
    // 捕获 updateDownload 实际收到的参数（useAppUpdate.performDownload 内部读
    // state.latestRelease 后 toRaw 解包透传给 ipc.updateDownload，捕获点即 IPC 入参）
    const received: LatestReleaseInfo[] = []
    hoisted.updateDownload.mockImplementation(async (r) => {
      received.push(r)
      return { downloaded: true }
    })
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.performDownload()

    expect(received).toHaveLength(1)
    const passed = received[0]!
    // 关键断言 1：原型是 Object.prototype（plain object），不是 reactive proxy 的目标
    expect(Object.getPrototypeOf(passed)).toBe(Object.prototype)
    // 关键断言 2：可被 structuredClone（IPC 用的同款序列化算法），不抛 DataCloneError
    expect(() => structuredClone(passed)).not.toThrow()
    // 关键断言 3：嵌套层也是 plain（assets.macArm64Zip 不能是 reactive proxy）
    expect(Object.getPrototypeOf(passed.assets.macArm64Zip!)).toBe(Object.prototype)
    expect(() => structuredClone(passed.assets.macArm64Zip!)).not.toThrow()
    // 数据完整性：深拷贝后字段保留
    expect(passed.version).toBe('0.9.0')
    expect(passed.assets.macArm64Zip!.sha256).toBe('a'.repeat(64))
    stop()
  })

  it('openFallbackUrl 调 ipc.openUpdateFallbackUrl(latestRelease.htmlUrl)', async () => {
    const release = makeRelease('0.9.0')
    hoisted.checkForUpdate.mockResolvedValue(release)
    hoisted.openUpdateFallbackUrl.mockResolvedValue(undefined)
    const { result, stop } = setupUseAppUpdate()
    await result.checkForUpdate()
    await result.openFallbackUrl()

    expect(hoisted.openUpdateFallbackUrl).toHaveBeenCalledWith(release.htmlUrl)
    stop()
  })

  // ── performInstall（安装/重启阶段）──
  it('performInstall 乐观置 replacing（IPC 往返延迟内 state 立即变 replacing，堵二次点击竞态）', async () => {
    // updateInstall 返回 pending promise，调 performInstall 后同步检查 state
    let resolveInstall!: (v: { triggerRestart: boolean }) => void
    hoisted.updateInstall.mockImplementation(
      () => new Promise<{ triggerRestart: boolean }>((r) => { resolveInstall = r }),
    )
    const { result, stop } = setupUseAppUpdate()
    const p = result.performInstall()
    // 同步断言：state 已乐观置 replacing（不等 IPC 往返）
    expect(result.state.state).toBe('replacing')
    resolveInstall({ triggerRestart: false })
    await p
    stop()
  })

  it('performInstall triggerRestart=true → state="restarting"', async () => {
    hoisted.updateInstall.mockResolvedValue({ triggerRestart: true })
    const { result, stop } = setupUseAppUpdate()
    await result.performInstall()
    expect(result.state.state).toBe('restarting')
    stop()
  })

  it('performInstall 失败 → state="error" + errorMessage（兜底）', async () => {
    hoisted.updateInstall.mockRejectedValue(new Error('替换文件失败'))
    const { result, stop } = setupUseAppUpdate()
    await result.performInstall()
    expect(result.state.state).toBe('error')
    expect(result.state.errorMessage).toBe('替换文件失败')
    stop()
  })

  // ── restorePreloadedUpdate（功能 2：预下载恢复）──
  it('restorePreloadedUpdate 有效预下载产物 → state="downloaded" + latestRelease 填充，返回 true', async () => {
    const release = makeRelease('0.9.0')
    hoisted.getPreloaded.mockResolvedValue({ release, filePath: '/tmp/preloaded.zip' })
    const { result, stop } = setupUseAppUpdate()
    const restored = await result.restorePreloadedUpdate()

    expect(restored).toBe(true)
    expect(result.state.state).toBe('downloaded')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    stop()
  })

  it('restorePreloadedUpdate 无预下载产物（null）→ no-op，state 不变，返回 false', async () => {
    hoisted.getPreloaded.mockResolvedValue(null)
    const { result, stop } = setupUseAppUpdate()
    const restored = await result.restorePreloadedUpdate()

    expect(restored).toBe(false)
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    stop()
  })

  // ── restorePreloadedUpdate 版本守卫（w2-frontend-guard：前端兜底拦截过期产物）──
  it('W2TC1：currentVersion < preloaded.version（0.8.48 < 0.8.49）→ 守卫放行，恢复 downloaded', async () => {
    vi.stubGlobal('__APP_VERSION__', '0.8.48')
    hoisted.getPreloaded.mockResolvedValue({ release: makeRelease('0.8.49'), filePath: '/tmp/x.zip' })
    const { result, stop } = setupUseAppUpdate()
    const restored = await result.restorePreloadedUpdate()

    expect(restored).toBe(true)
    expect(result.state.state).toBe('downloaded')
    expect(result.state.latestRelease?.version).toBe('0.8.49')
    stop()
  })

  it('W2TC2：currentVersion >= preloaded.version（0.8.49 >= 0.8.49）→ 守卫拦截，不恢复，回退 pending', async () => {
    vi.stubGlobal('__APP_VERSION__', '0.8.49')
    hoisted.getPreloaded.mockResolvedValue({ release: makeRelease('0.8.49'), filePath: '/tmp/x.zip' })
    const { result, stop } = setupUseAppUpdate()
    const restored = await result.restorePreloadedUpdate()

    expect(restored).toBe(false)
    expect(result.state.state).not.toBe('downloaded')
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    stop()
  })

  it('W2TC3：preloaded.version 非 semver → compare 抛错 catch 后继续恢复（对齐后端 keep 语义）', async () => {
    vi.stubGlobal('__APP_VERSION__', '0.8.49')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // makeRelease 填合法字段，仅覆盖 version 为非法 semver 触发 compare 抛错
    hoisted.getPreloaded.mockResolvedValue({
      release: { ...makeRelease('0.8.49'), version: 'not-a-version' },
      filePath: '/tmp/x.zip',
    })
    const { result, stop } = setupUseAppUpdate()
    const restored = await result.restorePreloadedUpdate()

    expect(warnSpy).toHaveBeenCalled()
    expect(restored).toBe(true)
    expect(result.state.state).toBe('downloaded')
    warnSpy.mockRestore()
    stop()
  })

  // ── 状态守卫 ES4/ES5（downloaded 态不被联网检测误覆盖）──
  it('状态守卫 ES4：downloaded 态检测到同版本 → 不被覆盖为 available（保持 downloaded）', async () => {
    // 通过 restorePreloadedUpdate 恢复 downloaded 态：同时设 pendingRestored=true，
    // 否则 checkForUpdate 进入时会置 checking 态破坏守卫前提（pendingRestored 守的是 checking 回退）
    const preloadedRelease = makeRelease('0.8.44')
    hoisted.getPreloaded.mockResolvedValue({ release: preloadedRelease, filePath: '/tmp/x.zip' })
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.8.44')) // 同版本
    const { result, stop } = setupUseAppUpdate()
    await result.restorePreloadedUpdate()
    expect(result.state.state).toBe('downloaded')

    await result.checkForUpdate()
    // ES4：downloaded + 同版本 → 不覆盖，保持 downloaded（仅刷新 latestRelease）
    expect(result.state.state).toBe('downloaded')
    expect(result.state.latestRelease?.version).toBe('0.8.44')
    stop()
  })

  it('状态守卫 ES5：downloaded 态检测到更新版本 → 退回 available（追新版）', async () => {
    const preloadedRelease = makeRelease('0.8.44')
    hoisted.getPreloaded.mockResolvedValue({ release: preloadedRelease, filePath: '/tmp/x.zip' })
    hoisted.checkForUpdate.mockResolvedValue(makeRelease('0.8.46')) // 更新版本
    const { result, stop } = setupUseAppUpdate()
    await result.restorePreloadedUpdate()
    expect(result.state.state).toBe('downloaded')

    await result.checkForUpdate()
    // ES5：downloaded + 更新版本 → 退回 available（追新版，旧 preloaded 由 main 侧下次 download 自动清）
    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.8.46')
    stop()
  })
})

describe('useAppUpdate initAutoCheck 定时器（递归 setTimeout + 守卫）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('30s 首次触发 checkForUpdate(force=true)', async () => {
    hoisted.checkForUpdate.mockResolvedValue(null)
    // initAutoCheck 必须在 scope 内调（onScopeDispose 需绑定活跃 scope），用 options 触发
    const { result, stop } = setupUseAppUpdate({ initAutoCheck: true })
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)
    expect(hoisted.checkForUpdate).toHaveBeenCalledWith({ force: true })
    stop()
  })

  it('首次完成后 20min 周期触发第二次 checkForUpdate', async () => {
    hoisted.checkForUpdate.mockResolvedValue(null)
    const { result, stop } = setupUseAppUpdate({ initAutoCheck: true })

    // 30s 首次触发
    await vi.advanceTimersByTimeAsync(30000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)

    // 20min（20 * 60 * 1000ms）周期触发第二次
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(2)
    expect(hoisted.checkForUpdate).toHaveBeenLastCalledWith({ force: true })
    stop()
  })

  it('守卫：state.state="downloaded" 时定时器触发跳过 checkForUpdate，但仍排下一次', async () => {
    hoisted.checkForUpdate.mockResolvedValue(null)
    const { result, stop } = setupUseAppUpdate({ initAutoCheck: true })
    // 置为升级流程态（downloaded），定时器触发时不应打断
    result.state.state = 'downloaded'

    await vi.advanceTimersByTimeAsync(30000)
    // 守卫跳过本次检查
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()

    // 恢复可检测态后，下一个周期应恢复检测（证明仍排了下一次定时器）
    result.state.state = 'idle'
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)
    stop()
  })

  it('守卫：state.state="replacing" 时定时器触发跳过 checkForUpdate', async () => {
    hoisted.checkForUpdate.mockResolvedValue(null)
    const { result, stop } = setupUseAppUpdate({ initAutoCheck: true })
    result.state.state = 'replacing'

    await vi.advanceTimersByTimeAsync(30000)
    expect(hoisted.checkForUpdate).not.toHaveBeenCalled()
    stop()
  })

  it('onScopeDispose 清理定时器：dispose 后周期不再触发 checkForUpdate', async () => {
    hoisted.checkForUpdate.mockResolvedValue(null)
    const { result, stop } = setupUseAppUpdate({ initAutoCheck: true })

    await vi.advanceTimersByTimeAsync(30000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1)

    stop() // 触发 onScopeDispose → clearAutoCheckTimer

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000)
    expect(hoisted.checkForUpdate).toHaveBeenCalledTimes(1) // 不再触发
  })
})

// ── W4: 启动结果 toast（launch result）──────────────────────────
describe('W4: launch result toast', () => {
  beforeEach(() => {
    _resetForTest()
    vi.clearAllMocks()
    hoisted.getLaunchResult.mockResolvedValue(null)
    vi.stubGlobal('__APP_VERSION__', '0.0.0')
  })

  afterEach(() => {
    _resetForTest()
  })

  it('A4-done-toast-vitest: done status → info toast 已升级到 vX.Y.Z', async () => {
    hoisted.getLaunchResult.mockResolvedValue({ status: 'done', version: '0.9.9' })
    hoisted.getPendingUpdate.mockResolvedValue(null)
    hoisted.getPreloaded.mockResolvedValue(null)
    const { stop } = setupUseAppUpdate({ initAutoCheck: true })
    // initAutoCheck 内 checkLaunchResult 是 fire-and-forget，等微任务完成
    await vi.waitFor(() => {
      expect(toastFns.info).toHaveBeenCalledWith(expect.stringContaining('0.9.9'))
    })
    expect(toastFns.info).toHaveBeenCalledWith(expect.stringContaining('已升级'))
    expect(toastFns.warning).not.toHaveBeenCalled()
    stop()
  })

  it('A6-rolledback-toast-vitest: rolled-back status → warning toast 已恢复到旧版本', async () => {
    hoisted.getLaunchResult.mockResolvedValue({ status: 'rolled-back', version: '0.9.7' })
    hoisted.getPendingUpdate.mockResolvedValue(null)
    hoisted.getPreloaded.mockResolvedValue(null)
    const { stop } = setupUseAppUpdate({ initAutoCheck: true })
    await vi.waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalled()
    })
    expect(toastFns.warning).toHaveBeenCalledWith(expect.stringContaining('0.9.7'))
    expect(toastFns.warning).toHaveBeenCalledWith(expect.stringContaining('已恢复'))
    stop()
  })

  it('A5-failed-toast-vitest: failed status → warning toast 上次升级未完成', async () => {
    hoisted.getLaunchResult.mockResolvedValue({ status: 'failed', version: '0.9.9' })
    hoisted.getPendingUpdate.mockResolvedValue(null)
    hoisted.getPreloaded.mockResolvedValue(null)
    const { stop } = setupUseAppUpdate({ initAutoCheck: true })
    await vi.waitFor(() => {
      expect(toastFns.warning).toHaveBeenCalledWith(expect.stringContaining('未完成'))
    })
    // failed 不含版本号
    expect(toastFns.warning).toHaveBeenCalledWith(expect.not.stringContaining('0.9.9'))
    stop()
  })

  it('A7-null-no-toast-vitest: null result → no toast + getLaunchResult 被调用', async () => {
    hoisted.getLaunchResult.mockResolvedValue(null)
    hoisted.getPendingUpdate.mockResolvedValue(null)
    hoisted.getPreloaded.mockResolvedValue(null)
    const { stop } = setupUseAppUpdate({ initAutoCheck: true })
    // 给微任务时间完成
    await new Promise((r) => setTimeout(r, 50))
    // A7: getLaunchResult 必须被调用（新实现的 checkLaunchResult 会调它）
    expect(hoisted.getLaunchResult).toHaveBeenCalled()
    // null 结果不弹 toast
    expect(toastFns.info).not.toHaveBeenCalled()
    expect(toastFns.warning).not.toHaveBeenCalled()
    stop()
  })
})
