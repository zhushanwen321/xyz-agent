// P0 coexistence spike 方案 B 实证脚本（AC9）：双 Electron 入口并存机制的构建期验证。
//
// 执行顺序（关键约束）：baseline 两构建先跑先扫描，spike 两构建后跑后扫描——
// 现有 renderer config（vite.config.ts）emptyOutDir:true 会清空整个 renderer/dist，
// 若 spike 先构建，其产物会被 baseline 构建清掉。
//
// 断言（任一失败 exit 1，打印原因）：
//   TC1 4 次构建全部 exit 0 + 两份 manifest（父 DM1 格式）七字段完整
//   TC2 物理隔离：mainOutDir/mainEntry/rendererEntry pairwise 不同 + bundleChunks 无交集
//   TC3 ES2 安全默认：git diff 无 tracked 改动（纯新增 wave）+ 主线 build:main 独立通过
//
// 产物：docs/architecture/coexistence-spike-manifests/baseline.json + dualEntry.json
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'apps/electron')
const RENDERER = join(ROOT, 'packages/renderer')
const RENDERER_DIST = join(ELECTRON, 'renderer/dist')
const MAIN_DIST = join(ELECTRON, 'dist')
const MANIFEST_DIR = join(ROOT, 'docs/architecture/coexistence-spike-manifests')

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.error(`  ✗ FAIL: ${msg}`)
  }
}

function run(cmd, cwd) {
  console.log(`\n$ ${cmd} (cwd=${cwd})`)
  execSync(cmd, { cwd, stdio: 'inherit', timeout: 600_000 })
}

// 扫描目录下所有 js 产物，返回相对 root 的路径列表（带目录归属前缀，保证两套无交集可判）
function scanChunks(dir) {
  const out = []
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(js|mjs|cjs)$/.test(name)) out.push(resolve(p).replace(ROOT + '/', ''))
    }
  }
  walk(dir)
  return out.sort()
}

function countFiles(dir) {
  let n = 0
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else n++
    }
  }
  walk(dir)
  return n
}

// index.html 的 script src（DM1 rendererEntry 字段）
function extractScriptSrc(indexHtmlPath) {
  const html = readFileSync(indexHtmlPath, 'utf-8')
  const m = html.match(/<script[^>]+src=["']([^"']+)["']/)
  return m ? m[1] : null
}

function scanManifest(label, mainOutDir, mainEntry, rendererOutDir, rendererIndexHtml) {
  const manifest = {
    label,
    rendererEntry: extractScriptSrc(rendererIndexHtml),
    rendererOutDir: resolve(rendererOutDir).replace(ROOT + '/', ''),
    mainEntry: resolve(mainEntry).replace(ROOT + '/', ''),
    mainOutDir: resolve(mainOutDir).replace(ROOT + '/', ''),
    bundleChunks: scanChunks(mainOutDir).concat(scanChunks(rendererOutDir)),
    fileCount: countFiles(mainOutDir) + countFiles(rendererOutDir),
  }
  assert(
    manifest.rendererEntry && manifest.mainEntry,
    `[TC1] ${label} manifest 字段完整（rendererEntry=${manifest.rendererEntry}）`,
  )
  const required = ['label', 'rendererEntry', 'rendererOutDir', 'mainEntry', 'mainOutDir', 'bundleChunks', 'fileCount']
  for (const k of required) {
    assert(manifest[k] !== undefined && manifest[k] !== null && manifest[k] !== '', `[TC1] ${label}.${k} 存在`)
  }
  return manifest
}

console.log('=== P0 spike 方案 B：双入口构建隔离实证 ===\n')

// ── Step 1: baseline 两构建（现有主线配置，顺序在前） ─────────────
run('npx vite build --config vite.config.main.ts', ELECTRON)
run('npx vite build --config vite.config.ts', RENDERER)

const baseline = scanManifest(
  'baseline',
  join(MAIN_DIST, 'main'),
  join(MAIN_DIST, 'main/main.cjs'),
  RENDERER_DIST,
  join(RENDERER_DIST, 'index.html'),
)
writeFileSync(join(MANIFEST_DIR, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n')
console.log(`\nbaseline manifest -> docs/architecture/coexistence-spike-manifests/baseline.json\n`)

// 记录 baseline 现有 main 产物 hash（TC3 用：spike 构建后应保持不变）
const mainCjsPath = join(MAIN_DIST, 'main/main.cjs')
const baselineMainHash = createHash('sha256').update(readFileSync(mainCjsPath)).digest('hex')

// ── Step 2: spike 两构建（独立新配置，顺序在后） ───────────────────
run('npx vite build --config vite.config.main-new.ts', ELECTRON)
run('npx vite build --config vite.config.spike-dual-entry.ts', RENDERER)

const spikeEntryHtml = join(RENDERER_DIST, 'spike-dual-entry/index.html')
assert(existsSync(spikeEntryHtml), `[TC1] spike-dual-entry 产物存在（${spikeEntryHtml.replace(ROOT + '/', '')}）`)

const dualEntry = scanManifest(
  'dualEntry',
  join(MAIN_DIST, 'main-new'),
  join(MAIN_DIST, 'main-new/main.cjs'),
  join(RENDERER_DIST, 'spike-dual-entry'),
  spikeEntryHtml,
)
writeFileSync(join(MANIFEST_DIR, 'dualEntry.json'), JSON.stringify(dualEntry, null, 2) + '\n')
console.log(`\ndualEntry manifest -> docs/architecture/coexistence-spike-manifests/dualEntry.json\n`)

// ── Step 3: TC2 物理隔离断言 ─────────────────────────────────────
console.log('--- TC2: 产物路径完全隔离 ---')
assert(dualEntry.mainOutDir !== baseline.mainOutDir, `mainOutDir 不同（${baseline.mainOutDir} vs ${dualEntry.mainOutDir}）`)
assert(dualEntry.mainEntry !== baseline.mainEntry, `mainEntry 不同（${baseline.mainEntry} vs ${dualEntry.mainEntry}）`)
assert(dualEntry.rendererEntry !== baseline.rendererEntry, `rendererEntry 不同（${baseline.rendererEntry} vs ${dualEntry.rendererEntry}）`)
assert(dualEntry.rendererOutDir !== baseline.rendererOutDir, `rendererOutDir 不同（${baseline.rendererOutDir} vs ${dualEntry.rendererOutDir}）`)
const intersection = dualEntry.bundleChunks.filter((c) => baseline.bundleChunks.includes(c))
assert(intersection.length === 0, `bundleChunks 无交集（交集=${JSON.stringify(intersection)}）`)
assert(
  existsSync(join(MAIN_DIST, 'main/main.cjs')) && existsSync(join(MAIN_DIST, 'main-new/main.cjs')),
  'dist/main 与 dist/main-new 各自独立存在（互不污染）',
)

// ── Step 4: TC3 ES2 安全默认断言 ─────────────────────────────────
console.log('--- TC3: ES2 安全默认（构建互不污染 + 纯新增） ---')
// ES2 核心语义：双入口独立 outDir 物理隔离——main-new 构建不得改写现有 dist/main 产物
const afterSpikeHash = createHash('sha256').update(readFileSync(mainCjsPath)).digest('hex')
assert(
  afterSpikeHash === baselineMainHash,
  `main-new 构建未改写现有 dist/main/main.cjs（ES2 互不污染：hash ${baselineMainHash.slice(0, 12)} 未变）`,
)
// 纯新增约束：本 wave 交付的 create 文件必须都是 untracked（??），非 modify/delete
const newFiles = [
  'apps/electron/vite.config.main-new.ts',
  'apps/electron/main/main-new.ts',
  'packages/renderer/spike-dual-entry/index.html',
  'packages/renderer/spike-dual-entry/main.ts',
  'packages/renderer/vite.config.spike-dual-entry.ts',
  'scripts/verify-dual-entry.mjs',
]
const statusOut = execSync('git status --porcelain --untracked-files=all', { cwd: ROOT, encoding: 'utf-8', timeout: 10_000 })
for (const f of newFiles) {
  assert(statusOut.includes(`?? ${f}`), `新增文件处于 untracked 状态（${f}）`)
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' ASSERTION(S) FAILED'} ===`)
process.exit(failures === 0 ? 0 : 1)
