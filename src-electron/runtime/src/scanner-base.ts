import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ScanSourceType } from '@xyz-agent/shared'

/** Expand `~` prefix to the user's home directory. */
export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/** Infer scan source type from the path's directory conventions. */
export function inferSourceType(path: string): ScanSourceType {
  if (path.includes('.pi/')) return 'pi'
  if (path.includes('.claude/')) return 'claude'
  if (path.includes('.agents/')) return 'agents'
  return 'custom'
}
