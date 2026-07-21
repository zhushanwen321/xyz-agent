/**
 * useProjectSkills 单测（W3，cw-2026-07-21-scan-project-agents-skills）。
 *
 * 验证：按 cwd key 缓存项目 skill（Map<cwd, SkillInfo[]>），watch(currentCwd) 触发
 * scanSessionSkills(currentCwd) 拉取。不污染 settingsStore.skills 全局 state（PR5 修复）。
 *
 * 核心场景：
 * - currentCwd 变化 → 触发 scanSessionSkills(newCwd) → projectSkills 更新为新 cwd 的 skill
 * - 切回旧 cwd → 命中缓存，不重复 RPC（性能 + 避免闪烁）
 * - currentCwd 为 null（landing 未选目录）→ projectSkills 为空数组，不 RPC
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/composables/use-project-skills.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { SkillInfo } from '@xyz-agent/shared'

// mock scanSessionSkills RPC
const scanSessionSkillsMock = vi.hoisted(() => vi.fn())
vi.mock('@/api', () => ({
  config: { scanSessionSkills: scanSessionSkillsMock },
}))

import { useProjectSkills } from '@/composables/features/useProjectSkills'

const SKILLS_A: SkillInfo[] = [
  { id: 's-a1', name: 'proj-a-skill', description: 'a', enabled: true, source: 'agents', effective: true },
]
const SKILLS_B: SkillInfo[] = [
  { id: 's-b1', name: 'proj-b-skill', description: 'b', enabled: true, source: 'agents', effective: true },
]

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('useProjectSkills (W3)', () => {
  it('currentCwd 变化触发 scanSessionSkills(cwd)，projectSkills 更新', async () => {
    scanSessionSkillsMock.mockResolvedValue(SKILLS_A)
    const cwd = ref<string | null>('/proj-a')

    const { projectSkills } = useProjectSkills(cwd)

    // 初始 cwd=/proj-a → 触发 RPC
    await vi.waitFor(() => {
      expect(scanSessionSkillsMock).toHaveBeenCalledWith('/proj-a')
    })
    await vi.waitFor(() => {
      expect(projectSkills.value).toEqual(SKILLS_A)
    })
  })

  it('切到新 cwd → 触发新 RPC，projectSkills 更新为新 cwd 的 skill', async () => {
    scanSessionSkillsMock.mockResolvedValueOnce(SKILLS_A).mockResolvedValueOnce(SKILLS_B)
    const cwd = ref<string | null>('/proj-a')

    const { projectSkills } = useProjectSkills(cwd)
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_A))

    cwd.value = '/proj-b'
    await vi.waitFor(() => {
      expect(scanSessionSkillsMock).toHaveBeenCalledWith('/proj-b')
    })
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_B))
  })

  it('切回旧 cwd 命中缓存，不重复 RPC', async () => {
    scanSessionSkillsMock.mockResolvedValue(SKILLS_A)
    const cwd = ref<string | null>('/proj-a')

    const { projectSkills } = useProjectSkills(cwd)
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_A))
    expect(scanSessionSkillsMock).toHaveBeenCalledTimes(1)

    cwd.value = '/proj-b'
    scanSessionSkillsMock.mockResolvedValue(SKILLS_B)
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_B))
    expect(scanSessionSkillsMock).toHaveBeenCalledTimes(2)

    // 切回 /proj-a → 命中缓存，不触发第 3 次 RPC
    cwd.value = '/proj-a'
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_A))
    expect(scanSessionSkillsMock).toHaveBeenCalledTimes(2)
  })

  it('currentCwd 为 null → projectSkills 为空数组，不 RPC', async () => {
    const cwd = ref<string | null>(null)
    const { projectSkills } = useProjectSkills(cwd)

    // 等待一个 tick 确保 watch 不触发
    await new Promise((r) => setTimeout(r, 10))
    expect(scanSessionSkillsMock).not.toHaveBeenCalled()
    expect(projectSkills.value).toEqual([])
  })

  it('scanSessionSkills 抛错 → projectSkills 为空数组，不崩（best-effort）', async () => {
    scanSessionSkillsMock.mockRejectedValue(new Error('rpc fail'))
    const cwd = ref<string | null>('/proj-x')

    const { projectSkills } = useProjectSkills(cwd)

    await vi.waitFor(() => expect(scanSessionSkillsMock).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(projectSkills.value).toEqual([])
  })
})
