/**
 * Worktree 偏好读写 helper（从 config-service.ts 抽出，控 max-lines 500）。
 *
 * 职责边界：worktree/git-cwt-anywhere 相关偏好（root dir / setup 脚本 / 超时 /
 * 默认 base branch）独立于 provider/skill/agent 配置，全部落在 app config.json 的
 * 顶层字段。本模块只负责字段级读写 + 校验，不关心 config.json 的落盘细节（由注入的
 * load/save 回调负责，避免循环依赖 + 不暴露 ConfigService 的私有方法可见性）。
 *
 * 抽出原因：config-service.ts 因本次 PR 新增 migration 委托方法触顶 max-lines(500)。
 * worktree 偏好是 config-service 内最内聚、对外接口稳定（IConfigService 已声明）的块，
 * 移到本模块后 ConfigService 仅保留单行委托，行为 / 签名 / import 路径零变化。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPiAgentDir } from '../infra/pi/pi-paths.js'

/** app config.json 的 load/save 能力（ConfigService 注入，避免暴露其私有方法）。 */
type AppConfigAccessors = {
  /** 读 app config.json（不存在 / 损坏返回 {}）。 */
  load(): Record<string, unknown>
  /** 全量覆写 app config.json。 */
  save(config: Record<string, unknown>): void
}

/** 默认 worktree 根目录（~/worktrees，与原 ConfigService 内联值一致）。 */
const DEFAULT_WORKTREE_ROOT_DIR = '~/worktrees'
/** 默认 setup 脚本相对路径（裸仓 / 普通仓共用同一默认）。 */
const DEFAULT_SETUP_SCRIPT = 'custom-hooks/setup-worktree.sh'
/** 默认 worktree 操作超时（秒）。 */
const DEFAULT_TIMEOUT = 60
/** 超时上限（秒）：与 setSystemPromptConfig 的窗口约束风格一致，防异常大值卡死 PTY。 */
const TIMEOUT_MAX = 3600
/** 默认 base branch（origin/main）。 */
const DEFAULT_BASE_BRANCH = 'origin/main'
/** auto-rename 开关标志文件名（放在 PI_CODING_AGENT_DIR 下，文件存在=开，不存在=关）。 */
const AUTO_RENAME_ENABLED_FILE = 'auto-rename-enabled'

export function getWorktreeRootDir(app: AppConfigAccessors): string {
  const val = app.load()['worktreeRootDir']
  return typeof val === 'string' ? val : DEFAULT_WORKTREE_ROOT_DIR
}

export function setWorktreeRootDir(app: AppConfigAccessors, dir: string): void {
  if (!dir || !dir.trim()) {
    throw new Error('worktreeRootDir cannot be empty')
  }
  const config = app.load()
  config['worktreeRootDir'] = dir
  app.save(config)
}

export function getSetupScript(app: AppConfigAccessors): string {
  const val = app.load()['setupScript']
  return typeof val === 'string' ? val : DEFAULT_SETUP_SCRIPT
}

export function setSetupScript(app: AppConfigAccessors, dir: string): void {
  if (dir.includes('..')) {
    throw new Error('setupScript path cannot contain ..')
  }
  const config = app.load()
  config['setupScript'] = dir
  app.save(config)
}

export function getBareSetupScript(app: AppConfigAccessors): string {
  const val = app.load()['bareSetupScript']
  return typeof val === 'string' ? val : DEFAULT_SETUP_SCRIPT
}

export function setBareSetupScript(app: AppConfigAccessors, script: string): void {
  const config = app.load()
  config['bareSetupScript'] = script
  app.save(config)
}

export function getTimeout(app: AppConfigAccessors): number {
  const val = app.load()['worktreeTimeout']
  return typeof val === 'number' ? val : DEFAULT_TIMEOUT
}

export function setTimeout(app: AppConfigAccessors, timeout: number): void {
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > TIMEOUT_MAX) {
    throw new Error(`timeout must be a positive number in (0, ${TIMEOUT_MAX}], got ${timeout}`)
  }
  const config = app.load()
  config['worktreeTimeout'] = timeout
  app.save(config)
}

export function getDefaultBaseBranch(app: AppConfigAccessors): string {
  const val = app.load()['defaultBaseBranch']
  return typeof val === 'string' ? val : DEFAULT_BASE_BRANCH
}

export function setDefaultBaseBranch(app: AppConfigAccessors, baseBranch: string): void {
  const config = app.load()
  config['defaultBaseBranch'] = baseBranch
  app.save(config)
}

/**
 * auto-rename 开关标志文件路径（${PI_CODING_AGENT_DIR}/auto-rename-enabled）。
 * 与 pi extension 契约一致：extension 读 process.env.PI_CODING_AGENT_DIR 下同名文件。
 * 注意：不走 AppConfigAccessors / config.json —— 开关是独立标志文件，不落 config 字段。
 */
export function getAutoRenameEnabledPath(): string {
  return join(getPiAgentDir(), AUTO_RENAME_ENABLED_FILE)
}

/**
 * 读取 auto-rename 开关状态。标志文件存在=开，不存在/出错=关。
 * 不抛错（读异常一律当关，防御性设计）。
 */
export function getAutoRenameEnabled(): boolean {
  try {
    return existsSync(getAutoRenameEnabledPath())
  } catch {
    return false
  }
}

/**
 * 设置 auto-rename 开关。enabled=true 创建标志文件（空内容，若不存在），
 * enabled=false 删除标志文件（不存在时吞 ENOENT，不报错）。
 */
export function setAutoRenameEnabled(enabled: boolean): void {
  const filePath = getAutoRenameEnabledPath()
  if (enabled) {
    mkdirSync(dirname(filePath), { recursive: true })
    if (!existsSync(filePath)) {
      writeFileSync(filePath, '', 'utf-8')
    }
  } else {
    try {
      rmSync(filePath)
    } catch (e: unknown) {
      // 文件不存在视为成功（吞 ENOENT）
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw e
    }
  }
}
