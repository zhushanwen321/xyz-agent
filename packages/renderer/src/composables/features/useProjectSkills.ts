/**
 * useProjectSkills —— 按 session cwd 缓存项目 skill（W3，cw-2026-07-21-scan-project-agents-skills）。
 *
 * 解决问题：landing 浮层要显示当前 cwd 的项目 skill（.agents/skills + .xyz-agent/skills），
 * 但 settingsStore.skills 是 AppShell 单例订阅 config.skills 全局广播的 state（useSettings.ts:67），
 * broadcastSkillList 用 services.projectRoot（Electron app 路径）扫，扫不到用户项目。
 * 直接合并项目 skill 进 settingsStore.skills 会污染全局 state（切 session/双 panel/广播覆盖残留）。
 *
 * 方案：独立 composable，按 cwd key 缓存（Map<cwd, SkillInfo[]>），watch(currentCwd) 触发
 * scanSessionSkills(cwd) RPC 拉取。按 cwd key 天然隔离，切 cwd 切分区，无需手动回滚。
 * landing 态无 sessionId 也能用（key 是 cwd 非 sid，不依赖 ADR-0036 per-session 分区）。
 *
 * 数据流：
 *   useNewTaskDirSelect.selectWorkspace 设 flow.currentCwd → 本 composable watch(currentCwd)
 *     → scanSessionSkills(cwd) RPC → runtime loadSkills(cwd) → 返回 SkillInfo[] → 缓存 + 暴露 projectSkills
 *   CommandPopover landing 分支合并 settingsStore.skills（全局）∪ projectSkills（当前 cwd）按 name 去重
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
      const skills = await configApi.scanSessionSkills(cwd)
      const next = new Map(skillsByCwd.value)
      next.set(cwd, skills)
      skillsByCwd.value = next
     
    } catch (e) {
      console.warn(`[useProjectSkills] scanSessionSkills failed for cwd=${cwd}, projectSkills will be empty:`, e)
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
