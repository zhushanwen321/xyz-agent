/**
 * paths.ts 纯函数测试（W3）。
 *
 * 覆盖 getAttachmentsDir（IF4）：
 * - W3TC1: 传 dataDir → path.join(dataDir,'attachments',sessionId)
 * - W3TC2: 不传 dataDir → path.join(getDataDir(),'attachments',sessionId)
 * - W5+B2（路径穿越防护）：sessionId 含分隔符/非法字符 → throw
 *   （原 W3TC3 用「不负责 sanitize sessionId」固化缺陷，已删除；改用纵深防御校验）
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

  it('sessionId 含路径分隔符 → throw（防路径穿越）', () => {
    // W5+B2: getAttachmentsDir 校验 sessionId 字符集，拒绝 / \ .. ; 等会逃逸 attachments/ 的载荷。
    expect(() => getAttachmentsDir('../etc', '/d')).toThrow(/path traversal/)
    expect(() => getAttachmentsDir('foo/bar', '/d')).toThrow(/path traversal/)
    expect(() => getAttachmentsDir('..\\etc', '/d')).toThrow(/path traversal/)
    expect(() => getAttachmentsDir('a;b', '/d')).toThrow(/path traversal/) // 分号等也不允许
  })

  it('合法 sessionId（uuidv7 / u-<uuid> 格式）正常拼接', () => {
    // pi 的 uuidv7 格式
    expect(getAttachmentsDir('019f9bd8-ee50-779d-a912-4a661683cf69', '/d'))
      .toBe(join('/d', 'attachments', '019f9bd8-ee50-779d-a912-4a661683cf69'))
    // xyz-agent store 的 u-<uuid> 格式
    expect(getAttachmentsDir('u-a1b2c3d4-e5f6-7890-abcd-ef1234567890', '/d'))
      .toBe(join('/d', 'attachments', 'u-a1b2c3d4-e5f6-7890-abcd-ef1234567890'))
  })
})
