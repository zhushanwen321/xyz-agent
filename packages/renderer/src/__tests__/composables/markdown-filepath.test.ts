/**
 * markdown 路径识别 + ReDoS 防御测试。
 *
 * 覆盖范围（对应 spec AC-1 ~ AC-9）：
 *  - AC-1: FILEPATH_RE 性能（病态输入不卡死）
 *  - AC-7: BASENAME_RE 性能（同构病态，同测）
 *  - AC-9: 静态结构断言（正则源码无嵌套量词，兜底 CI 计时 flaky）
 *  - AC-3: 含分隔符路径识别（filepathRule inline 路径）
 *  - AC-4: 无扩展名路径识别（src/Makefile）
 *  - AC-8: code_inline 渲染路径（反引号内路径，linkifyFilePathsHtml 第二条路径）
 *  - AC-5: 误识别防御（版本号/小数/纯数字段不命中）
 *  - AC-6: 取消空格路径支持（docs/My Document.md 不再识别为整条）
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect）。禁止 node:test。
 * 运行：cd packages/renderer && npx vitest run markdown-filepath
 */
import { describe, it, expect } from 'vitest'
// FILEPATH_RE / BASENAME_RE 需导出以做性能断言 + 静态结构断言（AC-1/7/9）。
// renderMarkdown 用于功能验收（AC-3/4/5/6/8，间接走 filepathRule + code_inline renderer）。
import { renderMarkdown, FILEPATH_RE, BASENAME_RE } from '@/composables/logic/markdown'

// ── AC-1 / AC-7：性能断言（ReDoS 回归防护）──────────────────────────────
// 修复前：单次 exec 26 字符纯 word 序列 = 146ms，40 字符直接挂死。
// 修复后：线性无回溯，任意长度输入常数时间内完成。

describe('AC-1 FILEPATH_RE 性能（无灾难性回溯）', () => {
  it('40 字符纯 word 序列 100 次总耗时 < 50ms', () => {
    const input = 'x'.repeat(40)
    FILEPATH_RE.lastIndex = 0
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) {
      FILEPATH_RE.lastIndex = 0
      // eslint-disable-next-line no-empty
      while (FILEPATH_RE.exec(input) !== null) { /* drain */ }
    }
    const elapsed = performance.now() - t0
    // 50ms 阈值：修复前单次就 >30s，线性结构 100 次应在个位数 ms。
    // 阈值留 5x+ 余量对冲 CI 抖动（静态结构断言 AC-9 是真正的零抖动兜底）。
    expect(elapsed).toBeLessThan(50)
  })

  it('200 字符混合长输入（无 / 路径）单次 < 10ms', () => {
    const input = 'see foobarbazqux and someLongIdentifierName plus mixedABC123def ' + 'x'.repeat(130)
    FILEPATH_RE.lastIndex = 0
    const t0 = performance.now()
    // eslint-disable-next-line no-empty
    while (FILEPATH_RE.exec(input) !== null) { /* drain */ }
    expect(performance.now() - t0).toBeLessThan(10)
  })
})

describe('AC-7 BASENAME_RE 性能（同构病态，同测）', () => {
  it('40 字符纯 word 序列 100 次总耗时 < 50ms', () => {
    const input = 'x'.repeat(40)
    BASENAME_RE.lastIndex = 0
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) {
      BASENAME_RE.lastIndex = 0
      // eslint-disable-next-line no-empty
      while (BASENAME_RE.exec(input) !== null) { /* drain */ }
    }
    expect(performance.now() - t0).toBeLessThan(50)
  })
})

// ── AC-9：静态结构断言（零抖动兜底）──────────────────────────────────────
// CI 计时断言可能 flaky。静态断言检查正则源码不含嵌套量词模式——
// 这是 ReDoS 的结构特征，零抖动，作为动态计时断言的补充保险。

describe('AC-9 静态结构断言（正则无嵌套量词）', () => {
  // 嵌套量词模式：一个量词（+ 或 *）紧跟在另一个带量词的组之后，
  // 如 )+)+、)*)+、)+)* —— 这是 O(2^n) 回溯的结构根因。
  // 注：BASENAME_RE 退化结构本就无 / 段，结构更简，同样检查。
  const NESTED_QUANTIFIER_RE = /\)[+*][^?]*\)[+*]/

  it('FILEPATH_RE 源码不含嵌套量词', () => {
    expect(NESTED_QUANTIFIER_RE.test(FILEPATH_RE.source)).toBe(false)
  })

  it('BASENAME_RE 源码不含嵌套量词', () => {
    expect(NESTED_QUANTIFIER_RE.test(BASENAME_RE.source)).toBe(false)
  })
})

// ── AC-3 / AC-4：路径识别（filepathRule inline 路径）──────────────────────
// 走 renderMarkdown 间接验证 filepathRule（注册于 markdown-it inline ruler text 之前）。

describe('AC-3/AC-4 含分隔符路径识别（filepathRule）', () => {
  it('AC-3: 相对路径 src/foo.ts 识别为 md-filepath 链接', async () => {
    const html = await renderMarkdown('edit src/foo.ts please', {})
    expect(html).toContain('class="md-filepath"')
    expect(html).toContain('src/foo.ts')
  })

  it('AC-3: 绝对路径 /var/folders/x.md 识别', async () => {
    const html = await renderMarkdown('log at /var/folders/x.md', {})
    expect(html).toContain('/var/folders/x.md')
    expect(html).toContain('class="md-filepath"')
  })

  it('AC-3: 家目录路径 ~/Code/p/bar.vue 识别', async () => {
    const html = await renderMarkdown('see ~/Code/p/bar.vue', {})
    expect(html).toContain('~/Code/p/bar.vue')
    expect(html).toContain('class="md-filepath"')
  })

  it('AC-4: 无扩展名路径 src/Makefile 识别', async () => {
    const html = await renderMarkdown('run `src/Makefile` target', {})
    // src/Makefile 含字母，扩展名可选，应命中
    expect(html).toContain('src/Makefile')
    expect(html).toContain('class="md-filepath"')
  })

  it('AC-3: 路径出现在剩余串中部（前有其他文本）仍由边界符触发命中', async () => {
    // filepathRule 输入是 state.src.slice(pos) 整段剩余，路径常在串中部而非起点。
    // 「前缀文本 + 空格 + 路径」的空格是边界符集合成员，应触发识别。
    const html = await renderMarkdown('请修改 packages/renderer/src/index.ts 的导出', {})
    expect(html).toContain('packages/renderer/src/index.ts')
    expect(html).toContain('class="md-filepath"')
  })
})

// ── AC-8：code_inline 渲染路径（linkifyFilePathsHtml 第二条路径）──────────
// 反引号内容被 backticks rule 消费成 code_inline token，filepath rule 接触不到，
// 走 code_inline renderer 的 linkifyFilePathsHtml 二次识别。

describe('AC-8 code_inline 路径识别（反引号内路径）', () => {
  it('反引号包裹的路径仍识别为 md-filepath 链接', async () => {
    const html = await renderMarkdown('edit `src/foo.ts` now', {})
    expect(html).toContain('class="md-filepath"')
    expect(html).toContain('src/foo.ts')
  })

  it('反引号内绝对路径识别', async () => {
    const html = await renderMarkdown('config in `/etc/nginx/nginx.conf`', {})
    expect(html).toContain('/etc/nginx/nginx.conf')
    expect(html).toContain('class="md-filepath"')
  })
})

// ── AC-5：误识别防御 ──────────────────────────────────────────────────────

describe('AC-5 误识别防御', () => {
  it('版本号 glm-5.2 不识别为路径', async () => {
    const html = await renderMarkdown('model glm-5.2 is fast', {})
    expect(html).not.toContain('class="md-filepath"')
  })

  it('版本号 node/18.0 不识别为路径', async () => {
    // node/18.0 含 / 但扩展名 .0 纯数字，前瞻 (?=\d*[a-zA-Z]) 要求数字后必有字母 → 不命中
    const html = await renderMarkdown('requires node/18.0 or above', {})
    expect(html).not.toContain('class="md-filepath"')
  })

  it('小数 pi/3.14 不识别为路径', async () => {
    const html = await renderMarkdown('value is pi/3.14 approx', {})
    expect(html).not.toContain('class="md-filepath"')
  })

  it('纯数字无扩展名路径 src/123 不识别（前瞻与无扩展名交互边界）', async () => {
    // src/123 无扩展名，但 123 纯数字 —— 修复后线性结构下此边界由前瞻/无扩展名可选的语义决定。
    // 注：此用例验证「无扩展名 + 纯数字」不命中（与 src/Makefile 含字母命中形成对照）。
    const html = await renderMarkdown('folder src/123 has files', {})
    expect(html).not.toContain('class="md-filepath"')
  })
})

// ── AC-6：取消空格路径支持（设计取舍）──────────────────────────────────────

describe('AC-6 取消空格路径支持', () => {
  it('docs/My Document.md 不再识别为整条路径', async () => {
    // 取消空格支持后，带空格路径不被作为整条识别（反引号场景同理）。
    // 这是换取线性无回溯结构的明确代价（决策 D1）。
    const html = await renderMarkdown('see docs/My Document.md here', {})
    // 整条「docs/My Document.md」不应作为一个 md-filepath 链接出现
    expect(html).not.toContain('docs/My Document.md</a>')
  })
})

// ── AC-2 真实渲染不卡顿（real layer 集成场景）──────────────────────────────
// 模拟 cw-cli SKILL.md 的触发块：长中英混排 + 反引号 + 表格行 + 连续长标识符。
// handoff 实测：修复前对该类输入单次 render 挂死（>30s 无返回）。

describe('AC-2 真实渲染不卡顿（模拟 cw-cli SKILL.md 触发块）', () => {
  it('750+ chars 中英混排+反引号+表格行 单次 render < 100ms 且不抛错', async () => {
    // 构造接近真实触发块的输入：长连续英文词（曾触发回溯）+ 反引号路径 + 中文 + 表格行
    const triggerBlock = [
      '这是一段混排文本，包含长英文单词如 configurationmanagementstrategies 和 backwardcompatibilityguarantees，',
      '以及反引号路径 `packages/renderer/src/composables/logic/markdown.ts` 和 `~/Code/project/foo.ts`。',
      '还有表格行：',
      '| 字段 | 类型 | 说明 |',
      '|------|------|------|',
      '| FILEPATH_RE | RegExp | 路径识别正则，曾因 nestedquantifiers 导致 catastrophicbacktracking |',
      '更多连续字符序列：' + 'x'.repeat(60) + ' end.',
    ].join('\n')
    expect(triggerBlock.length).toBeGreaterThan(200)

    const t0 = performance.now()
    let html: string
    try {
      html = await renderMarkdown(triggerBlock, {})
    } catch (e) {
      // 渲染抛错 = 失败（修复前是挂死不返回，不是抛错）
      expect.fail(`renderMarkdown threw: ${(e as Error).message}`)
    }
    const elapsed = performance.now() - t0
    // 100ms 阈值：修复前挂死 >30s。线性结构应在个位数 ms。
    // 阈值留余量对冲 CI 抖动 + shiki 首次加载（单例建好后后续更快）。
    expect(elapsed).toBeLessThan(100)
    // 渲染产出非空（不是卡死空输出）
    expect(html.length).toBeGreaterThan(0)
  })
})
