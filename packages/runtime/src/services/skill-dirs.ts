/**
 * Skill 目录解析 SSOT —— scanner 与 watcher 共用的唯一目录发现逻辑。
 *
 * 背景（EMFILE 事故 2026-07-22）：原 SkillRegistry.getProjectSkills 用 chokidar
 * 递归 watch 整个项目 cwd，cwd 为 home 目录等巨型目录时 fd 耗尽（EMFILE 10899 次），
 * 级联导致 pi 子进程 spawn EBADF → 发消息超时 / 读历史失败 / runtime 崩溃。
 *
 * 根因：watcher 的监听范围（整个 cwd）远大于 scanner 的扫描范围（仅几个 skill 子目录）。
 * 本模块把"skill 目录在哪"收敛为唯一事实源，scanner（ConfigService.loadSkills）和
 * watcher（SkillRegistry）都从这里取目录列表，从结构上保证 watch 范围 = scan 范围，
 * 不再有 watch 整个 cwd 的可能。
 *
 * 目录分类（与 loadSkills 的优先级链一致）：
 * - 全局目录（resolveGlobalSkillDirs）：不依赖 projectRoot，固定几个绝对路径
 *   （piAgentDir/skills、configDir/skills、discovery 中的绝对/~ 路径）。
 * - 项目目录（resolveProjectSkillDirs）：依赖 projectRoot resolve 的相对路径
 *   （强制项目目录 .xyz-agent/skills + discovery 中的相对路径如 .agents/skills）。
 */
import { isAbsolute, join, resolve } from 'node:path'

import { expandHome } from '../utils/path-utils.js'

/**
 * 强制·项目 skill 目录（ADR-0020 §1.1 桥接层硬编码，项目相对路径，最高优先）。
 * 存在则扫，resolve 基准是用户当前项目 cwd（projectRoot）。
 */
export const FORCED_PROJECT_SKILL_DIR = '.xyz-agent/skills'

/**
 * configStore 的窄接口（与 PiConfigStore / SkillRegistryConfigStore 对齐）。
 * 只需要目录发现相关的两个方法。
 */
export interface SkillDirConfigSource {
  /** pi agent 配置目录（~/.xyz-agent/pi/agent）。 */
  getPiAgentDir(): string
  /** discovery.json skillDirs（全局，无 cwd 参数）。 */
  getSkillPaths(): string[]
}

/**
 * 全局 skill 目录列表（不依赖 projectRoot）。
 * scanner 扫描这些 + 项目目录；watcher（initGlobal）只 watch 这些。
 *
 * @param configDir xyz-agent 配置根目录（~/.xyz-agent/，由调用方传入——ConfigService 传
 *   getConfigDir()，SkillRegistry 传 options.configDir；两者值相同，显式传入避免隐式 env 依赖）。
 *   全局强制目录 <configDir>/skills 由此派生。
 *   返回未去重的有序列表（靠前的优先级高），调用方按需处理。
 */
export function resolveGlobalSkillDirs(
  configStore: SkillDirConfigSource,
  configDir: string,
): string[] {
  return [
    join(configStore.getPiAgentDir(), 'skills'),
    join(configDir, 'skills'),
    ...configStore
      .getSkillPaths()
      .filter(d => isAbsolute(d) || d.startsWith('~'))
      .map(d => expandHome(d)),
  ]
}

/**
 * 项目级 skill 目录列表（依赖 projectRoot resolve 的相对路径）。
 * scanner 扫描这些 + 全局目录；watcher（getProjectSkills）只 watch 这些，
 * 不再 watch 整个 cwd。
 *
 * 包含强制项目目录（.xyz-agent/skills）+ discovery 中所有相对路径（如 .agents/skills），
 * 统一 resolve 到绝对路径。绝对路径 / ~ 开头的 discovery 路径属于全局（见 resolveGlobalSkillDirs），
 * 此处不含。
 */
export function resolveProjectSkillDirs(
  projectRoot: string,
  configStore: SkillDirConfigSource,
): string[] {
  const resolveDir = (dir: string): string =>
    isAbsolute(dir) ? dir : resolve(projectRoot, dir)
  return [
    resolve(projectRoot, FORCED_PROJECT_SKILL_DIR),
    ...configStore
      .getSkillPaths()
      .filter(d => !isAbsolute(d) && !d.startsWith('~'))
      .map(resolveDir),
  ]
}
