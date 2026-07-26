/**
 * ExtensionService.getExtensionPaths 追加 xyz-system-prompt-extension.js 单测（TDD 红灯）。
 *
 * 断言：
 * - 当 xyz-system-prompt-extension.js 存在时，返回路径列表包含它
 * - 它位于 xyz-agent-extension.js 之后
 * - 当该文件不存在时，路径列表不包含它
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionService } from '../src/services/extension-service.js'
import { NpmGitInstaller } from '../src/infra/installers/npm-git-installer.js'
import { ExtensionResolver } from '../src/infra/installers/extension-resolver.js'
import { PiExtensionSettings } from '../src/infra/pi/pi-extension-settings.js'
import { setSettingsPath } from '../src/infra/pi/pi-settings-store.js'
import { refreshModels, setModelsPath } from '../src/infra/pi/pi-provider-store.js'
import { installPackage, uninstallPackage, NpmInstallError } from '../src/infra/installers/npm-installer.js'
import { execFileSync } from 'node:child_process'

vi.mock('../src/infra/installers/npm-installer.js', () => ({
  installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
  installDependencies: vi.fn(),
  NpmInstallError: class extends Error {
    code: 'not_found' | 'network' | 'extract' | 'integrity'
    constructor(code: 'not_found' | 'network' | 'extract' | 'integrity', message: string) {
      super(message)
      this.code = code
      this.name = 'NpmInstallError'
    }
  },
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}))

const mockedInstallPackage = vi.mocked(installPackage)
const mockedUninstallPackage = vi.mocked(uninstallPackage)
const mockedExecFileSync = vi.mocked(execFileSync)

let tmpRoot: string
let projectRoot: string
let settingsDir: string
let service: ExtensionService

/**
 * 3 个 builtin extension 文件位于 repo root（= tmpRoot，模拟真实仓库根目录），
 * dev 模式 projectRoot = `<repo>/apps/electron`（见 process-control.ts:154 app.getAppPath()），
 * getExtensionFilePath dev 分支从 projectRoot/../.. 解析回 repo root（见 runtime-env.ts [HISTORICAL] 注释）。
 * 故这里把文件放在 tmpRoot、projectRoot 设为 tmpRoot/apps/electron 以对齐真实 dev 场景。
 */
function agentExtensionPath(): string {
  return join(tmpRoot, 'xyz-agent-extension.js')
}

function systemPromptExtensionPath(): string {
  return join(tmpRoot, 'xyz-system-prompt-extension.js')
}

function clientMsgIdMapperPath(): string {
  return join(tmpRoot, 'xyz-client-msg-id-mapper.js')
}

beforeEach(() => {
  vi.clearAllMocks()
  tmpRoot = mkdtempSync(join(tmpdir(), 'ext-system-prompt-'))
  projectRoot = join(tmpRoot, 'apps', 'electron')
  settingsDir = join(tmpRoot, 'settings')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(settingsDir, { recursive: true })

  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ packages: [] }), 'utf-8')
  setSettingsPath(join(settingsDir, 'settings.json'))
  setModelsPath(join(settingsDir, 'models.json'))
  refreshModels()

  service = new ExtensionService({
    settingsDir,
    projectRoot,
    packaged: false,
    installer: new NpmGitInstaller(),
    resolver: new ExtensionResolver({
      settingsDir,
      thirdPartyDir: join(settingsDir, 'extensions'),
      // Phase 1 路径迁移：npmDir 已从 settingsDir 子树迁出，注入回 settingsDir/npm 避免触碰真实 dataDir。
      npmDir: join(settingsDir, 'npm'),
    }),
    extensionSettings: new PiExtensionSettings(settingsDir),
    // Phase 1 路径迁移：extensions/npm/tmp 已从 settingsDir 子树迁出到 dataDir 根层，
    // 注入回 settingsDir 子目录让测试目录自洽（不依赖/污染真实 ~/.xyz-agent）。
    extensionsDir: join(settingsDir, 'extensions'),
    npmDir: join(settingsDir, 'npm'),
    tmpDir: join(settingsDir, 'tmp'),
  })
})

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignore cleanup errors
  }
})

describe('ExtensionService.getExtensionPaths system-prompt extension', () => {
  it('xyz-system-prompt-extension.js 存在时，结果包含它且位于 xyz-agent-extension.js 之后', async () => {
    writeFileSync(agentExtensionPath(), '// agent', 'utf-8')
    writeFileSync(systemPromptExtensionPath(), '// system-prompt', 'utf-8')

    const paths = await service.getExtensionPaths()

    expect(paths.some(p => p.endsWith('xyz-agent-extension.js'))).toBe(true)
    expect(paths.some(p => p.endsWith('xyz-system-prompt-extension.js'))).toBe(true)

    const agentIdx = paths.findIndex(p => p.endsWith('xyz-agent-extension.js'))
    const systemIdx = paths.findIndex(p => p.endsWith('xyz-system-prompt-extension.js'))
    expect(systemIdx).toBeGreaterThan(agentIdx)
  })

  it('xyz-system-prompt-extension.js 不存在时，结果不包含它', async () => {
    writeFileSync(agentExtensionPath(), '// agent', 'utf-8')
    expect(existsSync(systemPromptExtensionPath())).toBe(false)

    const paths = await service.getExtensionPaths()

    expect(paths.some(p => p.endsWith('xyz-agent-extension.js'))).toBe(true)
    expect(paths.some(p => p.endsWith('xyz-system-prompt-extension.js'))).toBe(false)
  })
})

describe('ExtensionService.getExtensionPaths client-msg-id-mapper extension', () => {
  it('xyz-client-msg-id-mapper.js 存在时，结果包含它且位于 system-prompt 之后', async () => {
    writeFileSync(agentExtensionPath(), '// agent', 'utf-8')
    writeFileSync(systemPromptExtensionPath(), '// system-prompt', 'utf-8')
    writeFileSync(clientMsgIdMapperPath(), '// client-msg-id-mapper', 'utf-8')

    const paths = await service.getExtensionPaths()

    expect(paths.some(p => p.endsWith('xyz-client-msg-id-mapper.js'))).toBe(true)
    // 位于 system-prompt 之后（追加顺序：agent → system-prompt → client-msg-id-mapper）
    const systemIdx = paths.findIndex(p => p.endsWith('xyz-system-prompt-extension.js'))
    const mapperIdx = paths.findIndex(p => p.endsWith('xyz-client-msg-id-mapper.js'))
    expect(mapperIdx).toBeGreaterThan(systemIdx)
  })

  it('xyz-client-msg-id-mapper.js 不存在时，结果不包含它', async () => {
    writeFileSync(agentExtensionPath(), '// agent', 'utf-8')
    expect(existsSync(clientMsgIdMapperPath())).toBe(false)

    const paths = await service.getExtensionPaths()

    expect(paths.some(p => p.endsWith('xyz-client-msg-id-mapper.js'))).toBe(false)
  })
})
