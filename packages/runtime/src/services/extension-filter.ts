/**
 * Extension Filter Pipeline — 唯一权威过滤实现
 *
 * 纯函数，零 IO。所有消费者 import 这里的函数，禁止其他地方写 inline disabled/mandatory 过滤。
 *
 * 优先级（高→低）：
 *   1. infrastructure 包 → 'load'（绝对强加载，disabled 无效）
 *   2. feature mandatory 包 → 'load'（强启用，disabled 无效；preset 可在其上层覆盖）
 *   3. 普通包 disabled → 'exclude'
 *   4. 普通包未 disabled → 'load'
 *
 * 注意：preset 的 extensionMode 过滤不在此函数内——那是更上层的 PresetService 职责，
 * 作用于本函数 'load' 的结果之上。
 */

import type { DiscoveredExtension } from './ports/installer.js'
import { isMandatoryExtension, isInfrastructureExtension } from '@xyz-agent/shared'
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

/** disabled source 集合（形如 'npm:@zhushanwen/pi-goal'） */
export type DisabledSet = Set<string>

interface PkgMeta {
  name?: string
  version?: string
  description?: string
  pi?: { tools?: string[] }
}

/**
 * 读取扩展目录的 package.json 元数据。
 * 失败返回空对象（resolver 已用 isValidPiExtension 校验过目录，这里只需读元数据）。
 */
export function readPkgMeta(dir: string): PkgMeta {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as PkgMeta
  } catch {
    return {}
  }
}

/**
 * 扩展在「disabled / mandatory」维度的过滤判定。
 *
 * 优先级（高→低）：
 *   1. infrastructure 包 → 'load'（绝对强加载，disabled 无效）
 *   2. feature mandatory 包 → 'load'（强启用，disabled 无效；preset 可在其上层覆盖）
 *   3. 普通包 disabled → 'exclude'
 *   4. 普通包未 disabled → 'load'
 *
 * 注意：preset 的 extensionMode 过滤不在此函数内——那是更上层的 PresetService 职责，
 * 作用于本函数 'load' 的结果之上。
 */
export function filterExtension(dir: string, disabled: DisabledSet): 'load' | 'exclude' {
  const meta = readPkgMeta(dir)
  const name = meta.name ?? basename(dir)
  // 规则 1+2：mandatory（infrastructure + feature）无视 disabled 强加载
  if (isMandatoryExtension(name)) return 'load'
  // 规则 3：普通包按 disabled 过滤
  if (disabled.has(`npm:${name}`)) return 'exclude'
  // 规则 4：普通包未 disabled → 加载
  return 'load'
}

/**
 * 批量过滤——getExtensionPaths 的核心。
 * 输入 resolver 全量发现结果 + disabled 集合，输出应加载的路径数组。
 */
export function filterLoadablePaths(
  discovered: DiscoveredExtension[],
  disabled: DisabledSet,
): string[] {
  return discovered
    .filter(d => filterExtension(d.path, disabled) === 'load')
    .map(d => d.path)
}

/**
 * 判定某扩展是否可被 preset extensionMode 覆盖（排除）。
 * infrastructure 包不可覆盖；其余可覆盖。
 * PresetService.resolveExtensionPaths 调用。
 */
export function isPresetOverridable(dir: string): boolean {
  const meta = readPkgMeta(dir)
  const name = meta.name ?? basename(dir)
  return !isInfrastructureExtension(name)
}
