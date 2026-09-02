import { readdir, stat } from 'node:fs/promises'
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
 * `workflow-state` 目录存放 workflow 运行状态文件（wf-*.jsonl，首行 `{"v":"wf-run-v1"|"wf-run-v2"...}`，
 * 版本随 subagent-workflow 快照格式演进，读取侧 v1/v2 兼容），非 session 文件——属 family 腿
 * 独立处理（design §3.3 D-7），扫描 main sessions 时排除，
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
        } catch (err) {
          // 文件并发删除等致 stat 失败 → 跳过（不中断整体扫描）；
          // 本模块零 pi 依赖（无 logger 可用），不留 void err 以外的语句
          void err
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

