/**
 * chat 组件测试 helper（w6 chat-ui-and-shell T7）。
 *
 * 提供 mock ChatViewDeps 的 provide 对象构造，供迁移的行为型测试 mount 组件时注入
 * （替代 renderer 旧 vi.mock(store/composable) 模式）。
 */
import { vi } from 'vitest'
import { ChatViewDepsKey } from '@xyz-agent/ui'
import type { ChatViewDeps } from '@xyz-agent/ui'

/** 构造 mock ChatViewDeps（所有字段 vi.fn 或合理默认，零真 store） */
export function createMockDeps(overrides: Partial<ChatViewDeps> = {}): ChatViewDeps {
  return {
    getMessages: () => [],
    isActive: () => false,
    isHandingOff: () => false,
    getChangeSetStatus: () => undefined,
    isExpanded: () => false,
    toggleExpand: vi.fn(),
    collapse: vi.fn(),
    abortBash: vi.fn(),
    editAndResend: vi.fn(),
    onFork: vi.fn(),
    onForkAsk: vi.fn(),
    onHandoff: vi.fn(),
    onHandoffAsk: vi.fn(),
    openDrawer: vi.fn(),
    onFileClick: vi.fn(),
    onAmbiguousSelect: vi.fn(),
    loadFileCandidates: vi.fn().mockResolvedValue([]),
    renderMarkdown: vi.fn().mockResolvedValue([]),
    renderMermaid: vi.fn().mockResolvedValue({ svg: '' }),
    toMarkdown: vi.fn().mockReturnValue(''),
    ...overrides,
  }
}

/** 构造 provide 对象（ChatViewDepsKey → mock），供 mount global.provide 用 */
export function mockChatProvide(overrides: Partial<ChatViewDeps> = {}) {
  return {
    [ChatViewDepsKey as symbol]: createMockDeps(overrides),
  }
}
