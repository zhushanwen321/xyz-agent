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
 *     extensions/                    ← 用户安装的 extension（local/git 副本 + discovery 扫描根）
 *     npm/                           ← npm 安装的 extension（node_modules 平铺布局）
 *     tmp/                           ← extension 安装临时目录（crash 恢复用）
 *     skills/                        ← skill 强制目录（ADR-0020）
 *     agents/                        ← agent 强制目录（ADR-0020）
 *     pi/                            ← xyz-pi 的根目录
 *       agent/                       ← xyz-pi 的 agent 目录（PI_CODING_AGENT_DIR）
 *         models.json / settings.json / disabled-packages.json
 *       sessions/                    ← Session jsonl 文件
 *
 * 注意：extensions/npm/tmp 原在 pi/agent/ 下，已迁出到 dataDir 根层（与 skills/agents 对齐）。
 * pi/agent/ 只保留 pi 原生配置文件（settings.json / models.json / disabled-packages.json 等），
 * 这些是 pi 进程直接读取的配置，不应迁出。
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

/**
 * 用户安装的 extension 目录（`<dataDir>/extensions`）。
 *
 * local/git 安装的 extension 副本存放于此；也是 discovery.json 可选目录的强制基址
 * （与 skill/agent 的 `<dataDir>/skills` 强制目录对齐，ADR-0020）。
 *
 * 注意：原在 `<piAgentDir>/extensions/`，已迁出到 dataDir 根层。
 *
 * @param env 可选 env 注入（测试用）；缺省读 process.env
 */
export function getExtensionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(env), 'extensions')
}

/**
 * npm 安装的 extension 目录（`<dataDir>/npm`）。
 *
 * extension 经 npm install 到此目录的 node_modules/ 下（平铺布局）。
 * settings.json.packages[] 的包名 → `<getNpmDir()>/node_modules/<pkgName>` 定位。
 *
 * 注意：原在 `<piAgentDir>/npm/`，已迁出到 dataDir 根层。
 *
 * @param env 可选 env 注入（测试用）；缺省读 process.env
 */
export function getNpmDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(env), 'npm')
}

/**
 * extension 安装临时目录（`<dataDir>/tmp`）。
 *
 * 多步安装流（installDir/installGit）的暂存区，crash 后由 cleanupOrphanedTempDirs 清理。
 *
 * 注意：原在 `<piAgentDir>/tmp/`，已随 extensions/npm 一起迁出到 dataDir 根层。
 *
 * @param env 可选 env 注入（测试用）；缺省读 process.env
 */
export function getTmpDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(env), 'tmp')
}
