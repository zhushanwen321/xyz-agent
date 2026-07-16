/**
 * CLI 端口发现：读 $XYZ_AGENT_DATA_DIR/runtime.port 获取 runtime WS 端口。
 * 与 apps/electron/main/supervisor/port-file.ts 对称（写 vs 读）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 推导 xyz-agent 数据目录。读 XYZ_AGENT_DATA_DIR 环境变量，缺省 ~/.xyz-agent。
 * 与 packages/shared/src/paths.ts getDataDir() 逻辑一致（CLI 不直接 import runtime 依赖，
 * 复制核心路径逻辑保持契约一致）。
 */
function getDataDir(): string {
  return process.env.XYZ_AGENT_DATA_DIR ?? join(homedir(), '.xyz-agent')
}

/**
 * 读 runtime.port 文件，返回端口号。
 * @throws runtime 没跑时文件不存在 → 抛出用户可读错误
 * @throws 端口文件内容非数字 → 抛出用户可读错误
 */
export function discoverPort(): number {
  const dataDir = getDataDir()
  const portFile = join(dataDir, 'runtime.port')

  let raw: string
  try {
    raw = readFileSync(portFile, 'utf-8').trim()
  } catch {
    throw new Error(
      'xyz-agent runtime not running. Start the app first, then retry.'
    )
  }

  const port = parseInt(raw, 10)
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid port in ${portFile}: "${raw}". Expected a number 1-65535.`
    )
  }

  return port
}
