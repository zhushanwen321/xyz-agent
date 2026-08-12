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
 * 2. 反向：extensions/ 下每个 @zhushanwen/pi-* 包（排除 extensions/shared/ 共享库）
 *    必须出现在文件中，directory 与磁盘目录一致
 * 3. 引用：dependsOn.package 为 workspace 内包（@zhushanwen/pi-* / @xyz-agent/*）
 *    时必须可解析（条目、extensions/shared/ 下包、或 packages/ 下包），防悬空引用
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
const DEPS_FILE = join(ROOT, 'extension-dependencies.json')

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

// ── 2. 反向：extensions/ 下 pi-* 包必须在文件中 ─────────────────────
const diskPackages = []
for (const dir of readdirSync(EXT_DIR)) {
  if (dir === 'shared') continue
  const pkgFile = join(EXT_DIR, dir, 'package.json')
  if (!existsSync(pkgFile)) continue
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'))
  if (pkg.name?.startsWith('@zhushanwen/pi-')) {
    diskPackages.push({ name: pkg.name, directory: `extensions/${dir}` })
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

if (failed === 0) {
  console.log(`✓ extension-dependencies.json 一致（${entries.length} entries ↔ 磁盘 ${diskPackages.length} 包）`)
  process.exit(0)
}
console.error('extension-dependencies.json 与磁盘不一致，修复后重跑（见上方 ✗ 明细）')
process.exit(1)
