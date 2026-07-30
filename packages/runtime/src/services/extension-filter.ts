/**
 * Extension Filter Pipeline — 唯一权威过滤实现
 *
 * 纯函数。所有消费者 import 这里的函数，禁止其他地方写 inline disabled/mandatory/preset 过滤。
 *
 * 两阶段管道：
 *   1. resolveExtensions：resolver 发现结果 → disabled 过滤 + tier 推导（一次读盘）
 *   2. applyPresetMode：preset extensionMode 二次筛选
 *
 * 关键设计：读盘只发生一次（resolveExtensions 内），结果 ResolvedExtension 携带 name/tier/loadable/presetOverridable，
 * 下游不再重复读盘。
 */
import type { DiscoveredExtension } from './ports/installer.js'
import { isMandatoryExtension, isInfrastructureExtension, isFeatureMandatoryExtension, type ExtensionTier } from '@xyz-agent/shared'
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

/** disabled source 集合（形如 'npm:@zhushanwen/pi-goal'） */
export type DisabledSet = ReadonlySet<string>

export interface PkgMeta {
  name?: string
  version?: string
  description?: string
  pi?: { tools?: string[] }
}

/** 从扩展目录读 package.json。失败返回空对象。 */
export function readPkgMeta(dir: string): PkgMeta {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as PkgMeta
  } catch {
    return {}
  }
}

/** 过滤管道流转的统一载体：读盘一次推导出的全部判定信息。 */
export interface ResolvedExtension {
  /** 扩展目录绝对路径 */
  path: string
  /** 包名（package.json name，或目录 basename fallback） */
  name: string
  /** mandatory 分级；undefined = 非 mandatory */
  tier: ExtensionTier | undefined
  /** 是否应加载（infrastructure/feature mandatory 强制 true；普通包看 disabled） */
  loadable: boolean
  /** 是否可被 preset 覆盖（false = infrastructure 绝对强加载；true = 其余） */
  presetOverridable: boolean
}

/**
 * 从单个扩展目录推导判定信息。一次读盘。
 * S8 修复：对 package.json 畸形 name（非 string）用 typeof 守卫，fallback 到 basename。
 */
export function resolveExtension(dir: string, disabled: DisabledSet): ResolvedExtension {
  const meta = readPkgMeta(dir)
  // S8：package.json name 字段类型未知（JSON.parse 可能返回 number/object），用 typeof 守卫
  const name = typeof meta.name === 'string' ? meta.name : basename(dir)
  const tier = isInfrastructureExtension(name) ? 'infrastructure'
    : isFeatureMandatoryExtension(name) ? 'feature'
    : undefined
  // mandatory（infrastructure + feature）无视 disabled 强加载；普通包看 disabled
  const loadable = isMandatoryExtension(name) ? true : !disabled.has(`npm:${name}`)
  const presetOverridable = !isInfrastructureExtension(name)
  return { path: dir, name, tier, loadable, presetOverridable }
}

/**
 * 批量推导——resolver 发现结果 → disabled 过滤 + tier 推导，每个 dir 只读一次 package.json。
 */
export function resolveExtensions(
  discovered: readonly DiscoveredExtension[],
  disabled: DisabledSet,
): ResolvedExtension[] {
  return discovered.map(d => resolveExtension(d.path, disabled))
}

/** preset extensionMode 枚举（与 pi-preset.ts 的 ExtensionMode 对齐） */
export type ExtensionMode = 'all' | 'allowlist' | 'denylist' | 'none'

/**
 * preset mode 二次筛选。
 * 作用于 resolveExtensions 的结果之上。
 *
 * 语义：
 *   - none：只保留不可覆盖的（infrastructure）
 *   - allowlist：infrastructure 强制保留 + 其余 name 须在 allowlist 内
 *   - denylist：infrastructure 强制保留（不在 denylist 生效范围）+ 其余 name 不在 denylist 内
 *   - all：全保留
 *
 * infrastructure 在任何模式下都存活（绝对强加载，本次重构的核心保证）。
 */
export function applyPresetMode(
  resolved: readonly ResolvedExtension[],
  mode: ExtensionMode,
  allowlist: readonly string[],
  denylist: readonly string[],
): ResolvedExtension[] {
  switch (mode) {
    case 'none':
      return resolved.filter(r => !r.presetOverridable)
    case 'allowlist':
      return resolved.filter(r => !r.presetOverridable || allowlist.includes(r.name))
    case 'denylist':
      return resolved.filter(r => !r.presetOverridable || !denylist.includes(r.name))
    case 'all':
      return [...resolved]
    default:
      return [...resolved]
  }
}
