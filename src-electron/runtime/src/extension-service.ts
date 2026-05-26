/**
 * ExtensionService — manages extension lifecycle: discovery, enable/disable, path resolution.
 *
 * Extensions live in `~/.xyz-agent/extensions/` as subdirectories, each with a `package.json`.
 * State is managed via a blacklist model: `extension-state.json` stores `{ disabled: string[] }`.
 * Extensions not in the disabled list are considered enabled by default.
 */
import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { ExtensionInfo } from '@xyz-agent/shared'

/** Shape of extension-state.json */
interface ExtensionState {
  disabled: string[]
}

/** package.json fields we care about */
interface ExtensionPackageJson {
  name?: string
  version?: string
  description?: string
}

const STATE_FILENAME = 'extension-state.json'
const DEFAULT_STATE: ExtensionState = { disabled: [] }

export class ExtensionService {
  private readonly extensionsDir: string
  private readonly stateFilePath: string

  /**
   * @param extensionsDir - Override extensions directory (for testing). Defaults to `~/.xyz-agent/extensions/`.
   */
  constructor(extensionsDir?: string) {
    this.extensionsDir = extensionsDir ?? join(homedir(), '.xyz-agent', 'extensions')
    this.stateFilePath = join(this.extensionsDir, STATE_FILENAME)
  }

  /**
   * Scan the extensions directory and return metadata for all discovered extensions.
   *
   * - Directory not found → empty array
   * - Subdirectory without package.json → skipped
   * - Missing state file → all enabled
   */
  async scanExtensions(): Promise<ExtensionInfo[]> {
    let entries: string[]
    try {
      entries = await readdir(this.extensionsDir, { withFileTypes: false })
    } catch (e) {
      // Directory doesn't exist — not an error, just empty
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }

    const state = await this.readState()

    const results: ExtensionInfo[] = []
    for (const entry of entries) {
      const extDir = join(this.extensionsDir, entry)
      const pkgPath = join(extDir, 'package.json')

      let raw: string
      try {
        raw = await readFile(pkgPath, 'utf-8')
      } catch (e) {
        // No package.json in this subdir — skip
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw e
      }

      let pkg: ExtensionPackageJson
      try {
        pkg = JSON.parse(raw) as ExtensionPackageJson
      } catch {
        // Invalid JSON — skip
        continue
      }

      results.push({
        name: pkg.name ?? entry,
        version: pkg.version ?? '',
        description: pkg.description ?? '',
        path: extDir,
        enabled: !state.disabled.includes(pkg.name ?? entry),
      })
    }

    return results
  }

  /** Return only enabled extensions. */
  async getEnabledExtensions(): Promise<ExtensionInfo[]> {
    const all = await this.scanExtensions()
    return all.filter(ext => ext.enabled)
  }

  /**
   * Enable or disable an extension by name.
   * Updates extension-state.json using atomic write (write temp + rename).
   * Silently ignores unknown extension names.
   */
  async toggleExtension(name: string, enabled: boolean): Promise<void> {
    const state = await this.readState()

    if (enabled) {
      // Remove from disabled list
      state.disabled = state.disabled.filter(n => n !== name)
    } else {
      // Add to disabled list if not already there
      if (!state.disabled.includes(name)) {
        state.disabled.push(name)
      }
    }

    await this.writeState(state)
  }

  /** Return absolute paths of all enabled extensions (for pi `--extension` CLI args). */
  async getExtensionPaths(): Promise<string[]> {
    const enabled = await this.getEnabledExtensions()
    return enabled.map(ext => ext.path)
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async readState(): Promise<ExtensionState> {
    try {
      const raw = await readFile(this.stateFilePath, 'utf-8')
      return JSON.parse(raw) as ExtensionState
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...DEFAULT_STATE }
      }
      throw e
    }
  }

  /** Atomic write: write to temp file, then rename. */
  private async writeState(state: ExtensionState): Promise<void> {
    const content = JSON.stringify(state, null, 2) + '\n'
    const tmpPath = this.stateFilePath + '.tmp'

    // Ensure directory exists
    await mkdir(dirname(this.stateFilePath), { recursive: true })

    await writeFile(tmpPath, content, 'utf-8')
    await rename(tmpPath, this.stateFilePath)
  }
}
