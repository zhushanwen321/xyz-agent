/**
 * ADR-0020 §1/§2/§3 目录级管道配置（discovery.json SSOT）的 UI 视图构建。
 *
 * 此前长在 transport/server.ts（config 域业务逻辑泄漏到传输层），C2 拆分时下沉到 services/。
 * 消费方：sendInitialState（新连接推送 config.skillDirs/config.agentDirs）+
 * 两个 broadcast helper（目录变更后广播）。
 */
import type { SkillDirConfig } from '@xyz-agent/shared'
import { expandHome } from '../utils/path-utils.js'

/**
 * ADR-0020 §2/§3 预设可选目录候选（层 A「可选目录」的固定来源）。
 * 用户可勾选启用/可拖排序；勾选的进 discovery.json 数组。
 * 强制目录（~/.xyz-agent/...）不在此列（UI 另行只读展示）。
 */
export const PRESET_SKILL_DIRS = [
  '~/.pi/agent/skills',
  '~/.claude/skills',
  '~/.agents/skills',
  '.agents/skills',
]
export const PRESET_AGENT_DIRS = [
  '~/.pi/agent/agents',
  '~/.claude/agents',
  '~/.agents/agents',
  '.agents/agents',
]

/**
 * 把预设候选目录 + discovery 启用列表 组合成 UI 用的 SkillDirConfig[]。
 *
 * 顺序语义（ADR-0020 §1.1：靠前覆盖靠后）——**discovery 数组顺序即优先级**：
 *   1. discovery 里启用的目录，按 discovery 数组顺序排列（用户拖拽排序的结果）
 *   2. 预设候选中未启用的，按 preset 固定顺序追加在后（供用户勾选）
 *   3. discovery 里有但不在预设里的自定义路径（已启用），紧随其后
 *
 * 这保证用户拖拽改变 discovery 顺序后，广播回来的 UI 列表顺序与之一致，
 * 不会被 preset 固定顺序覆盖（否则拖拽排序失效）。
 *
 * 过滤：不存在 / 非 skill 容器的启用路径不展示（脏数据，如 /path/a）。ADR §5。
 * 归一化：比较时展开 ~，避免 ~/.pi 与 /Users/.../pi 因字符串不同而重复。
 */
export function buildDirConfigs(preset: string[], enabledDirs: string[]): SkillDirConfig[] {
  const configs: SkillDirConfig[] = []

  // 1. discovery 启用目录，按 discovery 顺序（= 用户拖拽优先级，靠前覆盖靠后）
  for (const dir of enabledDirs) {
    configs.push({ path: dir, enabled: true })
  }

  // 2. 预设候选中尚未启用的，按 preset 固定顺序追加（供勾选）
  const enabledNormalized = new Set(enabledDirs.map(expandHome))
  for (const path of preset) {
    if (!enabledNormalized.has(expandHome(path))) {
      configs.push({ path, enabled: false })
    }
  }
  return configs
}
