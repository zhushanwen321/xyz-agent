/**
 * Pi 资源维护 helper（自 pi-provider-store.ts 抽出，控 max-lines 500）。
 *
 * 职责：
 * - syncBundledResources：打包模式 bundled skills/extensions 同步（直挂 runtime 启动，
 *   全仓唯一 bundled skills 同步点，打包版全新安装依赖）
 * - warnLegacyPiLayout：启动旧布局残留探测（WARN 指引手工迁移，不迁移不阻塞启动，
 *   v9 布局对齐设计 §6.11 U14b）
 * - cleanLeakedPackages / isLeakedPackage / getPiGlobalAgentDir：settings.json.packages
 *   泄漏到 pi 全局目录的相对路径清理（架构约定 #1 xyz-agent/pi 数据隔离）
 *
 * [HISTORICAL] 一次性目录迁移函数已整体退役删除（v9 布局对齐，设计 §6.11「既有函数
 * 处置」；空壳清除 = 2026-09 design-code-sync round1 F7 收尾）：`<configDir>/sessions →
 * pi/sessions` 等迁移使命终结，改由一次性手工迁移脚本 scripts/migrate-pi-layout-v2.mjs +
 * 启动残留探测 warnLegacyPiLayout 承接；无预兆 mkdirSync 前置段随之消亡。
 *
 * 抽出原因：pi-provider-store.ts 超 ESLint max-lines(500)。本模块含迁移类纯函数
 *（不碰 modelsStore 模块级缓存），移到本模块后 pi-provider-store 经 barrel re-export
 * 保 import 路径不变。
 */
import { cpSync, existsSync, statSync } from 'node:fs'
import { join, resolve as pathResolve, sep } from 'node:path'
import { getDataDir } from '@xyz-agent/shared/paths'
import { isPackaged } from '../../utils/runtime-env.js'
import { getPiAgentDir, getExtensionsDir } from './pi-paths.js'
import { updateSettingsFields } from './pi-settings-store.js'

/** 判定路径存在且为目录（探测「子目录形态」用；文件同名占位不算命中）。 */
function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory()
}

/**
 * 启动残留探测（U14b，设计 §6.11）：`<dataDir>/pi` 存在**且其下含 `agent/` 或
 * `sessions/` 子目录**（形态判据，非仅存在性——防纯 pi 宿主任意来源的 `pi/` 目录
 * 误报，与迁移脚本 0a 形态校验 / doctor 判据对齐）→ WARN 指引手工迁移。
 * 不迁移、不阻塞启动；统一兜住三种残留态：「忘了迁」「未知存量机」「降级回装旧版
 * 重建 `pi/`」。
 */
export function warnLegacyPiLayout(dataDir: string = getDataDir()): void {
  const legacyPiDir = join(dataDir, 'pi')
  const hasLegacyForm = ['agent', 'sessions'].some(sub => isDirectory(join(legacyPiDir, sub)))
  if (!hasLegacyForm) return
  console.warn(
    `[pi-maintenance] 检测到旧布局 ${legacyPiDir}，历史会话不在新布局中、不可见；` +
      `关闭应用后运行 scripts/migrate-pi-layout-v2.mjs 迁移`,
  )
}

/**
 * 打包模式：从 bundled 资源同步 skills/extensions（直挂
 * runtime 启动）。全仓唯一 bundled skills 同步点，打包版全新安装依赖，不得丢失。
 *
 * bundled 源 `join(process.cwd(), 'pi', 'agent')` 是 app 资源布局（打包时 stage 进
 * Resources 目录），非用户数据布局，不随路径 SSOT 切换变化。
 * 幂等：目标目录已存在则跳过。
 */
export function syncBundledResources(): void {
  if (!isPackaged()) return
  const piAgentDir = getPiAgentDir()
  const bundledAgentDir = join(process.cwd(), 'pi', 'agent')
  // skills 仍在 pi/agent/skills（bundled pi 自带 skill）；extensions 落 dataDir 根层
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

// ── settings.json.packages 泄漏路径清理（架构约定 #1：xyz-agent/pi 数据隔离）──────
//
// 背景：早期从 pi 导入 settings.json 时，packages[] 带入了泄漏到 pi 全局目录
// （~/.pi/agent/）的相对路径项（如 ../../../.pi/agent/extensions/pending-notifications），
// 违反隔离原则。runtime 启动时（index.ts syncBundledResources 之后）一次性清理。

/**
 * pi 全局 agent 目录，泄漏路径的判定目标。
 *
 * 结构性推导：从 getDataDir() 向上 1 层再下 .pi/agent，即「xyz-agent 数据目录的
 * 兄弟 .pi/agent」。生产（XYZ_AGENT_DATA_DIR=~/.xyz-agent）下返回 ~/.pi/agent。
 *
 * [HISTORICAL] 为何不从 homedir() 推导：vitest globalSetup 把 XYZ_AGENT_DATA_DIR 指向 tmp，
 * homedir()/.pi/agent 落在真实家目录，两者不同分区——相对路径解析后永远无法从 tmp 跨到
 * 真实家目录，导致 isLeakedPackage 不可测。从 getDataDir() 同源推导后，泄漏路径
 * ../../../.pi/agent/x 的解析与本函数天然同分区，任意 dataDir 位置均成立。
 *
 * [2026-09-10] 推导基点从 getPiAgentDir() 改为 getDataDir()（布局对齐 v9，设计 §6.11
 * U15②）：旧推导「向上 3 层」锚定 getPiAgentDir 的 pi/agent 子树层数，SSOT 切换为
 * `<dataDir>/agent` 后向上 3 层会落到 dataDir 的 grandparent，cleanLeakedPackages
 * 静默失效。从 getDataDir() 起向上 1 层与「dataDir 的兄弟 .pi/agent」语义恒等，
 * 不再依赖 getPiAgentDir 的内部层数。
 */
export function getPiGlobalAgentDir(): string {
  return pathResolve(getDataDir(), '..', '.pi', 'agent')
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
 * 启动时一次性调用（index.ts 的 syncBundledResources 之后）。幂等：filter 后无变化不触发写。
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
