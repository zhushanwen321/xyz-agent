/**
 * 启动后台初始化块（perf W29 D8-1，06 §3.3）——从 index.ts 组合根抽出的可测试序列。
 *
 * 背景：D8-1 把「listen 前无依赖的后置项」全部移到 listen 之后执行，端口先就绪
 * （/health 即 ready），迁移/探测在后台进行。本模块承载该后台序列；index.ts 组合根
 * 仍负责全部服务构造与注入（构造部分留在组合根，符合组合根职责），本模块只编排
 * 执行顺序。抽出独立模块的动机：验收要求「migrateBuiltin → autoUpgrade 顺序 spy 调用序」
 * 断言——内联在 main() 里无法在测试中调用，抽出后行为可测。
 *
 * 执行序（06 §3.3 D8-1 的收敛实现——串行链，2026-08-17 勘误回写口径；文档原文「相互可
 * 并行」为设计阶段判断，实施有意收敛为全串行，见该文档 D8-1 勘误段）：
 *   migrateProviderConfig（存 migrationReady gate）→ migrateBuiltinExtensions →
 *   checkAndAutoUpgrade（migrateBuiltin 必须在 autoUpgrade 前——唯一硬序约束，否则
 *   autoUpgrade 仍会尝试升级打包内置包）→ getPiVersion（mutate appInfo + 补发 app.info）→
 *   skillRegistry.initGlobal → pluginService.initialize → ensureAutoRenameDefault。
 * 全串行的取舍：约束零竞态面 + best-effort 语义最易保持；代价 = 后台总完成时间为各段之和。
 *
 * 每步独立 try/catch：任一步失败不阻塞其余（与改造前 best-effort 语义一致），
 * 无 rejection 逃逸。
 */
import { migrateProviderConfig } from './migration/legacy-provider-migration.js'
import { setMigrationGate } from './session/session-lifecycle.js'
import { cleanupTmpMigrateResidue } from '../infra/pi/session-file-utils.js'
import { getSessionsDir } from '../infra/pi/pi-paths.js'
import { ensureAutoRenameDefault } from './worktree-config-helper.js'
import type { PiConfigStore } from '../infra/pi/pi-config-store.js'
import type { AuthStorage } from './auth/auth-storage.js'
import type { ExtensionService } from './extension-service.js'
import type { ProcessManager } from '../infra/pi/process-manager.js'
import type { SkillRegistry } from './skill-registry.js'
import type { PluginService } from './plugin-service/plugin-service.js'

export interface StartupBackgroundDeps {
  configStore: PiConfigStore
  authStorage: AuthStorage
  extensionService: ExtensionService
  pm: ProcessManager
  /** appInfo 同对象（组合根 setServices 注入 broker 的引用）——本模块 mutate piVersion 后补发。 */
  appInfo: { appVersion: string; piVersion: string }
  /** 补发 app.info 广播（server.broadcastAppInfo → broker 全局广播，D8-2）。 */
  broadcastAppInfo: () => void
  skillRegistry: SkillRegistry
  pluginService: PluginService
}

/**
 * 执行后台初始化序列（listen 后调用）。返回的 promise 在全部步骤完成后 resolve
 * （每步自带 catch，不 reject）。测试可直接调用本函数 + spy 断言调用序。
 */
export async function runStartupBackgroundInit(deps: StartupBackgroundDeps): Promise<void> {
  const { configStore, authStorage, extensionService, pm, appInfo, broadcastAppInfo, skillRegistry, pluginService } = deps
  const tBg = performance.now()

  // ① provider 迁移 → migrationReady gate（D8-3）：session spawn（create/restore/fork）
  // 在迁移完成前等待该 promise。gate 显式 .then(onFulfilled, onRejected) 双处理——
  // 迁移失败也 resolve（best-effort：warn + 下次重试，不阻塞任何功能）。
  // 必须先于 setMigrationGate 启动（同步前缀立即执行），gate 在任何 WS 消息（macrotask）
  // 被处理前已就位——listen 后首个 session RPC 必然等到 gate。
  const migrationReady = migrateProviderConfig(configStore, authStorage).then(
    (migrationReport) => {
      const { catalog, enabled } = migrationReport
      if (catalog.migrated.length > 0 || catalog.errors.length > 0 || enabled.migratedEnabled || enabled.fullDisabledWarn) {
        console.log('[runtime] provider config migration:', JSON.stringify({
          catalogMigrated: catalog.migrated.length,
          catalogKept: catalog.kept.length,
          catalogSkipped: catalog.skipped.length,
          catalogFailed: catalog.failed.length,
          enabledMigrated: enabled.migratedEnabled,
          fullDisabledWarn: enabled.fullDisabledWarn ?? false,
        }))
        if (catalog.errors.length > 0) {
          console.warn('[runtime] legacy provider migration errors:', catalog.errors)
        }
        if (enabled.fullDisabledWarn) {
          console.warn('[runtime] all providers were disabled (enabled===false); pi does not support fully-disabled state. After migration all providers are available — please manually remove unwanted providers.')
        }
      }
    },
    (e) => {
      // best-effort 降级：provider config migration 失败不阻塞启动（旧配置保留，用户可在 Settings 手动修正）。
      console.warn('[runtime] provider config migration failed:', e)
    },
  )
  setMigrationGate(migrationReady)
  await migrationReady
  const tMigA = performance.now()

  // ② migrateBuiltinExtensions：清理旧版 mandatory npm install 遗留的 builtin 包记录。
  // 必须在 checkAndAutoUpgrade 前跑（顺序约束，见文件头注释）——否则 autoUpgrade 仍会
  // 尝试升级打包内置包。
  try {
    await extensionService.migrateBuiltinExtensions()
  } catch (e) {
    // best-effort：迁移失败不阻塞启动（最坏情况是 builtin 包被重复发现，不影响功能）
    console.warn('[runtime] builtin extension migration failed:', e)
  }
  const tMigB = performance.now()

  // ③ 自动升级：对开启 autoUpgrade 的 user-installed 扩展批量检查 npm latest 版本，
  // semver.lt 判定后静默升级。失败不阻塞启动（每个扩展独立 try-catch）。
  try {
    const upgradeResults = await extensionService.checkAndAutoUpgrade()
    const upgraded = upgradeResults.filter(r => r.upgraded)
    if (upgraded.length > 0) {
      console.log(`[runtime] auto-upgraded ${upgraded.length} extension(s):`,
        upgraded.map(r => `${r.name} ${r.from ?? '?'}→${r.to ?? '?'}`).join(', '))
    }
  } catch (e) {
    // checkAndAutoUpgrade 内部已 catch 每个扩展，此处是意外错误兜底
    console.warn('[runtime] extension auto-upgrade encountered an error:', e)
  }
  const tAutoUpgrade = performance.now()

  // ④ piVersion 惰性探测（D8-2）：完成后 mutate appInfo 同对象 + 补发 app.info——
  // 侧栏版本标签先显示应用版本，1-2s 内自动补全为完整版本串（V2 验收）。
  // getPiVersion 内部已 catch（失败返回 'unknown'），此处兜底防御。
  try {
    const piVersion = await pm.getPiVersion()
    appInfo.piVersion = piVersion
    broadcastAppInfo()
  } catch (e) {
    // best-effort：探测失败保持 'unknown'，不补发——版本标签显示应用版本即可，下次启动重试
    console.warn('[runtime] pi version detection failed:', e)
  }
  const tPiVersion = performance.now()

  // ⑤ SkillRegistry 全局扫描：启动期扫描全局 skill 目录（piAgentDir/skills、configDir/skills、
  // discovery.skillDirs）并挂 chokidar watcher。失败不阻塞（skill 降级空缓存）。
  try {
    await skillRegistry.initGlobal()
    console.log(`[runtime] skill registry initialized (${skillRegistry.getGlobalSkills().length} global skills)`)
  // eslint-disable-next-line taste/no-silent-catch -- skill 扫描失败不阻塞 runtime，UI 降级空列表
  } catch (e) {
    console.error('[runtime] skill registry initialization failed:', e)
  }
  const tSkillInit = performance.now()

  // ⑥ 插件系统初始化（扫描、激活 onStartupFinished 插件）
  try {
    await pluginService.initialize()
    console.log('[runtime] plugins initialized')
  // eslint-disable-next-line taste/no-silent-catch -- init: plugin failure must not block server
  } catch (e) {
    console.error('[runtime] plugin initialization failed:', e)
  }
  const tPlugins = performance.now()

  // ⑦ auto-rename 默认初始化：首次启动默认开启（创建 flag file + initialized 标记）
  try {
    ensureAutoRenameDefault()
  } catch (e) {
    // best-effort：初始化失败不影响主流程（下次启动重试），仅记录诊断信息
    console.warn('[runtime] auto-rename default initialization failed:', e)
  }

  // ⑧ sessions 目录 `.tmp-migrate-*.jsonl` 崩溃残留清扫（W3 残留清理）：目录级兜底，
  // 补 cleanupMigrateResidues 只在附着前/delete 链触发的覆盖缺口（不再被 restore 的
  // session 其残留会永久留存）。同步 readdir/unlink 扫一个本地目录（毫秒级）且在
  // listen 后的后台序列里执行，不阻塞启动路径；函数内部对过期阈值（1h）内的文件不删
  //（防并发误删进行中的归一化临时文件），失败逐文件 warn 不上抛。
  try {
    const removed = cleanupTmpMigrateResidue(getSessionsDir())
    if (removed > 0) {
      console.log(`[runtime] cleaned ${removed} stale .tmp-migrate-*.jsonl residue file(s) from sessions dir`)
    }
  } catch (e) {
    // best-effort：清扫失败不影响主流程（残留仅是磁盘垃圾，下次启动重试）
    console.warn('[runtime] tmp-migrate residue cleanup failed:', e)
  }

  // 后台初始化耗时分解探针（06 §5 m-7）：listen 后各段（改造前这些段全部堆在 listen 前）。
  console.log(`[runtime] background init breakdown: migrationA=${(tMigA - tBg).toFixed(1)}ms migrateBuiltin=${(tMigB - tMigA).toFixed(1)}ms autoUpgrade=${(tAutoUpgrade - tMigB).toFixed(1)}ms piVersion=${(tPiVersion - tAutoUpgrade).toFixed(1)}ms skillInit=${(tSkillInit - tPiVersion).toFixed(1)}ms plugins=${(tPlugins - tSkillInit).toFixed(1)}ms total=${(tPlugins - tBg).toFixed(1)}ms`)
}
