/**
 * ShareConnectionModal 单测（wave 远程分享）。
 *
 * Dialog 走 reka-ui Teleport 渲染到 document.body，故 wrapper.find/text 看不到 modal 内容。
 * 用 mount({ attachTo: document.body }) + document.querySelector 查询 teleport 后的真实 DOM。
 *
 * 验收：
 *  - TC1: mount → loading 态 → RPC resolve → 三种格式 URL 渲染（移动端含 #token=、桌面 wsUrl、deep link 含 xyz-agent://）
 *  - TC2: 点复制按钮 → navigator.clipboard.writeText 被调
 *  - TC3: RPC 失败 → 错误提示显示
 *  - TC4: token 为空（开放模式）→ 移动端 URL 不含 #token=、deep link 不含 &token=
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { ConnectionInfo } from '@/api/domains/config'
import ShareConnectionModal from '../ShareConnectionModal.vue'

// mock @/api 的 config domain：getConnectionInfo 返回可控 payload
const getConnectionInfoMock = vi.fn<() => Promise<ConnectionInfo>>()

vi.mock('@/api', () => ({
  config: {
    getConnectionInfo: (...args: unknown[]) => getConnectionInfoMock(...(args as [])),
  },
}))

// mock clipboard（useCopy 调 navigator.clipboard.writeText）
const writeTextMock = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)

beforeEach(() => {
  getConnectionInfoMock.mockReset()
  writeTextMock.mockClear()
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    configurable: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
  // 清理 teleport 残留 DOM，避免用例间污染
  document.body.innerHTML = ''
})

const LAN_INFO: ConnectionInfo = {
  token: 'test-token',
  urls: [
    {
      kind: 'lan',
      host: '192.168.1.100',
      httpUrl: 'http://192.168.1.100:3310',
      wsUrl: 'ws://192.168.1.100:3310',
    },
  ],
}

describe('ShareConnectionModal（wave 远程分享）', () => {
  it('TC1: loading → RPC resolve → 渲染三种格式 URL', async () => {
    // 手动控制 promise：mount 后 resolve 前 = loading 态，resolve 后 = 三种格式
    let resolveRpc!: (v: ConnectionInfo) => void
    getConnectionInfoMock.mockImplementation(
      () => new Promise<ConnectionInfo>((resolve) => {
        resolveRpc = resolve
      }),
    )
    const wrapper = mount(ShareConnectionModal, { attachTo: document.body })
    await flushPromises()

    // loading 态：RPC 未 resolve 前，三种格式均未渲染
    expect(document.querySelector('[data-testid="share-mobile-url"]')).toBeNull()
    // i18n common.loading → '加载中…'（zh-CN locale）
    expect(document.body.textContent).toContain('加载中')

    // resolve RPC → 三种格式渲染
    resolveRpc(LAN_INFO)
    await flushPromises()

    // flush onMounted 的 async
    await flushPromises()

    // 移动端直达：含 #token=
    const mobileEl = document.querySelector('[data-testid="share-mobile-url"]')
    expect(mobileEl).not.toBeNull()
    expect(mobileEl?.textContent).toContain('http://192.168.1.100:3310/#token=test-token')

    // 桌面 wsUrl
    const wsEl = document.querySelector('[data-testid="share-desktop-wsurl"]')
    expect(wsEl?.textContent).toBe('ws://192.168.1.100:3310')

    // token 行
    expect(document.querySelector('[data-testid="share-token"]')?.textContent).toBe('test-token')

    // deep link：含 xyz-agent:// + token
    const deepEl = document.querySelector('[data-testid="share-deep-link"]')
    expect(deepEl?.textContent).toContain('xyz-agent://connect?')
    expect(deepEl?.textContent).toContain('token=test-token')

    wrapper.unmount()
  })

  it('TC2: 点复制按钮 → navigator.clipboard.writeText 被调', async () => {
    getConnectionInfoMock.mockResolvedValue(LAN_INFO)
    const wrapper = mount(ShareConnectionModal, { attachTo: document.body })
    await flushPromises()

    const mobileBtn = document.querySelector('[data-testid="copy-mobile-url-btn"]') as HTMLElement
    mobileBtn.click()
    await flushPromises()
    expect(writeTextMock).toHaveBeenCalledWith('http://192.168.1.100:3310/#token=test-token')

    const wsBtn = document.querySelector('[data-testid="copy-wsurl-btn"]') as HTMLElement
    wsBtn.click()
    await flushPromises()
    expect(writeTextMock).toHaveBeenCalledWith('ws://192.168.1.100:3310')

    const deepBtn = document.querySelector('[data-testid="copy-deep-link-btn"]') as HTMLElement
    deepBtn.click()
    await flushPromises()
    // deep link 复制内容含 xyz-agent://
    expect(writeTextMock.mock.calls.at(-1)?.[0]).toContain('xyz-agent://connect?')

    wrapper.unmount()
  })

  it('TC3: RPC 失败 → 显示错误提示', async () => {
    getConnectionInfoMock.mockRejectedValue(new Error('rpc down'))
    const wrapper = mount(ShareConnectionModal, { attachTo: document.body })
    await flushPromises()

    // 失败态：loadError=true，渲染 AlertCircle 分支；三种格式均未渲染
    expect(document.querySelector('[data-testid="share-mobile-url"]')).toBeNull()
    // i18n connection.share.loadFailed → '获取连接信息失败'（zh-CN locale）
    expect(document.body.textContent).toContain('获取连接信息失败')

    wrapper.unmount()
  })

  it('TC4: token 为空（开放模式）→ 移动端 URL 不含 #token=、deep link 不含 &token=', async () => {
    getConnectionInfoMock.mockResolvedValue({
      token: '',
      urls: [
        {
          kind: 'lan',
          host: '192.168.1.100',
          httpUrl: 'http://192.168.1.100:3310',
          wsUrl: 'ws://192.168.1.100:3310',
        },
      ],
    })
    const wrapper = mount(ShareConnectionModal, { attachTo: document.body })
    await flushPromises()

    const mobileEl = document.querySelector('[data-testid="share-mobile-url"]')
    expect(mobileEl).not.toBeNull()
    // token 为空：mobileUrl 走 `${trimmed}/` 分支，无 #token=
    expect(mobileEl?.textContent).not.toContain('#token=')
    expect(mobileEl?.textContent).toContain('http://192.168.1.100:3310/')

    const deepEl = document.querySelector('[data-testid="share-deep-link"]')
    expect(deepEl?.textContent).not.toContain('&token=')
    expect(deepEl?.textContent).toContain('xyz-agent://connect?url=')

    // token 行展示开放模式占位文案：i18n connection.share.openMode → '开放模式（无需 token）'
    expect(document.querySelector('[data-testid="share-token"]')?.textContent).toContain('开放模式')
    // token 复制按钮 disabled
    const tokenBtn = document.querySelector('[data-testid="copy-token-btn"]') as HTMLElement
    expect(tokenBtn.hasAttribute('disabled')).toBe(true)

    wrapper.unmount()
  })
})
