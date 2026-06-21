/**
 * 端口探测 + stale 进程清理。
 *
 * 对应 spec §4.2 M2 子职责「端口探测」。
 *
 * [HISTORICAL] 不变量：
 * - 端口范围：BASE_PORT..BASE_PORT+10（dev 偏移 +DEV_PORT_OFFSET）
 * - SAFE_KILL_NAMES 白名单：只 kill 进程名匹配 node/pi/tsx/electron/xyz-agent/bash/sh/zsh 的进程
 *   防止误杀无关服务（如占用同端口的数据库/nginx）
 * - kill 顺序：SIGTERM → 等 KILL_WAIT_MS(200ms) → SIGKILL
 * - macOS `ps -o comm=` 可能返回完整路径，正则用 `(?:^|[\/\\])basename$` 兼容
 *
 * 时序（findAvailablePort，单端口被占的清理路径）：
 * ```
 *   T0: isPortInUse(port) → true
 *   T1: killStaleProcessOnPort(port)
 *        ├─ lsof -n -P -i :PORT | grep LISTEN  → 取 PIDs
 *        ├─ for each pid: isSafeToKill(pid)?
 *        │    ├─ 是 → SIGTERM → setTimeout(KILL_WAIT_MS) → SIGKILL
 *        │    └─ 否 → warn 跳过
 *   T2: sleep(PORT_RETRY_MS=300ms) 等 kill 生效
 *   T3: isPortInUse(port) → 仍占用? 尝试下一端口 : 返回此端口
 * ```
 *
 * 依赖方向：port-discoverer → shared（BASE_PORT/MAX_PORT/DEV_PORT_OFFSET）+ node:child_process + health-checker
 */
import { execSync } from 'node:child_process'
import { BASE_PORT, MAX_PORT, DEV_PORT_OFFSET } from '@xyz-agent/shared'
import { isPortInUse } from './health-checker.js'

/** 端口范围大小（BASE_PORT..BASE_PORT+10） */
export const PORT_RANGE_SIZE = 10

/** kill stale 后等待生效的时间 */
export const PORT_RETRY_MS = 300

/** SIGTERM 后等待转 SIGKILL 的时间 */
export const KILL_WAIT_MS = 200

/**
 * 安全 kill 白名单：匹配路径分隔符后的 basename。
 * macOS `ps -o comm=` 可能返回完整路径，故用 `(?:^|[\/\\])` 锚定 basename。
 */
export const SAFE_KILL_NAMES = /(?:^|[\/\\])(?:node|pi|tsx|electron|xyz-agent|bash|sh|zsh)$/i

/**
 * 获取端口偏移（默认 0，dev 模式 +DEV_PORT_OFFSET），clamp 到 [0, MAX_PORT-BASE_PORT]。
 * 读 process.env.XYZ_AGENT_PORT_OFFSET。
 */
export function getPortOffset(): number {
  const raw = parseInt(process.env.XYZ_AGENT_PORT_OFFSET ?? '0', 10) || 0
  // DEV_PORT_OFFSET 是 dev 模式惯用偏移（+100 → 3310-3320），实际偏移仍读 env。
  void DEV_PORT_OFFSET
  return Math.max(0, Math.min(raw, MAX_PORT - BASE_PORT))
}

/**
 * 获取动态端口范围的起止：[BASE_PORT + offset, BASE_PORT + offset + PORT_RANGE_SIZE]。
 */
export function getPortRange(): { start: number; end: number } {
  const offset = getPortOffset()
  return {
    start: BASE_PORT + offset,
    end: BASE_PORT + offset + PORT_RANGE_SIZE,
  }
}

/**
 * 检查进程名是否在安全 kill 列表中。
 * 用 `ps -p PID -o comm=` 取进程名，正则匹配 basename。
 *
 * @param pid 目标进程
 * @returns true=可安全 kill / false=不在白名单或查询失败
 */
export function isSafeToKill(pid: number): boolean {
  try {
    const name = execSync(`ps -p ${pid} -o comm= 2>/dev/null || true`, {
      encoding: 'utf-8',
      shell: '/bin/bash',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (!name) return false
    return SAFE_KILL_NAMES.test(name)
  } catch {
    // ps 查询失败（进程已退出）非关键，按「不可安全 kill」处理
    return false
  }
}

/**
 * 用 lsof 查找占用端口的进程并 kill（SIGTERM → 等 → SIGKILL）。
 * 只 kill 进程名匹配白名单的进程，防止误杀无关服务。
 *
 * @param port 被占用的端口
 */
export function killStaleProcessOnPort(port: number): void {
  try {
    // 注意：-sTCP:LISTEN 在 Linux 上不可用，用兼容方案
    const output = execSync(`lsof -n -P -i :${port} 2>/dev/null | grep LISTEN | awk '{print $2}' || true`, {
      encoding: 'utf-8',
      shell: '/bin/bash',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    for (const line of output.trim().split('\n')) {
      const pid = Number(line.trim())
      if (!Number.isNaN(pid) && pid > 0) {
        if (!isSafeToKill(pid)) {
          console.warn(`[runtime] Port ${port} occupied by PID ${pid} but process name not in allowlist, skipping kill`)
          continue
        }
        console.log(`[runtime] Killing stale process ${pid} on port ${port}`)
        try {
          process.kill(pid, 'SIGTERM')
        // eslint-disable-next-line taste/no-silent-catch -- 进程可能已退出，非关键错误
        } catch {
          // 进程可能已退出，非关键错误
        }
        // 等待后补 SIGKILL
        setTimeout(() => {
          try {
            process.kill(pid, 'SIGKILL')
          // eslint-disable-next-line taste/no-silent-catch
          } catch {
            // 已经死了，非关键错误
          }
        }, KILL_WAIT_MS)
      }
    }
  // eslint-disable-next-line taste/no-silent-catch -- lsof 没找到进程，正常情况
  } catch {
    // lsof 没找到进程，正常情况，无需处理
  }
}

/**
 * 在动态端口范围内寻找可用端口。
 * 遇占用则尝试 kill stale，等 PORT_RETRY_MS 后重试。
 *
 * @returns 首个可用端口
 * @throws 整个范围都被占用且无法清理
 */
export async function findAvailablePort(): Promise<number> {
  const { start, end } = getPortRange()
  let cleanedAny = false
  for (let port = start; port <= end; port++) {
    const inUse = await isPortInUse(port)
    if (!inUse) {
      // 如果之前清理了其他端口，这里多等一下让 kill 生效
      if (cleanedAny) await sleep(PORT_RETRY_MS)
      return port
    }

    // 端口被占用，尝试 kill stale
    console.warn(`[runtime] Port ${port} in use, cleaning up stale process (may kill non-agent services if name matches)`)
    killStaleProcessOnPort(port)
    cleanedAny = true
    await sleep(PORT_RETRY_MS)

    const stillInUse = await isPortInUse(port)
    if (!stillInUse) return port
  }
  throw new Error(`No available port in range ${start}-${end}`)
}

/** ms 延迟 helper（避免重复定义） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
