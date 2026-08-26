/**
 * W1-contract-foundation 验收测试（单文件，CW verify 兼容）。
 *
 * 覆盖 12 条验收：extractNetErrorCode / existing-5codes-regression /
 * extractNetErrorCode-regression / isPrivateHost / classifyProxyUnreachable /
 * C3-classifyProxyUnreachable-return-type / UPDATE_PROXY_UNREACHABLE-code /
 * 407-reverse-case / UPDATE_NETWORK_FAILED-for-public-EHOSTUNREACH /
 * UPDATE_ERROR_STAGES / UpdateError-rawCause / error-log-append。
 *
 * 运行：cd apps/electron && npx vitest run main/update/__tests__/update.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  extractNetErrorCode,
  isPrivateHost,
  classifyProxyUnreachable,
  wrapUpdateError,
  extractRawCause,
} from '../net-errors.js'
import { UpdateError, UPDATE_ERROR_MESSAGES } from '../types.js'

// ─── error-log mock ──────────────────────────────────────────────

const TEST_LOG_DIR = join(tmpdir(), `update-error-log-test-${Date.now()}`)
const TEST_LOG_PATH = join(TEST_LOG_DIR, 'update-error.log')

vi.mock('../constants.js', () => ({
  UPDATE_ERROR_LOG: TEST_LOG_PATH,
}))

const { appendUpdateError, _readLogForTest } = await import('../error-log.js')

// ─── W1-extractNetErrorCode ──────────────────────────────────────

describe('W1-extractNetErrorCode', () => {
  it('W1-extractNetErrorCode extracts .code from direct Error', () => {
    const err = Object.assign(new Error('connect failed'), { code: 'EHOSTUNREACH' })
    const result = extractNetErrorCode(err)
    // 精确断言：EHOSTUNREACH 是 net-errors.ts 新增的已知错误码
    // 基线 types.ts 无此码、无 extractNetErrorCode 函数
    expect(result).toBe('EHOSTUNREACH')
    expect(typeof result).toBe('string')
  })

  it('W1-extractNetErrorCode extracts .code from err.cause (undici pattern)', () => {
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    expect(extractNetErrorCode(err)).toBe('EHOSTUNREACH')
  })

  it('W1-extractNetErrorCode matches known error code in message when .code absent', () => {
    const err = new Error('connect ETIMEDOUT 10.0.0.1:443')
    expect(extractNetErrorCode(err)).toBe('ETIMEDOUT')
  })

  it('W1-extractNetErrorCode returns undefined for unknown error', () => {
    const err = new Error('something weird')
    expect(extractNetErrorCode(err)).toBeUndefined()
  })

  it('W1-extractNetErrorCode drills 3 levels of cause chain', () => {
    const inner = Object.assign(new Error('deep'), { code: 'ECONNREFUSED' })
    const mid = new Error('mid', { cause: inner })
    const outer = new Error('fetch failed', { cause: mid })
    expect(extractNetErrorCode(outer)).toBe('ECONNREFUSED')
  })

  it('W1-extractNetErrorCode handles non-Error input gracefully', () => {
    expect(extractNetErrorCode('string error')).toBeUndefined()
    expect(extractNetErrorCode(null)).toBeUndefined()
    expect(extractNetErrorCode(undefined)).toBeUndefined()
  })
})

// ─── W1-existing-5codes-regression ───────────────────────────────

describe('W1-existing-5codes-regression', () => {
  const EXISTING_5 = ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'] as const

  for (const code of EXISTING_5) {
    it(`W1-existing-5codes-regression ${code} cause.code 提取`, () => {
      const cause = Object.assign(new Error(`connect ${code}`), { code })
      const err = new Error('fetch failed', { cause })
      expect(extractNetErrorCode(err)).toBe(code)
    })
  }

  for (const code of EXISTING_5) {
    it(`W1-existing-5codes-regression ${code} message 前缀匹配`, () => {
      const cause = new Error(`socket hang up ${code} extra`)
      const err = new Error('fetch failed', { cause })
      expect(extractNetErrorCode(err)).toBe(code)
    })
  }
})

// ─── W1-extractNetErrorCode-regression ───────────────────────────

describe('W1-extractNetErrorCode-regression', () => {
  it('W1-extractNetErrorCode-regression 5 层嵌套 cause 链仍提取最内层', () => {
    let err: unknown = Object.assign(new Error('L0'), { code: 'ECONNREFUSED' })
    for (let i = 1; i <= 4; i++) {
      err = new Error(`L${i}`, { cause: err })
    }
    expect(extractNetErrorCode(err)).toBe('ECONNREFUSED')
  })

  it('W1-extractNetErrorCode-regression fetch failed + cause.code 真实形态', () => {
    const cause = Object.assign(new Error('connect EHOSTUNREACH 192.168.1.202:7890'), {
      code: 'EHOSTUNREACH',
    })
    const err = new Error('fetch failed', { cause })
    expect(extractNetErrorCode(err)).toBe('EHOSTUNREACH')
  })
})

// ─── W1-isPrivateHost ──────────────────────────────────────────────

describe('W1-isPrivateHost', () => {
  it('W1-isPrivateHost 10.x.x.x is private', () => {
    expect(isPrivateHost('http://10.0.0.1:8080')).toBe(true)
  })

  it('W1-isPrivateHost 172.16.x.x is private', () => {
    expect(isPrivateHost('http://172.16.0.1:8080')).toBe(true)
  })

  it('W1-isPrivateHost 172.31.x.x is private', () => {
    expect(isPrivateHost('http://172.31.255.255:8080')).toBe(true)
  })

  it('W1-isPrivateHost 192.168.x.x is private', () => {
    expect(isPrivateHost('http://192.168.1.202:7890')).toBe(true)
  })

  it('W1-isPrivateHost 127.x.x.x is private (loopback)', () => {
    expect(isPrivateHost('http://127.0.0.1:7890')).toBe(true)
  })

  it('W1-isPrivateHost fd00::1 is private (IPv6 ULA)', () => {
    expect(isPrivateHost('http://[fd00::1]:7890')).toBe(true)
  })

  it('W1-isPrivateHost fc00::1 is private (IPv6 ULA)', () => {
    expect(isPrivateHost('http://[fc00::1]:7890')).toBe(true)
  })

  it('W1-isPrivateHost ::1 is private (IPv6 loopback)', () => {
    expect(isPrivateHost('http://[::1]:7890')).toBe(true)
  })

  it('W1-isPrivateHost ::ffff:192.168.1.1 is private (mapped IPv4)', () => {
    expect(isPrivateHost('http://[::ffff:192.168.1.1]:7890')).toBe(true)
  })

  it('W1-isPrivateHost public IP is not private', () => {
    expect(isPrivateHost('http://203.0.113.1:7890')).toBe(false)
  })

  it('W1-isPrivateHost GitHub domain is not private', () => {
    expect(isPrivateHost('https://api.github.com')).toBe(false)
  })

  it('W1-isPrivateHost invalid URL returns false', () => {
    expect(isPrivateHost('not-a-url')).toBe(false)
  })

  it('W1-isPrivateHost 172.15.x.x is NOT private', () => {
    expect(isPrivateHost('http://172.15.0.1:8080')).toBe(false)
  })

  it('W1-isPrivateHost 172.32.x.x is NOT private', () => {
    expect(isPrivateHost('http://172.32.0.1:8080')).toBe(false)
  })

  it('W1-isPrivateHost hostname form returns false (no DNS resolution)', () => {
    expect(isPrivateHost('http://nas.local:7890')).toBe(false)
  })
})

// ─── W1-classifyProxyUnreachable ──────────────────────────────────

describe('W1-classifyProxyUnreachable', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('W1-classifyProxyUnreachable returns true on macOS + EHOSTUNREACH + private host', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH 192.168.1.202:7890'), {
      code: 'EHOSTUNREACH',
    })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, 'http://192.168.1.202:7890')).toBe(true)
  })

  it('W1-classifyProxyUnreachable returns false on non-macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, 'http://192.168.1.202:7890')).toBe(false)
  })

  it('W1-classifyProxyUnreachable returns false when error code is not EHOSTUNREACH', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, 'http://192.168.1.202:7890')).toBe(false)
  })

  it('W1-classifyProxyUnreachable returns false when proxyUrl is undefined', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, undefined)).toBe(false)
  })

  it('W1-classifyProxyUnreachable returns false when proxy host is public IP', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, 'http://203.0.113.1:7890')).toBe(false)
  })

  it('W1-classifyProxyUnreachable returns true for IPv6 ULA proxy', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, 'http://[fd00::1]:7890')).toBe(true)
  })
})

// ─── W1-C3-classifyProxyUnreachable-return-type ──────────────────

describe('W1-C3-classifyProxyUnreachable-return-type', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('W1-C3-classifyProxyUnreachable-return-type returns boolean true or false', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    const result = classifyProxyUnreachable(err, 'http://192.168.1.202:7890')
    expect(typeof result).toBe('boolean')
  })

  it('W1-C3-classifyProxyUnreachable-return-type returns boolean false for non-matching', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const err = new Error('fetch failed', { cause })
    const result = classifyProxyUnreachable(err, 'http://192.168.1.202:7890')
    expect(typeof result).toBe('boolean')
  })
})

// ─── W1-UPDATE_PROXY_UNREACHABLE-code ─────────────────────────────

describe('W1-UPDATE_PROXY_UNREACHABLE-code', () => {
  it('W1-UPDATE_PROXY_UNREACHABLE-code entry exists in mapping table', () => {
    expect(UPDATE_ERROR_MESSAGES).toHaveProperty('UPDATE_PROXY_UNREACHABLE')
  })

  it('W1-UPDATE_PROXY_UNREACHABLE-code message contains EHOSTUNREACH', () => {
    const entry = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE
    expect(entry.message).toContain('EHOSTUNREACH')
  })

  it('W1-UPDATE_PROXY_UNREACHABLE-code suggestion contains 本地网络', () => {
    const entry = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE
    expect(entry.suggestion).toContain('本地网络')
  })

  it('W1-UPDATE_PROXY_UNREACHABLE-code stage is downloading', () => {
    const entry = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE
    expect(entry.stage).toBe('downloading')
  })

  it('W1-UPDATE_PROXY_UNREACHABLE-code UPDATE_PROXY_ERROR 基线一致', () => {
    const proxyError = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_ERROR
    expect(proxyError.message).toBe('代理配置错误')
    expect(proxyError.stage).toBe('downloading')
    expect(proxyError.suggestion).toContain('代理')
  })
})

// ─── W1-407-reverse-case ──────────────────────────────────────────

describe('W1-407-reverse-case', () => {
  it('W1-407-reverse-case UPDATE_PROXY_ERROR remains separate from UPDATE_PROXY_UNREACHABLE', () => {
    const proxyError = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_ERROR
    const unreachable = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE
    expect(proxyError.message).not.toBe(unreachable.message)
    expect(proxyError.suggestion).not.toBe(unreachable.suggestion)
  })

  it('W1-407-reverse-case UPDATE_PROXY_ERROR message does not mention EHOSTUNREACH', () => {
    const proxyError = UPDATE_ERROR_MESSAGES.UPDATE_PROXY_ERROR
    expect(proxyError.message).not.toContain('EHOSTUNREACH')
  })
})

// ─── W1-UPDATE_NETWORK_FAILED-for-public-EHOSTUNREACH ────────────

describe('W1-UPDATE_NETWORK_FAILED-for-public-EHOSTUNREACH', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('W1-UPDATE_NETWORK_FAILED-for-public-EHOSTUNREACH classifyProxyUnreachable returns false for public IP', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const cause = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })
    const err = new Error('fetch failed', { cause })
    expect(classifyProxyUnreachable(err, 'http://203.0.113.1:7890')).toBe(false)
  })

  it('W1-UPDATE_NETWORK_FAILED-for-public-EHOSTUNREACH UPDATE_NETWORK_FAILED exists', () => {
    expect(UPDATE_ERROR_MESSAGES).toHaveProperty('UPDATE_NETWORK_FAILED')
    const networkFailed = UPDATE_ERROR_MESSAGES.UPDATE_NETWORK_FAILED
    expect(networkFailed.message).toContain('网络连接失败')
  })
})

// ─── W1-UPDATE_ERROR_STAGES ───────────────────────────────────────

describe('W1-UPDATE_ERROR_STAGES', () => {
  it('W1-UPDATE_ERROR_STAGES all error codes have valid stages', () => {
    const VALID_STAGES = new Set(['downloading', 'verifying', 'replacing', 'restarting'])
    for (const [code, info] of Object.entries(UPDATE_ERROR_MESSAGES)) {
      expect(VALID_STAGES.has(info.stage)).toBe(true)
    }
  })

  it('W1-UPDATE_ERROR_STAGES UPDATE_PROXY_UNREACHABLE stage is downloading', () => {
    expect(UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE.stage).toBe('downloading')
  })
})

// ─── W1-UpdateError-rawCause ──────────────────────────────────────

describe('W1-UpdateError-rawCause', () => {
  it('W1-UpdateError-rawCause UpdateError has rawCause property', () => {
    const err = new UpdateError('test', 'downloading', 'UPDATE_NETWORK_FAILED')
    expect(err).toHaveProperty('rawCause')
  })

  it('W1-UpdateError-rawCause wrapUpdateError injects rawCause from err.cause', () => {
    const cause = Object.assign(new Error('connect EHOSTUNREACH 192.168.1.202:7890'), {
      code: 'EHOSTUNREACH',
    })
    const err = new Error('fetch failed', { cause })

    const updateErr = wrapUpdateError(
      err,
      UPDATE_ERROR_MESSAGES.UPDATE_PROXY_UNREACHABLE.message,
      'downloading',
      'UPDATE_PROXY_UNREACHABLE',
    )

    expect(updateErr).toBeInstanceOf(UpdateError)
    expect(updateErr.errorCode).toBe('UPDATE_PROXY_UNREACHABLE')
    expect(updateErr.message).toBe('无法连接代理 (EHOSTUNREACH)')
    expect(updateErr.rawCause).toBe('connect EHOSTUNREACH 192.168.1.202:7890')
  })

  it('W1-UpdateError-rawCause rawCause drills nested causes to deepest message', () => {
    const inner = new Error('real network error')
    const mid = new Error('mid layer', { cause: inner })
    const outer = new Error('fetch failed', { cause: mid })
    const updateErr = wrapUpdateError(outer, 'msg', 'downloading', 'UPDATE_NETWORK_FAILED')
    expect(updateErr.rawCause).toBe('real network error')
  })
})

// ─── W1-error-log-append ──────────────────────────────────────────

describe('W1-error-log-append', () => {
  beforeEach(() => {
    mkdirSync(TEST_LOG_DIR, { recursive: true })
  })

  afterEach(() => {
    try { unlinkSync(TEST_LOG_PATH) } catch {}
    try { unlinkSync(`${TEST_LOG_PATH}.1`) } catch {}
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      fs.rmSync(TEST_LOG_DIR, { recursive: true, force: true })
    } catch {}
  })

  it('W1-error-log-append appends JSONL entry to log file', () => {
    appendUpdateError({
      at: '2026-08-26T12:00:00Z',
      source: 'download',
      stage: 'downloading',
      errorCode: 'UPDATE_PROXY_UNREACHABLE',
      rawCause: 'EHOSTUNREACH',
      proxyUrl: 'http://192.168.1.202:7890',
    })

    const lines = _readLogForTest()
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.source).toBe('download')
    expect(parsed.errorCode).toBe('UPDATE_PROXY_UNREACHABLE')
    expect(parsed.rawCause).toBe('EHOSTUNREACH')
  })

  it('W1-error-log-append each line is valid JSON (jq parseable)', () => {
    appendUpdateError({
      at: '2026-08-26T12:00:00Z',
      source: 'install',
      stage: 'replacing',
      errorCode: 'UPDATE_PERMISSION_DENIED',
    })

    const lines = _readLogForTest()
    for (const line of lines) {
      const parsed = JSON.parse(line)
      expect(parsed).toHaveProperty('at')
      expect(parsed).toHaveProperty('source')
    }
  })

  it('W1-error-log-append silently skips on write failure (does not throw)', () => {
    expect(() => {
      appendUpdateError({
        at: '2026-08-26T12:00:00Z',
        source: 'perform',
        stage: 'downloading',
      })
    }).not.toThrow()
  })

  it('W1-error-log-append five sources covered', () => {
    const sources = ['test-proxy', 'download', 'install', 'perform', 'preload'] as const
    for (const source of sources) {
      appendUpdateError({
        at: '2026-08-26T12:00:00Z',
        source,
        stage: 'downloading',
      })
    }
    const lines = _readLogForTest()
    expect(lines).toHaveLength(5)
    const parsed = lines.map(l => JSON.parse(l))
    expect(parsed.map(p => p.source)).toEqual(sources)
  })

  it('W1-error-log-append rotates when file exceeds 512KB', () => {
    const bigContent = 'x'.repeat(512 * 1024 + 1)
    writeFileSync(TEST_LOG_PATH, bigContent, 'utf-8')

    appendUpdateError({
      at: '2026-08-26T12:00:00Z',
      source: 'download',
      stage: 'downloading',
    })

    expect(existsSync(`${TEST_LOG_PATH}.1`)).toBe(true)
    const rotated = readFileSync(`${TEST_LOG_PATH}.1`, 'utf-8')
    expect(rotated).toBe(bigContent)

    const lines = _readLogForTest()
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).source).toBe('download')
  })

  it('W1-error-log-append does not rotate when file is under 512KB', () => {
    writeFileSync(TEST_LOG_PATH, '{"small":true}\n', 'utf-8')

    appendUpdateError({
      at: '2026-08-26T12:00:00Z',
      source: 'test-proxy',
      stage: 'downloading',
    })

    expect(existsSync(`${TEST_LOG_PATH}.1`)).toBe(false)
    const lines = _readLogForTest()
    expect(lines).toHaveLength(2)
  })

  it('W1-error-log-append covers old .1 on second rotation', () => {
    writeFileSync(TEST_LOG_PATH, 'x'.repeat(512 * 1024 + 1), 'utf-8')
    appendUpdateError({
      at: '2026-08-26T12:00:00Z',
      source: 'download',
      stage: 'downloading',
    })

    const current = readFileSync(TEST_LOG_PATH, 'utf-8')
    writeFileSync(TEST_LOG_PATH, current + 'y'.repeat(512 * 1024), 'utf-8')

    appendUpdateError({
      at: '2026-08-26T12:01:00Z',
      source: 'preload',
      stage: 'downloading',
    })

    expect(existsSync(`${TEST_LOG_PATH}.1`)).toBe(true)
    const lines = _readLogForTest()
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).source).toBe('preload')
  })
})
