import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rm, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { toErrorMessage } from '../../utils/errors.js'

const execFileAsync = promisify(execFile)

export interface InstallResult {
  success: boolean
  pluginId?: string
  path?: string
  error?: string
}

/**
 * Installs npm packages as xyz-agent plugins.
 *
 * Flow:
 *  1. Create temp dir
 *  2. npm pack → download tarball
 *  3. Extract tarball
 *  4. Validate package.json has xyzAgent manifest
 *  5. Move to plugins directory
 */
export class PluginInstaller {
  private pluginsDir: string

  /** @param pluginsDir 插件安装目录，由组合根注入（不再直连 infra 取默认值）。 */
  constructor(pluginsDir: string) {
    this.pluginsDir = pluginsDir
  }

  async install(packageSpecifier: string): Promise<InstallResult> {
    const tmpDir = join(tmpdir(), `xyz-plugin-install-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      // 1. npm pack to download the package
      await execFileAsync('npm', [
        'pack', packageSpecifier, '--pack-destination', tmpDir,
      ], { timeout: 60_000 })

      // 2. Find the tgz file
      const files = await readdir(tmpDir)
      const tgz = files.find(f => f.endsWith('.tgz'))
      if (!tgz) {
        return { success: false, error: 'No tarball found after npm pack' }
      }

      // 3. Extract (npm pack creates package/ directory inside tgz)
      const extractDir = join(tmpDir, 'extracted')
      await mkdir(extractDir, { recursive: true })
      await execFileAsync('tar', ['-xzf', join(tmpDir, tgz), '-C', extractDir], { timeout: 30_000 })

      // 4. Read package.json from extracted/package/
      const pkgPath = join(extractDir, 'package', 'package.json')
      const pkgRaw = await readFile(pkgPath, 'utf-8')
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>

      const xyzAgent = pkg.xyzAgent as Record<string, unknown> | undefined
      if (!xyzAgent || xyzAgent.manifestVersion !== 1) {
        return { success: false, error: 'Not a valid xyz-agent plugin (missing xyzAgent manifest)' }
      }

      // 5. Move to plugins dir
      await mkdir(this.pluginsDir, { recursive: true })
      const pluginName = typeof pkg.name === 'string' ? pkg.name : String(pkg.name ?? 'unknown-plugin')
      const targetDir = join(this.pluginsDir, pluginName)
      await rm(targetDir, { recursive: true, force: true })
      await rename(join(extractDir, 'package'), targetDir)

      return { success: true, pluginId: pluginName, path: targetDir }
    } catch (err) {
      const message = toErrorMessage(err)
      return { success: false, error: message }
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async uninstall(_pluginId: string, pluginPath: string): Promise<void> {
    await rm(pluginPath, { recursive: true, force: true })
  }
}
