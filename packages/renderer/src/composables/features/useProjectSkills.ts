/**
 * useProjectSkills / useGlobalSkills —— skill 命令源 composable（W4，cw-2026-07-21-fix-ask-user-ime）。
 *
 * W4 改动：
 * - useProjectSkills 改调 configApi.getProjectSkills(cwd)（走 skillRegistry projectCache，带 watcher），
 *   替代原 configApi.scanSessionSkills(cwd)（无缓存直调 configService.loadSkills）。
 * - 新增 useGlobalSkills()：模块级 singleton 缓存，启动拉一次全局 skill（skillRegistry globalCache），
 *   供 landing slash 命令源（FR-5：不再走 settingsStore.skills 配置态扫描）。
 *
 * Wave3 改动（订阅 skill 缓存失效信号）：
 * - useGlobalSkills 订阅 config.skillCacheInvalidated scope='global' → loadGlobal(true) force 重拉。
 *   修复原永久失败 bug：catch 分支不再置 globalLoaded=true，保留旧缓存值，允许下次失效信号触发重试。
 * - useProjectSkills 用模块级失效版本号机制：scope='project' 信号 → 版本号++ → 各实例 watch 清自己的
 *   skillsByCwd + 重拉当前 cwd。版本号是模块级 ref，所有实例共享一份订阅（避免每个 Composer 实例重复挂订阅）。
 *
 * 设计取舍：
 * - useGlobalSkills 用模块级 singleton（cache + loaded flag）：全局 skill 是 AppShell 级数据，
 *   所有 landing CommandPopover 共享一份。首次调用触发 RPC，后续命中缓存。runtime 侧 SkillRegistry
 *   有 chokidar watcher 自动刷新 globalCache，wave3 起前端订阅 config.skillCacheInvalidated 信号实时重拉。
 * - useProjectSkills 保持实例级 Map<cwd, SkillInfo[]>（按 cwd key 隔离，切 cwd 切分区）。
 *   当前唯一消费者是 landing Composer（单例活跃），per-instance 缓存足够。
 * - 失效信号用模块级订阅守卫（globalInvalidateSubscribed/projectInvalidateSubscribed）保证只挂一次，
 *   避免 Composer 每次实例化都重复订阅。project 侧用版本号而非实例级订阅：每个 Composer 实例调
 *   useProjectSkills，实例级订阅会随实例数重复挂载，版本号 watch 让订阅与实例数解耦。
 */
import { computed, ref, watch, type Ref } from 'vue'
import { config as configApi } from '@/api'
import type { SkillInfo } from '@xyz-agent/shared'

// ── useProjectSkills 失效信号版本号（模块级，所有实例共享）─────────
// setSkillDirs 改全局配置，所有已缓存 cwd 都可能受影响。收到 scope='project' 失效信号时
// 版本号++，所有实例的 watch(projectInvalidateVersion) 触发清自己的 skillsByCwd + 重拉当前 cwd。
// 用版本号而非实例级订阅：每个 Composer 实例调 useProjectSkills，实例级订阅会随实例数重复挂载。
let projectInvalidateSubscribed = false
const projectInvalidateVersion = ref(0)
if (!projectInvalidateSubscribed) {
  projectInvalidateSubscribed = true
  configApi.onSkillCacheInvalidated((payload) => {
    if (payload.scope === 'project') {
      // 保守策略：清所有 cwd（setSkillDirs 改全局配置，所有 cwd 都可能受影响）
      projectInvalidateVersion.value++
    }
  })
}

/**
 * @param currentCwd 当前 session/landing 的 cwd ref（null = 未选目录，projectSkills 为空）
 * @returns projectSkills：当前 cwd 对应的项目 skill（computed，切 cwd 自动切换分区）
 */
export function useProjectSkills(currentCwd: Ref<string | null>) {
  // 按 cwd 缓存的项目 skill 表（cwd → SkillInfo[]）。实例级 state（每次 useProjectSkills 调用新建），
  // 命中缓存不重复 RPC，避免闪烁 + 省 RPC。当前唯一消费者是 landing CommandPopover（单例活跃），
  // per-instance 缓存足够；未来多消费者共享再提升到模块级或 store。
  const skillsByCwd = ref<Map<string, SkillInfo[]>>(new Map())
  // R3（review fix）：in-flight 去重。cwd 快速切 A→B→A 时，若 A 的 RPC 仍 pending，
  // 没有 in-flight 标记会重复触发 loadFor(A)。Set 记录 pending cwd，RPC 完成后删除。
  const inFlight = new Set<string>()

  const projectSkills = computed<SkillInfo[]>(() => {
    const cwd = currentCwd.value
    if (!cwd) return []
    return skillsByCwd.value.get(cwd) ?? []
  })

  /** 拉取某 cwd 的 project skill 并写缓存（best-effort：RPC 失败留空数组，不崩）。 */
  async function loadFor(cwd: string): Promise<void> {
    inFlight.add(cwd)
    try {
      const skills = await configApi.getProjectSkills(cwd)
      const next = new Map(skillsByCwd.value)
      next.set(cwd, skills)
      skillsByCwd.value = next
    } catch (e) {
      console.warn(`[useProjectSkills] getProjectSkills failed for cwd=${cwd}, projectSkills will be empty:`, e)
      const next = new Map(skillsByCwd.value)
      next.set(cwd, [])
      skillsByCwd.value = next
    } finally {
      inFlight.delete(cwd)
    }
  }

  // watch currentCwd：变化时按需拉取（缓存命中跳过）。immediate 触发初始 cwd 的拉取。
  // R3：in-flight cwd 也跳过（RPC pending 中不重复触发）。
  watch(
    currentCwd,
    (cwd) => {
      if (!cwd) return // null cwd 不 RPC
      if (skillsByCwd.value.has(cwd)) return // 缓存命中，不重复 RPC
      if (inFlight.has(cwd)) return // RPC pending 中，不重复触发
      void loadFor(cwd)
    },
    { immediate: true },
  )

  // 监听模块级失效版本号：版本号变 → 清缓存 → 重拉当前 cwd
  watch(projectInvalidateVersion, () => {
    const next = new Map<string, SkillInfo[]>()
    skillsByCwd.value = next
    const cwd = currentCwd.value
    if (cwd && !inFlight.has(cwd)) {
      void loadFor(cwd)
    }
  })

  return { projectSkills }
}

// ── useGlobalSkills：模块级 singleton 缓存 ──────────────────────────
// 全局 skill 是 AppShell 级数据，所有 landing CommandPopover 共享一份。模块级 singleton 保证
// 首次调用触发一次 RPC，后续命中缓存。Wave3 改造：订阅 config.skillCacheInvalidated 失效信号，
// 收到 scope='global' 时 force 重拉（runtime 侧 SkillRegistry 已重扫 globalCache）。
let globalSkillsCache: SkillInfo[] | null = null
let globalLoaded = false
let globalInFlight: Promise<SkillInfo[]> | null = null
/** 模块级订阅守卫：保证 onSkillCacheInvalidated 只挂一次（AppShell 级常驻订阅）。 */
let globalInvalidateSubscribed = false

/**
 * 拉取全局 skill（skillRegistry globalCache）。模块级 singleton：
 * - 首次调用触发 configApi.getGlobalSkills() RPC，结果缓存到 globalSkillsCache。
 * - 后续调用命中缓存，返回同一份 ref（响应式）。
 * - in-flight 去重：并发调用共享同一个 Promise，避免重复 RPC。
 * - force=true 跳过 globalLoaded 守卫强制重拉（失效信号触发）。
 * - 失败时不置 globalLoaded=true（修复原永久失败 bug），保留旧缓存值允许下次失效信号触发重试。
 *
 * 供 landing slash 命令源（FR-5：不走 settingsStore.skills）。
 */
export function useGlobalSkills() {
  const globalSkills = ref<SkillInfo[]>(globalSkillsCache ?? [])

  /**
   * 拉取全局 skill。force=true 跳过 globalLoaded 守卫强制重拉（失效信号触发）。
   * 失败时不置 globalLoaded=true（修复原永久失败 bug），保留旧缓存值允许下次重试。
   */
  async function loadGlobal(force = false): Promise<void> {
    if (globalLoaded && !force) {
      globalSkills.value = globalSkillsCache ?? []
      return
    }
    if (globalInFlight) {
      if (!force) {
        globalSkills.value = await globalInFlight
        return
      }
      // force=true 时等待 in-flight 完成后再重拉（避免并发覆盖）
      await globalInFlight
    }
    globalInFlight = (async () => {
      try {
        const skills = await configApi.getGlobalSkills()
        globalSkillsCache = skills
        globalLoaded = true
        globalSkills.value = skills
        return skills
      } catch (e) {
        // 失败时不置 globalLoaded=true（允许下次失效信号触发重试），保留旧缓存值
        console.warn('[useGlobalSkills] getGlobalSkills failed, will retry on next trigger:', e)
        globalSkills.value = globalSkillsCache ?? []
        return globalSkillsCache ?? []
      } finally {
        globalInFlight = null
      }
    })()
    await globalInFlight
  }

  // 模块加载即触发首次拉取（AppShell 级）
  void loadGlobal()

  // 订阅失效信号（模块级，只挂一次）。收到 scope='global' 时强制重拉。
  if (!globalInvalidateSubscribed) {
    globalInvalidateSubscribed = true
    configApi.onSkillCacheInvalidated((payload) => {
      if (payload.scope === 'global') {
        void loadGlobal(true)
      }
    })
  }

  return { globalSkills }
}
