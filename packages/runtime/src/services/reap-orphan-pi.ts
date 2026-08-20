/**
 * 孤儿 pi 进程收殓（docs/architecture/integrity-hardening.md §3.4 D4a/D4b，修 M6 / G4）。
 *
 * 背景：runtime 被 SIGKILL/OOM 后，它 spawn 的 pi 子进程与 supervisor 拉起的新 runtime
 * 不再是父子关系，无人回收——挂住的 pi 持有 API key、长 turn 继续烧 token（失败模式 F）。
 * pi 自身的 stdin-EOF 自杀链有两个挂起点（dispose handler 串行 await 无超时 /
 * flushRawStdout 遇 EPIPE throw 跳过 exit），均在 pi 源码侧、xyz 不可修，因此需要不依赖
 * 父进程存活的自救兜底：新 runtime 启动后延迟数秒（调用方控制，见
 * startup-background-init.ts 的 5s 定时器）扫描并回收残留 pi。
 *
 * 孤儿判据（argv，跨平台统一）——设计原文 D4a 的 env 判据（PI_CODING_AGENT_DIR）已被
 * 本机探针否决：macOS 的 `ps eww` 与 `launchctl procinfo` 均因 SIP 拿不到其他进程的
 * env（Linux 才有 /proc/<pid>/environ 可用），env 判据无法跨平台。改用 argv 判据：xyz
 * spawn 的 pi 恒为 `--mode rpc ... --session-dir <getSessionsDir()>`（argv 拼接见
 * rpc-client.ts），--session-dir 值精确等于本实例 sessions 目录——同机其他数据目录
 * （如 ~/.pi）的 pi 不匹配。
 *
 * 误杀三重防线（D4b，缺一不可）：
 * ① --session-dir 值与本实例 getSessionsDir() 推导值【精确相等】——禁止子串/前缀
 *   匹配（防 /a/b 与 /a/bc 混淆）；dev/prod 数据目录天然不同，互不误伤；
 * ② ppid === 1（reparent 证据，跨实例保护的关键防线）。xyz 直接 spawn pi、无 wrapper，
 *   父 runtime 活着时 pi 的 ppid 恒等于该 runtime pid；父死后内核把孤儿 reparent 到
 *   init/launchd（pid 1）。因此「argv 匹配 + ppid=1」= 原父已死 = 真孤儿。为什么不用
 *   「ppid ≠ 本 runtime pid」排除法：dev 与打包版默认共用同一数据目录（--session-dir
 *   同值），而 W0 单实例锁按 userData 路径区分（dev/prod userData 不同）——两实例可
 *   同时合法并存，对方的活跃 pi（ppid=对方 runtime pid）必须不杀（本机实测形态：打包
 *   版 runtime 40842 名下 3 个活跃 pi，ppid=40842）。已知边界：Linux subreaper 场景
 *   （用户级 systemd 等）孤儿 reparent 到 subreaper 而非 1，此时漏收（fail-safe 方向，
 *   宁漏不误杀）。
 * ③ Electron 单实例锁（W0 已落地 requestSingleInstanceLock）：只排除同 userData 的
 *   第二实例；dev/prod userData 不同、并存合法，「另一合法实例的 pi」由防线②的
 *   ppid=1 判据保护，单实例锁不承担该职责。
 *
 * 处置：SIGTERM → 宽限（默认 2s，对齐 destroy 链 KILL_TIMEOUT_MS 惯例）→ 仍活则
 * SIGKILL；每条记日志，失败仅记日志不抛（收殓是 best-effort 兜底，不允许阻塞或击穿
 * 启动）。幂等：重复执行只是再扫一遍进程表。
 */
import { execFile } from 'node:child_process'

/** ps 枚举超时：全量进程表是毫秒级本地操作，10s 只是无 ps/假死兜底，防启动链悬挂。 */
const PS_TIMEOUT_MS = 10_000

/** SIGTERM 后等 pi 优雅退出的宽限，对齐 rpc-client kill 链的 KILL_TIMEOUT_MS（2s）。 */
export const ORPHAN_KILL_GRACE_MS = 2_000

/**
 * 启动后延迟多久执行收殓（挂载方 startup-background-init.ts 使用）。初值 5s：给 pi
 * stdin-EOF 自杀链留优雅退出时间（设计 D4a ⛔实施期门：宽限值待 S6 真机实测调整）。
 */
export const ORPHAN_REAP_DELAY_MS = 5_000

/** ps 单行解析结果（`ps -axo pid=,ppid=,command=` 的一行）。 */
export interface PsRow {
  pid: number
  ppid: number
  /** command 列原始文本（argv 空白连接，个别环境可能保留引号形态）。 */
  command: string
}

/**
 * 解析 `ps -axo pid=,ppid=,command=` 输出（macOS/Linux 通用，`列名=` 抑制表头）。
 * 非数字 pid/ppid 的行（空行、异常输出）跳过——fail-open 只影响扫描覆盖面，不影响精确性。
 */
export function parsePsOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] })
  }
  return rows
}

/**
 * 引号感知的 argv 分词（纯函数）。
 *
 * 真实 macOS/Linux ps 的 command 列不保留引号、只用空格连接，但测试与个别环境会以
 * 带引号形态呈现——分词按 POSIX 近似规则处理（引号内空格不分词，引号本身剥离）。
 * 真实 ps 不加引号时含空格的路径会被拆碎，由 matchesOwnPiArgv 的尾部精确匹配兜底。
 */
export function tokenizeArgv(command: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
    } else if (ch === ' ' || ch === '\t') {
      if (hasToken) {
        tokens.push(cur)
        cur = ''
        hasToken = false
      }
    } else {
      cur += ch
      hasToken = true
    }
  }
  if (hasToken) tokens.push(cur)
  return tokens
}

/**
 * 取 flag 值：支持 `--flag value` 与 `--flag=value` 两种形态，全 argv 扫描（顺序无关）。
 * 未找到或 flag 是最后一个 token（无值）返回 null。
 */
function flagValue(tokens: string[], flag: string): string | null {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === flag) return tokens[i + 1] ?? null
    if (tokens[i].startsWith(flag + '=')) return tokens[i].slice(flag.length + 1)
  }
  return null
}

/**
 * 判定 ps 行是否「本实例数据目录的 pi RPC 进程」：argv 含 `--mode rpc` 且
 * `--session-dir` 值与 expectedSessionDir 精确相等。
 *
 * --mode rpc 是必要条件：用户在终端手工跑的同 session-dir 交互式 pi 不带它——
 * 没有这条判据会误杀用户自己的调试进程。
 *
 * 精确相等只走 === 与「整串尾部对齐」两条路径，均不允许值级子串/前缀命中
 * （`/a/b` 不得匹配 `/a/bc`）。尾部对齐兜底真实 ps 的引号剥离：含空格的
 * session-dir 分词后拿不回原值，但 xyz spawn 的 argv 里 `--session-dir <path>`
 * 恰为最后一对参数（rpc-client.ts 拼参顺序），尾部整串比较仍能精确恢复。
 */
export function matchesOwnPiArgv(row: PsRow, expectedSessionDir: string): boolean {
  const tokens = tokenizeArgv(row.command)
  if (flagValue(tokens, '--mode') !== 'rpc') return false
  if (flagValue(tokens, '--session-dir') === expectedSessionDir) return true
  return (
    row.command.endsWith(`--session-dir ${expectedSessionDir}`)
    || row.command.endsWith(`--session-dir=${expectedSessionDir}`)
  )
}

/** init/launchd 的 pid——内核 reparent 孤儿的默认归宿（macOS launchd / Linux systemd）。 */
const INIT_PID = 1

/**
 * 从 ps 行集合筛出可处置孤儿：argv 匹配本数据目录（防线①）且 ppid=1（防线②，
 * reparent 证据：原父 runtime 已死）。pid/ppid 等于 ownPid 的行一并排除——正常场景
 * runtime pid ≠ 1，该检查恒被 ppid=1 蕴含，仅为 pid namespace 容器内 runtime 自身
 * 即 pid 1 的异形兜底。返回 PsRow（含 command 供日志摘要）而非裸 pid。
 */
export function findOrphanPiRows(rows: PsRow[], expectedSessionDir: string, ownPid: number): PsRow[] {
  return rows.filter(
    r => r.pid !== ownPid && r.ppid !== ownPid && r.ppid === INIT_PID && matchesOwnPiArgv(r, expectedSessionDir),
  )
}

export interface ReapOrphanOptions {
  /** 本实例 sessions 目录（getSessionsDir() 推导值，孤儿判据的精确等值目标）。 */
  sessionsDir: string
  /** 本 runtime 进程 pid（排除其活跃子进程，防线②）。 */
  ownPid: number
  /** SIGTERM→SIGKILL 宽限 ms，默认 ORPHAN_KILL_GRACE_MS。 */
  killGraceMs?: number
  /** 进程枚举注入（测试替身）；缺省真实执行 ps。返回 ps stdout 原文。 */
  listProcesses?: () => Promise<string>
  /** 信号注入（测试替身）；缺省 process.kill。signal 0 = 仅探活不实际发信号。 */
  signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => void
  /** 延时注入（测试替身，避免真实等待宽限）。 */
  delay?: (ms: number) => Promise<void>
}

export interface ReapOrphanResult {
  /** 扫描到的进程行数（诊断用）。 */
  scanned: number
  /** 成功回收（SIGTERM 退出 / 已自行退出 / SIGKILL 兜底）的孤儿 pid。 */
  reaped: number[]
  /** 处置失败的孤儿 pid（仅日志，不抛）。 */
  failed: number[]
  /** 平台不支持（Windows / ps 不可用）时为 true——已知边界，非错误。 */
  unsupported: boolean
}

/** ESRCH = 目标 pid 不存在（扫描到处置之间自行退出，或探活确认已死）。 */
function isProcessGone(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ESRCH'
}

/** argv 日志摘要截断长度：防 ps 极端长 command 刷屏，保留头部（pi 路径 + --mode rpc 可辨识）。 */
const ARGV_SUMMARY_MAX = 200

/** argv 摘要：截断防 ps 极端长 command 刷屏，保留头部（pi 路径 + --mode rpc 可辨识）。 */
function argvSummary(command: string): string {
  return command.length > ARGV_SUMMARY_MAX ? command.slice(0, ARGV_SUMMARY_MAX) + '…' : command
}

function defaultListProcesses(): Promise<string> {
  // -axo 全量进程；列名后缀 `=` 抑制表头；输出走 pipe（非 TTY）时 command 列不按
  // 终端宽度截断。数组参数经 execFile 不经 shell（对齐 git-executor 惯例）。
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,command='],
      { encoding: 'utf8', timeout: PS_TIMEOUT_MS },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      },
    )
  })
}

function defaultSignal(pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0): void {
  process.kill(pid, signal)
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/**
 * 执行一次孤儿收殓：枚举 → 筛选 → 逐个 SIGTERM → 宽限 → 仍活则 SIGKILL。
 * 本函数不抛（全路径 catch 或降级返回），调用方可安全 fire-and-forget。
 */
export async function reapOrphanPiProcesses(options: ReapOrphanOptions): Promise<ReapOrphanResult> {
  const { sessionsDir, ownPid } = options
  const killGraceMs = options.killGraceMs ?? ORPHAN_KILL_GRACE_MS
  const listProcesses = options.listProcesses ?? defaultListProcesses
  const signal = options.signal ?? defaultSignal
  const delay = options.delay ?? defaultDelay

  const result: ReapOrphanResult = { scanned: 0, reaped: [], failed: [], unsupported: false }

  // 平台边界：Windows 无 ps（也无 /proc）。降级为单条 warn 的已知边界，不阻塞启动。
  if (process.platform === 'win32') {
    console.warn('[orphan-reap] platform does not support orphan pi reaping (no ps on Windows); known limitation, skipped')
    result.unsupported = true
    return result
  }

  let stdout: string
  try {
    stdout = await listProcesses()
  } catch (e) {
    // ps 缺失/不可执行：与 Windows 同级的已知边界，warn 一次即返回（不重试、不上抛）。
    console.warn('[orphan-reap] process enumeration unavailable, orphan pi reaping skipped (known limitation):', e instanceof Error ? e.message : e)
    result.unsupported = true
    return result
  }

  const rows = parsePsOutput(stdout)
  result.scanned = rows.length
  const orphans = findOrphanPiRows(rows, sessionsDir, ownPid)
  if (orphans.length === 0) return result

  console.log(`[orphan-reap] found ${orphans.length} orphan pi process(es) for session-dir=${sessionsDir}, reaping`)
  for (const row of orphans) {
    const ok = await killOrphan(row, killGraceMs, signal, delay)
    if (ok) result.reaped.push(row.pid)
    else result.failed.push(row.pid)
  }
  return result
}

/** 单个孤儿的处置序列。返回 false = 处置失败（调用方记入 failed，仅日志不抛）。 */
async function killOrphan(
  row: PsRow,
  killGraceMs: number,
  signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => void,
  delay: (ms: number) => Promise<void>,
): Promise<boolean> {
  const summary = argvSummary(row.command)
  try {
    signal(row.pid, 'SIGTERM')
  } catch (e) {
    if (isProcessGone(e)) {
      // 扫描到处置之间已自行退出（stdin-EOF 自杀链赶到前面）——按已回收计，幂等。
      console.log(`[orphan-reap] reaped orphan pi pid=${row.pid} (exited before SIGTERM) ${summary}`)
      return true
    }
    console.warn(`[orphan-reap] SIGTERM failed for orphan pi pid=${row.pid}:`, e instanceof Error ? e.message : e)
    return false
  }

  await delay(killGraceMs)

  // 宽限后探活：signal 0 只验证存在性不实际发信号。EPERM 等其他错误按「活着」处理
  // （走 SIGKILL 兜底，宁可多一发强杀信号也不漏收）。
  let alive = true
  try {
    signal(row.pid, 0)
  } catch (e) {
    if (isProcessGone(e)) alive = false
  }
  if (!alive) {
    console.log(`[orphan-reap] reaped orphan pi pid=${row.pid} (SIGTERM) ${summary}`)
    return true
  }

  try {
    signal(row.pid, 'SIGKILL')
    console.log(`[orphan-reap] reaped orphan pi pid=${row.pid} (SIGKILL after ${killGraceMs}ms grace) ${summary}`)
    return true
  } catch (e) {
    if (isProcessGone(e)) {
      console.log(`[orphan-reap] reaped orphan pi pid=${row.pid} (exited during grace) ${summary}`)
      return true
    }
    console.warn(`[orphan-reap] SIGKILL failed for orphan pi pid=${row.pid}:`, e instanceof Error ? e.message : e)
    return false
  }
}
