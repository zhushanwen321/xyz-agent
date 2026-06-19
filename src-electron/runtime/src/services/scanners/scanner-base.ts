import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ScanSourceType } from '@xyz-agent/shared'

/** Expand `~` prefix to the user's home directory. */
export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

// atomicWrite 已迁至跨层共享层 utils/fs-utils.ts（ADR 0004）：该函数被 infra 和
// services 共用，无业务语义，不属于任一业务层。scanner 自身用不到它。

/** Infer scan source type from the path's directory conventions. */
export function inferSourceType(path: string): ScanSourceType {
  // 用路径分隔符限定，避免 .pi-backup、.claude-old 等误判
  const sep = /[/\\]/
  // 检查路径中是否包含 /.<name>/ 或 \<name>\ 的目录段
  const segments = path.split(sep)
  for (const seg of segments) {
    // 匹配 .xyz-agent 及其变体（如 .xyz-agent-dev、.xyz-agent-v2），但不匹配 .xyz-agentator 等非预期名称
    if (seg === '.xyz-agent' || seg.startsWith('.xyz-agent-')) return 'pi'
    if (seg === '.pi') return 'pi'
    if (seg === '.claude') return 'claude'
    if (seg === '.agents') return 'agents'
  }
  return 'custom'
}
