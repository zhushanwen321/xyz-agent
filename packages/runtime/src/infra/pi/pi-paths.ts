/**
 * Pi 路径解析（env-var-aware，支持实例隔离）
 *
 * 数据根目录委托 shared 的 getDataDir（SSOT，ADR-0009 隔离）。
 * 其余 pi 子路径在此派生。
 *
 * 目录结构：
 *   ~/.xyz-agent/                    ← xyz-agent 配置根目录
 *     config.json                    ← xyz-agent 自身配置
 *     pi/                            ← xyz-pi 的根目录
 *       agent/                       ← xyz-pi 的 agent 目录
 *         models.json                ← Provider & Model 定义
 *         settings.json              ← xyz-pi 设置
 *         agents/                    ← Agent markdown 文件
 *         extensions/                ← bundled extensions
 *         skills/                    ← bundled skills
 *       sessions/                    ← Session jsonl 文件
 */

import { getDataDir } from '@xyz-agent/shared/paths'
import { join } from 'node:path'

/** xyz-agent 数据根目录（委托 shared SSOT，读 XYZ_AGENT_DATA_DIR，缺省 ~/.xyz-agent）。 */
export function getConfigDir(): string {
  return getDataDir()
}

/** xyz-pi root: ~/.xyz-agent/pi/ */
export function getPiRoot(): string {
  return join(getConfigDir(), 'pi')
}

/** xyz-pi agent directory: ~/.xyz-agent/pi/agent/ */
export function getPiAgentDir(): string {
  return join(getPiRoot(), 'agent')
}

export function getModelsPath(): string {
  return join(getPiAgentDir(), 'models.json')
}

export function getSettingsPath(): string {
  return join(getPiAgentDir(), 'settings.json')
}

export function getSessionsDir(): string {
  return join(getPiRoot(), 'sessions')
}

export function getAgentsDir(): string {
  return join(getPiAgentDir(), 'agents')
}

/**
 * 编码 cwd 为目录名（复刻 pi-subagent-workflow 的 path-encoding.ts）。
 *
 * 规则：'--' + cwd 去掉首斜杠 + 所有 / \ : 替换为 - + '--'
 * 例：/Users/x/proj → --Users-x-proj--
 *     C:\Users\x\proj → --C-Users-x-proj--
 *
 * 用于定位 subagent session 目录：<piAgentDir>/subagents/<encodeCwd(cwd)>/sessions/
 */
export function encodeCwd(cwd: string): string {
  return '--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'
}

/**
 * 获取 subagent session 目录路径。
 * <piAgentDir>/subagents/<encodeCwd(mainCwd)>/sessions/
 */
export function getSubagentSessionDir(mainCwd: string): string {
  return join(getPiAgentDir(), 'subagents', encodeCwd(mainCwd), 'sessions')
}
