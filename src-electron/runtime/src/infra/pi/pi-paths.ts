/**
 * Pi 路径解析（env-var-aware，支持实例隔离）
 *
 * 所有路径从 XYZ_AGENT_DATA_DIR 推导。未设置时回退 ~/.xyz-agent/
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

import { homedir } from 'node:os'
import { join } from 'node:path'

export function getConfigDir(): string {
  return process.env.XYZ_AGENT_DATA_DIR ?? join(homedir(), '.xyz-agent')
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
