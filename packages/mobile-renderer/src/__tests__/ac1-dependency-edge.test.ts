// AC1 回归护栏（W1）：mobile-renderer → @xyz-agent/core + @xyz-agent/ui 物理依赖边。
// 包拓扑（package.json workspace:*）+ 入口 import（main.ts）双断言。
// 未来若有人把 core/ui 依赖降级为 sync-copy 或删除 main.ts import，此测试红。
//
// M1d-01：补充禁止边与白名单校验——
//   - 允许边白名单：@xyz-agent/core / dom-core / ui / shared（架构分层 shared←core←dom-core←ui←mobile）
//   - 禁止边：@xyz-agent/renderer（渲染壳包不得依赖桌面壳，违反分层）
//   - 故意把 @xyz-agent/renderer 加进 dependencies 会让本测试红（护栏有效）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// vitest 运行时 cwd 即包根（vitest.config.ts 所在目录），package.json 与 src 均在其下
const pkgRoot = process.cwd()

/** 允许依赖的 @xyz-agent/* 包白名单（arch-fix-v2 分层：shared←core←dom-core←ui←mobile 装配层） */
const ALLOWED_XYZ_DEPS = ['@xyz-agent/core', '@xyz-agent/dom-core', '@xyz-agent/ui', '@xyz-agent/shared'] as const

/** 禁止依赖集合（壳包不得反向依赖上层/渲染层） */
const FORBIDDEN_XYZ_DEPS = ['@xyz-agent/renderer'] as const

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

  it('所有 @xyz-agent/* 依赖 ∈ 允许边白名单（core/dom-core/ui/shared）', () => {
    const xyzDeps = Object.keys(pkg.dependencies).filter((d) => d.startsWith('@xyz-agent/'))
    expect(xyzDeps.length).toBeGreaterThan(0)
    for (const dep of xyzDeps) {
      expect(ALLOWED_XYZ_DEPS).toContain(dep)
    }
  })

  it('禁止依赖集不在 dependencies（@xyz-agent/renderer 等，M1d-01 负向护栏）', () => {
    for (const dep of FORBIDDEN_XYZ_DEPS) {
      expect(pkg.dependencies[dep]).toBeUndefined()
    }
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

  it('main.ts 不 import 自 @xyz-agent/renderer（M1d-01 负向护栏）', () => {
    expect(mainSrc).not.toMatch(/from '@xyz-agent\/renderer'/)
  })
})
