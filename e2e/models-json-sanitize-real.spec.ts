/**
 * M1（e2e real）：models.json 空壳 provider → bundled pi 0.80.3 拒绝加载 → sanitize 自愈。
 *
 * 对应修复：48777f91b fix(runtime): sanitize invalid providers from models.json on startup
 * Bug 场景：重装后 models.json 残留空壳 provider（如 {apiKey,name} 无五字段任一），
 * bundled pi 0.80.3 严格校验「一个坏 provider 拖垮整个 models.json」→ 自定义 provider
 * 全部丢失 → 前端 Model not found。
 *
 * 真实性（零 mock）：
 * - 真实 bundled pi 0.80.3 二进制（/Applications/xyz-agent.app/... 或 env XYZ_BUNDLED_PI_BIN）
 * - 真实 models.json（seed 临时目录，PI_CODING_AGENT_DIR 隔离）
 * - 真实 sanitizeInvalidProviders（tsx 子进程跑 runtime 源码）
 *
 * 断言设计：
 * - 复现：`--list-models` 输出含 "must specify"（加载失败标志），表格不含 seed 的
 *   legal/gpt-4o 行（自定义 provider 整体丢失 = Model not found 根因）
 * - 修复：sanitize 返回 removed=['concurrency-verify-A'] + 文件上删除 + 再次
 *   `--list-models` 输出无 "must specify" 且含 legal/gpt-4o 行
 *
 * 注意：pi 0.80.3 加载失败时 exit code 仍为 0（降级内置默认模型），故断言基于输出内容
 * 而非退出码。
 */
import { test, expect } from '@playwright/test'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const SANITIZE_SCRIPT = path.join(REPO_ROOT, 'e2e', 'fixtures', 'sanitize-providers.mts')

/** bundled pi 二进制候选（本地打包版 → env 覆盖 → repo resources）。找不到则 skip。 */
function resolveBundledPiBin(): string | null {
  const candidates = [
    process.env.XYZ_BUNDLED_PI_BIN,
    '/Applications/xyz-agent.app/Contents/Resources/pi/pi-darwin-arm64',
    path.join(REPO_ROOT, 'resources', 'pi', 'pi-darwin-arm64'),
  ].filter((p): p is string => Boolean(p))
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

/** 跑 bundled pi --list-models，返回 stdout+stderr 合并输出（不抛，调用方断言内容）。 */
function runPiListModels(piBin: string, piAgentDir: string): SpawnSyncReturns<string> {
  return spawnSync(piBin, ['--list-models'], {
    env: { ...process.env, PI_CODING_AGENT_DIR: piAgentDir },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

/** 合法 provider：完整五字段之一 + api + models（--list-models 应列出其 gpt-4o）。 */
const LEGAL_PROVIDER = {
  baseUrl: 'https://api.example.com/v1',
  api: 'openai-completions',
  apiKey: 'sk-test',
  models: [
    { id: 'gpt-4o', name: 'gpt-4o', input: ['text'], contextWindow: 128000, maxTokens: 8192 },
  ],
}

/** 空壳 provider：复刻真实事故的 concurrency-verify-A（apiKey+name，无五字段任一）。 */
const SHELL_PROVIDER = { apiKey: 'sk-empty-shell', name: 'empty shell provider' }

test('M1 (e2e real): 空壳 provider 致 bundled pi 拒绝加载 models.json，sanitize 后恢复', async () => {
  const piBin = resolveBundledPiBin()
  test.skip(!piBin, 'bundled pi 二进制未找到（本地 /Applications/xyz-agent.app/... 或 env XYZ_BUNDLED_PI_BIN）')

  // ── 1. seed 隔离数据目录：<tmp>/pi/agent/models.json（合法 + 空壳） ──
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-m1-'))
  const piAgentDir = path.join(dataDir, 'pi', 'agent')
  fs.mkdirSync(piAgentDir, { recursive: true })
  const modelsFile = path.join(piAgentDir, 'models.json')
  fs.writeFileSync(
    modelsFile,
    JSON.stringify(
      { providers: { legal: LEGAL_PROVIDER, 'concurrency-verify-A': SHELL_PROVIDER } },
      null,
      2,
    ),
  )

  try {
    // ── 2. 复现 bug：bundled pi 0.80.3 拒绝加载整个 models.json ──
    const before = runPiListModels(piBin, piAgentDir)
    expect(before.status).toBe(0) // 0.80.3 降级内置默认，不硬失败——但必须报加载错误
    const beforeOutput = `${before.stdout ?? ''}${before.stderr ?? ''}`
    expect(beforeOutput, '空壳 provider 应触发 pi 加载报错').toContain('must specify')
    expect(beforeOutput, '整个 models.json 加载失败 → 自定义 provider 的模型不应列出（Model not found 根因）').not.toMatch(/legal\s+gpt-4o/)

    // ── 3. 触发修复：tsx 子进程跑 runtime 真实 sanitizeInvalidProviders ──
    const sanitized = spawnSync(TSX_BIN, [SANITIZE_SCRIPT], {
      env: { ...process.env, MODELS_JSON_PATH: modelsFile },
      encoding: 'utf-8',
      timeout: 30_000,
    })
    expect(sanitized.status, `sanitize 子进程失败: ${sanitized.stderr ?? sanitized.stdout ?? ''}`).toBe(0)
    const resultMatch = /SANITIZE_RESULT=(\{.*\})/.exec(`${sanitized.stdout ?? ''}`)
    expect(resultMatch, 'sanitize 子进程应输出 SANITIZE_RESULT=JSON').not.toBeNull()
    const result = JSON.parse(resultMatch![1] ?? 'null') as { removed?: string[] }
    expect(result.removed, '空壳 provider 应被剔除').toEqual(['concurrency-verify-A'])

    // 文件层面确认：空壳已删、合法保留
    const afterSeed = JSON.parse(fs.readFileSync(modelsFile, 'utf-8')) as { providers: Record<string, unknown> }
    expect(afterSeed.providers['concurrency-verify-A'], 'models.json 不应再含空壳 provider').toBeUndefined()
    expect(afterSeed.providers.legal, '合法 provider 必须保留').toBeDefined()

    // ── 4. 验证修复：bundled pi 正常加载，legal/gpt-4o 列出 ──
    const after = runPiListModels(piBin, piAgentDir)
    expect(after.status).toBe(0)
    const afterOutput = `${after.stdout ?? ''}${after.stderr ?? ''}`
    expect(afterOutput, '加载错误应消失').not.toContain('must specify')
    expect(afterOutput).not.toContain('Failed to load models.json')
    expect(afterOutput, '合法 provider 的模型应被列出').toMatch(/legal\s+gpt-4o/)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
