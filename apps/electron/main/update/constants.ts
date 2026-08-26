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

/** 升级错误日志路径（JSONL 格式，D7） */
export const UPDATE_ERROR_LOG = path.join(UPDATE_DIR, 'update-error.log')
