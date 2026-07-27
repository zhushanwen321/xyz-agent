/**
 * remote lib 单测 —— 聚合 ws-origin / parse-connect-info / connection-config 三模块。
 *
 * 覆盖 plan.json TC1-TC20（20 用例），框架 vitest（happy-dom，禁止 node:test）。
 * connection-config 测试 beforeEach 清空 localStorage + 重置模块级内存缓存。
 * 每条用例至少一个用户可见断言（AGENTS 测试规范）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { wsUrlToHttpOrigin } from '../ws-origin'
import {
  parseConnectionInfo,
  classifyNetworkKind,
} from '../parse-connect-info'
import {
  getClientId,
  getDeviceName,
  isRemoteMode,
  getActiveProfile,
  listProfiles,
  saveProfile,
  removeProfile,
  activateRemote,
  deactivateRemote,
  __resetForTest,
} from '../connection-config'

// ── ws-origin（TC1-TC3）─────────────────────────────────────────
describe('wsUrlToHttpOrigin', () => {
  it('TC1: ws://host:port → http://host:port（scheme ws→http，host:port 保留）', () => {
    expect(wsUrlToHttpOrigin('ws://127.0.0.1:3210')).toBe('http://127.0.0.1:3210')
  })

  it('TC2: wss://domain → https://domain（无显式端口不补端口）', () => {
    expect(wsUrlToHttpOrigin('wss://myserver.tail-7c3a.ts.net')).toBe(
      'https://myserver.tail-7c3a.ts.net',
    )
  })

  it('TC3: 非 ws(s) scheme / 空串 / 畸形 url 安全降级不抛', () => {
    // 已是 http：非 ws(s) → 空串降级（调用方应仅对 WS 地址调用）
    expect(wsUrlToHttpOrigin('http://host:3210')).toBe('')
    // 空串
    expect(wsUrlToHttpOrigin('')).toBe('')
    // 畸形 URL：构造器抛 → 降级空串，不 crash
    expect(wsUrlToHttpOrigin('not a url !!!')).toBe('')
    expect(wsUrlToHttpOrigin('ws://')).toBe('')
  })
})

// ── parse-connect-info（TC4-TC11）──────────────────────────────
describe('parseConnectionInfo', () => {
  it('TC4: deep-link 格式（xyz-agent://connect + URLSearchParams 解码 url）', () => {
    const r = parseConnectionInfo('xyz-agent://connect?url=ws%3A%2F%2Fhost%3A3210&token=abc')
    expect(r.format).toBe('deep-link')
    expect(r.url).toBe('ws://host:3210')
    expect(r.token).toBe('abc')
    expect(r.networkKind).toBe('public')
    expect(r.error).toBeUndefined()
  })

  it('TC5: http-url 格式（http→ws 推导 + hash token）', () => {
    const r = parseConnectionInfo('http://host:3210/#token=abc')
    expect(r.format).toBe('http-url')
    expect(r.url).toBe('ws://host:3210')
    expect(r.token).toBe('abc')
    expect(r.networkKind).toBe('public')
  })

  it('TC6: ws-url 格式但 token 缺失（ES2，仍命中无 error）', () => {
    const r = parseConnectionInfo('ws://host:3210')
    expect(r.format).toBe('ws-url')
    expect(r.url).toBe('ws://host:3210')
    expect(r.token).toBeUndefined()
    expect(r.error).toBeUndefined()
    expect(r.networkKind).toBe('public')
  })

  it('TC7: url-token-lines 多行格式（行级正则两行）', () => {
    const r = parseConnectionInfo('URL: ws://host:3210\nToken: abc')
    expect(r.format).toBe('url-token-lines')
    expect(r.url).toBe('ws://host:3210')
    expect(r.token).toBe('abc')
    expect(r.networkKind).toBe('public')
  })

  it('TC8: 全不命中返回 unrecognized（ES1，静默不抛）', () => {
    const r = parseConnectionInfo('随便一段无关文本 hello world')
    expect(r.error).toBe('unrecognized')
    expect(r.format).toBeUndefined()
    expect(r.url).toBeUndefined()
    // 空串也走 unrecognized
    expect(parseConnectionInfo('').error).toBe('unrecognized')
  })

  it('TC9: 四格式变形（多余空白 / 大小写 / 带路径）仍正确命中', () => {
    // wss 带路径 + 前后空白 + 大小写 → trim 后命中 ws-url，url 返回 trim 后的原文（TC9「url 原文经 trim」）
    const r = parseConnectionInfo('  WSS://Host:3210/path  ')
    expect(r.format).toBe('ws-url')
    // host 为非 IP 域名 Host → classifyNetworkKind 走 public（非 localhost/非 ts.net/非私网 IP）
    expect(r.networkKind).toBe('public')
    // url 取 trim 后原文（保留大小写与路径）
    expect(r.url).toBe('WSS://Host:3210/path')
  })
})

// ── classifyNetworkKind（TC10-TC11）────────────────────────────
describe('classifyNetworkKind', () => {
  it('TC10: localhost / tailscale / lan / public 四类识别', () => {
    expect(classifyNetworkKind('127.0.0.1')).toBe('localhost')
    expect(classifyNetworkKind('myserver.tail-7c3a.ts.net')).toBe('tailscale')
    expect(classifyNetworkKind('192.168.1.5')).toBe('lan')
    expect(classifyNetworkKind('8.8.8.8')).toBe('public')
  })

  it('TC11: 边界 CGNAT 100.64/10 → tailscale，畸形/空 → public（ES4）', () => {
    expect(classifyNetworkKind('100.64.0.1')).toBe('tailscale')
    expect(classifyNetworkKind('')).toBe('public')
    expect(classifyNetworkKind('not a host!!!')).toBe('public')
    // localhost 字面量 + 127/8 回环
    expect(classifyNetworkKind('localhost')).toBe('localhost')
    expect(classifyNetworkKind('127.1.2.3')).toBe('localhost')
    // 其他私网段
    expect(classifyNetworkKind('10.0.0.1')).toBe('lan')
    expect(classifyNetworkKind('172.16.0.1')).toBe('lan')
    // 172.32 不在 172.16/12 内 → public
    expect(classifyNetworkKind('172.32.0.1')).toBe('public')
  })
})

// ── connection-config（TC12-TC20）──────────────────────────────
describe('connection-config', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetForTest()
  })

  describe('getClientId', () => {
    it('TC12: 首次生成 uuid 写回 localStorage，二次读幂等返回同值', () => {
      // 首次：无 client-id
      expect(localStorage.getItem('xyz-agent:client-id')).toBeNull()
      const first = getClientId()
      // RFC4122 v4 uuid 格式（8-4-4-4-12，含 v4 标记）
      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      // 写回 localStorage
      expect(localStorage.getItem('xyz-agent:client-id')).toBe(first)
      // 二次幂等
      const second = getClientId()
      expect(second).toBe(first)
    })

    it('TC13: localStorage 不可用时降级内存缓存幂等（ES3）', () => {
      // mock setItem 抛 SecurityError（模拟隐私模式）
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('SecurityError', 'SecurityError')
      })
      const first = getClientId()
      const second = getClientId()
      // 两次返回同值（模块级内存缓存幂等），不抛异常
      expect(first).toBe(second)
      expect(first.length).toBeGreaterThan(0)
      spy.mockRestore()
    })
  })

  describe('getDeviceName', () => {
    it('TC14: 读存储值，缺省按 UA 推导 Mac/Windows/Linux', () => {
      // 缺省：UA 推导（happy-dom UA 含某平台标识；断言三选一且非空）
      const name = getDeviceName()
      expect(['Mac', 'Windows', 'Linux']).toContain(name)
      // 有存储值则返回存储值
      localStorage.setItem('xyz-agent:device-name', '我的 Mac')
      expect(getDeviceName()).toBe('我的 Mac')
    })
  })

  describe('saveProfile', () => {
    it('TC15: upsert-by-url：同 url 复用 id 覆盖 token/name（ES5）', () => {
      // 预置一个 profile
      const existing = saveProfile({
        url: 'ws://h:3210',
        token: 'old',
        name: 'A',
        networkKind: 'public',
      })
      const originalId = existing.id
      expect(listProfiles()).toHaveLength(1)

      // 同 url upsert
      const updated = saveProfile({
        url: 'ws://h:3210',
        token: 'new',
        name: 'B',
        networkKind: 'lan',
      })
      expect(updated.id).toBe(originalId) // 复用 id
      expect(updated.token).toBe('new')
      expect(updated.name).toBe('B')
      expect(updated.networkKind).toBe('lan')
      // 数组长度不变（不新增元素）
      expect(listProfiles()).toHaveLength(1)
      expect(listProfiles()[0]).toMatchObject({
        id: originalId,
        token: 'new',
        name: 'B',
        networkKind: 'lan',
      })
    })

    it('TC16: 新 url 生成新 uuid 并追加到数组', () => {
      saveProfile({ url: 'ws://h1:3210', token: 't1', name: 'A', networkKind: 'public' })
      expect(listProfiles()).toHaveLength(1)
      const added = saveProfile({
        url: 'ws://h2:3210',
        token: 't2',
        name: 'B',
        networkKind: 'lan',
      })
      // 新 uuid
      expect(added.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      // 追加到末尾，长度 +1
      const list = listProfiles()
      expect(list).toHaveLength(2)
      expect(list[1]).toMatchObject({ url: 'ws://h2:3210', name: 'B' })
    })
  })

  describe('activate / deactivate / isRemoteMode 状态机', () => {
    it('TC17: 缺省 local → activate → remote → deactivate → local', () => {
      // 缺省：无 connection-mode / active-server-id
      expect(isRemoteMode()).toBe(false)

      // 先存一个 profile 才能激活
      const p = saveProfile({ url: 'ws://h:3210', token: 't', name: 'A', networkKind: 'public' })
      activateRemote(p.id)
      // connection-mode=remote + active=id
      expect(localStorage.getItem('xyz-agent:connection-mode')).toBe('remote')
      expect(localStorage.getItem('xyz-agent:active-server-id')).toBe(p.id)
      expect(isRemoteMode()).toBe(true) // getActiveProfile()!==null

      deactivateRemote()
      expect(localStorage.getItem('xyz-agent:connection-mode')).toBe('local')
      // profiles 保留
      expect(listProfiles()).toHaveLength(1)
      expect(isRemoteMode()).toBe(false)
    })

    it('TC18: active-server-id 指向不存在 profile 时 isRemoteMode 短路 false（ES6）', () => {
      localStorage.setItem('xyz-agent:connection-mode', 'remote')
      localStorage.setItem('xyz-agent:active-server-id', 'ghost')
      // remote-servers 中无 'ghost'
      expect(getActiveProfile()).toBeNull()
      expect(isRemoteMode()).toBe(false)
    })
  })

  describe('removeProfile', () => {
    it('TC19: 删除指定 id，删 active 项时清空 active-server-id', () => {
      const p1 = saveProfile({ url: 'ws://h1:3210', token: 't1', name: 'A', networkKind: 'public' })
      const p2 = saveProfile({ url: 'ws://h2:3210', token: 't2', name: 'B', networkKind: 'lan' })
      activateRemote(p1.id)
      expect(localStorage.getItem('xyz-agent:active-server-id')).toBe(p1.id)

      removeProfile(p1.id)
      // 剩 p2
      expect(listProfiles()).toHaveLength(1)
      expect(listProfiles()[0].id).toBe(p2.id)
      // active 被清空（删的是 active 项）
      expect(localStorage.getItem('xyz-agent:active-server-id')).toBeNull()
      expect(getActiveProfile()).toBeNull()
    })
  })

  describe('listProfiles / getActiveProfile 边界', () => {
    it('TC20: localStorage 无数据 / JSON.parse 失败时返回 [] / null（ES3）', () => {
      expect(listProfiles()).toEqual([])
      expect(getActiveProfile()).toBeNull()

      // JSON.parse 失败降级
      localStorage.setItem('xyz-agent:remote-servers', '{not valid json')
      expect(listProfiles()).toEqual([])
    })

    afterEach(() => {
      __resetForTest()
    })
  })
})
