/**
 * useProjectSkills / useGlobalSkills —— skill 命令源 composable（W4，cw-2026-07-21-fix-ask-user-ime）。
 *
 * W4 改动：
 * - useProjectSkills 改调 configApi.getProjectSkills(cwd)（走 skillRegistry projectCache，带 watcher），
 *   替代原 configApi.scanSessionSkills(cwd)（无缓存直调 configService.loadSkills）。
 * - 新增 useGlobalSkills()：模块级 singleton 缓存，启动拉一次全局 skill（skillRegistry globalCache），
 *   供 landing slash 命令源（FR-5：不再走 settingsStore.skills 配置态扫描）。
 *
 * 设计取舍：
 * - useGlobalSkills 用模块级 singleton（cache + loaded flag）：全局 skill 是 AppShell 级数据，
 *   所有 landing CommandPopover 共享一份。首次调用触发 RPC，后续命中缓存。skillRegistry runtime 侧
 *   有 chokidar watcher 自动刷新 globalCache，但 renderer 侧不监听文件变动（landing 浮层打开时拉一次即可，
 *   skill 目录变动是低频操作，重启或切 landing 可覆盖；如需实时刷新后续加 WS 广播）。
 * - useProjectSkills 保持实例级 Map<cwd, SkillInfo[]>（按 cwd key 隔离，切 cwd 切分区）。
 *   当前唯一消费者是 landing Composer（单例活跃），per-instance 缓存足够。
 */
import { computed, ref, watch, type Ref } from 'vue'
import { config as configApi } from '@/api'
import type { SkillInfo } from '@xyz-agent/shared'

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

  return { projectSkills }
}

// ── useGlobalSkills：模块级 singleton 缓存 ──────────────────────────
// 全局 skill 是 AppShell 级数据，所有 landing CommandPopover 共享一份。模块级 singleton 保证
// 首次调用触发一次 RPC，后续命中缓存（skillRegistry runtime 侧 watcher 自动刷新 globalCache，
// renderer 侧不监听文件变动，landing 浮层打开时拉一次即可）。
let globalSkillsCache: SkillInfo[] | null = null
let globalLoaded = false
let globalInFlight: Promise<SkillInfo[]> | null = null

/**
 * 拉取全局 skill（skillRegistry globalCache）。模块级 singleton：
 * - 首次调用触发 configApi.getGlobalSkills() RPC，结果缓存到 globalSkillsCache。
 * - 后续调用命中缓存，返回同一份 ref（响应式）。
 * - in-flight 去重：并发调用共享同一个 Promise，避免重复 RPC。
 *
 * 供 landing slash 命令源（FR-5：不走 settingsStore.skills）。
 */
export function useGlobalSkills() {
  const globalSkills = ref<SkillInfo[]>(globalSkillsCache ?? [])

  async function loadGlobal(): Promise<void> {
    if (globalLoaded) {
      globalSkills.value = globalSkillsCache ?? []
      return
    }
    if (globalInFlight) {
      globalSkills.value = await globalInFlight
      return
    }
    globalInFlight = (async () => {
      try {
        const skills = await configApi.getGlobalSkills()
        globalSkillsCache = skills
        globalLoaded = true
        globalSkills.value = skills
        return skills
      } catch (e) {
        console.warn('[useGlobalSkills] getGlobalSkills failed, globalSkills will be empty:', e)
        globalSkillsCache = []
        globalLoaded = true
        globalSkills.value = []
        return []
      } finally {
        globalInFlight = null
      }
    })()
    await globalInFlight
  }

  // 模块加载即触发（AppShell 级，启动拉一次）。loadGlobal 内部命中缓存/in-flight 去重。
  void loadGlobal()

  return { globalSkills }
}
