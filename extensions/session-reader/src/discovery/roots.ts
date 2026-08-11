import { readdir, stat, open, type FileHandle } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * M2 discovery 发现层：文件系统扫描（design §3.3 D-5 首行扫描策略的文件定位部分）。
 *
 * agentDir 注入：本模块所有函数接收 `agentDir: string` 参数，**不调用** `getAgentDir()`
 *（pi SDK，调用留到 M3 tool-adapter 层）。故本模块零 pi 依赖，仅 node:fs + 相对
 * import M1 core，可完全单测。
 */

export interface SessionFileMeta {
  /** 绝对路径 */
  path: string
  mtime: number
  size: number
}

/**
 * main sessions 扫描时整体跳过的子目录名。
 * `workflow-state` 目录存放 workflow 运行状态文件（wf-*.jsonl，首行 `{"v":"wf-run-v1"...}`），
 * 非 session 文件——属 family 腿独立处理（design §3.3 D-7），扫描 main sessions 时排除，
 * 否则会把 wf 文件误收为 session（且 find.ts 读其首行 header 时会因 type≠session 被丢弃，
 * 在此排除可避免这批无效首行扫描）。
 */
const SKIP_DIRS_MAIN = new Set(['workflow-state'])

/**
 * 文件名是否为待收的 session .jsonl。
 * `.jsonl.finalized` 不以 `.jsonl` 结尾，故 `endsWith('.jsonl')` 天然排除之
 *（design §3.3 D-7 Q2：finalized 是已完成态快照副本，与 .jsonl 同 base name 并存，不收）。
 */
function isSessionJsonl(name: string): boolean {
  return name.endsWith('.jsonl')
}

/**
 * 递归扫描 rootDir 下所有 .jsonl 文件（排除 .finalized），返回绝对路径 + mtime + size。
 * `skipDirs` 命名的目录整体跳过。目录不存在/无权限 → 返回空数组，不抛错（design §2 坏路径容错）。
 */
async function scanJsonlRecursive(
  rootDir: string,
  skipDirs: Set<string>,
): Promise<SessionFileMeta[]> {
  const results: SessionFileMeta[] = []

  async function walk(currentDir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      return // 目录不存在/无权限 → 静默返回（容错，listXxxSessions 契约要求不抛错）
    }
    for (const entry of entries) {
      const full = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        await walk(full)
      } else if (entry.isFile() && isSessionJsonl(entry.name)) {
        try {
          const s = await stat(full)
          results.push({ path: full, mtime: s.mtimeMs, size: s.size })
        } catch {
          // 文件并发删除等致 stat 失败 → 跳过（不中断整体扫描）
        }
      }
    }
  }

  await walk(rootDir)
  return results
}

/**
 * 列出 agentDir/sessions/ 下所有主 session 文件。
 * 递归扫描子目录（cwd 编码目录如 --Users-foo--），glob *.jsonl，排除 *.jsonl.finalized
 *（design §3.3 D-7 Q2）；跳过 workflow-state 子目录（workflow 运行状态文件，非 session）。
 */
export async function listMainSessions(agentDir: string): Promise<SessionFileMeta[]> {
  return scanJsonlRecursive(join(agentDir, 'sessions'), SKIP_DIRS_MAIN)
}

/**
 * 列出 agentDir/subagents/ 下所有 subagent session 文件（同样排除 .finalized）。
 * 结构：subagents/<cwd编码>/sessions/*.jsonl。records/ 子目录（.json manifest）无 .jsonl，
 * 天然不被误收。
 */
export async function listSubagentSessions(agentDir: string): Promise<SessionFileMeta[]> {
  return scanJsonlRecursive(join(agentDir, 'subagents'), new Set())
}

// ── 全局 session id 提取（O5 修复：# 补全唯一前缀的全局作用域）──────────────────

/**
 * session 文件名内的标准 uuid v7（**5 组 4 连字符**：8-4-4-4-12）。
 * 文件名形如 `<ISO-timestamp>_<uuid>.jsonl`
 *（如 2026-05-28T03-17-12-844Z_019e6c96-0a0c-74b8-a73f-d1854d88e2a7.jsonl）。
 *
 * 注意：uuid 是 8-4-4-4-12（5 组），非 8-4-4-4-4-12（6 组）。
 */
const SESSION_UUID_IN_NAME = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

/** orphan 首行读取上限（与 find.ts HEADER_READ_BYTES 同值；session header < 300B，8KB 余量足）。 */
const HEADER_READ_BYTES = 8192

/**
 * 读文件首行（session header）的 id 字段（orphan 回退用）。
 *
 * 与 find.ts 的 readFirstLine + parseHeader 同构——roots 不 import find（find 依赖 roots，
 * 反向 import 会循环），故 roots 内独立实现。坏文件/非 session header → undefined。
 */
async function readHeaderId(filePath: string): Promise<string | undefined> {
  let fh: FileHandle | undefined
  try {
    fh = await open(filePath, 'r')
    const buf = Buffer.alloc(HEADER_READ_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEADER_READ_BYTES, 0)
    if (bytesRead === 0) return undefined
    const line = buf.subarray(0, bytesRead).toString('utf8').split('\n')[0]
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return undefined
    }
    if (typeof raw !== 'object' || raw === null) return undefined
    const obj = raw as Record<string, unknown>
    if (obj.type !== 'session' || typeof obj.id !== 'string') return undefined
    return obj.id
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * 列出 agentDir/sessions/ 下所有主 session 的 id（全局，跨 cwd）。
 *
 * **用途**：# 补全 insertText 唯一前缀的全局作用域（hash-provider / session-command）。
 * findSessions 全局扫 agentDir，故唯一前缀也须对全局 id 集计算——否则跨 cwd 碰撞时
 * #→find 多匹配（O5 must-fix：per-cwd 唯一在全局 find 时失效）。
 *
 * **两阶段提取**（实测 ~/.pi/agent 4039 文件：冷启动 ~82ms / 热缓存 ~50ms，均 < 100ms）：
 * 1. 文件名匹配 `<timestamp>_<uuid>.jsonl`（86%）→ 纯文件名 regex 提取，零文件 IO
 * 2. 文件名不含 uuid（14% orphan，如 `session.jsonl`）→ Promise.all 并发读首行 header.id
 *
 * **orphan 必须纳入**：实测 50/549 orphan 的 id 前 8 字符与 timestamp 文件碰撞，漏掉会
 * 破坏全局唯一性保证（碰撞桶缺成员 → 唯一前缀算短 → find 仍多匹配）。
 *
 * 不 stat（只需 id，不需 mtime/size）。排除 .finalized + workflow-state（同 listMainSessions）。
 * 目录不存在/无权限 → 空数组（同 listMainSessions 容错契约）。
 */
export async function listGlobalSessionIds(agentDir: string): Promise<string[]> {
  const ids: string[] = []
  const orphans: string[] = []
  const sessionsDir = join(agentDir, 'sessions')

  async function walk(currentDir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      return // 目录不存在/无权限 → 静默返回（容错，同 listMainSessions 契约）
    }
    for (const entry of entries) {
      const full = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS_MAIN.has(entry.name)) continue
        await walk(full)
      } else if (entry.isFile() && isSessionJsonl(entry.name)) {
        const m = entry.name.match(SESSION_UUID_IN_NAME)
        if (m) {
          // m[0] 含末尾 .jsonl，剥 6 字符得纯 uuid
          ids.push(m[0].slice(0, -'.jsonl'.length))
        } else {
          orphans.push(full)
        }
      }
    }
  }

  await walk(sessionsDir)

  if (orphans.length > 0) {
    const orphanIds = await Promise.all(orphans.map((p) => readHeaderId(p)))
    for (const id of orphanIds) {
      if (id) ids.push(id)
    }
  }
  return ids
}
