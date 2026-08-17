#!/usr/bin/env node
/**
 * P0 coexistence spike AC9 实证脚本（方案 A：构建 flag 按域灰度机制）。
 *
 * 流程：
 *   1. NEW_ARCH unset → 跑 renderer vite build（产物 → apps/electron/renderer/dist）→ manifest-off
 *   2. NEW_ARCH=1    → 跑 renderer vite build（产物 → apps/electron/renderer/dist-new）→ manifest-on
 *   3. 断言（三断言 + ES1）：
 *      (a) bakedFlagValue：off=false / on=true（vite define 烘焙生效）
 *      (b) distNewEntryExists：on 构建产物 dist-new/index.html 存在（loadFile 切换目标可达）
 *      (c) rendererScriptSrc：off 主壳 chunk 与 on 骨架 chunk 不同（构建期入口切换生效）
 *      (d) consumerCount：grep 仓库源码中 __NEW_ARCH__ 消费点（排除 define 声明与 loadFile 分支）=== 0
 *          → ES1 安全默认：无业务模块读取 → 未设 flag 时构建行为零变化
 *
 * 运行：node scripts/verify-coexistence-flag.mjs（根目录）
 * 产物：docs/architecture/coexistence-spike-manifests/flag-off.json + flag-on.json（DM1 格式）
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererDist = resolve(root, 'apps/electron/renderer/dist')
const rendererDistNew = resolve(root, 'apps/electron/renderer/dist-new')
// 新壳产物路径：vite 保留源 html 相对 root 的目录结构（源 packages/renderer/new-arch/index.html）
const rendererDistNewEntry = resolve(rendererDistNew, 'new-arch/index.html')
const manifestsDir = resolve(root, 'docs/architecture/coexistence-spike-manifests')

/** 提取 index.html 的 script src（module script 的 src 属性） */
function extractScriptSrc(htmlPath) {
  if (!existsSync(htmlPath)) return null
  const html = readFileSync(htmlPath, 'utf-8')
  const m = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)
  return m ? m[1] : null
}

/** 跑一次 renderer vite build（绕开 vue-tsc，只验证构建期机制） */
function runBuild(env) {
  const cmd = 'npx vite build'
  execSync(cmd, { cwd: resolve(root, 'packages/renderer'), env: { ...process.env, ...env }, stdio: 'inherit' })
}

/** 生成 manifest 快照 */
function snapshot(label, newArchEnv, indexHtmlPath, distDir) {
  const bakedFlag = extractBakedFlag(distDir, newArchEnv)
  return {
    label,
    newArchEnv,
    rendererEntryHtml: indexHtmlPath ? indexHtmlPath.replace(root + '/', '') : null,
    rendererScriptSrc: extractScriptSrc(indexHtmlPath),
    bakedFlagValue: bakedFlag,
    distNewEntryExists: existsSync(rendererDistNewEntry),
  }
}

/** 从构建产物 JS 提取 define 烘焙证据：
 *  - on：骨架 chunk 含 `[new-arch] skeleton loaded` 标记，其上下文（前 300 字符窗口）内的
 *    !0/!1 即 define 替换后的烘焙字面量（globalThis.__NEW_ARCH__ → true → minify !0）
 *  - off：主壳无消费者 → 产物不含 `__NEW_ARCH__` 符号（ES1 零变化证据），语义值为 false
 */
function extractBakedFlag(distDir, newArchEnv) {
  const assetsDir = resolve(distDir, 'assets')
  if (!existsSync(assetsDir)) return null
  const jsFiles = readdirRecursive(assetsDir).filter((f) => f.endsWith('.js'))
  const allContent = jsFiles.map((f) => readFileSync(f, 'utf-8')).join('\n')
  if (newArchEnv === '1') {
    const idx = allContent.indexOf('[new-arch] skeleton loaded')
    if (idx === -1) return null
    const ctx = allContent.slice(Math.max(0, idx - 300), idx + 100)
    if (/!0|true/.test(ctx)) return true
    if (/!1|false/.test(ctx)) return false
    return null
  }
  // off：无 __NEW_ARCH__ 符号残留 = define 未污染主壳产物 → 语义 false（零变化）
  return allContent.includes('__NEW_ARCH__') ? null : false
}

/** 递归列目录下全部文件（sync，产物目录规模小） */
function readdirRecursive(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = resolve(dir, entry)
    if (statSync(p).isDirectory()) out.push(...readdirRecursive(p))
    else out.push(p)
  }
  return out
}

// ── 主流程 ──
mkdirSync(manifestsDir, { recursive: true })

// 1. flag OFF（显式 delete 保证 env 干净）
delete process.env.NEW_ARCH
runBuild({})
const offSnapshot = snapshot('flag-off', 'unset', resolve(rendererDist, 'index.html'), rendererDist)
writeFileSync(resolve(manifestsDir, 'flag-off.json'), JSON.stringify(offSnapshot, null, 2))

// 2. flag ON
process.env.NEW_ARCH = '1'
runBuild({ NEW_ARCH: '1' })
const onSnapshot = snapshot('flag-on', '1', rendererDistNewEntry, rendererDistNew)
writeFileSync(resolve(manifestsDir, 'flag-on.json'), JSON.stringify(onSnapshot, null, 2))

// 3. 断言
const failures = []
if (offSnapshot.bakedFlagValue !== false) failures.push(`(a) bakedFlagValue off 应为 false，实际 ${offSnapshot.bakedFlagValue}`)
if (onSnapshot.bakedFlagValue !== true) failures.push(`(a) bakedFlagValue on 应为 true，实际 ${onSnapshot.bakedFlagValue}`)
if (onSnapshot.distNewEntryExists !== true) failures.push(`(b) distNewEntryExists 应为 true（dist-new/index.html 不存在）`)
if (offSnapshot.rendererScriptSrc === onSnapshot.rendererScriptSrc) {
  failures.push(`(c) rendererScriptSrc 应不同（off=${offSnapshot.rendererScriptSrc} on=${onSnapshot.rendererScriptSrc}）`)
}

// 4. ES1：consumerCount（grep 源码，排除 define 声明、loadFile 分支、骨架演示消费点）
const consumerGrep = execSync(
  `grep -rn "__NEW_ARCH__" packages/renderer/src apps/electron/main packages/renderer/new-arch --include="*.ts" --include="*.vue" --include="*.html" || true`,
  { cwd: root, encoding: 'utf-8' },
)
// 排除：vite.config.ts（define 声明处）、resolve-renderer-entry.ts/window-factory.ts（main 侧合法消费点）、
// new-arch/（骨架演示消费点，非业务模块，仅在 NEW_ARCH=1 时进入构建）
const excluded = /vite\.config\.ts|resolve-renderer-entry\.ts|window-factory\.ts|packages\/renderer\/new-arch\//
const consumers = consumerGrep.split('\n').filter((l) => l.trim() !== '' && !excluded.test(l))
if (consumers.length > 0) failures.push(`(d) consumerCount 应为 0（ES1），实际 ${consumers.length}：\n${consumers.join('\n')}`)

console.log('\n=== manifest-off ===')
console.log(JSON.stringify(offSnapshot, null, 2))
console.log('=== manifest-on ===')
console.log(JSON.stringify(onSnapshot, null, 2))
console.log(`\nconsumerCount = ${consumers.length}`)

if (failures.length > 0) {
  console.error('\nFAIL:\n- ' + failures.join('\n- '))
  process.exit(1)
}
console.log('\nOK: flag 机制实证通过（define 烘焙 / dist-new 存在 / script src 切换 / ES1 零消费者）')
