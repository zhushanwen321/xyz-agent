import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import type { ScheduledTask, SchedulerEntryOp, SchedulerStore, TaskSnapshot } from './types.js'

/**
 * 获取旧 store 文件路径：~/.pi/agent/scheduler/<root>/<segments>/scheduler.json。
 *
 * 内联自 store.ts getStorePath——store.ts 本 wave 删除后此函数是旧路径的唯一推导实现，
 * 不能 import 已删 store。workspace 路径隔离，不同 cwd 存不同文件。
 *
 * export 供测试推导期望路径（断言 renameSync/unlinkSync 参数）。
 *
 * ⚠️ 路径硬编码说明：硬编码 `~/.pi/agent/scheduler/` 是因为已发布版（npm 0.1.1）的 store.ts
 * 即用此路径，旧数据确在此处，必须按此路径探测才能迁移。注意分支 `feat-auto-name-session-refactor`
 * 的 commit 4b5513b5e 把 store 路径改为 getAgentDir()（读 PI_CODING_AGENT_DIR，用于 xyz-agent
 * 数据目录隔离）；该分支合并后此处需改为双候选路径探测（先 getAgentDir() 再 fallback ~/.pi/agent），
 * 否则 xyz-agent 隔离目录下的旧任务探测不到。
 */
export function getLegacyStorePath(cwd: string): string {
  const home = os.homedir()
  const resolved = path.resolve(cwd)
  const parsed = path.parse(resolved)
  const segments = resolved.slice(parsed.root.length)
    .split(path.sep).filter(Boolean)
  const root = parsed.root
    .replaceAll(/[^a-zA-Z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .toLowerCase() || 'root'
  return path.join(home, '.pi', 'agent', 'scheduler', root, ...segments, 'scheduler.json')
}

/**
 * 旧 store 任务字段补全（参考 store.ts load() 默认值兜底）：旧数据可能缺字段，逐字段给默认值。
 * ownerSessionFile/pending 不补全——旧数据本无此二字段，由 toTaskSnapshot 显式剥离。
 */
function normalizeLegacyTask(t: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: t.id ?? '',
    name: t.name ?? '',
    prompt: t.prompt ?? '',
    kind: t.kind ?? 'recurring',
    schedule: t.schedule ?? { mode: 'interval', intervalMs: 60000 },
    createdAt: t.createdAt ?? 0,
    nextRunAt: t.nextRunAt ?? 0,
    runCount: t.runCount ?? 0,
    enabled: t.enabled ?? true,
    force: t.force ?? false,
    history: t.history ?? [],
    expiresAt: t.expiresAt,
    lastRunAt: t.lastRunAt,
    lastStatus: t.lastStatus,
    lastError: t.lastError,
  }
}

/**
 * ScheduledTask → TaskSnapshot：显式构造 15 字段
 * （id/name/prompt/kind/schedule/enabled/force/createdAt/nextRunAt/expiresAt?/
 * runCount/lastRunAt?/lastStatus?/lastError?/history），剥离 ownerSessionFile（在 op 顶层）
 * 与 pending（运行时标记），history 用 slice() 深拷贝。
 *
 * 显式构造而非复用 runtime.toSnapshot 的解构写法（T-C3-explicit）：旧 store 数据本无
 * ownerSessionFile/pending 运行时字段，显式构造更安全。两处构造逻辑需保持形状一致
 * （对照 types.ts TaskSnapshot 15 字段）。
 */
function toTaskSnapshot(task: ScheduledTask): TaskSnapshot {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    kind: task.kind,
    schedule: task.schedule,
    enabled: task.enabled,
    force: task.force,
    createdAt: task.createdAt,
    nextRunAt: task.nextRunAt,
    expiresAt: task.expiresAt,
    runCount: task.runCount,
    lastRunAt: task.lastRunAt,
    lastStatus: task.lastStatus,
    lastError: task.lastError,
    history: task.history.slice(),
  }
}

/**
 * 判断 err 是否为 ENOENT（fs.renameSync 源文件不存在）。
 * Record 守卫模式与 replay.ts isSchedulerEntryOp 同款（避免 taste/no-unsafe-cast）。
 */
function isENOENT(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (!('code' in err)) return false
  return (err as Record<'code', unknown>).code === 'ENOENT'
}

/**
 * 从 .imported 路径读取旧 store JSON、逐任务 pi.appendEntry upsert、删除 .imported。
 * read/parse/append 任一异常由外层 importLegacyStore 的 try/catch 兜底（C1 整体降级）。
 */
function importFromFile(
  importedPath: string,
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  currentSessionFile: string,
): void {
  const content = fs.readFileSync(importedPath, 'utf-8')
  const data = JSON.parse(content) as Partial<SchedulerStore>
  const tasks = (data.tasks ?? []).map(normalizeLegacyTask)

  for (const task of tasks) {
    const op: SchedulerEntryOp = {
      op: 'upsert',
      taskId: task.id,
      ownerSessionFile: currentSessionFile,
      task: toTaskSnapshot(task),
    }
    // customType 与 backend.ts PiSchedulerBackend.appendEntry 同源，改一处必改两处
    pi.appendEntry('pi-scheduler:task', op)
  }

  fs.unlinkSync(importedPath)
  // 内部诊断日志（非用户可见消息）：用 console.warn 而非 console.log（项目 convention：
  // extensions 禁 console.log/info 防泄漏到 TUI；诊断输出统一 console.warn）
  console.warn(`[scheduler] imported ${tasks.length} legacy tasks from ${importedPath}`)
}

/**
 * 残留恢复：rename 抛 ENOENT（别人已把 scheduler.json rename 走）后处理 .imported 残留。
 *
 * 并发 + 崩溃恢复交叉窗口（R-CONCURRENT-IMPORT）：若 .imported 存在，可能是
 *   a) 本进程上次崩溃留下的 .imported（崩溃恢复）→ 导入正确
 *   b) 另一进程 winner rename 后、unlinkSync 前的 .imported（并发）→ 本进程也会导入
 * 窗口极窄（rename→unlinkSync 毫秒级）+ 需两进程同时 session_start 同 cwd（罕见）。
 *
 * ⚠️ 双导入后果（如实记录，非「已被消除」）：情况 b 下 A/B 各自导入一份副本、owner 各为自己，
 * 同一个逻辑任务会在两个 session 各触发一次（跨 session 双触发，正是 G5 要防的）。owner 过滤
 * （按 ownerSessionFile）只保证「单一 session 内不重复」，并不能消除此跨 session 双触发——
 * owner 过滤针对的是 fork 继承的「owner=他者」任务，而此处两副本的 owner 各自匹配本 session。
 * 窗口极窄（毫秒级 + 双进程同时启动同 cwd），可接受，不引入锁机制（过度工程）。
 */
function handleImportedResidue(
  importedPath: string,
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  currentSessionFile: string,
): void {
  if (fs.existsSync(importedPath)) {
    importFromFile(importedPath, pi, currentSessionFile)
  }
  // else: 双不存在（TC3），no-op
}

/**
 * 导入旧 scheduler store 到当前 session（append-only event sourcing 迁移，IF-IMPORT-LEGACY）。
 *
 * 策略：原子 rename scheduler.json → scheduler.json.imported 独占迁移；成功者读取 .imported
 * 逐任务 pi.appendEntry('pi-scheduler:task', upsert) 后删除 .imported；rename 抛 ENOENT
 * 说明并发场景下别人已 rename 走，走 handleImportedResidue 幂等恢复。
 *
 * 时序（CL3 方案A）：必须在 backend.loadTasks() 之前执行——append 的 upsert entry 进入 pi
 * 内存 fileEntries，紧接的 loadTasks replay 统一重放读到导入任务（pi _appendEntry 同步 push
 * fileEntries，design-review 已实测验证）。
 *
 * 整体降级（C1）：read/parse/appendEntry 任一异常 → console.warn + 不 rethrow，不让
 * session_start 崩溃（与 replay gap4 / ER-APPEND-FAIL 同款降级语义）。
 *
 * nextRunAt 原样保留不重算、不 gc 过滤（CL4）：导入后首个 tick 立即 dispatch（D3 立即触发语义）。
 */
export function importLegacyStore(
  cwd: string,
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  currentSessionFile: string | undefined,
): void {
  // TC5：--no-session 模式无 owner session 可归属，导入无意义，早 return 不碰 fs
  if (currentSessionFile === undefined) return

  const storePath = getLegacyStorePath(cwd)
  const importedPath = storePath + '.imported'

  try {
    try {
      fs.renameSync(storePath, importedPath)
    } catch (err) {
      if (isENOENT(err)) {
        // 并发 S10 / 崩溃恢复：scheduler.json 已不在（被别人 rename 走或上次崩溃）→ 残留恢复
        handleImportedResidue(importedPath, pi, currentSessionFile)
        return
      }
      // 其他 fs 错误走整体降级 warn
      throw err
    }

    // 成功 rename → 导入 .imported
    importFromFile(importedPath, pi, currentSessionFile)
  } catch (err) {
    // C1 整体降级：read/parse/appendEntry 任一异常不崩 session_start
    console.warn(
      `[scheduler] import failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
