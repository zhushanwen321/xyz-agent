/**
 * TokenManager —— wave1 远程化访问令牌管理（W1-T2）。
 *
 * 职责：
 * - load()：读取并缓存 token 文件（启动时一次，后续命中缓存避免每连接 IO）。
 *   返回判别联合：enabled=false 表示开放模式（无 token 文件或文件空）；enabled=true 携带 token。
 * - generate()：生成 base64url 编码的 32 字节随机 token（256 bit 熵）。
 * - verify()：timingSafeEqual 常量时间比对（防时序侧信道）。candidate 长度不符直接返回 false
 *   （timingSafeEqual 对不等长 Buffer 抛错，前置 length 检查规避）。
 * - persist()：以 0o600 权限写 token 文件 + 修正已存在文件权限，并刷新缓存。
 *
 * 设计取舍：
 * - load() 同步签名（readFileSync）。调用方 ConnectionManager.handleConnection 处于 WS
 *   'connection' 事件同步上下文（非 async），load 必须同步。启动一次性读，后续走缓存，verify
 *   也不触发 IO（用缓存 token）。
 * - 缓存 null 哨兵区分「未加载」与「已加载 enabled:false」，避免每连接重读文件。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'

export interface LoadedTokenEnabled {
  enabled: true
  token: string
}
export interface LoadedTokenDisabled {
  enabled: false
}
export type LoadedToken = LoadedTokenEnabled | LoadedTokenDisabled

export interface TokenManager {
  load(): LoadedToken
  generate(): string
  verify(candidate: string): boolean
  persist(token: string): void
}

export interface TokenManagerOptions {
  tokenFile?: string
}

export function createTokenManager(opts: TokenManagerOptions): TokenManager {
  // null = 未加载；首次 load 后缓存结果，后续命中缓存避免重复 IO。
  let cached: LoadedToken | null = null

  return {
    load(): LoadedToken {
      if (cached) return cached
      if (!opts.tokenFile) {
        cached = { enabled: false }
        return cached
      }
      let content: string
      try {
        content = readFileSync(opts.tokenFile, 'utf8')
      } catch {
        // 文件不存在/不可读 → 视为开放模式（与未配置 tokenFile 等价）。
        cached = { enabled: false }
        return cached
      }
      const token = content.trim()
      if (!token) {
        console.warn('[runtime] token file is empty, running in open mode')
        cached = { enabled: false }
        return cached
      }
      cached = { enabled: true, token }
      return cached
    },

    generate(): string {
      // 32 字节 = 256 bit 熵（base64url 编码后 ~43 字符），token 强度标准值。
      // eslint-disable-next-line no-magic-numbers -- 32 bytes 是密码学 token 的标准熵长度
      return randomBytes(32).toString('base64url')
    },

    verify(candidate: string): boolean {
      const loaded = this.load()
      if (!loaded.enabled) return false
      const a = Buffer.from(candidate)
      const b = Buffer.from(loaded.token)
      // timingSafeEqual 要求两 Buffer 等长，否则抛 RangeError；前置 length 检查。
      if (a.length !== b.length) return false
      return timingSafeEqual(a, b)
    },

    persist(token: string): void {
      if (!opts.tokenFile) throw new Error('tokenFile not configured')
      // 0o600：仅 owner 可读写（token 是高敏感凭据）。writeFileSync 新建文件用 mode，
      // 但已存在文件 mode 不变，故追加 chmodSync 兜底修正权限。
      writeFileSync(opts.tokenFile, token, { mode: 0o600 })
      try {
        // eslint-disable-next-line no-magic-numbers -- 同上，owner-only 权限修正
        chmodSync(opts.tokenFile, 0o600)
      // eslint-disable-next-line taste/no-silent-catch -- chmod 失败（不支持权限模型的 FS）不阻断持久化
      } catch {
        // chmod 失败（如不支持权限模型的 FS）不阻断——文件已写入，仅权限可能偏宽。
      }
      cached = { enabled: true, token }
    },
  }
}
