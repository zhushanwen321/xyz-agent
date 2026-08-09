import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

/**
 * Plan 05 — reduced-motion 兜底细化 + TaijiLogo 守卫生效回归测试。
 * 源码字符串断言：TC1 logo spin 由 class 注入（motion-reduce 守卫生效）、
 * TC2 style.css reduced-motion 白名单保留辅助过渡、TC3 边界（默认值/path 几何/
 * 其他组件局部守卫保留）、TC4 @keyframes taiji-spin 存在。
 */
const rendererSrc = resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(resolve(rendererSrc, rel), 'utf-8')

const taijiLogo = read('src/components/icons/TaijiLogo.vue')
const styleCss = read('src/style.css')

/** 递归收集 src/components 下所有 .vue 文件（TC3 局部守卫扫描用） */
function collectVueFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectVueFiles(full, acc)
    else if (entry.endsWith('.vue')) acc.push(full)
  }
  return acc
}

describe('plan 05 reduced-motion 兜底 + TaijiLogo 守卫', () => {
  it('TC1: logo spin 由 :class 注入而非内联 style（motion-reduce:animate-none 可覆盖）', () => {
    // animation 移到动态 class（Tailwind arbitrary animate-[taiji-spin_...]）
    expect(taijiLogo).toContain(':class="spin ? `animate-[taiji-spin_${duration}s_linear_infinite]` : \'\'"')
    // :style 只留 transformOrigin，不再含 animation 键
    expect(taijiLogo).toContain(':style="{ transformOrigin: \'center\' }"')
    expect(taijiLogo).not.toContain('animation: `taiji-spin')
    // 静态 class 保留（局部守卫 + 布局类）
    expect(taijiLogo).toContain('class="block shrink-0 motion-reduce:animate-none"')
  })

  it('TC2: style.css reduced-motion 块白名单保留 opacity/color 等辅助过渡', () => {
    expect(styleCss).toContain(
      'transition-property: opacity, color, background-color, border-color, fill, stroke, box-shadow, filter',
    )
    expect(styleCss).toContain('transition-duration: var(--duration-fast) !important')
    // 瞬切兜底仍在（动画 + 位移过渡清零）
    expect(styleCss).toContain('animation-duration: 0.01ms !important')
    expect(styleCss).toContain('animation-iteration-count: 1 !important')
    expect(styleCss).toContain('transition-duration: 0.01ms !important')
    expect(styleCss).toContain('transition-delay: 0ms !important')
  })

  it('TC3 边界: spin 默认 true、duration 8、SVG path 几何未变、其他组件局部守卫保留', () => {
    // prop 默认值未动（品牌旋转保留）
    expect(taijiLogo).toContain('spin: true')
    expect(taijiLogo).toContain('duration: 8')
    // SVG path 几何未变：viewBox + 6 条 path + 首条 path d 前缀与改动前一致
    expect(taijiLogo).toContain('viewBox="0 0 1200 1200"')
    expect(taijiLogo).toContain('d="M3655 9803 c-107 -15 -300 -61 -489 -118')
    expect(taijiLogo.match(/<path d="/g)?.length).toBe(6)
    // 其他组件文件的 motion-reduce:animate-none 局部守卫保留（排除 TaijiLogo 自身）
    const otherGuards = collectVueFiles(resolve(rendererSrc, 'src/components'))
      .filter((f) => !f.endsWith('TaijiLogo.vue'))
      .filter((f) => readFileSync(f, 'utf-8').includes('motion-reduce:animate-none'))
    expect(otherGuards.length).toBeGreaterThan(0)
  })

  it('TC4: @keyframes taiji-spin 定义存在（arbitrary animation 引用有效）', () => {
    expect(styleCss).toContain('@keyframes taiji-spin')
  })
})
