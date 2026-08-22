#!/usr/bin/env node
/**
 * check-extension-dependencies.mjs —— extension-dependencies.json 一致性守卫（S-7）。
 *
 * 背景：R1 MF-6 事故是 extension-dependencies.json 与磁盘上的扩展包清单漂移
 * （已删除的 pi-statusline 残留条目 + schema 无人消费）。本脚本让该文件与磁盘事实
 * 双向对应，漂移立即报错。由 preflight-check.sh 调用（CI: build.yml --ci 拦截）。
 *
 * 检查项：
 * 1. 正向：每个条目 name + directory 必须对应真实 extensions/<dir>/package.json
 *    （name 字段与 package.json.name 精确一致，防改名/误删/错目录）
 * 2. 反向：extensions/{taiji,universal}/ 下每个 @zhushanwen/pi-* 包
 *    必须出现在文件中，directory 与磁盘目录一致
 * 3. 引用：dependsOn.package 为 workspace 内包（@zhushanwen/pi-* / @xyz-agent/*）
 *    时必须可解析（条目、extensions/shared/ 下包、或 packages/ 下包），防悬空引用
 * 4. 分组：包必须在 taiji/（xyz 集成）或 universal/（独立通用）分组下；
 *    package.json 的 xyz-agent.role 必须与所在分组一致；role=taiji 的包必须在
 *    mandatory-extensions.json（xyz 集成包随应用打包，见 docs/extensions/extension-conventions.md）
 *
 * 零第三方依赖（node:fs/node:path）。退出码：0 = 通过；1 = 违规。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const EXT_DIR = join(ROOT, 'extensions')
const SHARED_DIR = join(EXT_DIR, 'shared')
const GROUPS = ['taiji', 'universal']
const DEPS_FILE = join(ROOT, 'extension-dependencies.json')
const MANDATORY_FILE = join(ROOT, 'packages/shared/src/mandatory-extensions.json')

let failed = 0
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  failed = 1
}

const deps = JSON.parse(readFileSync(DEPS_FILE, 'utf-8'))
const entries = deps.extensions ?? []

// ── 1. 正向：条目 → 磁盘 package.json ───────────────────────────────
for (const entry of entries) {
  if (!entry.directory.startsWith('extensions/')) {
    fail(`条目 ${entry.name} 的 directory 必须以 extensions/ 开头: ${entry.directory}`)
    continue
  }
  const pkgFile = join(ROOT, entry.directory, 'package.json')
  if (!existsSync(pkgFile)) {
    fail(`条目 ${entry.name} 指向不存在的包目录: ${entry.directory}（包已删除/移动？）`)
    continue
  }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'))
  if (pkg.name !== entry.name) {
    fail(`条目 ${entry.name} 与 ${entry.directory}/package.json 的 name 不一致: ${pkg.name}`)
  }
}

// ── 2. 反向：分组目录下 pi-* 包必须在文件中 ────────────────────────
const diskPackages = []
for (const group of GROUPS) {
  const groupDir = join(EXT_DIR, group)
  if (!existsSync(groupDir)) continue
  for (const dir of readdirSync(groupDir)) {
    const pkgFile = join(groupDir, dir, 'package.json')
    if (!existsSync(pkgFile)) continue
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'))
    if (pkg.name?.startsWith('@zhushanwen/pi-')) {
      diskPackages.push({ name: pkg.name, directory: `extensions/${group}/${dir}`, group, dir, pkg })
    }
  }
}
// extensions/ 一层不允许散装 pi-* 包（分组后残留 = 路径适配漏改）
for (const dir of readdirSync(EXT_DIR)) {
  if (GROUPS.includes(dir) || dir === 'shared' || dir === 'tsconfig.json') continue
  if (existsSync(join(EXT_DIR, dir, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(EXT_DIR, dir, 'package.json'), 'utf-8'))
    if (pkg.name?.startsWith('@zhushanwen/pi-')) {
      fail(`包 ${pkg.name} 位于 extensions/ 一层（${dir}/），必须移入 taiji/ 或 universal/ 分组`)
    }
  }
}
for (const pkg of diskPackages) {
  const entry = entries.find((e) => e.name === pkg.name)
  if (!entry) {
    fail(`磁盘存在但文件缺失条目: ${pkg.name}（extension-dependencies.json 漏记）`)
  } else if (entry.directory !== pkg.directory) {
    fail(`条目 ${pkg.name} 的 directory 与磁盘不一致: 文件=${entry.directory} 磁盘=${pkg.directory}`)
  }
}

// ── 3. 引用：dependsOn 的 workspace 内包必须可解析 ──────────────────
const entryNames = new Set(entries.map((e) => e.name))
const sharedNames = new Set()
for (const dir of readdirSync(SHARED_DIR)) {
  const pkgFile = join(SHARED_DIR, dir, 'package.json')
  if (!existsSync(pkgFile)) continue
  sharedNames.add(JSON.parse(readFileSync(pkgFile, 'utf-8')).name)
}
const packageNames = new Set()
for (const dir of readdirSync(join(ROOT, 'packages'))) {
  const pkgFile = join(ROOT, 'packages', dir, 'package.json')
  if (!existsSync(pkgFile)) continue
  packageNames.add(JSON.parse(readFileSync(pkgFile, 'utf-8')).name)
}
for (const entry of entries) {
  for (const dep of entry.dependsOn ?? []) {
    const name = dep.package
    if (name.startsWith('@zhushanwen/') || name.startsWith('@xyz-agent/')) {
      if (!entryNames.has(name) && !sharedNames.has(name) && !packageNames.has(name)) {
        fail(`条目 ${entry.name} 的 dependsOn 引用无法解析: ${name}`)
      }
    }
  }
}

// ── 4. 分组：目录位置 ↔ xyz-agent.role ↔ mandatory 清单 ───────────
const mandatoryNames = new Set(
  JSON.parse(readFileSync(MANDATORY_FILE, 'utf-8')).map((e) => e.name),
)
for (const pkg of diskPackages) {
  const role = pkg.pkg['xyz-agent']?.role
  if (role !== pkg.group) {
    fail(`包 ${pkg.name} 的 xyz-agent.role=${role ?? '(缺失)'} 与所在分组目录 ${pkg.group}/ 不一致`)
  }
  if (pkg.group === 'taiji' && !mandatoryNames.has(pkg.name)) {
    fail(`包 ${pkg.name} 在 taiji/ 分组（xyz 集成）但不在 mandatory-extensions.json，builtin 集合与职责分组矛盾`)
  }
}

// ── 5. 一层路径残留：活文件禁止引用 extensions/<pkg>/（分组后必须带 taiji|universal 前缀）──
// 背景：2026-08-22 目录分组时人工适配了 14 处写死一层路径的引用（脚本/eslint/tsconfig/
// 文档），本检测防新引用回退。包名清单从磁盘动态构建（新增包自动纳入检测范围）。
// 检测面 = 活代码/配置/活文档；历史记录与构建产物不检测（保留当时事实，不追溯改写）：
//   - resources/：staged 构建产物（bundle 时已是新路径，磁盘残留旧 staged 无意义）
//   - CHANGELOG.md / adr/ / .orchestration/ / 包内 docs/：历史记录（当时路径是事实）
//   - (?<!\./)：排除包内相对导入 ./extensions/xxx（与仓库顶层 extensions/ 无关）
const SCAN_ROOTS = ['scripts', 'packages', 'apps', 'extensions', 'docs/extensions', '.agents/skills']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '__pycache__', 'resources'])
const SKIP_PATH_PARTS = ['/adr/', '/.orchestration/']
const SCAN_EXT = new Set(['.ts', '.mjs', '.js', '.cjs', '.sh', '.py', '.yml', '.yaml', '.json', '.md'])

// 动态包名清单：分组包 + shared 库（一层引用 shared 库同样非法）
const knownNames = new Set(diskPackages.map((p) => p.dir))
for (const dir of readdirSync(SHARED_DIR)) {
  if (existsSync(join(SHARED_DIR, dir, 'package.json'))) knownNames.add(dir)
}

const staleRe = new RegExp(`(?<!\\./)extensions/(${[...knownNames].join('|')})(?=[/\\s"'\\\`,)\\]]|$)`)
// 历史记录判定：CHANGELOG / ADR / 验收报告 / 包内 docs 设计记录 / 历史事故文档
const HISTORICAL_FILES = new Set([
  'docs/extensions/tool-schema-openai-compat.md', // 2026-07 OpenAI 兼容事故复盘，路径为当时事实
])
function entryIsHistorical(rel) {
  const norm = `/${rel}`
  if (HISTORICAL_FILES.has(rel)) return true
  if (rel === 'CHANGELOG.md' || rel.endsWith('/CHANGELOG.md')) return true
  if (SKIP_PATH_PARTS.some((part) => norm.includes(part))) return true
  if (/^extensions\/(taiji|universal)\/[^/]+\/docs\//.test(rel)) return true
  return false
}
function* scanFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* scanFiles(p)
    } else {
      const dot = entry.name.slice(entry.name.lastIndexOf('.'))
      if (SCAN_EXT.has(dot)) yield p
    }
  }
}
let staleScanned = 0
for (const root of SCAN_ROOTS) {
  if (!existsSync(join(ROOT, root))) continue
  for (const file of scanFiles(join(ROOT, root))) {
    const rel = file.slice(ROOT.length + 1)
    if (entryIsHistorical(rel)) continue
    staleScanned++
    const text = readFileSync(file, 'utf-8')
    const m = staleRe.exec(text)
    if (m) {
      const line = text.slice(0, m.index).split('\n').length
      fail(`一层路径残留: ${rel}:${line} 引用 "${m[0]}"（分组后应为 extensions/{taiji|universal}/${m[1]}/）`)
    }
  }
}

if (failed === 0) {
  console.log(`✓ extension-dependencies.json 一致（${entries.length} entries ↔ 磁盘 ${diskPackages.length} 包，分组/role/路径残留 ${staleScanned} 文件扫描通过）`)
  process.exit(0)
}
console.error('extension-dependencies.json 与磁盘不一致，修复后重跑（见上方 ✗ 明细）')
process.exit(1)
