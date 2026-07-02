/**
 * 跨进程数据目录路径解析（main + runtime 共用，ADR-0009 隔离）。
 *
 * 单一真值源：所有 `~/.xyz-agent` / `pi/agent` 路径推导集中于此，
 * main 与 runtime 均 import 使用，禁止各自硬编码（实例隔离后路径可能是
 * `~/.xyz-agent-dev`，硬编码会导致 dev/prod 实例互相串数据）。
 *
 * ADR-0009 隔离约束：xyz-agent 数据目录（`~/.xyz-agent/`）与 pi 自身的
 * 数据目录（`~/.pi/agent/`）完全隔离。本模块只解析 xyz-agent 自己的目录，
 * getPiAgentDir 返回 `<dataDir>/pi/agent`（xyz-agent 内嵌的 pi agent 目录），
 * 不是系统 pi 的 `~/.pi/agent`。
 *
 * 目录结构：
 *   ~/.xyz-agent/                    ← xyz-agent 配置根目录（XYZ_AGENT_DATA_DIR 可覆盖）
 *     config.json                    ← xyz-agent 自身配置
 *     runtime.port                   ← runtime 监听端口文件
 *     pi/                            ← xyz-pi 的根目录
 *       agent/                       ← xyz-pi 的 agent 目录（PI_CODING_AGENT_DIR）
 *         models.json / settings.json / agents/ / extensions/ / skills/
 *       sessions/                    ← Session jsonl 文件
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * xyz-agent 数据根目录。
 * 读 XYZ_AGENT_DATA_DIR 环境变量，缺省 `~/.xyz-agent`。
 *
 * @param env 可选 env 注入（测试用）；缺省读 process.env
 */
export function getDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.XYZ_AGENT_DATA_DIR ?? join(homedir(), '.xyz-agent')
}

/**
 * xyz-agent 内嵌的 pi agent 目录（PI_CODING_AGENT_DIR）。
 * 即 `<dataDir>/pi/agent`，**不是**系统 pi 的 `~/.pi/agent`（ADR-0009 隔离）。
 *
 * @param env 可选 env 注入（测试用）；缺省读 process.env
 */
export function getPiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(env), 'pi', 'agent')
}
