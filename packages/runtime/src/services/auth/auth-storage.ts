/**
 * auth.json 凭据存储（OAuth 路径 B 自实现）。
 *
 * 镜像 pi FileAuthStorageBackend 的 RMW 语义（写前重读最新文件，防丢更新），
 * 差异：跨进程锁（proper-lockfile）改为进程内 per-file promise-chain mutex——
 * 本模块只服务单一 runtime 进程，跨进程并发写不是真实场景，进程内串行化
 * 已消除 RMW 竞态（slice M1 修复目标）。
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

export interface OAuthCredential {
  type: 'oauth'
  access: string
  refresh?: string
  expires: number
  [k: string]: unknown
}

/** per-file 写互斥链：同一文件的所有写操作串行执行（RMW 全程持锁） */
const fileMutexes = new Map<string, Promise<unknown>>()

/**
 * 进程内 per-file mutex：把 fn 排到该文件已有链尾。
 * Map 里存的是永不复用的吞错链（catch 后继续），返回给调用方的是带错误的原始链。
 */
function withFileMutex<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileMutexes.get(filePath) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  fileMutexes.set(filePath, next.then(
    () => undefined,
    () => undefined,
  ))
  return next
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
function readAuthFile(filePath: string): Record<string, OAuthCredential> {
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

  async get(providerId: string): Promise<OAuthCredential | undefined> {
    return readAuthFile(this.filePath)[providerId]
  }

  async getAll(): Promise<Record<string, OAuthCredential>> {
    return readAuthFile(this.filePath)
  }

  /** RMW：锁内重读最新文件 → merge 单 provider → 原子写回 */
  async set(providerId: string, credential: OAuthCredential): Promise<void> {
    await withFileMutex(this.filePath, async () => {
      const data = readAuthFile(this.filePath)
      data[providerId] = credential
      // eslint-disable-next-line no-magic-numbers -- 缩进 2 空格，与 pi FileAuthStorageBackend 输出格式一致
      writeFileAtomic(this.filePath, JSON.stringify(data, null, 2))
    })
  }

  /** 幂等：provider 不存在时跳过写（避免无谓的磁盘 IO） */
  async remove(providerId: string): Promise<void> {
    await withFileMutex(this.filePath, async () => {
      const data = readAuthFile(this.filePath)
      if (!(providerId in data)) return
      delete data[providerId]
      // eslint-disable-next-line no-magic-numbers -- 缩进 2 空格，与 pi FileAuthStorageBackend 输出格式一致
      writeFileAtomic(this.filePath, JSON.stringify(data, null, 2))
    })
  }

  async hasOAuth(providerId: string): Promise<boolean> {
    return readAuthFile(this.filePath)[providerId]?.type === 'oauth'
  }
}
