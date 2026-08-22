/**
 * XyzProviderStore — xyz 扩展域 providers.json 的唯一读写者。
 *
 * 文件：`<piAgentDir>/config/providers.json`（路径 SSOT = pi-paths.getProviderExtrasPath）。
 * 承载自 pi models.json 迁出的 xyz 私有字段（provider 级 quota/authMethod、
 * models[].enabled 转化的 modelStates），models.json 只留 pi schema 内字段——
 * pi 升级收紧 schema 时 xyz 配置零迁移风险（provider-config-quota 架构 G3/D4）。
 *
 * 并发安全：读-改-写全程 proper-lockfile 锁（与 auth-storage.ts 的 AuthStorage 同模式、
 * 同参数——pi 侧/多实例并发写 providers.json 时 RMW 后写者基于陈旧读覆盖先写者）；
 * 写走 atomicWrite（tmp + rename）。损坏容错复用 quarantineCorruptFile（rename 为
 * `<path>.corrupt-<ts>` 保留取证 + 按空配置继续，与 JsonStore 隔离行为同源）。
 *
 * 注意：本文件不存放凭证明文（cookieSet/apiKeySet 只是布尔标记），无需 0600。
 * 实例模式（构造传 filePath），组合根创建单例注入消费方——与 AuthStorage 同构。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { atomicWrite } from '../utils/fs-utils.js'
import { quarantineCorruptFile } from '../utils/json-store.js'

/** providers.json 文件结构（version 留未来迁移钩子，当前恒 1）。 */
export interface ProviderExtrasFile {
  version: 1
  providers: Record<string, ProviderExtras>
  /** 模型白名单（scopedModels），条目为 provider/modelId 复合串。空/缺失 = 未启用（显示全部）。 */
  scopedModels?: string[]
}

/** 单 provider 的 xyz 扩展数据（全部字段自 models.json 寄生字段迁出，语义不变）。 */
export interface ProviderExtras {
  /** 凭证形态标注（自 models.json providers.<id>.authMethod 迁入）。 */
  authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
  /** 套餐额度绑定（自 models.json providers.<id>.quota 迁入，含 cookieSet/apiKeySet 布尔态）。 */
  quota?: {
    fetcher?: string
    enabled: boolean
    cookieSet?: boolean
    apiKeySet?: boolean
  }
  /** 模型启停（自 models.json providers.<id>.models[].enabled 迁入，key = modelId）。 */
  modelStates?: Record<string, { enabled: boolean }>
}

const EMPTY_FILE: ProviderExtrasFile = { version: 1, providers: {} }

/** JSON 序列化缩进（与 pi models.json / auth.json 输出格式一致，2 空格）。 */
const JSON_INDENT = 2
/** 损坏 shape 诊断消息中的 JSON 快照截断长度（防超长内容刷屏日志）。 */
const SCHEMA_SNIPPET_MAX = 120

/**
 * 跨进程写锁：参数对齐 AuthStorage.withFileLock（retries 10/factor 2/minTimeout 100/
 * maxTimeout 10s/randomize + stale 30s + onCompromised throw），锁文件为
 * `<providers.json>.lock`。proper-lockfile realpath 需要目标文件存在——锁前
 * ensureFileExists 建空结构（写路径专用；读路径不持锁不物化文件）。
 */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  ensureFileExists(filePath)
  let compromised: Error | undefined
  const release = await lockfile.lock(filePath, {
    retries: {
      retries: 10,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 10_000,
      randomize: true,
    },
    stale: 30_000,
    onCompromised: (err) => { compromised = err },
  })
  try {
    if (compromised) throw compromised
    return await fn()
  } finally {
    try {
      await release()
    } catch (error) {
      // 对齐 AuthStorage：compromised 之外的 unlock 失败需可观测（锁可能被外部删）
      console.warn('[provider-extras-store] release lock failed (continuing, lock may be compromised):', error)
    }
  }
}

/** 锁前保证文件存在（proper-lockfile realpath 需要）。同时确保 config/ 父目录存在。 */
function ensureFileExists(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(filePath)) {
    writeFileSync(filePath, JSON.stringify(EMPTY_FILE, null, JSON_INDENT), 'utf-8')
  }
}

/**
 * 读并解析 providers.json。文件不存在返回空结构（读路径不物化文件）。
 * 损坏（非法 JSON / version 非 1）→ quarantineCorruptFile 隔离为
 * `<path>.corrupt-<ts>` 后按空配置继续（设计文档 §3.4 错误规格：按空配置启动，
 * 备份坏文件供人工恢复——隔离是 rename 语义，原位置不会被后续写覆盖坏文件内容）。
 */
function readInternal(filePath: string): ProviderExtrasFile {
  if (!existsSync(filePath)) return { version: 1, providers: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (cause) {
    quarantineCorruptFile(filePath, { tag: 'provider-extras-store', reason: 'parse failed', cause })
    return { version: 1, providers: {} }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (parsed as ProviderExtrasFile).version !== 1
    // providers: null 必须显式排除：typeof null === 'object' 会让下方类型检查穿透，
    // null 原样返回后消费方（readAllExtrasWithFallback 的 merged[key] 赋值）TypeError
    // 且不触发隔离自愈（round 1 review must-fix #5）
    || (parsed as ProviderExtrasFile).providers === null
    // providers: [] 同理穿透：typeof [] === 'object'，数组形态原样返回后 modify 对其
    // 赋字符串键属性，JSON.stringify 序列化数组只留索引项 → 写盘静默丢弃、文件永久
    // 停留损坏形态无自愈（round 2 review must-fix）
    || Array.isArray((parsed as ProviderExtrasFile).providers)
    || typeof (parsed as ProviderExtrasFile).providers !== 'object'
    // 条目级形态：providers: {"foo": null} 穿透后 getExtrasSync('foo') 返回 null 与
    // 签名 ProviderExtras | undefined 失实，消费方 !== undefined 判定被 null 欺骗
    // （round 2 review suggestion）
    || !Object.values((parsed as ProviderExtrasFile).providers).every(
      entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    )) {
    quarantineCorruptFile(filePath, {
      tag: 'provider-extras-store',
      reason: 'schema mismatch (expect { version: 1, providers: {} })',
      cause: new Error(`unexpected shape: ${JSON.stringify(parsed).slice(0, SCHEMA_SNIPPET_MAX)}`),
    })
    return { version: 1, providers: {} }
  }
  return parsed as ProviderExtrasFile
}

/** 原子写（tmp + rename）+ 确保父目录。恒写 version: 1。 */
function writeInternal(filePath: string, file: ProviderExtrasFile): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  atomicWrite(filePath, JSON.stringify({ ...file, version: 1 }, null, JSON_INDENT))
}

/** providers.json 的唯一读写者。所有写入必须经 modify/delete（RMW 锁内）。 */
export class XyzProviderStore {
  constructor(private readonly filePath: string) {}

  /** 读全部 provider 扩展数据。文件不存在/损坏 → 空对象（不抛错）。 */
  async readAll(): Promise<Record<string, ProviderExtras>> {
    return readInternal(this.filePath).providers
  }

  /** 读单 provider 扩展数据。无条目 → undefined。 */
  async getExtras(providerId: string): Promise<ProviderExtras | undefined> {
    return readInternal(this.filePath).providers[providerId]
  }

  /**
   * 同步读全部扩展数据（readAll 的同步版）。同步契约的消费方（listProviders 聚合层，
   * IConfigService 同步接口）用；与 async 版同一 readInternal（读路径不持锁、不缓存，
   * 每次调用读盘）——先例：AuthStorage.hasCredentialSync / listCredentialIds。
   */
  readAllSync(): Record<string, ProviderExtras> {
    return readInternal(this.filePath).providers
  }

  /** 同步读单 provider 扩展数据（getExtras 的同步版，无条目 → undefined）。 */
  getExtrasSync(providerId: string): ProviderExtras | undefined {
    return readInternal(this.filePath).providers[providerId]
  }

  /**
   * RMW 单入口：锁内重读最新文件 → fn(current) 计算新值 → 原子写回。
   * current 是该 provider 当前扩展数据（无条目时 undefined）；返回值整条替换。
   * 并发 modify 同 provider 由锁串行化（后者基于前者的结果计算）。
   */
  async modify(
    providerId: string,
    fn: (current: ProviderExtras | undefined) => ProviderExtras,
  ): Promise<ProviderExtras> {
    let result: ProviderExtras | undefined
    await withFileLock(this.filePath, async () => {
      const file = readInternal(this.filePath)
      result = fn(file.providers[providerId])
      file.providers[providerId] = result
      writeInternal(this.filePath, file)
    })
    return result!
  }

  /**
   * 删除 provider 扩展条目。幂等：条目不存在时跳过写；文件不存在时直接返回
   * （不物化 providers.json——对齐 AuthStorage.remove 的「无内容不产生文件」语义）。
   */
  async delete(providerId: string): Promise<void> {
    if (!existsSync(this.filePath)) return
    await withFileLock(this.filePath, async () => {
      const file = readInternal(this.filePath)
      if (!(providerId in file.providers)) return
      delete file.providers[providerId]
      writeInternal(this.filePath, file)
    })
  }

  /**
   * 读取模型白名单（scopedModels）。非法值容错：非 string[] 整体视为空、
   * 条目不匹配 `^[^/]+/.+$` 的过滤掉并 log warning。
   */
  getScopedModels(): string[] {
    const file = readInternal(this.filePath)
    const raw = file.scopedModels
    if (!Array.isArray(raw)) return []
    const VALID_MODEL_RE = /^[^/]+\/.+$/
    const result: string[] = []
    for (const entry of raw) {
      if (typeof entry !== 'string') {
        console.warn('[provider-extras-store] scopedModels: non-string entry filtered out:', entry)
        continue
      }
      if (!VALID_MODEL_RE.test(entry)) {
        console.warn('[provider-extras-store] scopedModels: invalid entry format (expected provider/modelId):', entry)
        continue
      }
      result.push(entry)
    }
    return result
  }

  /**
   * RMW 模型白名单：锁内重读 → fn(current) → 原子写回。
   * 与 modify 同一 withFileLock 锁，天然与 per-provider 写串行。
   */
  async modifyScopedModels(fn: (cur: string[]) => string[]): Promise<string[]> {
    let result: string[] | undefined
    await withFileLock(this.filePath, async () => {
      const file = readInternal(this.filePath)
      const current = Array.isArray(file.scopedModels) ? file.scopedModels : []
      result = fn(current)
      file.scopedModels = result
      writeInternal(this.filePath, file)
    })
    return result!
  }
}
