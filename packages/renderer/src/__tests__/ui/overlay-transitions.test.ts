import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 浮层进出场过渡回归守卫（Plan 01: overlay enter-exit transition）。
 *
 * 背景：tailwindcss-animate 插件未安装，旧的 data-state animate/zoom/fade/slide
 * utility 类不生成任何 CSS（死类）。Plan 01 用手写 CSS transition 原语类
 * （reka-*-transition）替代，由 reka data-state 驱动 + starting-style 入场起点。
 *
 * 本测试固化该重构成果，防止回归：
 *   1. style.css 必须定义 3 个过渡原语类 + starting-style 块
 *   2. 4 个浮层组件必须接入对应原语类
 *   3. 4 个浮层组件不得残留死类（animate-in/zoom/fade/slide）
 *
 * 参考：.xyz-harness/2026-08-09-animation-audit/01-overlay-enter-exit-transition.md
 */
const styleCss = readFileSync(resolve(__dirname, '../../style.css'), 'utf-8')
const popoverContent = readFileSync(
  resolve(__dirname, '../../components/ui/popover/PopoverContent.vue'),
  'utf-8',
)
const selectContent = readFileSync(
  resolve(__dirname, '../../components/ui/select/SelectContent.vue'),
  'utf-8',
)
const hoverCardContent = readFileSync(
  resolve(__dirname, '../../components/ui/hover-card/HoverCardContent.vue'),
  'utf-8',
)
const dialogContent = readFileSync(
  resolve(__dirname, '../../components/ui/dialog/DialogContent.vue'),
  'utf-8',
)

const DEAD_CLASSES = [
  'animate-in',
  'animate-out',
  'zoom-in-95',
  'zoom-out-95',
  'fade-in-0',
  'fade-out-0',
  'slide-in-from',
  'slide-out-to',
]

describe('浮层进出场过渡原语（Plan 01）', () => {
  describe('style.css 定义 3 个过渡原语类', () => {
    it('.reka-popover-transition 跟随触发点 scale（消费 --reka-popper-transform-origin）', () => {
      expect(styleCss).toContain('.reka-popover-transition')
      expect(styleCss).toContain(
        'transform-origin: var(--reka-popper-transform-origin, center)',
      )
      expect(styleCss).toContain('data-state=\'open\'')
      expect(styleCss).toContain('data-state=\'closed\'')
    })

    it('.reka-dialog-transition 居中缩放（transform 保留 translate 居中）', () => {
      expect(styleCss).toContain('.reka-dialog-transition')
      expect(styleCss).toContain('translate(-50%, -50%) scale(1)')
      expect(styleCss).toContain('translate(-50%, -50%) scale(0.96)')
    })

    it('.reka-overlay-transition 纯 opacity', () => {
      expect(styleCss).toContain('.reka-overlay-transition')
    })

    it('@starting-style 提供入场起点（3 个原语类各一）', () => {
      expect(styleCss).toContain('@starting-style')
      // popover 族入场起点：scale(0.96) opacity 0
      const popoverStart = styleCss.match(
        /@starting-style\s*\{[^}]*\.reka-popover-transition\[data-state='open'\][^}]*\}/s,
      )
      expect(popoverStart, '.reka-popover-transition 的 @starting-style 块存在').not.toBeNull()
      // dialog 入场起点
      const dialogStart = styleCss.match(
        /@starting-style\s*\{[^}]*\.reka-dialog-transition\[data-state='open'\][^}]*\}/s,
      )
      expect(dialogStart, '.reka-dialog-transition 的 @starting-style 块存在').not.toBeNull()
      // overlay 入场起点
      const overlayStart = styleCss.match(
        /@starting-style\s*\{[^}]*\.reka-overlay-transition\[data-state='open'\][^}]*\}/s,
      )
      expect(overlayStart, '.reka-overlay-transition 的 @starting-style 块存在').not.toBeNull()
    })
  })

  describe('popover 族组件接入 reka-popover-transition 且无死类', () => {
    it('PopoverContent.vue 接入原语类', () => {
      expect(popoverContent).toContain('reka-popover-transition')
    })

    it('SelectContent.vue 接入原语类', () => {
      expect(selectContent).toContain('reka-popover-transition')
    })

    it('HoverCardContent.vue 接入原语类', () => {
      expect(hoverCardContent).toContain('reka-popover-transition')
    })

    it.each(DEAD_CLASSES)('PopoverContent.vue 无死类 %s', (dead) => {
      expect(popoverContent, `PopoverContent.vue 不应残留死类 ${dead}`).not.toContain(dead)
    })

    it.each(DEAD_CLASSES)('SelectContent.vue 无死类 %s', (dead) => {
      expect(selectContent, `SelectContent.vue 不应残留死类 ${dead}`).not.toContain(dead)
    })

    it.each(DEAD_CLASSES)('HoverCardContent.vue 无死类 %s', (dead) => {
      expect(hoverCardContent, `HoverCardContent.vue 不应残留死类 ${dead}`).not.toContain(dead)
    })
  })

  describe('dialog 组件接入 reka-dialog/overlay-transition 且无死类', () => {
    it('DialogContent 接入 reka-dialog-transition', () => {
      expect(dialogContent).toContain('reka-dialog-transition')
    })

    it('DialogOverlay 接入 reka-overlay-transition', () => {
      expect(dialogContent).toContain('reka-overlay-transition')
    })

    it('DialogContent 不再用 -translate 居中（由 transition transform 承担）', () => {
      expect(dialogContent).not.toContain('-translate-x-1/2')
      expect(dialogContent).not.toContain('-translate-y-1/2')
    })

    it.each(DEAD_CLASSES)('DialogContent.vue 无死类 %s', (dead) => {
      expect(dialogContent, `DialogContent.vue 不应残留死类 ${dead}`).not.toContain(dead)
    })
  })
})
