/**
 * kill 回路的 registry 写工具（D6 分支矩阵的写侧；锁内版——调用方持
 * `<registry.json>.lock`，与 extension 写侧 / reaper 写侧互斥同一把锁）。
 *
 * 为什么只有 Locked 版：D6 分支①③要求「锁内重读 → 判活重查 → 写」在同一锁临界区
 * 内完成（防 stale 条目覆盖 poller 已写的新鲜终态——writeMerged 范式），嵌套取锁
 * 必然 ELOCKED（file-lock 契约），故写原语必须无锁化，锁编排归 kill 流程
 * （background-task-service.ts killTask）。
 *
 * orphaned 终态写复用 reaper 提炼导出的 writeOrphanedTerminalLocked（②③属主死分支，
 * 对齐 reaper 分支②③语义）；本文件只补 kill 特有的两种写：
 *  - writeKillingStateLocked：分支① killing intent 预写（仅置 state，不写 reason——
 *    契约规定 reason 仅 exited 语义，与 bash_kill 落盘同构）
 *  - writeExitedTransitionalLocked：分支③属主活的过渡终态（exited/reason natural/
 *    exitCode null——poller 若健康会 ≤2s 用真实 exitCode/tailSummary 覆盖，两写均
 *    终态、RMW 串行，覆盖无害）
 */

import {
  BACKGROUND_TASK_REGISTRY_VERSION,
  MAX_TERMINAL_REGISTRY_ENTRIES,
  isTerminalBackgroundTaskState,
  type BackgroundTaskRegistryEntry,
} from '@xyz-agent/extension-protocol'
import { atomicWriteRegistry, readRegistryEntries } from '../session/background-task-reaper.js'

/** registry 序列化缩进（契约：JSON indent 2 + 尾部换行；与 reaper/extension 写侧一致）。 */
const JSON_INDENT = 2

/**
 * 终态 LRU 裁剪 + 原子写（对齐 reaper writeOrphanedTerminalLocked 的裁剪语义：
 * 按 endedAt ?? startedAt 升序淘汰最老终态，保 MAX_TERMINAL_REGISTRY_ENTRIES）。
 */
function writeTrimmedLocked(registryPath: string, entries: BackgroundTaskRegistryEntry[]): void {
  const merged = new Map(entries.map((e) => [e.taskId, e] as const))
  const terminal = entries
    .filter((e) => isTerminalBackgroundTaskState(e.state))
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
  const excess = terminal.length - MAX_TERMINAL_REGISTRY_ENTRIES
  for (let i = 0; i < excess; i++) merged.delete(terminal[i].taskId)
  atomicWriteRegistry(registryPath, `${JSON.stringify({ version: BACKGROUND_TASK_REGISTRY_VERSION, entries: [...merged.values()] }, null, JSON_INDENT)}\n`)
}

/**
 * 分支① killing intent 预写（锁内调用）：仅置 `state: 'killing'`，不写 reason 字段
 * （契约：reason 仅 exited 语义）。条目缺失 / 已终态（poller 竞争先赢）→ false（调用方
 * 映射 already-exited，不覆盖）；fs 错误向上抛（调用方捕获 → 分支⑤ registry-write-failed）。
 */
export function writeKillingStateLocked(registryPath: string, taskId: string): boolean {
  const entries = readRegistryEntries(registryPath)
  const idx = entries.findIndex((e) => e.taskId === taskId)
  if (idx === -1 || isTerminalBackgroundTaskState(entries[idx].state)) return false
  entries[idx] = { ...entries[idx], state: 'killing' }
  writeTrimmedLocked(registryPath, entries)
  return true
}

/**
 * 分支③属主活的过渡终态写（锁内调用）：exited / reason natural / exitCode null +
 * endedAt/durationMs。条目缺失 / 已终态 → false（poller 已写权威终态，不覆盖）；
 * fs 错误向上抛（调用方捕获 → 分支⑤）。终态 +1 触发 LRU 裁剪。
 */
export function writeExitedTransitionalLocked(registryPath: string, taskId: string): boolean {
  const entries = readRegistryEntries(registryPath)
  const idx = entries.findIndex((e) => e.taskId === taskId)
  if (idx === -1 || isTerminalBackgroundTaskState(entries[idx].state)) return false
  const entry = entries[idx]
  const endedAt = Date.now()
  entries[idx] = {
    ...entry,
    state: 'exited',
    reason: 'natural',
    exitCode: null,
    endedAt,
    durationMs: endedAt - entry.startedAt,
  }
  writeTrimmedLocked(registryPath, entries)
  return true
}
