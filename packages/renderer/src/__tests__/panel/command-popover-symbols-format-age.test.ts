/**
 * command-popover-symbols 单测（增量覆盖 gate）+ open-fetch file 路 cwd 通道（D2/D3）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && pnpm vitest run src/__tests__/panel/command-popover-symbols-format-age.test.ts
 *
 * - formatAge 分档全覆盖：<1m 'now' / <1h 'Nm' / <1d 'Nh' / >=1d 'Nd' 封顶 + 未来时间钳 0；
 *   now 显式传参，不依赖真实当前时间。
 * - buildSessionCandidates（D1 删 hasSessionId 参）：landing/panel 统一「有数据就列」——
 *   空 sessions → []；有数据不过滤 landing/panel 区别（D7 口径不变：hidden 排除 + 子串过滤 + 降序）。
 * - buildSubagentCandidates：hasSessionId 参数保留（@ landing 空语义，G3/A5 护栏）。
 * - open-fetch file 路（mount）：landing 无 sid 有 cwd 边沿拉、无 cwd 不拉、panel 有 sid 不拉、
 *   1s 节流、拉取失败（session cwd 已删 runtime not_found）降级空候选。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { FileNode, SessionSummary, SubagentRecord } from '@xyz-agent/shared'
import { formatAge } from '@/components/panel/command-popover-symbols'

// open-fetch 直接 import composer domain（landing cwd 通道）——mock 之隔离真实 WS 通路。
// u5 re-anchor（e79ba3647/8ca21226f）后实现 import 的是 core 子路径，mock 必须对齐同一
// specifier（旧 '@/api/domains/composer' bridge 已删，mock 指旧路径 = mock 失效）；
// importActual 保留其余真实导出（getFileCandidates/getMentionCandidates）防其他消费方断链
const getFileCandidatesByCwdMock = vi.hoisted(() => vi.fn())
vi.mock('@xyz-agent/core/transport/api/domains/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyz-agent/core/transport/api/domains/composer')>()
  return {
    ...actual,
    getFileCandidatesByCwd: (...args: unknown[]) => getFileCandidatesByCwdMock(...args),
  }
})

import CommandPopover from '@/components/panel/CommandPopover.vue'
import { buildSessionCandidates, buildSubagentCandidates } from '@/components/panel/command-popover-symbols'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('formatAge 相对时间分档', () => {
  it('<1m → now；未来时间钳为 now（diff 负值归 0）', () => {
    const now = 1_000_000_000_000
    expect(formatAge(now - 30_000, now)).toBe('now')
    expect(formatAge(now + 5 * MIN, now)).toBe('now')
  })

  it('<1h → Nm', () => {
    const now = 1_000_000_000_000
    expect(formatAge(now - 5 * MIN, now)).toBe('5m')
    expect(formatAge(now - 59 * MIN, now)).toBe('59m')
  })

  it('<1d → Nh', () => {
    const now = 1_000_000_000_000
    expect(formatAge(now - 3 * HOUR, now)).toBe('3h')
    expect(formatAge(now - 23 * HOUR, now)).toBe('23h')
  })

  it('>=1d → Nd 封顶（多天仍用天数）', () => {
    const now = 1_000_000_000_000
    expect(formatAge(now - DAY, now)).toBe('1d')
    expect(formatAge(now - 45 * DAY, now)).toBe('45d')
  })
})

// ─────────────── buildSessionCandidates 删参（D1：landing/panel 统一「有数据就列」） ───────────────

const NOW = 1_000_000_000_000

const SESSIONS: SessionSummary[] = [
  { id: 'sess-alpha', label: 'alpha 设计讨论', cwd: '/p/a', status: 'idle', lastActiveAt: NOW - 60_000, modelId: 'm', tokenCount: 0 },
  { id: 'sess-beta', label: 'beta review', cwd: '/p/b', status: 'idle', lastActiveAt: NOW - 3 * 3_600_000, modelId: 'm', tokenCount: 0 },
]

describe('buildSessionCandidates 删 hasSessionId 参（D1/D7）', () => {
  it('空 sessions → []（无数据不弹的唯一门，与有无 session 上下文无关）', () => {
    expect(buildSessionCandidates([], '', NOW)).toEqual([])
    expect(buildSessionCandidates([], 'alpha', NOW)).toEqual([])
  })

  it('有数据 → 直接列全量（无 hasSessionId 门：landing/panel 不再有区别；D7 不做 landing 过滤）', () => {
    const items = buildSessionCandidates(SESSIONS, '', NOW)
    expect(items).toHaveLength(2)
    // 降序 + 两行副行维持（跨 cwd 全量口径不变）
    expect(items[0].name).toBe('alpha 设计讨论')
    expect(items[0].subText).toContain('/p/a')
    expect(items[0].subText).toContain('1m')
    expect(items[1].subText).toContain('3h')
  })

  it('hidden 排除 + label/id 子串过滤口径维持（删参仅删门，非删过滤）', () => {
    const withHidden: SessionSummary[] = [...SESSIONS, { ...SESSIONS[0], id: 'sess-h', label: 'hidden one', hidden: true }]
    expect(buildSessionCandidates(withHidden, '', NOW)).toHaveLength(2)
    expect(buildSessionCandidates(SESSIONS, 'beta', NOW)).toHaveLength(1)
    expect(buildSessionCandidates(SESSIONS, 'sess-beta', NOW)).toHaveLength(1) // id 子串命中
    expect(buildSessionCandidates(SESSIONS, 'zzz', NOW)).toEqual([])
  })
})

// ─────────── buildSubagentCandidates hasSessionId 保留（G3：@ landing 空语义，A5 护栏） ───────────

const RECORDS: SubagentRecord[] = [
  { subagentId: 'bg-1', sessionFile: null, agent: 'worker', slug: 'build-api', task: 't', status: 'running' },
]

describe('buildSubagentCandidates hasSessionId 保留（landing 空语义）', () => {
  it('hasSessionId=false（landing）→ []（含「新建」项也不返回）', () => {
    expect(buildSubagentCandidates(RECORDS, '', false, '新建 subagent')).toEqual([])
    expect(buildSubagentCandidates([], '', false, '新建 subagent')).toEqual([])
  })

  it('hasSessionId=true（panel）→ records + 固定「新建」尾项（语义不变）', () => {
    const items = buildSubagentCandidates(RECORDS, '', true, '新建 subagent')
    expect(items).toHaveLength(2)
    expect(items[0].slug).toBe('build-api')
    expect(items[1].id).toBe('__new_subagent__')
  })
})

// ─────────────── open-fetch file 路（D3：landing cwd 通道边沿拉，mount 验证） ───────────────

/** body 内浮层候选行（PopoverContent teleport 到 body，v-for 渲染为 .cmd-row div） */
function bodyRows(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll('.cmd-row'))
}

describe('open-fetch file 路 landing cwd 通道（D2/D3）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('无 sid 有 cwd：open false→true 边沿按 cwd 拉取，候选渲染进浮层（G1）', async () => {
    const nodes: FileNode[] = [{ path: 'src/index.ts', name: 'index.ts', type: 'file' }]
    getFileCandidatesByCwdMock.mockResolvedValueOnce({ files: nodes, truncated: false })
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', cwd: '/repo' },
    })
    await nextTick()
    expect(getFileCandidatesByCwdMock).not.toHaveBeenCalled() // 关闭态/挂载不预拉
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(1)
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledWith('/repo')
    // 拉取结果经 onCwdFileCandidates → items → 浮层 DOM（用户可见）
    expect(bodyRows().some((r) => r.textContent?.includes('index.ts'))).toBe(true)
  })

  it('无 sid 无 cwd：不拉（S4b 无数据源不弹，无 unhandled rejection）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).not.toHaveBeenCalled()
    expect(bodyRows()).toHaveLength(0)
    expect(document.body.querySelector('[data-reka-popper-content-wrapper]')).toBeNull()
  })

  it('有 sid（panel）：open-fetch 不拉（file 候选专属 store 缓存路，防双路重复 RPC）', async () => {
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', sessionId: 's1', cwd: '/repo' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).not.toHaveBeenCalled()
  })

  it('1s 节流：窗口内关→开不重拉（模式对齐 slash/subagent 路）', async () => {
    const nodes: FileNode[] = [{ path: 'a.ts', name: 'a.ts', type: 'file' }]
    getFileCandidatesByCwdMock.mockResolvedValue(nodes)
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', cwd: '/repo' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(1)
    // 关→开（1s 窗口内）：节流命中，不重拉
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(1)
  })

  it('拉取失败（session cwd 已删，runtime not_found）→ D7 错误态浮层「加载失败，点击重试」、不 throw', async () => {
    getFileCandidatesByCwdMock.mockRejectedValueOnce(Object.assign(new Error('session cwd not found'), { code: 'not_found' }))
    wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: false, type: 'file', cwd: '/deleted-dir' },
    })
    await nextTick()
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(1)
    // D7 失败路径（与 #10 合流裁决）：错误态浮层渲染（cmd-file-error）而非静默空候选；
    // unhandled rejection 不冒泡为失败
    const errorRow = document.body.querySelector('[data-testid="cmd-file-error"]')
    expect(errorRow).not.toBeNull()
    // 行可点重试（force 绕节流重发起拉取），重试成功后错误态消失、候选恢复
    getFileCandidatesByCwdMock.mockResolvedValueOnce({ files: [{ path: 'a.ts', name: 'a.ts', type: 'file' } as FileNode], truncated: false })
    ;(errorRow as HTMLElement).click()
    await flushPromises()
    expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[data-testid="cmd-file-error"]')).toBeNull()
    expect(bodyRows().some((r) => r.textContent?.includes('a.ts'))).toBe(true)
  })
})
