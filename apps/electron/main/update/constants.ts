/**
 * 自动升级后端常量（路径 SSOT）。
 *
 * 对应 slice auto-update-and-install w3：所有升级相关文件统一落在
 * `<dataDir>/update/` 目录下，跨进程（main + detached updater 脚本 + self-healer）
 * 共享同一路径源。
 *
 * [HISTORICAL] 不变量：
 * - 所有路径基于 getDataDir()（读 XYZ_AGENT_DATA_DIR，dev 模式隔离到 ~/.xyz-agent-dev）
 * - update-result.json 是升级流程的跨进程状态 SSOT（status:
 *   replacing|done|failed|rolled-back|no-op，其中 no-op 由 self-healer 在
 *   "中断但无 .old 备份"时写入，表示未做回滚动作）
 * - updater.sh / updater-linux.sh 由 platform-updater 在每次升级时覆写（含 sha256/版本）
 *
 * 依赖方向：constants → @xyz-agent/shared/paths + node:path
 */
import path from 'node:path'
import { getDataDir } from '@xyz-agent/shared/paths'

/** 升级工作根目录：`<dataDir>/update` */
export const UPDATE_DIR = path.join(getDataDir(), 'update')

/** 升级结果状态文件（跨进程 SSOT） */
export const UPDATE_RESULT_FILE = path.join(UPDATE_DIR, 'update-result.json')

/** 升级提醒持久化标志文件（检测到新版时写，启动时读以恢复「可升级」提醒）。 */
export const PENDING_UPDATE_FILE = path.join(UPDATE_DIR, 'pending-update.json')

/** 预下载产物元信息文件（后台下载完成后写，点击更新时读以跳过重复下载）。 */
export const PRELOADED_UPDATE_FILE = path.join(UPDATE_DIR, 'preloaded-update.json')

/** 升级设置文件（如预下载开关）。 */
export const UPDATE_SETTINGS_FILE = path.join(UPDATE_DIR, 'update-settings.json')

/** mac 升级 detached bash 脚本路径 */
export const UPDATER_SCRIPT_PATH = path.join(UPDATE_DIR, 'updater.sh')

/** linux AppImage 升级 detached bash 脚本路径 */
export const LINUX_UPDATER_SCRIPT_PATH = path.join(UPDATE_DIR, 'updater-linux.sh')

/** mac 升级日志路径 */
export const UPDATER_LOG_PATH = path.join(UPDATE_DIR, 'updater.log')

/** linux 升级日志路径 */
export const LINUX_UPDATER_LOG_PATH = path.join(UPDATE_DIR, 'updater-linux.log')

/** win wrapper cmd 脚本路径（批次 2；与 mac/linux 脚本同入清理矩阵） */
export const WIN_UPDATER_SCRIPT_PATH = path.join(UPDATE_DIR, 'updater.cmd')

/** win wrapper 日志路径（批次 2；与 mac/linux 日志同入 m14 归档/删除策略） */
export const WIN_UPDATER_LOG_PATH = path.join(UPDATE_DIR, 'updater-win.log')

/** 升级错误日志路径（JSONL 格式，D7） */
export const UPDATE_ERROR_LOG = path.join(UPDATE_DIR, 'update-error.log')

/**
 * 升级脚本 PID 文件（批次 5 互斥 §3.7.1）。
 *
 * 读写两端共用此常量，避免路径双写漂移：
 * - 写侧：mac/linux 由 updater 脚本模板自写 `$$`（`$(dirname "{{RESULT_PATH}}")/updater.pid`，
 *   与 UPDATE_DIR 同目录）；win 由 platform-updater 在 spawn 后写 `child.pid`（#13）
 * - 读侧：update-self-healer 的存活探测（含 PID 复用加固与死 PID 自愈清理）
 *
 * [HISTORICAL] 写侧分散在 shell 模板与 TS 两处，但路径必须唯一——此前 mac 模板按
 * `dirname(RESULT_PATH)` 推导、self-healer 按 UPDATE_DIR 推导，两者恰好等价
 * （UPDATE_RESULT_FILE = UPDATE_DIR/update-result.json），抽出常量把这个巧合固化。
 */
export const UPDATER_PID_FILE = path.join(UPDATE_DIR, 'updater.pid')
