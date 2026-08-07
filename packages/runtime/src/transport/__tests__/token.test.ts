/**
 * TokenManager / ensureToken 单测（W1-T2 远程化访问令牌）。
 *
 * 验收：
 *  - TC1: token 文件不存在 → ensureToken 生成新 token + persist（文件被创建）+ 返回非空 token
 *  - TC2: token 文件已存在 → ensureToken 读已有 token（不覆盖）+ 返回相同值
 *  - TC3: tokenManager disabled（tokenFile=undefined）→ ensureToken 生成新 token（load 返回 enabled:false，
 *         与「文件不存在」等价；persist 因 tokenFile 未配置抛错——见 ensureToken 实现）。
 *
 * 隔离：mkdtempSync 临时目录，每用例独立 tokenFile 路径，避免互相污染。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTokenManager, ensureToken } from '../token.js'

let tmpDir: string

beforeEach(() => {
  // 每用例新建独立子目录，避免缓存/文件残留互相干扰
  tmpDir = mkdtempSync(join(tmpdir(), 'xyz-token-'))
})

afterAll(() => {
  // best-effort 清理（rmSync 递归删临时目录）
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败不影响测试结论 */
  }
})

describe('ensureToken（首启 token 生成）', () => {
  it('TC1: token 文件不存在 → 生成新 token + persist 创建文件 + 返回非空 token', () => {
    const tokenFile = join(tmpDir, 'token.txt')
    const tm = createTokenManager({ tokenFile })

    // 文件不存在
    expect(existsSync(tokenFile)).toBe(false)

    const token = ensureToken(tm)

    // 返回非空 token（base64url 32 字节 ≈ 43 字符）
    expect(token).toBeTruthy()
    expect(token.length).toBeGreaterThan(20)

    // persist 已写文件（0600 权限）
    expect(existsSync(tokenFile)).toBe(true)
    const persisted = readFileSync(tokenFile, 'utf8')
    expect(persisted).toBe(token)
  })

  it('TC2: token 文件已存在 → 读已有 token（不覆盖）+ 返回相同值', () => {
    const tokenFile = join(tmpDir, 'token.txt')
    const tm = createTokenManager({ tokenFile })

    // 首启生成
    const firstToken = ensureToken(tm)

    // 新 manager 实例（清缓存），再 ensureToken 应读到已存在文件，不覆盖
    const tm2 = createTokenManager({ tokenFile })
    const secondToken = ensureToken(tm2)

    expect(secondToken).toBe(firstToken)

    // 文件内容未被覆盖（仍是 firstToken）
    const persisted = readFileSync(tokenFile, 'utf8')
    expect(persisted).toBe(firstToken)
  })

  it('TC3: tokenManager disabled（tokenFile=undefined）→ load 返回 enabled:false；persist 抛 tokenFile not configured', () => {
    // tokenFile=undefined → load 返回 { enabled: false }（开放模式）
    const tm = createTokenManager({})
    const loaded = tm.load()
    expect(loaded.enabled).toBe(false)

    // ensureToken 走 !loaded.enabled 分支 → 调 generate + persist；
    // persist 在 tokenFile 未配置时抛错（createTokenManager.persist:106 `tokenFile not configured`）。
    // 这验证了开放模式下 ensureToken 不会静默成功——调用方必须配置 tokenFile 才能首启生成 token。
    expect(() => ensureToken(tm)).toThrow(/tokenFile not configured/)
  })
})

describe('createTokenManager（辅助：load 缓存 + verify 行为）', () => {
  it('load 二次调用命中缓存（不重复 IO）', () => {
    const tokenFile = join(tmpDir, 'token.txt')
    const tm = createTokenManager({ tokenFile })
    const first = tm.load()
    const second = tm.load()
    // 引用相同（缓存命中）
    expect(second).toBe(first)
  })

  it('空文件 → load 返回 enabled:false（开放模式）', () => {
    const tokenFile = join(tmpDir, 'token.txt')
    // 写一个空文件（仅创建）
    const { writeFileSync } = require('node:fs')
    writeFileSync(tokenFile, '   \n  ')
    const tm = createTokenManager({ tokenFile })
    const loaded = tm.load()
    expect(loaded.enabled).toBe(false)
  })

  it('verify 常量时间比对：正确 token 返回 true，错误返回 false', () => {
    const tokenFile = join(tmpDir, 'token.txt')
    const tm = createTokenManager({ tokenFile })
    const token = ensureToken(tm)

    expect(tm.verify(token)).toBe(true)
    expect(tm.verify('wrong-token')).toBe(false)
    expect(tm.verify('')).toBe(false)
  })
})
