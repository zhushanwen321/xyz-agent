/**
 * 升级错误日志落盘（D7）。
 *
 * JSONL 格式，512KB 轮转 x2。五个 source 覆盖：
 * test-proxy / download / install / perform / preload。
 *
 * 落盘失败静默跳过（日志失败不能阻断升级主流程）。
 *
 * 依赖方向：error-log → constants（UPDATE_ERROR_LOG 路径）+ node:fs。
 */
import { existsSync, mkdirSync, statSync, renameSync, appendFileSync } from 'node:fs'
import { UPDATE_ERROR_LOG, UPDATE_DIR } from './constants.js'

/** 单条错误日志条目 */
export interface UpdateErrorEntry {
  /** ISO 8601 时间戳 */
  at: string
  /** 错误来源：test-proxy / download / install / perform / preload */
  source: string
  /** 升级阶段 */
  stage: string
  /** 错误码（可选） */
  errorCode?: string
  /** 最内层原始 cause（可选，落盘诊断用） */
  rawCause?: string
  /** 代理 URL（可选，脱敏后） */
  proxyUrl?: string
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
    mkdirSync(UPDATE_DIR, { recursive: true })

    // 轮转检查
    if (existsSync(UPDATE_ERROR_LOG)) {
      try {
        const stat = statSync(UPDATE_ERROR_LOG)
        if (stat.size >= MAX_LOG_SIZE) {
          const rotatedPath = `${UPDATE_ERROR_LOG}.1`
          // 覆盖旧 .1（如果存在）
          renameSync(UPDATE_ERROR_LOG, rotatedPath)
        }
      } catch {
        // 轮转失败不阻断写入
      }
    }

    const line = JSON.stringify(entry) + '\n'
    appendFileSync(UPDATE_ERROR_LOG, line, 'utf-8')
  } catch (err) {
    // 落盘失败静默跳过，仅 console.error 兜底
    console.error('[update-error-log] failed to write:', err)
  }
}

