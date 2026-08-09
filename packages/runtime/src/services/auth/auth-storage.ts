/**
 * auth.json 凭据存储（OAuth 路径 B 自实现）。
 *
 * 镜像 pi FileAuthStorageBackend 的 RMW 语义（写前重读最新文件，防丢更新），
 * 跨进程锁用 proper-lockfile（与 pi 同一把锁、同一路径语义：<auth.json>.lock）——
 * pi 侧 resolveStoredOAuth 在 token 过期时持锁刷新并写回 auth.json，与 xyz-agent
 * login 写入是真实跨进程并发写场景；进程内 mutex 只能串行化本进程写入，无跨进程锁时
 * RMW 后写者基于陈旧读覆盖先写者，轮换后的 refresh_token 会丢失（anthropic 等
 * 轮换 refresh token 的 provider 掉登录）。
 *
 * 安全约束：文件内容是 OAuth token，权限 0600；任何路径不得打印 credential。
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import lockfile from 'proper-lockfile'

export interface ApiKeyCredential {
  type: 'api_key'
  key: string
  env?: Record<string, string>
}

export interface OAuthCredential {
  type: 'oauth'
  access: string
  refresh?: string
  expires: number
  [k: string]: unknown
}

export type Credential = ApiKeyCredential | OAuthCredential

/**
 * 跨进程写锁：proper-lockfile 锁 auth.json，参数对齐 pi FileAuthStorageBackend.withLockAsync
 * （retries 10/factor 2/minTimeout 100/maxTimeout 10s/randomize + stale 30s），与 pi 侧
 * 刷新写回互斥同一把锁（<auth.json>.lock）。
 * proper-lockfile realpath 默认 true，目标文件不存在时 realpath ENOENT 拿不到锁——
 * 先按 pi 同款 ensureFileExists 建空文件（0600）再锁。
 */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  ensureFileExists(filePath)
  // onCompromised：锁被判定 stale 抢占（进程卡死超时等）时标记，fn 执行前抛错，
  // 防止在失去互斥保证的锁下写盘（对齐 pi throwIfCompromised 语义）。
  let compromised: Error | undefined
  const release = await lockfile.lock(filePath, {
    retries: {
      retries: 10,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 10_000,
      randomize: true,
    },
    // eslint-disable-next-line no-magic-numbers -- stale 30s 与 pi 一致（进程卡死超时视为锁失效）
    stale: 30_000,
    onCompromised: (err) => { compromised = err },
  })
  try {
    if (compromised) throw compromised
    return await fn()
  } finally {
    try {
      await release()
    } catch {
      // 锁已 compromised 时 unlock 失败可忽略（对齐 pi finally 的 catch 语义）
    }
  }
}

/** 与 pi FileAuthStorageBackend.ensureFileExists 同款：锁前保证文件存在（proper-lockfile realpath 需要） */
function ensureFileExists(filePath: string): void {
  if (!existsSync(filePath)) {
    // eslint-disable-next-line no-magic-numbers -- 0o600：仅 owner 可读写（文件含 token）
    writeFileSync(filePath, '{}', { encoding: 'utf-8', mode: 0o600 })
    chmodSync(filePath, 0o600)
  }
}

/**
 * 原子写：tmp 文件（同目录保证 rename 同文件系统）→ fsync → rename → chmod 0600。
 * open 时即指定 0600，rename 后再 chmod 一次兜底（rename 保留 tmp 的 mode，
 * 但显式 chmod 使权限位不依赖实现细节）。
 */
function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`
  // eslint-disable-next-line no-magic-numbers -- 0o600：仅 owner 可读写（文件含 token）
  const fd = openSync(tmpPath, 'w', 0o600)
  try {
    writeFileSync(fd, content, 'utf-8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, filePath)
  // eslint-disable-next-line no-magic-numbers -- 0o600：rename 保留 tmp 的 mode，显式 chmod 兜底
  chmodSync(filePath, 0o600)
}

/**
 * 读并解析 auth.json。文件不存在按空对象（首次写入前 get 是合法路径）；
 * JSON 损坏抛错（不静默返回空——损坏意味着有外部写坏或磁盘问题，
 * 静默吞掉会让用户以为凭据被删了）。
 */
function readAuthFile(filePath: string): Record<string, Credential> {
  if (!existsSync(filePath)) return {}
  const raw = readFileSync(filePath, 'utf-8')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw) as Record<string, OAuthCredential>
  } catch (cause) {
    throw new Error(`auth.json 损坏: ${filePath}`, { cause })
  }
}

export class AuthStorage {
  constructor(private readonly filePath: string) {}

  async get(providerId: string): Promise<Credential | undefined> {
    return readAuthFile(this.filePath)[providerId]
  }

  async getAll(): Promise<Record<string, Credential>> {
    return readAuthFile(this.filePath)
  }

  /** RMW：锁内重读最新文件 → merge 单 provider → 原子写回 */
  async set(providerId: string, credential: Credential): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const data = readAuthFile(this.filePath)
      data[providerId] = credential
      // eslint-disable-next-line no-magic-numbers -- 缩进 2 空格，与 pi FileAuthStorageBackend 输出格式一致
      writeFileAtomic(this.filePath, JSON.stringify(data, null, 2))
    })
  }

  /** 幂等：provider 不存在时跳过写（避免无谓的磁盘 IO）。文件不存在时直接返回——
   * 没有可读可删的内容，且避免 withFileLock 的 ensureFileExists 在 remove 路径物化空
   * auth.json（从未使用过 OAuth 的用户目录每次保存 API Key 都会走 remove，不该产生文件）。
   * 注意：set()/getAll() 等其余路径仍需 ensureFileExists（proper-lockfile realpath 需要文件存在）。 */
  async remove(providerId: string): Promise<void> {
    if (!existsSync(this.filePath)) return
    await withFileLock(this.filePath, async () => {
      const data = readAuthFile(this.filePath)
      if (!(providerId in data)) return
      delete data[providerId]
      // eslint-disable-next-line no-magic-numbers -- 缩进 2 空格，与 pi FileAuthStorageBackend 输出格式一致
      writeFileAtomic(this.filePath, JSON.stringify(data, null, 2))
    })
  }

  /**
   * 同步判 auth.json 内存快照中有该 providerId 的任意 type 条目（api_key 或 oauth）。
   * 用于 listProviders 替代 hasOAuthSync 的 oauth-only 判定。
   * 写是原子 rename，读永远拿到完整文件。
   */
  hasCredentialSync(providerId: string): boolean {
    return providerId in readAuthFile(this.filePath)
  }

  /**
   * 同步列出 auth.json 顶层所有 providerId（provider key 列表）。
   * wave2 listProviders 双源聚合 catalog 源用（C4 推荐方案）：聚合 (auth.json keys ∪
   * models.json catalog keys) ∩ builtinData，修复 F1（catalog 凭据在 auth.json 但
   * models.json 无该条目时也能显示）。文件不存在/空 → []，与 hasCredentialSync 同源
   * （复用 readAuthFile 私有核心，写是原子 rename 读永远拿完整文件）。
   */
  listCredentialIds(): string[] {
    return Object.keys(readAuthFile(this.filePath))
  }

  /** @deprecated 用 hasCredentialSync 替代（支持 api_key + oauth 联合类型） */
  async hasOAuth(providerId: string): Promise<boolean> {
    return readAuthFile(this.filePath)[providerId]?.type === 'oauth'
  }

  /**
   * @deprecated 用 hasCredentialSync 替代（支持 api_key + oauth 联合类型）。
   * 同步版 hasOAuth（listProviders 是同步契约，M6 status 派生用）。
   * 与异步版读同一 readAuthFile（同步核心）；写是原子 rename，读永远拿到完整文件。
   */
  hasOAuthSync(providerId: string): boolean {
    return readAuthFile(this.filePath)[providerId]?.type === 'oauth'
  }
}
