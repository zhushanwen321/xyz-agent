#!/usr/bin/env node
/**
 * smoke-core-dist.mjs —— subagent-core dist 发布回归门（D9-②，设计
 * docs/design/subagent-core-package-extraction.md §3.3 D9-② / V7 产品化）。
 *
 * 背景：workspace 消费者永远吃最新 TS 源，npm 消费者吃 tsup dist——src 侧全绿
 * 不代表 dist 未坏（tsup 配置漂移 / 依赖升级 / d.ts 缺陷都可能「src 绿 dist 坏」
 * 照常发布）。本脚本在发布前强制走一遍 npm 消费者视角的最小回路：
 *
 *   1. build：cd packages/subagent-core && pnpm run build（tsup ESM+CJS 双 dist）
 *   2. require：node require CJS dist——主入口 + 四条语义子入口
 *      （engines/zcode/reader、engines/zcode/constants、engine/paths、relay-env），
 *      经 package.json exports 的 require 条件解析（Node self-reference），
 *      等价验证 npm 消费者的加载路径与 exports→dist 映射，而非直接拼文件路径
 *   3. golden 回放：vitest run 跑 conformance 免 LLM 免二进制测试集
 *      （golden-replay.pi/zcode + contract.probe/abort/agent-events/read-degradation，
 *      全部 fake 注入），质量资产随 dist 形态可用
 *
 * 全绿 exit 0；任一步失败非零退出（发布管线据此拦截）。
 *
 * 挂载点（发布门接线，u1-guards）：
 *   - scripts/npm-prerelease.sh 阶段 1（本地，分支/changeset 变更之前，fail-fast）
 *   - .github/workflows/release-npm.yml publish job（"Publish to npm" 步骤之前）
 *
 * node 版本说明：engines 声明 node>=20。本脚本实际执行环境跟随调用方
 * （本机 dev / release-npm.yml CI 均为 node 24）。TODO(node20 runner)：真正的
 * node 20 require 复验需 node 20 runner——已知事实：主入口 dist/index.cjs 的
 * require 链不含 node:sqlite（node 20 可加载），但 ./engines/zcode/reader 的
 * CJS 产物 require node:sqlite（node >= 22.5 才有），node 20 下该子入口不可加载
 * （zsw 消费面为主入口 + relay-env 等，reader 属引擎内部读取件）。语义等价声明：
 * 本脚本在 node 24 上验证的是「构建产物可加载 + exports 映射正确 + golden 回放
 * 绿」的回归语义，与 node 20 上的差异面仅上述已知项；接入 node 20 runner 时
 * reader 子入口需按引擎版本门控。
 *
 * 零第三方依赖（node:child_process/node:module/node:path）。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CORE_DIR = join(ROOT, 'packages', 'subagent-core')
const CORE_PKG_NAME = '@zhushanwen/subagent-core'

// conformance 免 LLM 免二进制测试集（golden 回放层；engine-conformance.live.test.ts
// 是真机 live 层，刻意不在列——发布门不允许依赖真机/凭据）
const GOLDEN_TEST_FILES = [
  'src/execution/engine/__tests__/conformance/golden-replay.pi.test.ts',
  'src/execution/engine/__tests__/conformance/golden-replay.zcode.test.ts',
  'src/execution/engine/__tests__/conformance/contract.probe.test.ts',
  'src/execution/engine/__tests__/conformance/contract.abort.test.ts',
  'src/execution/engine/__tests__/conformance/contract.agent-events.test.ts',
  'src/execution/engine/__tests__/conformance/contract.read-degradation.test.ts',
]

// CJS dist 必须可加载的入口（exports require 条件的映射验证面）
const CJS_ENTRY_SPECS = [
  CORE_PKG_NAME,
  `${CORE_PKG_NAME}/engines/zcode/reader`,
  `${CORE_PKG_NAME}/engines/zcode/constants`,
  `${CORE_PKG_NAME}/engine/paths`,
  `${CORE_PKG_NAME}/relay-env`,
]

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    console.error(`  ✗ ${cmd} ${args.join(' ')} 失败（exit ${r.status ?? r.signal}）`)
    process.exit(r.status ?? 1)
  }
}

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 20) {
  console.error(`  ✗ node >= 20 required（engines），当前 ${process.versions.node}`)
  process.exit(1)
}

console.log('[1/3] build subagent-core dist（tsup ESM+CJS）...')
run('pnpm', ['run', 'build'], { cwd: CORE_DIR })

console.log('[2/3] require CJS dist（exports require 条件 → dist 产物）...')
// require 解析根锚定在 C 包内（Node self-reference）——等价 npm 消费者的
// exports 解析路径；dist 缺失/映射漂移都在此显式报错
const coreRequire = createRequire(join(CORE_DIR, 'package.json'))
for (const spec of CJS_ENTRY_SPECS) {
  try {
    const mod = coreRequire(spec)
    const ok = mod !== null && typeof mod === 'object'
    if (!ok) throw new Error(`module loaded but not an object namespace`)
    console.log(`  ✓ require("${spec}")`)
  } catch (e) {
    console.error(`  ✗ require("${spec}") 失败: ${e.message}`)
    console.error('    排查：cd packages/subagent-core && pnpm run build 后重跑；')
    console.error('    exports require 条件与 dist 产物映射核对 package.json（D4 双形态契约）')
    process.exit(1)
  }
}

console.log('[3/3] golden 回放层（conformance 免 LLM 免二进制，6 文件）...')
run('pnpm', ['exec', 'vitest', 'run', ...GOLDEN_TEST_FILES], { cwd: CORE_DIR })

console.log('✓ subagent-core dist smoke 通过（build + require CJS dist + golden 回放全绿）')
