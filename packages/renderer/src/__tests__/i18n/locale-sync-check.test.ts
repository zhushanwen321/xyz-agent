/**
 * i18n-frontend-p2 U7 + U8: locale key 双侧对齐 + 组件模板 CJK 残留扫描（W5）。
 *
 * U7: 扫 packages/renderer/src/i18n/locales/zh-CN 与 en-US 双侧，断言每个子模块
 *     文件 key 集合完全一致（嵌套 key 也算）。
 * U8: 扫 components 下所有 .vue 文件的 template 块，断言无新增 CJK 字符（豁免清单外）。
 *
 * 这两个测试是"机械闸门"——任何漏网的中文 UI 文案或 locale desync 都会被捕获。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const LOCALES_DIR = resolve(__dirname, '../../i18n/locales')
const COMPONENTS_DIR = resolve(__dirname, '../../components')

interface LocaleObject {
  [key: string]: string | LocaleObject
}

/** 读 .ts locale 文件为对象（export default {...}） */
function loadLocaleObject(filePath: string): LocaleObject {
  const src = readFileSync(filePath, 'utf-8')
  // 极简解析：只支持 export default { ... } 形式（项目内 locale 全是这种）
  const match = src.match(/export\s+default\s+(\{[\s\S]*\})\s*$/)
  if (!match) throw new Error(`无法解析 locale 文件: ${filePath}`)
  // 用 Function 构造器 + 闭包模拟（避免引入额外依赖）
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const obj = new Function(`return (${match[1]});`)() as LocaleObject
  return obj
}

/** 拍平嵌套对象为 '.' 路径集合 */
function flattenKeys(obj: LocaleObject, prefix = ''): Set<string> {
  const out = new Set<string>()
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') {
      for (const sub of flattenKeys(v, fullKey)) out.add(sub)
    } else {
      out.add(fullKey)
    }
  }
  return out
}

/** 列出指定目录下所有 .ts 文件（不含子目录递归——locales 子目录就是子模块） */
function listTsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f))
}

/** 递归列 .vue 文件 */
function listVueFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...listVueFiles(full))
    } else if (full.endsWith('.vue')) {
      out.push(full)
    }
  }
  return out
}

/** 提取 .vue 的 <template> 块（贪婪匹配到第一个 </template>） */
function extractTemplate(source: string): string {
  const m = source.match(/<template>([\s\S]*?)<\/template>/)
  return m ? m[1] : ''
}

describe('U7: locale key 双侧对齐（zh-CN === en-US）', () => {
  const zhDir = join(LOCALES_DIR, 'zh-CN')
  const enDir = join(LOCALES_DIR, 'en-US')
  const zhFiles = listTsFiles(zhDir)
  const enFiles = listTsFiles(enDir)

  it('双侧子模块文件数量一致', () => {
    const zhNames = zhFiles.map((f) => f.split('/').pop()).sort()
    const enNames = enFiles.map((f) => f.split('/').pop()).sort()
    expect(enNames).toEqual(zhNames)
  })

  it.each(
    zhFiles.map((f) => ({ name: f.split('/').pop()!, zh: f, en: join(enDir, f.split('/').pop()!) })),
  )('$name 双侧 key 集合完全一致', ({ zh, en }) => {
    const zhKeys = flattenKeys(loadLocaleObject(zh))
    const enKeys = flattenKeys(loadLocaleObject(en))
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k))
    const extraInEn = [...enKeys].filter((k) => !zhKeys.has(k))
    expect({ missingInEn, extraInEn }).toEqual({ missingInEn: [], extraInEn: [] })
  })
})

describe('U8: 组件 <template> 无新增 CJK 字符（豁免清单外）', () => {
  /** 豁免清单：已知含 CJK 但属于合理使用的位置（mock fixtures / icon SVG / 数据值） */
  const ALLOW_FILES = new Set<string>([
    // 已知豁免：mock fixtures 含 CJK（数据值非 UI 文案）
    'components/panel/message-stream/gui/Card.vue', // 抽 placeholder mock
  ])

  it.each(listVueFiles(COMPONENTS_DIR))('%s 模板无新增 CJK 字符', (filePath) => {
    const rel = filePath.split('/packages/renderer/src/')[1]
    if (ALLOW_FILES.has(rel)) return
    const source = readFileSync(filePath, 'utf-8')
    const tpl = extractTemplate(source)
    // 移除 HTML 注释（<!-- ... -->）
    const tplNoComment = tpl.replace(/<!--[\s\S]*?-->/g, '')
    // 检测 CJK Unified Ideographs U+4E00-U+9FFF
    const cjkMatches = tplNoComment.match(/[\u4e00-\u9fff]/g) || []
    if (cjkMatches.length > 0) {
      // 输出首个 CJK 字符所在行（帮助定位）
      const lines = tplNoComment.split('\n')
      let firstLine = -1
      for (let i = 0; i < lines.length; i++) {
        if (/[\u4e00-\u9fff]/.test(lines[i])) {
          firstLine = i + 1
          break
        }
      }
      throw new Error(
        `${rel} 模板含 ${cjkMatches.length} 个 CJK 字符，首个在第 ${firstLine} 行: ${cjkMatches.slice(0, 3).join('')}`,
      )
    }
  })
})
