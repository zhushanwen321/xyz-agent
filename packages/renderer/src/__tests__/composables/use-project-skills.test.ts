/**
 * useProjectSkills / useGlobalSkills 单测（W4，cw-2026-07-21-fix-ask-user-ime）。
 *
 * W4 改动：useProjectSkills 改调 configApi.getProjectSkills(cwd)（走 skillRegistry projectCache），
 * 替代原 scanSessionSkills（无缓存直调 configService）。新增 useGlobalSkills（模块级 singleton 缓存）。
 *
 * 验证 useProjectSkills：
 * - currentCwd 变化 → 触发 getProjectSkills(newCwd) → projectSkills 更新
 * - 切回旧 cwd → 命中缓存，不重复 RPC
 * - currentCwd 为 null → projectSkills 为空，不 RPC
 * - RPC 抛错 → projectSkills 为空，不崩
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/composables/use-project-skills.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { SkillInfo } from '@xyz-agent/shared'

// mock getProjectSkills RPC（W4：替代 scanSessionSkills）
const getProjectSkillsMock = vi.hoisted(() => vi.fn())
vi.mock('@/api', () => ({
  config: { getProjectSkills: getProjectSkillsMock },
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

describe('useProjectSkills (W4)', () => {
  it('currentCwd 变化触发 getProjectSkills(cwd)，projectSkills 更新', async () => {
    getProjectSkillsMock.mockResolvedValue(SKILLS_A)
    const cwd = ref<string | null>('/proj-a')

    const { projectSkills } = useProjectSkills(cwd)

    // 初始 cwd=/proj-a → 触发 RPC
    await vi.waitFor(() => {
      expect(getProjectSkillsMock).toHaveBeenCalledWith('/proj-a')
    })
    await vi.waitFor(() => {
      expect(projectSkills.value).toEqual(SKILLS_A)
    })
  })

  it('切到新 cwd → 触发新 RPC，projectSkills 更新为新 cwd 的 skill', async () => {
    getProjectSkillsMock.mockResolvedValueOnce(SKILLS_A).mockResolvedValueOnce(SKILLS_B)
    const cwd = ref<string | null>('/proj-a')

    const { projectSkills } = useProjectSkills(cwd)
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_A))

    cwd.value = '/proj-b'
    await vi.waitFor(() => {
      expect(getProjectSkillsMock).toHaveBeenCalledWith('/proj-b')
    })
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_B))
  })

  it('切回旧 cwd 命中缓存，不重复 RPC', async () => {
    getProjectSkillsMock.mockResolvedValue(SKILLS_A)
    const cwd = ref<string | null>('/proj-a')

    const { projectSkills } = useProjectSkills(cwd)
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_A))
    expect(getProjectSkillsMock).toHaveBeenCalledTimes(1)

    cwd.value = '/proj-b'
    getProjectSkillsMock.mockResolvedValue(SKILLS_B)
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_B))
    expect(getProjectSkillsMock).toHaveBeenCalledTimes(2)

    // 切回 /proj-a → 命中缓存，不触发第 3 次 RPC
    cwd.value = '/proj-a'
    await vi.waitFor(() => expect(projectSkills.value).toEqual(SKILLS_A))
    expect(getProjectSkillsMock).toHaveBeenCalledTimes(2)
  })

  it('currentCwd 为 null → projectSkills 为空数组，不 RPC', async () => {
    const cwd = ref<string | null>(null)
    const { projectSkills } = useProjectSkills(cwd)

    // 等待一个 tick 确保 watch 不触发
    await vi.waitFor(() => {
      expect(getProjectSkillsMock).not.toHaveBeenCalled()
      expect(projectSkills.value).toEqual([])
    })
  })

  it('getProjectSkills 抛错 → projectSkills 为空数组，不崩（best-effort）', async () => {
    getProjectSkillsMock.mockRejectedValue(new Error('rpc fail'))
    const cwd = ref<string | null>('/proj-x')

    const { projectSkills } = useProjectSkills(cwd)

    await vi.waitFor(() => expect(getProjectSkillsMock).toHaveBeenCalled())
    await vi.waitFor(() => {
      expect(projectSkills.value).toEqual([])
    })
  })
})
