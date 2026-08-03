// AC1 回归护栏（W1）：mobile-renderer → @xyz-agent/core + @xyz-agent/ui 物理依赖边。
// 包拓扑（package.json workspace:*）+ 入口 import（main.ts）双断言。
// 未来若有人把 core/ui 依赖降级为 sync-copy 或删除 main.ts import，此测试红。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// vitest 运行时 cwd 即包根（vitest.config.ts 所在目录），package.json 与 src 均在其下
const pkgRoot = process.cwd()

describe('AC1: mobile-renderer 包拓扑依赖边', () => {
  const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf-8')) as {
    dependencies: Record<string, string>
  }

  it('package.json dependencies 含 @xyz-agent/core（workspace:*）', () => {
    expect(pkg.dependencies['@xyz-agent/core']).toBe('workspace:*')
  })

  it('package.json dependencies 含 @xyz-agent/ui（workspace:*）', () => {
    expect(pkg.dependencies['@xyz-agent/ui']).toBe('workspace:*')
  })
})

describe('AC1: main.ts 入口 import 依赖边', () => {
  const mainSrc = readFileSync(resolve(pkgRoot, 'src/main.ts'), 'utf-8')

  it('main.ts import 自 @xyz-agent/core', () => {
    expect(mainSrc).toMatch(/from '@xyz-agent\/core'/)
  })

  it('main.ts import 自 @xyz-agent/ui', () => {
    expect(mainSrc).toMatch(/from '@xyz-agent\/ui'/)
  })
})
