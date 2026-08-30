/**
 * 升级错误日志落盘（D7）。
 *
 * JSONL 格式，512KB 轮转 x2。五个 source 覆盖：
 * test-proxy / download / install / perform / preload。
 *
 * 形态豁免说明（data-source-registry C-data-11 口径）：本文件是 append-only 诊断
 * 日志（appendFileSync 单向追加 + rename 轮转，无读-改-写），非 C-data-11 针对的
 * 「每域一 JSON 配置文件」RMW 丢失面，不属于 writeFileSync 直写禁令范围。
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

/** 1KB 的字节数。 */
const BYTES_PER_KB = 1024

/** 轮转阈值（KB）。 */
const MAX_LOG_SIZE_KB = 512

/** 轮转阈值：512KB */
const MAX_LOG_SIZE = MAX_LOG_SIZE_KB * BYTES_PER_KB

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
      } catch (err) {
        // best-effort 降级：轮转失败（rename 被占用/权限）不阻断写入——error-log 本身是
        // 诊断日志通道，宁可继续追加原文件（超出轮转阈值），不可因轮转失败丢错误记录
        console.warn('[update-error-log] rotate failed, keep appending to original file:', err)
      }
    }

    const line = JSON.stringify(entry) + '\n'
    appendFileSync(UPDATE_ERROR_LOG, line, 'utf-8')
  } catch (err) {
    // 落盘失败静默跳过，仅 console.error 兜底
    console.error('[update-error-log] failed to write:', err)
  }
}

