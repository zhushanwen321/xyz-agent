/**
 * ignore-parser.test.ts — compileIgnoreRules/matchPath 纯函数（AC-1.3 + AC-16.5）
 *
 * 覆盖：空内容、简单名字、锚定、取反、目录后缀、注释/空行。
 * 语义对齐 git：多条规则按顺序求值，最后匹配规则决定结果（取反覆盖正向）。
 */
import { describe, it, expect } from 'vitest'
import { compileIgnoreRules, matchPath } from '../src/infra/fs/ignore-parser.js'

describe('compileIgnoreRules / matchPath', () => {
  describe('empty content', () => {
    it('empty matcher matches nothing for any path', () => {
      const m = compileIgnoreRules('')
      expect(matchPath(m, 'anything')).toBe(false)
      expect(matchPath(m, 'src/index.ts')).toBe(false)
    })

    it('whitespace-only content matches nothing', () => {
      const m = compileIgnoreRules('\n  \n\t\n')
      expect(matchPath(m, 'x/y')).toBe(false)
    })
  })

  describe('simple name (non-anchored)', () => {
    it('matches at any depth', () => {
      const m = compileIgnoreRules('node_modules')
      expect(matchPath(m, 'node_modules/pkg/index.js')).toBe(true)
    })

    it('matches top-level name', () => {
      const m = compileIgnoreRules('node_modules')
      expect(matchPath(m, 'node_modules')).toBe(true)
    })

    it('does not match name appearing only as substring of a segment', () => {
      // 'mynode_modules' is a different segment, should not match plain 'node_modules'
      const m = compileIgnoreRules('node_modules')
      expect(matchPath(m, 'mynode_modules/x')).toBe(false)
    })
  })

  describe('anchored pattern (leading /)', () => {
    it('matches only at root', () => {
      const m = compileIgnoreRules('/dist')
      expect(matchPath(m, 'dist/x')).toBe(true)
    })

    it('does not match when nested under another dir', () => {
      const m = compileIgnoreRules('/dist')
      expect(matchPath(m, 'src/dist')).toBe(false)
    })

    it('matches the anchored name itself', () => {
      const m = compileIgnoreRules('/dist')
      expect(matchPath(m, 'dist')).toBe(true)
    })
  })

  describe('negation (!)', () => {
    it('later negation overrides earlier positive', () => {
      const m = compileIgnoreRules(['node_modules', '!node_modules/keep'].join('\n'))
      expect(matchPath(m, 'node_modules/keep')).toBe(false)
    })

    it('positive still applies to non-negated paths', () => {
      const m = compileIgnoreRules(['node_modules', '!node_modules/keep'].join('\n'))
      expect(matchPath(m, 'node_modules/other')).toBe(true)
    })

    it('negation then positive: last match wins', () => {
      const m = compileIgnoreRules(['!foo', 'foo'].join('\n'))
      expect(matchPath(m, 'foo')).toBe(true)
    })
  })

  describe('directory suffix (/ trailing)', () => {
    it('does not match a file named like the dir', () => {
      // build/ → dir only; bare 'build' (a file) should not match
      const m = compileIgnoreRules('build/')
      expect(matchPath(m, 'build')).toBe(false)
    })

    it('matches contents under the directory', () => {
      const m = compileIgnoreRules('build/')
      expect(matchPath(m, 'build/output')).toBe(true)
    })

    it('matches deeper contents under the directory', () => {
      const m = compileIgnoreRules('build/')
      expect(matchPath(m, 'build/out/a/b')).toBe(true)
    })

    it('anchored dir suffix matches only at root', () => {
      const m = compileIgnoreRules('/build/')
      expect(matchPath(m, 'build/output')).toBe(true)
      expect(matchPath(m, 'src/build/output')).toBe(false)
    })
  })

  describe('comments and blank lines', () => {
    it('skips comment lines and blank lines', () => {
      const content = [
        '# this is a comment',
        '',
        '   ',
        'node_modules',
        '# another comment',
        '*.log',
      ].join('\n')
      const m = compileIgnoreRules(content)
      expect(matchPath(m, 'node_modules/x')).toBe(true)
      expect(matchPath(m, 'app.log')).toBe(true)
      expect(matchPath(m, 'src/main.ts')).toBe(false)
    })

    it('does not treat # in middle of line as comment', () => {
      // only lines STARTING with # are comments
      const m = compileIgnoreRules('foo#bar')
      expect(matchPath(m, 'foo#bar')).toBe(true)
    })
  })

  describe('wildcards', () => {
    it('* matches single segment (no slash)', () => {
      const m = compileIgnoreRules('*.log')
      expect(matchPath(m, 'app.log')).toBe(true)
      expect(matchPath(m, 'dir/app.log')).toBe(true) // non-anchored, any depth
    })

    it('* does not cross directory separator in the matched segment', () => {
      // *.log matches a single segment ending in .log; 'a/b.log' matches via dir-agnostic
      const m = compileIgnoreRules('/*.log')
      expect(matchPath(m, 'app.log')).toBe(true)
      expect(matchPath(m, 'a/app.log')).toBe(false) // anchored, must be root segment
    })

    it('** matches across directories', () => {
      const m = compileIgnoreRules('node_modules/**/test')
      expect(matchPath(m, 'node_modules/a/b/test')).toBe(true)
      expect(matchPath(m, 'node_modules/test')).toBe(true)
    })
  })

  /**
   * 短路径直通（D7-2，W24）：无 '/' 的路径只有自身一个前缀（allPrefixes('x') ≡ ['x']），
   * matchPath 跳过 allPrefixes 直接以 [path] 测试。等价性守卫：覆盖 plain/dirOnly/
   * negated/anchored 四类规则在无斜杠路径上的行为，防止直通分支引入语义漂移。
   */
  describe('short-path fast path (D7-2)', () => {
    it('plain name: short path matches the rule itself', () => {
      const m = compileIgnoreRules('dist')
      expect(matchPath(m, 'dist')).toBe(true)
      expect(matchPath(m, 'other')).toBe(false)
    })

    it('dirOnly rule: short path (bare name) not matched, contents matched via expansion', () => {
      const m = compileIgnoreRules('build/')
      expect(matchPath(m, 'build')).toBe(false) // dirOnly 不匹配目录自身名（与展开路径语义一致）
      expect(matchPath(m, 'build/out')).toBe(true) // 深路径走 allPrefixes 展开，行为不变
    })

    it('negation applies on short paths (last match wins)', () => {
      const m = compileIgnoreRules(['foo', '!foo'].join('\n'))
      expect(matchPath(m, 'foo')).toBe(false)
    })

    it('anchored rule: short path matches root-level name', () => {
      const m = compileIgnoreRules('/dist')
      expect(matchPath(m, 'dist')).toBe(true)
      expect(matchPath(m, 'src/dist')).toBe(false)
    })

    it('empty matcher: short path never matched', () => {
      const m = compileIgnoreRules('')
      expect(matchPath(m, 'x')).toBe(false)
    })
  })
})
