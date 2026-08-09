import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Plan 04 — 删除常驻装饰性动画（pulse-dot / steer-breathe / wiggle）回归测试。
 * 源码字符串断言：4 处常驻动画已删除（TC1-TC4）+ 边界保留（TC5：streaming spin、
 * keyframes 定义不动）。
 */
const rendererSrc = resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(resolve(rendererSrc, rel), 'utf-8')

const segmentedTab = read('src/components/sidebar/SegmentedTab.vue')
const sessionItem = read('src/components/sidebar/SessionItem.vue')
const composerShell = read('src/composables/panel/composer-shell.ts')
const sessionStatus = read('src/composables/logic/sessionStatus.ts')
const styleCss = read('src/style.css')

const PULSE_ANIM = 'animate-[pulse-dot_1.8s_ease-in-out_infinite]'

describe('plan 04 删除常驻装饰性动画', () => {
  it('TC1: SegmentedTab badge 为静态（无 pulse-dot / motion-reduce 动画 class）', () => {
    expect(segmentedTab).not.toContain(PULSE_ANIM)
    expect(segmentedTab).not.toContain('motion-reduce:animate-none')
    // 静态 badge 本体保留
    expect(segmentedTab).toContain('absolute right-1 top-1 size-[7px] rounded-full bg-accent')
  })

  it('TC2: SessionItem running 指示条为静态（无 pulse-dot，尺寸/底色保留）', () => {
    expect(sessionItem).not.toContain(PULSE_ANIM)
    expect(sessionItem).toContain('inline-block h-[9px] w-[3px] rounded-[2px] bg-accent')
  })

  it('TC3: composer-shell isActive 分支为静态 ring（无 steer-breathe，border+shadow 保留）', () => {
    expect(composerShell).not.toContain('animate-steer-breathe')
    expect(composerShell).toContain('border-[var(--accent)] shadow-[0_0_0_3px_rgba(79,142,247,0.25)]')
  })

  it('TC4: sessionStatus waiting 对齐静态范式（animation 为空串，无 animate-wiggle）', () => {
    expect(sessionStatus).toContain("waiting: { icon: 'Wrench', color: 'text-warn', animation: '' }")
    expect(sessionStatus).not.toContain('animate-wiggle')
  })

  it('TC5 边界: streaming/compacting/working 的 spin 保留，keyframes 定义不动', () => {
    // 有「正在产出」语义的动画保留
    expect(sessionStatus).toContain("streaming: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    expect(sessionStatus).toContain("compacting: { icon: 'Hourglass', color: 'text-accent', animation: 'animate-spin' }")
    expect(sessionStatus).toContain("working: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    // keyframes 定义保留（pulse-dot 仍被 SystemShortcutSection 消费；wiggle/steer-breathe 暂留待后续清理）
    expect(styleCss).toContain('@keyframes pulse-dot')
    expect(styleCss).toContain('@keyframes wiggle')
    expect(styleCss).toContain('@keyframes steer-breathe')
  })
})
