/**
 * extension domain upgrade / autoUpgrade 测试。
 *
 * TDD Red phase：验证 upgrade() 和 setAutoUpgrade() 发送正确的 WS 消息。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock transport 和 pending 模块（vi.mock 会自动提升到文件顶部）
vi.mock('../api/transport', () => ({
  send: vi.fn(),
}))

vi.mock('../api/pending', () => ({
  create: vi.fn(() => 'test-id'),
  register: vi.fn(() => Promise.resolve()),
}))

import * as extension from '../api/domains/extension'
import * as transport from '../api/transport'
import * as pending from '../api/pending'

describe('extension domain upgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pending.create).mockReturnValue('test-id')
    vi.mocked(pending.register).mockReturnValue(Promise.resolve())
  })

  it('upgrade 发送 extension.upgrade 消息，payload 含 name', () => {
    extension.upgrade('my-extension')
    expect(transport.send).toHaveBeenCalledWith({
      type: 'extension.upgrade',
      id: 'test-id',
      payload: { name: 'my-extension' },
    })
  })

  it('upgrade 返回 pending promise', async () => {
    const result = extension.upgrade('my-extension')
    expect(result).toBeInstanceOf(Promise)
  })
})

describe('extension domain setAutoUpgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pending.create).mockReturnValue('test-id')
    vi.mocked(pending.register).mockReturnValue(Promise.resolve())
  })

  it('setAutoUpgrade 发送 extension.setAutoUpgrade 消息，payload 含 name 和 enabled', () => {
    extension.setAutoUpgrade('my-extension', true)
    expect(transport.send).toHaveBeenCalledWith({
      type: 'extension.setAutoUpgrade',
      id: 'test-id',
      payload: { name: 'my-extension', enabled: true },
    })
  })

  it('setAutoUpgrade 禁用时发送 enabled=false', () => {
    extension.setAutoUpgrade('my-extension', false)
    expect(transport.send).toHaveBeenCalledWith({
      type: 'extension.setAutoUpgrade',
      id: 'test-id',
      payload: { name: 'my-extension', enabled: false },
    })
  })

  it('setAutoUpgrade 返回 pending promise', async () => {
    const result = extension.setAutoUpgrade('my-extension', true)
    expect(result).toBeInstanceOf(Promise)
  })
})
