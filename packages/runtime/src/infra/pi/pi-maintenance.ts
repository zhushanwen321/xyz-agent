/**
 * Pi 目录迁移 + 泄漏包清理 helper（从 pi-provider-store.ts 抽出，控 max-lines 500）。
 *
 * 职责：首次加载时的一次性目录结构迁移（migrateToPiSubdir：旧路径 → pi/agent 子树 +
 * extension/npm/tmp 迁出）+ settings.json.packages 泄漏到 pi 全局目录的相对路径清理
 *（cleanLeakedPackages，架构约定 #1 xyz-agent/pi 数据隔离）。
 *
 * 抽出原因：pi-provider-store.ts 超 ESLint max-lines(500)。本模块含迁移类纯函数
 *（不碰 modelsStore 模块级缓存，只做文件 rename + settings.json 清理），移到本模块后
 * pi-provider-store 经 barrel re-export 保 import 路径不变，行为 / 签名零变化。
 */
import { existsSync, readdirSync, mkdirSync, renameSync, rmdirSync, cpSync } from 'node:fs'
import { join, resolve as pathResolve, sep } from 'node:path'
import { toErrorMessage } from '../../utils/errors.js'
import { isPackaged } from '../../utils/runtime-env.js'
import {
  getConfigDir,
  getModelsPath,
  getSettingsPath,
  getPiAgentDir,
  getSessionsDir,
  getAgentsDir,
  getExtensionsDir,
  getNpmDir,
  getTmpDir,
} from './pi-paths.js'
import { updateSettingsFields } from './pi-settings-store.js'

/**
 * 把 oldDir 的内容逐项迁移到 newDir（跳过 newDir 中已存在的同名项），
 * 迁移后若 oldDir 为空则删除。幂等。
 *
 * 抽自 migrateToPiSubdir 的 sessions/agents 两段近乎逐行相同的目录迁移块（D4）。
 */
function migrateDirContents(oldDir: string, newDir: string, label: string): void {
  if (!existsSync(oldDir)) return
  try {
    const entries = readdirSync(oldDir)
    if (entries.length > 0) {
      let migrated = 0
      for (const entry of entries) {
        const newPath = join(newDir, entry)
        if (!existsSync(newPath)) {
          renameSync(join(oldDir, entry), newPath)
          migrated++
        }
      }
      if (migrated > 0) {
        console.log(`[provider-store] migrated ${migrated} ${label}`)
      }
      try {
        const remaining = readdirSync(oldDir)
        if (remaining.length === 0) rmdirSync(oldDir)
      // eslint-disable-next-line taste/no-silent-catch -- migration cleanup: error logged, non-critical
      } catch (e) {
        console.warn(`[provider-store] failed to remove old ${label} dir:`, toErrorMessage(e))
      }
    }
  // eslint-disable-next-line taste/no-silent-catch -- migration: error logged, non-critical
  } catch (e) {
    console.warn(`[provider-store] failed to migrate ${label} dir:`, toErrorMessage(e))
  }
}

/**
 * 首次加载时执行一次性迁移：将旧路径下的文件移动到新的 xyz-pi 目录结构。
 * 幂等：如果新路径已存在文件，跳过迁移。
 */
export function migrateToPiSubdir(): void {
  const piAgentDir = getPiAgentDir()
  const sessionsDir = getSessionsDir()
  const agentsDir = getAgentsDir()
  const configDir = getConfigDir()

  const oldModelsPath = join(configDir, 'models.json')
  const oldSettingsPath = join(configDir, 'settings.json')
  const oldSessionsDir = join(configDir, 'sessions')
  const oldAgentsDir = join(configDir, 'agents')

  mkdirSync(piAgentDir, { recursive: true })
  mkdirSync(sessionsDir, { recursive: true })
  mkdirSync(agentsDir, { recursive: true })

  const modelsPath = getModelsPath()
  const settingsPath = getSettingsPath()

  if (existsSync(oldModelsPath) && !existsSync(modelsPath)) {
    renameSync(oldModelsPath, modelsPath)
    console.log('[provider-store] migrated models.json → pi/agent/models.json')
  }

  if (existsSync(oldSettingsPath) && !existsSync(settingsPath)) {
    renameSync(oldSettingsPath, settingsPath)
    console.log('[provider-store] migrated settings.json → pi/agent/settings.json')
  }

  migrateDirContents(oldSessionsDir, sessionsDir, 'session files → pi/sessions/')
  migrateDirContents(oldAgentsDir, agentsDir, 'agent files → pi/agent/agents/')

  // extension/npm/tmp 目录迁移：原在 pi/agent/ 子树下，迁出到 dataDir 根层
  // （与 skills/agents 强制目录结构对齐，详见 paths.ts 目录结构注释）。
  // 幂等：新目录已有内容时跳过（migrateDirContents 内部逐项判重）。
  migrateDirContents(join(piAgentDir, 'extensions'), getExtensionsDir(), 'extension files → extensions/')
  migrateDirContents(join(piAgentDir, 'npm'), getNpmDir(), 'npm packages → npm/')
  migrateDirContents(join(piAgentDir, 'tmp'), getTmpDir(), 'temp files → tmp/')

  // 打包模式：从 bundled 资源同步
  if (isPackaged()) {
    const bundledAgentDir = join(process.cwd(), 'pi', 'agent')
    // skills 仍在 pi/agent/skills（bundled pi 自带 skill）；extensions 已迁出到 dataDir/extensions
    for (const [subDir, destDir] of [
      ['extensions', getExtensionsDir()],
      ['skills', join(piAgentDir, 'skills')],
    ] as const) {
      const src = join(bundledAgentDir, subDir)
      if (existsSync(src) && !existsSync(destDir)) {
        try {
          cpSync(src, destDir, { recursive: true })
          console.log(`[provider-store] synced bundled ${subDir} → ${destDir}`)
        // eslint-disable-next-line taste/no-silent-catch -- bundled sync: error logged, non-critical
        } catch (e) {
          console.error(`[provider-store] failed to sync bundled ${subDir}:`, e)
        }
      }
    }
  }
}

// ── settings.json.packages 泄漏路径清理（架构约定 #1：xyz-agent/pi 数据隔离）──────
//
// 背景：早期从 pi 导入 settings.json 时，packages[] 带入了泄漏到 pi 全局目录
// （~/.pi/agent/）的相对路径项（如 ../../../.pi/agent/extensions/pending-notifications），
// 违反隔离原则。runtime 启动时（index.ts migrateToPiSubdir 之后）一次性清理。

/**
 * pi 全局 agent 目录，泄漏路径的判定目标。
 *
 * 结构性推导：从 getPiAgentDir() 向上 3 层（agent→pi→dataDir→parent）再下 .pi/agent，
 * 即「xyz-agent 数据目录（getConfigDir()）的兄弟 .pi/agent」。
 *
 * 生产（XYZ_AGENT_DATA_DIR=~/.xyz-agent）：getPiAgentDir()=~/.xyz-agent/pi/agent，
 * 向上 3 层到 ~，本函数返回 ~/.pi/agent（pi 全局 agent 目录）。
 *
 * [HISTORICAL] 为何不从 homedir() 推导：vitest globalSetup 把 XYZ_AGENT_DATA_DIR 指向 tmp，
 * getPiAgentDir() 落在 tmp 分区，而 homedir()/.pi/agent 落在真实家目录，两者不同分区——
 * 相对路径解析后永远无法从 tmp 跨到真实家目录，导致 isLeakedPackage 不可测（tmp 嵌套深度
 * 还随机器变化）。从 getPiAgentDir() 同源推导后，泄漏路径 ../../../.pi/agent/x 的 ../../../
 *（向上 3 层）与本函数的向上 3 层天然对齐，depth-structural 一致，任意 dataDir 位置均成立。
 */
export function getPiGlobalAgentDir(): string {
  return pathResolve(getPiAgentDir(), '..', '..', '..', '.pi', 'agent')
}

/**
 * 判定 packages 项是否为泄漏到 pi 全局目录的相对路径。
 *
 * 泄漏特征：以 '../' 开头（相对路径），且相对 settings.json 所在目录（getPiAgentDir()）
 * 解析后落在 pi 全局目录（~/.pi/agent/）内。
 *
 * 合法项不被误杀：npm:@xxx 不以 ../ 开头；extensions/xxx 不以 ../ 开头；
 * ./local-ext 不以 ../ 开头；../../../other-dir 解析后不在 ~/.pi/agent/ 内。
 *
 * @param pkg packages 数组的一项
 * @returns true = 泄漏项（应删除）
 */
export function isLeakedPackage(pkg: string): boolean {
  if (!pkg.startsWith('../')) return false
  const resolved = pathResolve(getPiAgentDir(), pkg)
  return resolved.startsWith(getPiGlobalAgentDir() + sep)
}

/**
 * 清理 settings.json.packages 中泄漏到 pi 全局目录的相对路径项。
 *
 * 启动时一次性调用（index.ts 的 migrateToPiSubdir 之后）。幂等：filter 后无变化不触发写。
 *
 * @returns { removed: string[] } 被删除的项列表（供调用方 log）
 */
export function cleanLeakedPackages(): { removed: string[] } {
  try {
    let removed: string[] = []
    // full scope 白名单调用点（D1b）：启动迁移在无并发 pi 进程窗口运行，且迁移可能
    // 触及任意字段，故允许全量覆盖。新代码禁止使用 full scope——用具体字段域
    //（model/skills/extension），review 按 data-source-registry.md 登记表检查。
    updateSettingsFields('full', s => {
      const packages = s.packages ?? []
      const filtered = packages.filter(p => !isLeakedPackage(p))
      removed = packages.filter(p => isLeakedPackage(p))
      if (removed.length > 0) {
        s.packages = filtered
      }
    })
    if (removed.length > 0) {
      console.log(`[provider-store] cleaned ${removed.length} leaked package(s) from settings.json:`, removed)
    }
    return { removed }
  } catch (e) {
    // settings.json 读取失败不阻塞启动（ES1）
    console.warn('[provider-store] cleanLeakedPackages failed:', e)
    return { removed: [] }
  }
}
