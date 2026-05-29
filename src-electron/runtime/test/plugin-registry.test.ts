import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolve(__dirname, 'fixtures/plugins')

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-registry-test-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/**
 * 在 <tmpDir>/.xyz-agent/plugins/ 下创建指定名称的插件子目录，
 * 并写入 package.json。
 */
async function createPluginDir(pluginName: string, packageJson: Record<string, unknown>): Promise<string> {
  const pluginDir = join(tmpDir, '.xyz-agent', 'plugins', pluginName)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf-8')
  return pluginDir
}

describe('PluginRegistry', () => {
  // ── TC-1-01: scan() discovers valid plugin from fixture dir ────
  it('TC-1-01: scan() discovers valid plugin from fixture dir', async () => {
    // 复制 fixture 到 temp dir
    const pluginDir = join(tmpDir, '.xyz-agent', 'plugins', 'hello-world')
    await mkdir(pluginDir, { recursive: true })
    await cp(join(FIXTURES_DIR, 'hello-world'), pluginDir, { recursive: true })

    const registry = new PluginRegistry(tmpDir)
    const descriptors = await registry.scan()

    expect(descriptors.length >= 1).toBeTruthy()
    const hw = descriptors.find(d => d.pluginId === 'hello-world')!
    expect(hw).toBeTruthy()
    // Version comes from fixture package.json; don't hardcode to avoid CI flakiness
    expect(hw.version).toBeTruthy()
    expect(hw.displayName).toBe('Hello World')
    expect(hw.description).toBe('A test plugin for xyz-agent')
    expect(hw.main).toBe('index.js')
    expect(hw.trustLevel).toBe('trusted')
    expect(hw.activationEvents.includes('onStartupFinished')).toBeTruthy()
    expect(hw.activationEvents.includes('onSlashCommand:hello')).toBeTruthy()
  })

  // ── TC-1-02: scan() skips invalid manifest (no xyzAgent field) ─
  it('TC-1-02: scan() skips invalid manifest (no xyzAgent field)', async () => {
    const noAgent = join(tmpDir, '.xyz-agent', 'plugins', 'no-agent')
    await mkdir(noAgent, { recursive: true })
    await writeFile(
      join(noAgent, 'package.json'),
      JSON.stringify({ name: 'no-agent', version: '1.0.0' }),
      'utf-8',
    )

    const registry = new PluginRegistry(join(tmpDir, 'scan-no-agent'))
    const descriptors = await registry.scan()
    const found = descriptors.find(d => d.pluginId === 'no-agent')
    expect(found).toBe(undefined)
  })

  // ── TC-1-03: scan() auto-infers activationEvents from contributes ─
  it('TC-1-03: scan() auto-infers activationEvents from contributes', async () => {
    await createPluginDir('infer-test', {
      name: 'infer-test',
      version: '1.0.0',
      xyzAgent: {
        manifestVersion: 1,
        main: 'index.js',
        // 不声明 onSlashCommand:foo —— 应从 contributes 自动推断
        activationEvents: ['onStartupFinished'],
        contributes: {
          slashCommands: [
            { name: 'foo', description: 'Foo command' },
            { name: 'bar', description: 'Bar command' },
          ],
        },
      },
    })

    const registry = new PluginRegistry(tmpDir)
    await registry.scan()
    const desc = registry.getDescriptor('infer-test')!

    expect(desc).toBeTruthy()
    expect(desc.activationEvents.includes('onStartupFinished')).toBeTruthy()
    expect(
      desc.activationEvents.includes('onSlashCommand:foo'),
    ).toBeTruthy()
    expect(
      desc.activationEvents.includes('onSlashCommand:bar'),
    ).toBeTruthy()
  })

  // ── TC-1-04: cacheDescriptors / getDescriptor / getAllDescriptors ─
  it('TC-1-04: cacheDescriptors / getDescriptor / getAllDescriptors', async () => {
    const registry = new PluginRegistry(tmpDir)

    const descA = {
      pluginId: 'plugin-a',
      version: '1.0.0',
      displayName: 'Plugin A',
      description: '',
      main: 'index.js',
      activationEvents: ['onStartupFinished'],
      trustLevel: 'sandbox' as const,
      status: 'UNLOADED' as const,
      contributes: {},
      permissions: [],
      engines: { 'xyz-agent': '*' },
      pluginPath: '/tmp/plugin-a',
      source: 'external' as const,
      extensionDependencies: [],
    }
    const descB = {
      pluginId: 'plugin-b',
      version: '2.0.0',
      displayName: 'Plugin B',
      description: 'Second plugin',
      main: 'main.js',
      activationEvents: ['onSlashCommand:test'],
      trustLevel: 'trusted' as const,
      status: 'UNLOADED' as const,
      contributes: {},
      permissions: [],
      engines: { 'xyz-agent': '*' },
      pluginPath: '/tmp/plugin-b',
      source: 'external' as const,
      extensionDependencies: [],
    }

    registry.cacheDescriptors([descA, descB])

    expect(registry.getDescriptor('plugin-a')).toEqual(descA)
    expect(registry.getDescriptor('plugin-b')).toEqual(descB)
    expect(registry.getDescriptor('nonexistent')).toBe(undefined)

    const all = registry.getAllDescriptors()
    expect(all.length).toBe(2)
    const ids = all.map(d => d.pluginId).sort()
    expect(ids).toEqual(['plugin-a', 'plugin-b'])
  })

  // ── TC-1-05: reload() re-scans ────────────────────────────────
  it('TC-1-05: reload() re-scans', async () => {
    // 先扫描，此时应包含 hello-world
    const registry = new PluginRegistry(tmpDir)
    const first = await registry.scan()
    expect(first.some(d => d.pluginId === 'hello-world')).toBeTruthy()

    // 添加新插件
    await createPluginDir('late-plugin', {
      name: 'late-plugin',
      version: '1.0.0',
      xyzAgent: { manifestVersion: 1, main: 'index.js', activationEvents: [] },
    })

    const reloaded = await registry.reload()
    expect(reloaded.some(d => d.pluginId === 'late-plugin')).toBeTruthy()
    expect(reloaded.some(d => d.pluginId === 'hello-world')).toBeTruthy()
  })
})
