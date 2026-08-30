/**
 * 升级错误日志落盘（D7）。
 *
 * JSONL 格式，512KB 轮转 x2。七个 source 覆盖：
 * test-proxy / download / install / perform / preload /
 * engine-fallback / manual-claim（D8：前者为单引擎失败被另一引擎兜住的
 * 降级点落盘，后者为手动认领校验失败落盘）。
 *
 * 形态豁免说明（data-source-registry C-data-11 口径）：本文件是 append-only 诊断
 * 日志（appendFileSync 单向追加 + rename 轮转，无读-改-写），非 C-data-11 针对的
 * 「每域一 JSON 配置文件」RMW 丢失面，不属于 writeFileSync 直写禁令范围。
 *
 * 落盘失败静默跳过（日志失败不能阻断升级主流程）。
 *
 * 依赖方向：error-log → constants（getUpdateErrorLog 路径）+ node:fs。
 */
import { existsSync, mkdirSync, statSync, renameSync, appendFileSync } from 'node:fs'
import { getUpdateDir, getUpdateErrorLog } from './constants.js'

/** 单条错误日志条目 */
export interface UpdateErrorEntry {
  /** ISO 8601 时间戳 */
  at: string
  /**
   * 错误来源：test-proxy / download / install / perform / preload /
   * engine-fallback（单引擎失败被另一引擎兜住时在降级发生点落盘，D8）/
   * manual-claim（手动认领 size/sha256 校验失败落盘，D2）
   */
  source: string
  /** 升级阶段 */
  stage: string
  /** 错误码（可选） */
  errorCode?: string
  /** 最内层原始 cause（可选，落盘诊断用） */
  rawCause?: string
  /** 代理 URL（可选，脱敏后） */
  proxyUrl?: string
  /**
   * 失败引擎（可选，D8 诊断字段，不入 shared 枚举）：降级落盘时为失败引擎；
   * 双引擎均失败时落 undici——对用户的错误分类以 undici 侧 errno 为准
   * （curl exit code 无 errno 级区分，见 D8）。
   */
  engine?: 'undici' | 'curl'
}

/** 轮转阈值：512KB */
const MAX_LOG_SIZE = 512 * 1024

/**
 * 追加一条错误日志到 update-error.log。
 *
 * 轮转策略：超 MAX_LOG_SIZE 时重命名为 .log.1（覆盖旧 .1），最多两份。
 * 落盘失败静默跳过（console.error 兜底，不阻断主流程）。
 */
export function appendUpdateError(entry: UpdateErrorEntry): void {
  try {
    mkdirSync(getUpdateDir(), { recursive: true })

    // 轮转检查（每次调用现取路径：env 可能在模块加载后才注入，见 constants.ts）
    const errorLogPath = getUpdateErrorLog()
    if (existsSync(errorLogPath)) {
      try {
        const stat = statSync(errorLogPath)
        if (stat.size >= MAX_LOG_SIZE) {
          const rotatedPath = `${errorLogPath}.1`
          // 覆盖旧 .1（如果存在）
          renameSync(errorLogPath, rotatedPath)
        }
      } catch {
        // 轮转失败不阻断写入
      }
    }

    const line = JSON.stringify(entry) + '\n'
    appendFileSync(errorLogPath, line, 'utf-8')
  } catch (err) {
    // 落盘失败静默跳过，仅 console.error 兜底
    console.error('[update-error-log] failed to write:', err)
  }
}

