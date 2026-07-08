/**
 * 修复 GUI 启动时的残缺 PATH。
 *
 * [HISTORICAL] 背景：Electron 从 Dock/Finder 启动时，macOS LaunchServices 给的 PATH
 * 是最小值（典型 `/usr/bin:/bin:/usr/sbin:/sbin`），不含 `~/.local/bin`、`~/.cargo/bin`、
 * `/opt/homebrew/bin` 等用户级 bin。这个残缺 PATH 经 buildSafeEnv 白名单（PATH 在白名单内
 * 被保留但不补全）→ runtime → pi 一路原样传递，pi 的 bash 工具找不到用户安装的 CLI（uv 等）。
 *
 * 修复方式：用用户登录 shell（`$SHELL -ilc 'env'`）读取完整环境，
 * 在 shell PATH 比当前 PATH 更长时覆盖 process.env.PATH。
 * 后续 buildSafeEnv 自然把完整 PATH 传递到 pi，一处修复全链路受益。
 *
 * 自实现而非引 shell-env/fix-path 包：核心逻辑就是 spawnSync + 解析 KEY=VALUE，
 * 引包要同步改 package.json deps + vite.config.main.ts external + electron-builder.yml files
 * + preflight-check.sh，碰打包链路代价过大（规则 #12）。
 */
import { spawnSync } from 'node:child_process'

/** spawnSync 超时（ms）——用户 shell 配置异常时防卡死 */
const SHELL_ENV_TIMEOUT = 5000

/** 合法环境变量名：字母/下划线开头，后跟字母/数字/下划线 */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 从登录 shell 读取完整环境，补全 process.env.PATH。
 *
 * 只在 shell PATH 比当前 PATH 更长时覆盖（安全策略）：
 * - 终端启动：PATH 已完整，shell PATH 同等长度，不覆盖（无害）
 * - GUI 启动：shell PATH 更长，覆盖生效
 * - shell 配置异常返回短 PATH：不破坏已有的
 *
 * 任何失败（无 $SHELL、spawnSync 失败、超时）均不修改 process.env（fail-safe）。
 */
export function fixPathEnv(): void {
  // Windows GUI 应用从注册表读取 PATH，通常完整，跳过
  if (process.platform === 'win32') return

  const shell = process.env.SHELL
  if (!shell) return

  const result = spawnSync(shell, ['-ilc', 'env'], {
    timeout: SHELL_ENV_TIMEOUT,
    encoding: 'utf8',
  })

  // 非零退出、超时、无输出 → 不修改
  if (result.status !== 0 || !result.stdout) return

  const shellPath = parseEnvOutput(result.stdout).PATH
  if (!shellPath) return

  const currentPath = process.env.PATH ?? ''
  // 只在 shell PATH 更长时覆盖（安全策略）
  if (shellPath.length > currentPath.length) {
    process.env.PATH = shellPath
  }
}

/**
 * 解析 `env` 命令输出为 Record<string, string>。
 * 只认 `KEY=VALUE` 格式的行，跳过 motd/fortune 等污染输出。
 */
function parseEnvOutput(stdout: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const eqIndex = line.indexOf('=')
    if (eqIndex <= 0) continue
    const key = line.slice(0, eqIndex)
    if (!ENV_KEY_PATTERN.test(key)) continue
    env[key] = line.slice(eqIndex + 1)
  }
  return env
}
