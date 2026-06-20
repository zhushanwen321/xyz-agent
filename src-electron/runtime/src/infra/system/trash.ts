import { unlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { platform } from 'node:os'

const isMac = platform() === 'darwin'

/**
 * Move file to system trash if possible, otherwise permanently delete.
 */
export async function trash(filePath: string): Promise<void> {
  if (isMac) {
    try {
      execSync(`trash "${filePath}" 2>/dev/null || osascript -e 'tell application "Finder" to delete POSIX file "${filePath}"' 2>/dev/null`, {
        stdio: 'ignore',
        timeout: 5000,
      })
      return
    // eslint-disable-next-line taste/no-silent-catch -- intentional: fall back to permanent delete
    } catch (e) {
      console.error('[trash] trash command failed, falling back to permanent delete:', e)
    }
  }
  unlinkSync(filePath)
}
