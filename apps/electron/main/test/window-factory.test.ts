/**
 * window-factory 窗口级拓扑配置源码断言（review MF-5）。
 *
 * D-6 拓扑回填的窗口级配置（BrowserWindow options）零单测，且创建 BrowserWindow
 * 需要 electron 运行时（vitest 无法实例化）。改用源码断言（fork-keymap.test.ts 同款
 * readFileSync 模式）：断言配置常量存在且数值正确，防止回填被后续改动静默退化。
 *
 * 覆盖：
 *  - title 'TaiJi'（打包窗口标题）
 *  - mac titleBarStyle 'hidden' + trafficLightPosition {x:16,y:26}（红黄绿原生左上角，
 *    圆点中线 y=32 与 AppNavControls / PanelHeader 三处 chrome 对齐）
 *  - win/linux frame:false（renderer TrafficLight 自绘圆点 mimic mac）
 *
 * 运行：cd apps/electron/main && npx vitest run test/window-factory.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sourcePath = new URL('../window/window-factory.ts', import.meta.url)
const source = readFileSync(sourcePath, 'utf-8')

describe('window-factory: D-6 窗口级拓扑配置', () => {
  it('title 为 TaiJi', () => {
    expect(source).toContain("title: 'TaiJi'")
  })

  it('mac：titleBarStyle hidden + trafficLightPosition {x:16,y:26}（红黄绿中线 y=32 对齐三处 chrome）', () => {
    expect(source).toContain("titleBarStyle: 'hidden' as const")
    expect(source).toContain('trafficLightPosition: { x: 16, y: 26 }')
  })

  it('win/linux：frame:false（renderer TrafficLight 自绘圆点 mimic mac）', () => {
    expect(source).toContain(': { frame: false }')
  })
})
