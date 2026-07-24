/**
 * ADR-0020 §1/§2/§3 目录级管道配置（discovery.json SSOT）的 UI 视图构建。
 *
 * 此前长在 transport/server.ts（config 域业务逻辑泄漏到传输层），C2 拆分时下沉到 services/。
 * 消费方：sendInitialState（新连接推送 config.skillDirs/config.agentDirs）+
 * 两个 broadcast helper（目录变更后广播）。
 */
import type { SkillDirConfig } from '@xyz-agent/shared'
import { PRESET_SKILL_DIRS, PRESET_AGENT_DIRS, PRESET_EXTENSION_DIRS } from '@xyz-agent/shared'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { expandHome } from '../utils/path-utils.js'

// Re-export 供历史调用方（消费 PRESET_SKILL_DIRS/PRESET_AGENT_DIRS/PRESET_EXTENSION_DIRS 的模块）继续从此处 import，
// SSOT 已上提到 @xyz-agent/shared/constants（infra 与 services 共享，消除本地副本漂移）。
export { PRESET_SKILL_DIRS, PRESET_AGENT_DIRS, PRESET_EXTENSION_DIRS }

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
 * 过滤：不存在的「自定义」启用路径不展示（脏数据，如 /path/a 等 pi 首制 discovery 占位符）。ADR §5。
 * **preset 成员豁免存在性检查**：preset 是「推荐候选」语义，用户勾选启用后即使该目录在此机器
 * 上不存在（未安装 Claude Code / 换机器 / 正准备创建），也应显示为 enabled，否则用户启用的配置
 * 会从 UI 消失、不可取消勾选（回归）。脏数据 /path/a 不在 preset 里，仍被过滤。
 * 相对路径（如 .agents/skills）不检查（buildDirConfigs 不知 cwd，且 preset 含相对路径作为候选语义）。
 */
export function buildDirConfigs(preset: readonly string[], enabledDirs: string[]): SkillDirConfig[] {
  const configs: SkillDirConfig[] = []
  const presetNormalized = new Set(preset.map(expandHome))

  // 1. discovery 启用目录，按 discovery 顺序（= 用户拖拽优先级，靠前覆盖靠后）。
  //    ADR §5 脏数据过滤：展开 ~ 后为绝对路径的，检查存在性——不存在则跳过
  //    （/path/a 等 pi 首次写入的占位符、已删除的自定义路径）。
  //    preset 成员豁免（推荐候选语义，启用后即使不存在也要显示，见函数 JSDoc）。
  for (const dir of enabledDirs) {
    const resolved = expandHome(dir)
    const isPresetMember = presetNormalized.has(resolved)
    if (!isPresetMember && isAbsolute(resolved) && !existsSync(resolved)) continue
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
