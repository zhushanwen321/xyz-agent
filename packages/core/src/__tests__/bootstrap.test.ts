import { describe, it, expect, vi, beforeEach } from 'vitest'
// namespace import：vi.spyOn(portNs, 'providePlatform') 需 namespace 可写（vitest 支持）。
import * as portNs from '../platform/port'
import { bootstrap, bootstrapSteps, type BootstrapOptions } from '../bootstrap'
import { createFakeWebSocket } from '../transport/__tests__/helpers/fake-websocket'

// initConnection 真实现 import use-connection（连带端口装配依赖链）——模块级拦截为无副作用
// stub。步骤调用面经 bootstrapSteps spy 拦截（下方用例全覆盖），此处 mock 防 spy 未覆盖的
// 调用路径意外触发真实连接编排。
vi.mock('../transport/use-connection', () => ({
  useConnection: () => ({ init: async () => {} }),
}))

// 最小 mock PlatformPort（满足 BootstrapOptions.platform 类型；webSocket stub 返回合法 WebSocketLike）
function makeOptions(): BootstrapOptions {
  return {
    platform: {
      kind: 'mock',
      storage: {
        get: async () => null,
        set: async () => {},
        remove: async () => {},
      },
      webSocket: { create: () => createFakeWebSocket() },
      ipc: null,
    },
  }
}

describe('AC6: bootstrap 五步显式 await 编排', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('按严格顺序调用 [providePlatform, initConnection, restoreSessions, registerMountPoints, scanContributions]', async () => {
    const callOrder: string[] = []
    vi.spyOn(portNs, 'providePlatform').mockImplementation(() => {
      callOrder.push('providePlatform')
      return Promise.resolve()
    })
    vi.spyOn(bootstrapSteps, 'initConnection').mockImplementation(() => {
      callOrder.push('initConnection')
      return Promise.resolve()
    })
    vi.spyOn(bootstrapSteps, 'restoreSessions').mockImplementation(() => {
      callOrder.push('restoreSessions')
      return Promise.resolve()
    })
    vi.spyOn(bootstrapSteps, 'registerMountPoints').mockImplementation(() => {
      callOrder.push('registerMountPoints')
      return Promise.resolve()
    })
    vi.spyOn(bootstrapSteps, 'scanContributions').mockImplementation(() => {
      callOrder.push('scanContributions')
      return Promise.resolve()
    })

    await bootstrap(makeOptions())

    expect(callOrder).toEqual([
      'providePlatform',
      'initConnection',
      'restoreSessions',
      'registerMountPoints',
      'scanContributions',
    ])
  })
})

describe('ES1: 任一步 reject 中断后续步骤', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // 默认全部 resolve，单个 it 注入 reject
    vi.spyOn(portNs, 'providePlatform').mockResolvedValue(undefined)
    vi.spyOn(bootstrapSteps, 'initConnection').mockResolvedValue(undefined)
    vi.spyOn(bootstrapSteps, 'restoreSessions').mockResolvedValue(undefined)
    vi.spyOn(bootstrapSteps, 'registerMountPoints').mockResolvedValue(undefined)
    vi.spyOn(bootstrapSteps, 'scanContributions').mockResolvedValue(undefined)
  })

  it('providePlatform reject → initConnection 不调用', async () => {
    vi.mocked(portNs.providePlatform).mockRejectedValueOnce(new Error('pp boom'))
    await expect(bootstrap(makeOptions())).rejects.toThrow('pp boom')
    expect(vi.mocked(bootstrapSteps.initConnection)).not.toHaveBeenCalled()
  })

  it('initConnection reject → restoreSessions 不调用', async () => {
    vi.mocked(bootstrapSteps.initConnection).mockRejectedValueOnce(new Error('ic boom'))
    await expect(bootstrap(makeOptions())).rejects.toThrow('ic boom')
    expect(vi.mocked(bootstrapSteps.restoreSessions)).not.toHaveBeenCalled()
  })

  it('restoreSessions reject → registerMountPoints 不调用', async () => {
    vi.mocked(bootstrapSteps.restoreSessions).mockRejectedValueOnce(new Error('rs boom'))
    await expect(bootstrap(makeOptions())).rejects.toThrow('rs boom')
    expect(vi.mocked(bootstrapSteps.registerMountPoints)).not.toHaveBeenCalled()
  })

  it('registerMountPoints reject → scanContributions 不调用', async () => {
    vi.mocked(bootstrapSteps.registerMountPoints).mockRejectedValueOnce(new Error('rmp boom'))
    await expect(bootstrap(makeOptions())).rejects.toThrow('rmp boom')
    expect(vi.mocked(bootstrapSteps.scanContributions)).not.toHaveBeenCalled()
  })
})
