#!/usr/bin/env node
/**
 * 文档-代码符号漂移守卫（doc-symbol-drift）。
 *
 * [HISTORICAL] 起因 2026-08-31：update 模块 13 个路径常量函数化（4f973590e）后，
 * 设计文档与 impl-plan 中 3 处旧常量引用（UPDATE_DIR / MANUAL_ASSET_DIR×2）悬空
 * 存活，无任何机器信号，靠事后对抗审查才抓出。本脚本把「文档引用已删除/改名符号」
 * 变成可机检的失败。
 *
 * 检查逻辑（TypeScript 编译器 API = tsserver 同源语义引擎，语法级 AST 解析，
 * 不起 LSP server、不做完整类型检查，单文档毫秒级）：
 *   1. 从映射源码模块收集合法符号表：命名导出（const/function/class/interface/
 *      type/enum + export {} specifier）+ export const 对象字面量的一层属性键
 *      （错误码族如 UPDATE_ERROR_MESSAGES 的键由此覆盖）
 *   2. 从映射设计文档提取反引号 span 内的符号候选：
 *      蛇形大写（≥2 段，如 UPDATE_DIR）+ get 前缀驼峰（如 getUpdateDir）
 *   3. 候选不在符号表且不在 env 前缀白名单（XYZ_* / PI_*）→ 报 drift，exit 1
 *
 * 书写约定：反引号 = 现行代码符号。历史性提及已删除/改名的符号（如描述事故成因）
 * 不带反引号——带反引号即按现状引用检查，这正是本守卫的判定口径。
 *
 * 映射表 DOC_MODULE_MAP 是显式登记（文档 → 权威源码模块）。新增设计文档时在
 * 此登记映射，未登记的文档不检查（宁缺勿滥，误报面收敛到声明过的对照对）。
 *
 * 用法：node scripts/check-doc-symbol-drift.mjs（始终检查全部映射文档——触发面
 * 由 pre-commit 按路径控制，检查本身毫秒级无需增量）
 */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const PROJECT_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..')

/**
 * 文档 → 权威源码模块映射（新增设计文档在此登记）。
 * 值为目录（递归收 .ts，排除 __tests__/test）或精确文件。
 */
const DOC_MODULE_MAP = {
  'docs/design/update-network-resilience.md': ['apps/electron/main/update', 'apps/electron/main/gateway/update-handlers.ts'],
  'docs/design/update-network-resilience.impl-plan.md': ['apps/electron/main/update', 'apps/electron/main/gateway/update-handlers.ts'],
}

/** 环境变量名白名单（非导出符号，文档合法引用）：项目 env 前缀 */
const ENV_NAME_ALLOW_RE = /^(XYZ_|PI_|NODE_|ELECTRON_)[A-Z0-9_]+$/
/** undici errno 字符串族（文档描述错误分类的字符串字面量，非本项目符号） */
const ERRNO_STRING_ALLOW_RE = /^(UND_ERR_|E[A-Z]{3,})/

// ─── 源码侧：收集合法符号表 ─────────────────────────────────────────

/** 递归收集目录下 .ts（排除测试目录与 .d.ts） */
function collectTsFiles(absDir) {
  const out = []
  for (const name of readdirSync(absDir)) {
    const full = path.join(absDir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'test' || name === 'node_modules' || name === 'dist') continue
      out.push(...collectTsFiles(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

/**
 * 从单个 .ts 的 AST 提取符号。检查语义是「存在性」而非「可导入性」：
 * - 命名导出（export const/function/class/interface/type/enum 的名字）
 * - export { a, b as c } 的导出名
 * - 模块级 const/let 声明（含非 export——文档引用私有常量名描述机制不算漂移）
 * - export const OBJ = { KEY: ...} 的一层属性键（错误码族覆盖）
 */
function extractExportedSymbols(sourceFile) {
  const symbols = new Set()
  const objKeys = new Set()

  function visit(node) {
    // 模块级 const/let/var（export 与否均收：存在性检查）
    if (ts.isVariableStatement(node) && node.parent === sourceFile) {
      const isExport = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          symbols.add(decl.name.text)
          // 一层属性键：export const MESSAGES = { CODE: ... } → CODE 合法
          if (isExport && ts.isObjectLiteralExpression(decl.initializer)) {
            for (const prop of decl.initializer.properties) {
              if (ts.isPropertyAssignment(prop)) {
                if (ts.isIdentifier(prop.name)) objKeys.add(prop.name.text)
                else if (ts.isStringLiteral(prop.name)) objKeys.add(prop.name.text)
              }
            }
          }
        }
      }
    }
    // export function/class/interface/type/enum
    for (const kind of ['FunctionDeclaration', 'ClassDeclaration', 'InterfaceDeclaration', 'TypeAliasDeclaration', 'EnumDeclaration']) {
      const fn = ts[`is${kind}`]
      if (fn && fn(node) && node.name && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        symbols.add(node.name.text)
      }
    }
    // export { a, b as c }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        symbols.add((el.propertyName ?? el.name).text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { symbols, objKeys }
}

/** 汇总一组源码路径的合法符号表 */
function buildSymbolTable(modulePaths) {
  const exported = new Set()
  const objKeys = new Set()
  const files = []
  for (const p of modulePaths) {
    const abs = path.join(PROJECT_ROOT, p)
    if (statSync(abs).isDirectory()) files.push(...collectTsFiles(abs))
    else files.push(abs)
  }
  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf-8'), ts.ScriptTarget.Latest, true)
    const { symbols, objKeys: keys } = extractExportedSymbols(sf)
    for (const s of symbols) exported.add(s)
    for (const k of keys) objKeys.add(k)
  }
  return { exported, objKeys, fileCount: files.length }
}

// ─── 文档侧：提取反引号符号候选 ─────────────────────────────────────

const SCREAMING_SNAKE_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g
// get 前缀驼峰只认「紧跟 (」的函数调用形态——`update:getPreloaded` 这类 IPC channel
// 名/属性名无括号，不是符号引用，不检查
const GET_CAMEL_CALL_RE = /\b(get[A-Z][A-Za-z0-9]*)\(/g

/**
 * 从 md 文本提取符号候选。
 * @returns {Map<string, number[]>} 符号 → 出现行号列表（1-based）
 */
function extractDocCandidates(mdText) {
  const candidates = new Map()
  const lines = mdText.split('\n')
  const add = (sym, line) => {
    if (!candidates.has(sym)) candidates.set(sym, [])
    candidates.get(sym).push(line)
  }
  // 逐行扫反引号 span（跨行 span 不支持——设计文档惯例单行内闭合）
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      for (const sm of m[1].matchAll(SCREAMING_SNAKE_RE)) add(sm[0], i + 1)
      for (const gm of m[1].matchAll(GET_CAMEL_CALL_RE)) add(gm[1], i + 1)
    }
  })
  return candidates
}

// ─── 主流程 ─────────────────────────────────────────────────────────

function main() {
  const drifts = []
  for (const [docRel, modulePaths] of Object.entries(DOC_MODULE_MAP)) {
    const docAbs = path.join(PROJECT_ROOT, docRel)
    let mdText
    try {
      mdText = readFileSync(docAbs, 'utf-8')
    } catch {
      // 文档被删除/改名：映射随之更新，不算 drift
      continue
    }
    const { exported, objKeys, fileCount } = buildSymbolTable(modulePaths)
    const candidates = extractDocCandidates(mdText)
    for (const [sym, lineNos] of candidates) {
      if (exported.has(sym) || objKeys.has(sym)) continue
      if (ENV_NAME_ALLOW_RE.test(sym) || ERRNO_STRING_ALLOW_RE.test(sym)) continue
      drifts.push({ doc: docRel, sym, lines: lineNos, moduleCount: fileCount })
    }
  }

  if (drifts.length > 0) {
    console.error(`[doc-symbol-drift] 发现 ${drifts.length} 个文档引用了源码中不存在的符号：`)
    for (const d of drifts) {
      console.error(`  ✗ ${d.doc}:${d.lines.join(',')}  \`${d.sym}\` 不在映射源码模块的导出表/对象键中`)
    }
    console.error('')
    console.error('恢复动作：该符号已被删除或改名——同步修正文档（改用现行导出名或文字描述），')
    console.error('或在 scripts/check-doc-symbol-drift.mjs 的 DOC_MODULE_MAP 登记新文档映射。')
    process.exit(1)
  }
  console.log(`[doc-symbol-drift] OK：${Object.keys(DOC_MODULE_MAP).length} 个映射文档 × 源码导出表，零悬空符号`)
}

main()
