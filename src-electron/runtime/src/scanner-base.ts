import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ScanSourceType } from '@xyz-agent/shared'

/** Expand `~` prefix to the user's home directory. */
export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/** Infer scan source type from the path's directory conventions. */
export function inferSourceType(path: string): ScanSourceType {
  // 用路径分隔符限定，避免 .pi-backup、.claude-old 等误判
  const sep = /[/\\]/
  // 检查路径中是否包含 /.<name>/ 或 \<name>\ 的目录段
  const segments = path.split(sep)
  for (const seg of segments) {
    if (seg === '.pi') return 'pi'
    if (seg === '.claude') return 'claude'
    if (seg === '.agents') return 'agents'
  }
  return 'custom'
}
