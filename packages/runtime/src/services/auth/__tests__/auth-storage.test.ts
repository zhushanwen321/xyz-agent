/**
 * auth.json 凭据存储单测（tmp 目录真实文件）。
 *
 * 覆盖：set 后 get / merge 不丢其他 provider / 并发 set 多个 provider 最终全在
 * （per-file promise-chain mutex 防 RMW 丢更新）/ 0600 权限位 / remove 幂等 /
 * 文件不存在 get 返回 undefined / 损坏 JSON 抛错 / hasOAuth。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthStorage, type OAuthCredential } from '../auth-storage.js'

let dir: string
let file: string
let storage: AuthStorage

function cred(access: string, expires = 1_000): OAuthCredential {
  return { type: 'oauth', access, expires }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auth-storage-'))
  file = join(dir, 'auth.json')
  storage = new AuthStorage(file)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AuthStorage', () => {
  it('set 后 get 返回完整 credential', async () => {
    await storage.set('provider-a', cred('token-1'))
    expect(await storage.get('provider-a')).toMatchObject({ type: 'oauth', access: 'token-1', expires: 1_000 })
  })

  it('set 不同 provider 不互相覆盖（RMW merge）', async () => {
    await storage.set('a', cred('t1'))
    await storage.set('b', cred('t2'))
    expect(await storage.get('a')).toMatchObject({ access: 't1' })
    expect(await storage.get('b')).toMatchObject({ access: 't2' })
    expect(await storage.hasOAuth('a')).toBe(true)
    expect(await storage.hasOAuth('missing')).toBe(false)
  })

  it('同 provider 重复 set 覆盖旧值', async () => {
    await storage.set('a', cred('old'))
    await storage.set('a', cred('new'))
    expect(await storage.get('a')).toMatchObject({ access: 'new' })
  })

  it('并发 set 多个 provider：全部保留（mutex 串行化 RMW）', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => storage.set(`p${i}`, cred(`t${i}`))),
    )
    const all = await storage.getAll()
    expect(Object.keys(all)).toHaveLength(10)
    for (let i = 0; i < 10; i++) {
      expect(all[`p${i}`]).toMatchObject({ access: `t${i}` })
    }
  })

  it('写入后文件权限为 0600', async () => {
    await storage.set('a', cred('t1'))
    const stat = statSync(file)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('remove 幂等：不存在时再次 remove 不抛错', async () => {
    await storage.set('a', cred('t1'))
    await storage.remove('a')
    expect(await storage.get('a')).toBeUndefined()
    await storage.remove('a')
    await storage.remove('never-existed')
    expect(await storage.get('a')).toBeUndefined()
  })

  it('文件不存在时 get 返回 undefined、getAll 返回空对象', async () => {
    expect(await storage.get('nope')).toBeUndefined()
    expect(await storage.getAll()).toEqual({})
  })

  it('损坏 JSON：get 抛错（不静默返回空）', async () => {
    writeFileSync(file, '{ not valid json')
    await expect(storage.get('a')).rejects.toThrow()
  })

  it('损坏 JSON：set 抛错（RMW 重读时发现损坏）', async () => {
    writeFileSync(file, '{ not valid json')
    await expect(storage.set('a', cred('t1'))).rejects.toThrow()
  })

  it('空文件内容按空对象处理', async () => {
    writeFileSync(file, '')
    expect(await storage.getAll()).toEqual({})
  })
})
