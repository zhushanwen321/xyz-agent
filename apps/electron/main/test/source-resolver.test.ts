/**
 * u-source-resolver 单测：auto 模式源顺序决策表（update-multi-source D4）。
 *
 * 覆盖验收条款（docs/design/update-multi-source.impl-plan.md §2 u-source-resolver 行）：
 *   ① 三偏好映射（github / atomgit / auto）
 *   ② 代理短路：auto + 代理 URL → [github, atomgit]，断言未发起探测请求
 *   ③ 双探测可达排序：仅 github 可达 / 仅 gitcode 可达 / 均可达 tie-break github /
 *      均不可达回退 [github, atomgit]
 *   ④ 双引擎等价判定：undici resolve 与 curl 非 2xx CurlFetchError（携带
 *      httpStatusCode）均判可达；无 httpStatusCode 的连接错误判不可达
 *   ⑤ disableFlagPersistence 传参断言（D5：探测不参与引擎偏好置位）
 *   ⑥ TTL 命中不重复探测（fake timers + 调用计数）
 *
 * Mock 策略（对齐既有测试风格）：
 *   - upgrade-fetch：vi.mock + importOriginal（保留真实 CurlFetchError /
 *     isCurlHttpStatusError，仅替换 upgradeFetch）——禁止真实网络请求
 *   - proxy-config：vi.spyOn（对齐 release-checker-proxy.test.ts 先例）
 *   - timer：vi.useFakeTimers（TTL 缓存过期推进）
 *
 * 运行：cd apps/electron/main && npx vitest run test/source-resolver.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as proxyConfig from '../update/proxy-config.js'

vi.mock('../update/upgrade-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../update/upgrade-fetch.js')>()
  // 仅替换 upgradeFetch 入口；CurlFetchError / isCurlHttpStatusError 保持真实实现
  return { ...actual, upgradeFetch: vi.fn() }
})

import {
  resolveSourceOrder,
  resetSourceOrderCacheForTest,
  type SourceOrder,
} from '../update/source-resolver.js'
import { upgradeFetch, CurlFetchError } from '../update/upgrade-fetch.js'
import type { UpgradeFetchResult } from '../update/upgrade-fetch.js'

const upgradeFetchMock = vi.mocked(upgradeFetch)

/** 与 source-resolver.ts 内常量锁定的规格值（实现漂移时本测试红） */
const GITHUB_PROBE_URL = 'https://github.com'
const GITCODE_PROBE_URL = 'https://gitcode.com'
const EXPECTED_PROBE_TIMEOUT_MS = 3_000

/** 探测成功返回形态（undici 引擎任何 resolve 即可达，不看 ok/status） */
function okProbe(status = 206): UpgradeFetchResult {
  return { ok: true, status, headers: {}, bodyText: '', usedEngine: 'undici' }
}

/** curl 引擎 exit 22（-f）形态：携带 httpStatusCode = 服务器已响应 → 可达 */
function curlHttpStatusError(status: number): CurlFetchError {
  return new CurlFetchError({
    kind: 'http-error',
    exitCode: 22,
    stderr: `curl: (22) The requested URL returned error: ${status}`,
    httpStatusCode: status,
  })
}

/** curl 引擎 exit 7 形态：连接错误，无 httpStatusCode → 不可达 */
function curlConnectError(): CurlFetchError {
  return new CurlFetchError({
    kind: 'connection-failed',
    exitCode: 7,
    stderr: 'curl: (7) Failed to connect to github.com',
  })
}

type ProbeBehavior = UpgradeFetchResult | Error

/**
 * 按探测域名分流设置 upgradeFetch 行为；未指定域默认成功。
 * Error → reject（超时/连接错误/curl 非 2xx 形态），其余 → resolve。
 */
function setProbeBehavior(behavior: { github?: ProbeBehavior; gitcode?: ProbeBehavior }): void {
  const settle = (b: ProbeBehavior): Promise<UpgradeFetchResult> =>
    b instanceof Error ? Promise.reject(b) : Promise.resolve(b)
  upgradeFetchMock.mockImplementation(((url: string) => {
    if (url === GITHUB_PROBE_URL) {
      return settle(behavior.github ?? okProbe())
    }
    return settle(behavior.gitcode ?? okProbe())
  }) as typeof upgradeFetch)
}

describe('source-resolver: auto 模式源顺序决策表（D4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSourceOrderCacheForTest()
    // 默认无代理（mode=disabled → resolveProxyUrl undefined）；各用例按需覆写
    vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({ mode: 'disabled' })
    vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(undefined)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('显式偏好直接映射（零探测）', () => {
    it('github 偏好 → [github, atomgit]，不发起探测', async () => {
      const order: SourceOrder = await resolveSourceOrder('github')
      expect(order).toEqual(['github', 'atomgit'])
      expect(upgradeFetchMock).not.toHaveBeenCalled()
    })

    it('atomgit 偏好 → [atomgit, github]，不发起探测', async () => {
      const order = await resolveSourceOrder('atomgit')
      expect(order).toEqual(['atomgit', 'github'])
      expect(upgradeFetchMock).not.toHaveBeenCalled()
    })
  })

  describe('auto + 代理短路（跳过探测）', () => {
    it('解析出代理 URL → [github, atomgit]，未发起任何探测请求', async () => {
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue('http://192.168.1.202:7890')

      const order = await resolveSourceOrder('auto')

      expect(order).toEqual(['github', 'atomgit'])
      expect(upgradeFetchMock).not.toHaveBeenCalled()
    })

    it('manual 模式但代理 URL 为空（解析不出代理）→ 走探测路径', async () => {
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(undefined)
      setProbeBehavior({ github: okProbe(), gitcode: curlHttpStatusError(403) })

      const order = await resolveSourceOrder('auto')

      expect(order).toEqual(['github', 'atomgit'])
      expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('auto + 无代理：并行探测排序', () => {
    it('仅 github 可达 → [github, atomgit]', async () => {
      setProbeBehavior({ github: okProbe(), gitcode: new Error('timeout (aborted)') })

      const order = await resolveSourceOrder('auto')

      expect(order).toEqual(['github', 'atomgit'])
    })

    it('仅 gitcode 可达 → [atomgit, github]（目标 1：国内自动落 AtomGit）', async () => {
      setProbeBehavior({ github: new Error('timeout (aborted)'), gitcode: okProbe() })

      const order = await resolveSourceOrder('auto')

      expect(order).toEqual(['atomgit', 'github'])
    })

    it('均可达 → [github, atomgit]（tie-break github）', async () => {
      setProbeBehavior({ github: okProbe(), gitcode: okProbe() })

      const order = await resolveSourceOrder('auto')

      expect(order).toEqual(['github', 'atomgit'])
    })

    it('均不可达（超时/连接错误）→ 回退 [github, atomgit]（现状行为）', async () => {
      setProbeBehavior({
        github: new Error('timeout (aborted)'),
        gitcode: new Error('connect ECONNREFUSED'),
      })

      const order = await resolveSourceOrder('auto')

      expect(order).toEqual(['github', 'atomgit'])
    })
  })

  describe('双引擎等价判定（对齐 testProxyConnection 准绳）', () => {
    it('curl 引擎非 2xx CurlFetchError（携带 httpStatusCode）判可达：github 403 + gitcode 成功 → github 排前', async () => {
      setProbeBehavior({ github: curlHttpStatusError(403), gitcode: okProbe() })

      const order = await resolveSourceOrder('auto')

      // github 域以 curl http 形态「完成 HTTP 响应」→ 可达 → 恒排前（等价于 undici resolve）
      expect(order).toEqual(['github', 'atomgit'])
    })

    it('curl 引擎非 2xx 判可达：仅 gitcode 以 403 CurlFetchError 可达 → gitcode 排前', async () => {
      setProbeBehavior({ github: new Error('timeout (aborted)'), gitcode: curlHttpStatusError(403) })

      const order = await resolveSourceOrder('auto')

      expect(order).toEqual(['atomgit', 'github'])
    })

    it('无 httpStatusCode 的 CurlFetchError（exit 7 连接错误）判不可达：github 连接失败 + gitcode 可达 → gitcode 排前', async () => {
      setProbeBehavior({ github: curlConnectError(), gitcode: okProbe() })

      const order = await resolveSourceOrder('auto')

      expect(order).toEqual(['atomgit', 'github'])
    })
  })

  describe('探测请求规格（D4/D5 锁定）', () => {
    it('探测调用带 disableFlagPersistence: true + GET + Range bytes=0-0 + 3s 超时，且只打两主域', async () => {
      setProbeBehavior({})

      await resolveSourceOrder('auto')

      expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
      const urls = upgradeFetchMock.mock.calls.map((call) => call[0])
      expect(urls).toEqual([GITHUB_PROBE_URL, GITCODE_PROBE_URL])
      for (const call of upgradeFetchMock.mock.calls) {
        const opts = call[1] ?? {}
        // D5：探测失败不得翻转进程级引擎偏好（对齐 testProxy 先例）
        expect(opts.disableFlagPersistence).toBe(true)
        // D4：GET + Range（GitCode 禁 HEAD 的实测规避），不走 HEAD
        expect(opts.method).toBe('GET')
        expect(opts.headers?.Range).toBe('bytes=0-0')
        expect(opts.timeoutMs).toBe(EXPECTED_PROBE_TIMEOUT_MS)
      }
    })
  })

  describe('探测结果 TTL 缓存（1h）', () => {
    it('TTL 内命中缓存不重复探测；过期后重新探测', async () => {
      const start = new Date('2026-09-07T10:00:00Z')
      vi.setSystemTime(start)
      setProbeBehavior({ github: new Error('timeout (aborted)'), gitcode: okProbe() })

      // 首次：探测 2 次，gitcode 可达胜出
      const first = await resolveSourceOrder('auto')
      expect(first).toEqual(['atomgit', 'github'])
      expect(upgradeFetchMock).toHaveBeenCalledTimes(2)

      // +30min：缓存命中，零新增探测，顺序不变
      vi.setSystemTime(new Date(start.getTime() + 30 * 60 * 1000))
      const second = await resolveSourceOrder('auto')
      expect(second).toEqual(['atomgit', 'github'])
      expect(upgradeFetchMock).toHaveBeenCalledTimes(2)

      // +61min：TTL 过期，重新探测（再 +2 次）
      vi.setSystemTime(new Date(start.getTime() + 61 * 60 * 1000))
      const third = await resolveSourceOrder('auto')
      expect(third).toEqual(['atomgit', 'github'])
      expect(upgradeFetchMock).toHaveBeenCalledTimes(4)
    })

    it('显式偏好不消费探测缓存（直接映射，缓存窗口内切偏好即时生效）', async () => {
      vi.setSystemTime(new Date('2026-09-07T10:00:00Z'))
      setProbeBehavior({})

      await resolveSourceOrder('auto')
      expect(upgradeFetchMock).toHaveBeenCalledTimes(2)

      // 缓存命中窗口内切显式偏好 atomgit：不经缓存/探测，直接映射
      const order = await resolveSourceOrder('atomgit')
      expect(order).toEqual(['atomgit', 'github'])
      expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
    })

    it('代理短路不消费也不污染探测缓存', async () => {
      const start = new Date('2026-09-07T10:00:00Z')
      vi.setSystemTime(start)
      setProbeBehavior({})

      // 代理短路：零探测，不写缓存
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue('http://192.168.1.202:7890')
      await resolveSourceOrder('auto')
      expect(upgradeFetchMock).not.toHaveBeenCalled()

      // 撤掉代理：缓存为空 → 走探测（若短路误写缓存则此处为 0 次调用）
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(undefined)
      await resolveSourceOrder('auto')
      expect(upgradeFetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('缺省与返回值形态', () => {
    it('无参调用按 auto 语义解析（老 settings 无 updateSource 字段 = auto）', async () => {
      setProbeBehavior({ github: new Error('timeout (aborted)'), gitcode: okProbe() })

      const order = await resolveSourceOrder()

      expect(order).toEqual(['atomgit', 'github'])
    })

    it('返回数组为独立副本（连续调用互不共享引用，防调用方突变污染缓存）', async () => {
      setProbeBehavior({})
      vi.setSystemTime(new Date('2026-09-07T10:00:00Z'))

      const first = await resolveSourceOrder('auto')
      first.push('github' as never)

      const second = await resolveSourceOrder('auto')
      expect(second).toEqual(['github', 'atomgit'])
    })
  })
})
