/**
 * paths.ts 纯函数测试（W3）。
 *
 * 覆盖 getAttachmentsDir（IF4）：
 * - W3TC1: 传 dataDir → path.join(dataDir,'attachments',sessionId)
 * - W3TC2: 不传 dataDir → path.join(getDataDir(),'attachments',sessionId)
 *
 * 运行：cd packages/shared && npx vitest run __tests__/paths.test.ts
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { getAttachmentsDir, getDataDir } from '../src/paths'

describe('getAttachmentsDir（W3 IF4 纯函数）', () => {
  it('W3TC1: 传 dataDir → path.join(dataDir, "attachments", sessionId)', () => {
    const result = getAttachmentsDir('sess-1', '/custom/data')
    expect(result).toBe(join('/custom/data', 'attachments', 'sess-1'))
    // 纯函数不创建目录——无副作用可断言（仅校验返回值，目录是否真实存在由 IPC handler 负责）
  })

  it('W3TC2: 不传 dataDir → path.join(getDataDir(), "attachments", sessionId)', () => {
    const result = getAttachmentsDir('sess-2')
    expect(result).toBe(join(getDataDir(), 'attachments', 'sess-2'))
  })

  it('sessionId 含特殊路径段也不会被清理（纯字符串拼接，校验在调用方）', () => {
    // getAttachmentsDir 不负责 sanitize sessionId（sessionId 来自 sessionStore 的 uuid，
    // 不会含分隔符）。此处仅验证纯拼接行为。
    const result = getAttachmentsDir('abc', '/d')
    expect(result).toBe(join('/d', 'attachments', 'abc'))
  })
})
