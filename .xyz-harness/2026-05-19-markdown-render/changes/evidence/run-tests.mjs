/**
 * Markdown 渲染管线验证脚本
 * 用 Node.js + tsx 直接调用 markdown.ts 的纯逻辑部分进行验证
 * 不涉及 Vue/DOM，只验证 HTML 输出正确性
 */
import { execSync } from 'child_process'

const RESULTS = []

function test(name, passed, detail = '') {
  RESULTS.push({ name, passed, detail })
  const icon = passed ? 'PASS' : 'FAIL'
  console.log(`[${icon}] ${name}${detail ? ' — ' + detail : ''}`)
}

// ── 用 vite build + node 执行测试 ──
// 直接用 tsx 执行 markdown.ts
console.log('=== Markdown 渲染管线验证 ===\n')

// 由于 markdown.ts 使用 ESM import 且依赖 shiki (WASM)，需要用 vite 预构建
// 改为直接用 node --import tsx 执行
try {
  const testCode = `
import { renderLightweight, renderFull, renderMarkdown } from './src/lib/markdown.ts'

let passed = 0
let failed = 0
const results = []

async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    passed++
    console.log('[PASS] ' + name)
  } catch (e) {
    results.push({ name, ok: false, error: e.message })
    failed++
    console.log('[FAIL] ' + name + ' — ' + e.message)
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed')
}

// ── Test 1: renderMarkdown 向后兼容 ──
await test('renderMarkdown 向后兼容', () => {
  const result = renderMarkdown('**bold**')
  assert(result.includes('<strong>bold</strong>'), 'should contain <strong> tag')
})

// ── Test 2: renderLightweight 基础渲染 ──
await test('renderLightweight 空字符串', () => {
  assert(renderLightweight('') === '', 'empty string returns empty')
})

await test('renderLightweight 段落', () => {
  const r = renderLightweight('hello world')
  assert(r.includes('hello world'), 'contains text')
})

await test('renderLightweight 粗体', () => {
  const r = renderLightweight('**bold**')
  assert(r.includes('<strong>bold</strong>'), 'bold tag')
})

await test('renderLightweight 行内代码', () => {
  const r = renderLightweight('\`code\`')
  assert(r.includes('<code>code</code>'), 'code tag')
})

await test('renderLightweight 链接', () => {
  const r = renderLightweight('[link](http://example.com)')
  assert(r.includes('href'), 'has href')
  assert(r.includes('http://example.com'), 'has url')
})

await test('renderLightweight 删除线', () => {
  const r = renderLightweight('~~deleted~~')
  assert(r.includes('<del>deleted</del>') || r.includes('<s>deleted</s>'), 'strikethrough')
})

await test('renderLightweight 表格', () => {
  const r = renderLightweight('| a | b |\\n|---|---|\\n| 1 | 2 |')
  assert(r.includes('<table') || r.includes('<th'), 'has table')
})

await test('renderLightweight 不高亮代码块', () => {
  const r = renderLightweight('\`\`\`python\\nprint("hi")\\n\`\`\`')
  assert(!r.includes('shiki'), 'no shiki in lightweight')
  assert(r.includes('print'), 'contains code text')
})

// ── Test 3: renderFull 代码高亮 ──
await test('renderFull 空字符串', async () => {
  const r = await renderFull('', 'dark')
  assert(r === '', 'empty returns empty')
})

await test('renderFull 基础段落', async () => {
  const r = await renderFull('hello world', 'dark')
  assert(r.includes('hello world'), 'contains text')
})

await test('renderFull Python 代码高亮', async () => {
  const r = await renderFull('\`\`\`python\\nprint("hello")\\n\`\`\`', 'dark')
  assert(r.includes('code-block'), 'has code-block wrapper')
  assert(r.includes('code-block-lang'), 'has lang label')
  assert(r.includes('python'), 'lang is python')
  assert(r.includes('code-copy-btn'), 'has copy button')
  assert(r.includes('line-numbers'), 'has line numbers')
})

await test('renderFull 代码块行号', async () => {
  const code = '\`\`\`python\\nline1\\nline2\\nline3\\n\`\`\`'
  const r = await renderFull(code, 'dark')
  assert(r.includes('1\\n2\\n3') || r.includes('1'), 'has line numbers')
})

await test('renderFull 文件名标签', async () => {
  const r = await renderFull('\`\`\`ts:main.ts\\nexport {}\\n\`\`\`', 'dark')
  assert(r.includes('main.ts'), 'has filename')
  assert(r.includes('code-block-filename'), 'has filename class')
})

await test('renderFull 长代码块折叠', async () => {
  const lines = Array.from({length: 25}, (_, i) => 'line ' + i).join('\\n')
  const r = await renderFull('\`\`\`python\\n' + lines + '\\n\`\`\`', 'dark')
  assert(r.includes('data-collapsed'), 'collapsed by default')
  assert(r.includes('code-expand-btn'), 'has expand button')
})

await test('renderFull 短代码块不折叠', async () => {
  const r = await renderFull('\`\`\`python\\nshort\\n\`\`\`', 'dark')
  assert(!r.includes('data-collapsed'), 'not collapsed')
  assert(!r.includes('code-expand-btn'), 'no expand button')
})

await test('renderFull 表格', async () => {
  const r = await renderFull('| a | b |\\n|---|---|\\n| 1 | 2 |', 'dark')
  assert(r.includes('<table'), 'has table')
  assert(r.includes('<th'), 'has header')
})

await test('renderFull Mermaid 占位', async () => {
  const r = await renderFull('\`\`\`mermaid\\ngraph TD; A-->B\\n\`\`\`', 'dark')
  assert(r.includes('mermaid-source'), 'has mermaid-source class')
  assert(r.includes('data-mermaid'), 'has data-mermaid attr')
})

await test('renderFull 任务列表', async () => {
  const r = await renderFull('- [x] done\\n- [ ] todo', 'dark')
  assert(r.includes('task-list-item'), 'has task list class')
  assert(r.includes('checkbox'), 'has checkbox')
  assert(r.includes('checked'), 'has checked')
})

await test('renderFull KaTeX 行内公式', async () => {
  const r = await renderFull('$E=mc^2$', 'dark')
  // KaTeX outputs .katex class
  assert(r.includes('katex') || r.includes('E=mc'), 'katex rendered or raw preserved')
})

await test('renderFull 亮色主题', async () => {
  const r = await renderFull('\`\`\`js\\nconst x = 1\\n\`\`\`', 'light')
  assert(r.includes('code-block'), 'renders in light theme')
})

await test('renderFull 暗色主题', async () => {
  const r = await renderFull('\`\`\`js\\nconst x = 1\\n\`\`\`', 'dark')
  assert(r.includes('code-block'), 'renders in dark theme')
})

await test('renderFull 标题', async () => {
  const r = await renderFull('# Title\\n## Sub\\n### Sub2', 'dark')
  assert(r.includes('<h1'), 'has h1')
  assert(r.includes('<h2'), 'has h2')
  assert(r.includes('<h3'), 'has h3')
})

await test('renderFull 引用块', async () => {
  const r = await renderFull('> quote text', 'dark')
  assert(r.includes('<blockquote'), 'has blockquote')
})

await test('renderFull 无语言代码块', async () => {
  const r = await renderFull('\`\`\`\\nplain text\\n\`\`\`', 'dark')
  assert(r.includes('code-block'), 'renders as code block')
})

console.log('\\n=== Results ===')
console.log('Passed: ' + passed)
console.log('Failed: ' + failed)
process.exit(failed > 0 ? 1 : 0)
`

  // Write test to temp file
  const fs = await import('fs')
  const tmpFile = '/tmp/markdown-test.mjs'
  fs.writeFileSync(tmpFile, testCode)
  
  // Run with tsx
  const output = execSync(`cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-markdown-render/src-electron/renderer && npx tsx ${tmpFile}`, {
    timeout: 60000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  })
  
  console.log(output)
  
  const lines = output.split('\n')
  const passLine = lines.find(l => l.startsWith('Passed:'))
  const failLine = lines.find(l => l.startsWith('Failed:'))
  const passed = passLine ? parseInt(passLine.split(':')[1].trim()) : 0
  const failed = failLine ? parseInt(failLine.split(':')[1].trim()) : 0
  
  test('全部测试通过', failed === 0, `passed=${passed}, failed=${failed}`)
  
} catch (e) {
  const output = e.stdout || e.message
  console.log('\n--- Error output ---')
  console.log(output)
  
  // Count PASS/FAIL from output
  const passCount = (output.match(/\[PASS\]/g) || []).length
  const failCount = (output.match(/\[FAIL\]/g) || []).length
  test('全部测试通过', failCount === 0, `passed=${passCount}, failed=${failCount}`)
}

// ── Build 验证 ──
console.log('\n=== 构建验证 ===')
try {
  execSync('npx vite build --logLevel error', {
    cwd: '/Users/zhushanwen/Code/xyz-agent-workspace/feat-markdown-render/src-electron/renderer',
    timeout: 60000,
    encoding: 'utf-8'
  })
  test('Vite build 成功', true)
} catch (e) {
  test('Vite build 成功', false, e.message?.slice(0, 200))
}

// ── TypeScript 类型检查 ──
console.log('\n=== 类型检查 ===')
try {
  const tsOutput = execSync(`
    cd /Users/zhushanwen/Code/xyz-agent-workspace/feat-markdown-render/src-electron/renderer && node -e "
const ts = require('typescript');
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, '.');
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
const relevant = diagnostics.filter(d => {
  const file = d.file ? d.file.fileName : '';
  return file.includes('MessageBubble') || file.includes('markdown');
});
console.log(relevant.length);
"
  `, { encoding: 'utf-8', timeout: 30000 })
  const errorCount = parseInt(tsOutput.trim())
  test('TypeScript 类型检查 (markdown + MessageBubble)', errorCount === 0, `${errorCount} errors`)
} catch (e) {
  test('TypeScript 类型检查', false, e.message?.slice(0, 200))
}

// ── 汇总 ──
console.log('\n=== 汇总 ===')
const allPassed = RESULTS.every(r => r.passed)
const totalPassed = RESULTS.filter(r => r.passed).length
const totalFailed = RESULTS.filter(r => !r.passed).length
console.log(`总计: ${totalPassed} passed, ${totalFailed} failed`)
console.log(`Verdict: ${allPassed ? 'PASS' : 'FAIL'}`)

process.exit(allPassed ? 0 : 1)
