/**
 * DiscoveryStore — discovery.json 的唯一读写层（ADR-0020 §1 落地）。
 *
 * discovery.json 是 skill/agent 加载路径的**唯一真相源（SSOT）**：
 *   - 路径：`<piAgentDir>/discovery.json`（~/.xyz-agent/pi/agent/discovery.json）
 *   - schema：{ version:1, skillDirs:string[], agentDirs:string[] }
 *   - skillDirs/agentDirs 是有序数组，靠前覆盖靠后（ADR §1.1 层 3）
 *   - 强制目录（~/.xyz-agent/skills · .xyz-agent/skills 等）不进此文件（桥接层硬编码注入）
 *
 * 与 settings.json 的关系（ADR §理由 2 + 方案 C 决策）：
 *   discovery.json = SSOT（xyz-agent 自有，UI 读写此）。
 *   settings.json.skills = 派生投影（pi 原生经 collectSettingsSkillPaths 读此加载 skill）。
 *   每次 discovery.json 的 skillDirs 变更，由 pi-provider-store 同步投影到 settings.json.skills。
 *   agent 无 pi 原生多目录扫描，agentDirs 仅由 xyz-agent 的 listAgentFiles 多目录扫描消费。
 *
 * 🔒 三层架构：本模块属 infra（直接碰文件系统），services 经 port 访问。
 * 与 pi-settings-store / pi-provider-store 同构：JsonStore 封装 + 测试用 setDiscoveryPath + invalidate。
 */
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { PRESET_SKILL_DIRS, PRESET_AGENT_DIRS } from '@xyz-agent/shared'
import { JsonStore } from '../../utils/json-store.js'
import { getPiAgentDir } from './pi-paths.js'
import { expandHome } from '../../utils/path-utils.js'
import type { DiscoveryConfig } from '@xyz-agent/shared'

const DEFAULT_DISCOVERY: DiscoveryConfig = { version: 1, skillDirs: [], agentDirs: [] }

/**
 * discovery.json 存储：read-through（TTL 缓存 + ENOENT 容错）+ atomicWrite。
 * schema guard：version 必须为 1，skillDirs/agentDirs 必须为 string[]。
 */
let discoveryStore = createDiscoveryStore(getDiscoveryPath())

function createDiscoveryStore(path: string): JsonStore<DiscoveryConfig> {
  return new JsonStore<DiscoveryConfig>(path, DEFAULT_DISCOVERY, {
    ttlMs: 3_000,
    deserialize: (raw): DiscoveryConfig => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        console.warn(`[discovery-store] ${path} schema 不匹配，使用 fallback`)
        return { ...DEFAULT_DISCOVERY }
      }
      const obj = raw as Partial<DiscoveryConfig>
      return {
        version: 1,
        skillDirs: Array.isArray(obj.skillDirs) ? obj.skillDirs.filter((s): s is string => typeof s === 'string') : [],
        agentDirs: Array.isArray(obj.agentDirs) ? obj.agentDirs.filter((s): s is string => typeof s === 'string') : [],
      }
    },
    // skillDirs + agentDirs 都空 → 删文件（与 disabled-packages.json 的「空则删」语义一致）
    shouldDeleteWhen: (v) => v.skillDirs.length === 0 && v.agentDirs.length === 0,
  })
}

/** discovery.json 路径：<piAgentDir>/discovery.json。导出供 pi-provider-store 投影逻辑复用。 */
export function getDiscoveryPath(): string {
  return `${getPiAgentDir()}/discovery.json`
}

/**
 * 覆盖 discovery.json 路径（仅测试用）。生产不应调用。
 * 重建 store 实例并清空缓存，确保后续读拿到新路径的文件。
 */
export function setDiscoveryPath(path: string): void {
  discoveryStore = createDiscoveryStore(path)
}

/** 失效缓存（外部改了文件后调用）。 */
export function invalidateDiscoveryCache(): void {
  discoveryStore.invalidate()
}

/** 读取 discovery.json 全量（带 3s 缓存）。 */
export function readDiscovery(): DiscoveryConfig {
  return discoveryStore.read()
}

/** 写入 discovery.json 全量（刷新缓存；空则删文件）。 */
export function writeDiscovery(config: DiscoveryConfig): void {
  discoveryStore.write(config)
}

// ── 便捷访问器（与 pi-provider-store 的 skill 路径函数 API 形状对称）──

/** 读取 skillDirs 有序数组（SSOT）。 */
export function getSkillDirs(): string[] {
  return readDiscovery().skillDirs
}

/** 读取 agentDirs 有序数组（SSOT）。 */
export function getAgentDirs(): string[] {
  return readDiscovery().agentDirs
}

/**
 * 覆盖 skillDirs（有序数组 = 优先级，靠前覆盖靠后）。
 *
 * ADR §5 脏数据过滤：写入前剔除不存在的「自定义」绝对路径（/path/a 等 pi 首次写入的占位符、
 * 已删除的自定义路径）。与 services/skill-dir-config.ts 的 buildDirConfigs 读取端过滤对齐——
 * 双向拦截，确保 discovery.json 不残留脏数据（否则用户日后 mkdir 该路径会重新作为 enabled 出现）。
 *
 * 豁免（与 buildDirConfigs 一致）：
 *   - preset 成员（推荐候选语义，即使不存在也保留）—— PRESET_SKILL_DIRS 从 @xyz-agent/shared
 *     import（SSOT，与读取端共用同一份，无副本漂移风险）
 *   - 相对路径（无 cwd 上下文，不检查存在性）
 */
export function setSkillDirs(dirs: string[]): void {
  const presetNormalized = new Set(PRESET_SKILL_DIRS.map(expandHome))
  const filtered = dirs.filter(dir => {
    const resolved = expandHome(dir)
    const isPresetMember = presetNormalized.has(resolved)
    return isPresetMember || !isAbsolute(resolved) || existsSync(resolved)
  })
  const draft = readDiscovery()
  writeDiscovery({ ...draft, skillDirs: filtered })
}

/**
 * 覆盖 agentDirs（有序数组 = 优先级，靠前覆盖靠后）。与 setSkillDirs 对称的脏数据过滤。
 */
export function setAgentDirs(dirs: string[]): void {
  const presetNormalized = new Set(PRESET_AGENT_DIRS.map(expandHome))
  const filtered = dirs.filter(dir => {
    const resolved = expandHome(dir)
    const isPresetMember = presetNormalized.has(resolved)
    return isPresetMember || !isAbsolute(resolved) || existsSync(resolved)
  })
  const draft = readDiscovery()
  writeDiscovery({ ...draft, agentDirs: filtered })
}
