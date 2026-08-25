/**
 * format-utils 纯函数测试（W3 折叠头截短 + 末行截取）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/format-utils.test.ts
 */
import { describe, it, expect } from 'vitest'
import { shortenForHeader, tailLines } from '../format-utils'

describe('shortenForHeader', () => {
  // U1: bash 命令——绝对路径 4 段截短，相对路径不动
  it('U1: bash cd 绝对路径截短 + 相对路径保留', () => {
    const input = 'cd /Users/z/Code/repo-wt && rg -l -i "drawer" packages/renderer/src'
    expect(shortenForHeader(input)).toBe(
      'cd \u2026/Code/repo-wt && rg -l -i "drawer" packages/renderer/src',
    )
  })

  // U2: home 规则优先——替换后 ~/notes/a.md 不再是 ≥3 段绝对路径
  it('U2: home 前缀替换为 ~，阻止规则②触发', () => {
    expect(shortenForHeader('/Users/z/notes/a.md', { home: '/Users/z' })).toBe('~/notes/a.md')
  })

  // U3: 相对路径 + 两段绝对路径——原样返回
  it('U3: 相对路径与两段绝对路径不变', () => {
    expect(shortenForHeader('packages/ui/src/chat/Block.vue')).toBe('packages/ui/src/chat/Block.vue')
    expect(shortenForHeader('/a/b.vue')).toBe('/a/b.vue')
  })

  // U4: 空输入返回空串
  it('U4: 空字符串与 null 返回空串', () => {
    expect(shortenForHeader('')).toBe('')
    expect(shortenForHeader(null as unknown as string)).toBe('')
  })

  // U5: URL——scheme+host 占位保护，路径原样保留
  it('U5: URL scheme+host 保护，路径部分保留原样', () => {
    const input = 'curl https://example.com/a/b/c/d.tar.gz'
    expect(shortenForHeader(input)).toBe('curl https://example.com/a/b/c/d.tar.gz')
  })

  // 追加：真实 bash 场景长命令
  it('真实 bash 场景：长路径截短含子串', () => {
    const input =
      'cd /Users/zhushanwen/Code/xyz-agent-workspace/fix-drawer-subagent-render && rg -l -i "drawer" packages/renderer/src --type vue --type ts | head -30'
    const result = shortenForHeader(input)
    expect(result).toContain('\u2026/xyz-agent-workspace/fix-drawer-subagent-render')
  })

  // 追加：引号内路径同样生效
  it('引号内绝对路径同样截短', () => {
    expect(shortenForHeader('edit "/a/b/c/d.txt"')).toBe('edit "\u2026/c/d.txt"')
  })
})

describe('tailLines', () => {
  // U6: 正常取末 n 行
  it('U6: 取末 3 行', () => {
    expect(tailLines('l1\nl2\nl3\nl4', 3)).toEqual(['l2', 'l3', 'l4'])
  })

  // U7: 不足 n 行全返 + 空文本返回 []
  it('U7: 不足 n 行全返；空文本返回 []', () => {
    expect(tailLines('l1\nl2', 3)).toEqual(['l1', 'l2'])
    expect(tailLines('', 3)).toEqual([])
  })
})
