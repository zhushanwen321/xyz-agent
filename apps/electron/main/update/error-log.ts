/**
 * 升级错误日志落盘工具（D7）。
 *
 * appendUpdateError 将错误信息以 JSONL 格式追加到 update-error.log。
 * 轮转策略：超 512KB 重命名为 .log.1（覆盖旧 .1），最多两份。
 *
 * [HISTORICAL] 设计决策：
 * - 五处落盘点：testProxyConnection / download / install / perform / preload
 * - 落盘失败静默跳过——日志失败不能阻断升级主流程
 * - rawCause 来自 UpdateError.rawCause（D1 的 net-errors 包装构造时注入）
 * - proxyUrl 由 append 侧现取（文件读，成本可忽略）
 *
 * 依赖方向：error-log → constants（UPDATE_ERROR_LOG）+ node:fs + node:path
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { UPDATE_ERROR_LOG } from './constants.js'

/** 单条错误日志条目 */
export interface UpdateErrorEntry {
  /** ISO 8601 时间戳 */
  at: string
  /** 错误来源 */
  source: 'test-proxy' | 'download' | 'install' | 'perform' | 'preload'
  /** 升级阶段 */
  stage: string
  /** 错误码 */
  errorCode?: string
  /** 原始错误 cause（从 UpdateError.rawCause 取得） */
  rawCause?: string
  /** 代理 URL（可选，由 append 侧 resolveProxyUrl 取得） */
  proxyUrl?: string
}

/** 轮转阈值：512KB */
const MAX_LOG_SIZE = 512 * 1024

/**
 * 追加一条错误日志到 update-error.log（JSONL 格式）。
 *
 * 落盘失败静默跳过——日志失败不能阻断升级主流程，只 console.error 兜底。
 *
 * @param entry 错误日志条目
 */
export function appendUpdateError(entry: UpdateErrorEntry): void {
  try {
    ensureLogDir()
    maybeRotate()
    const line = JSON.stringify(entry) + '\n'
    // 使用 appendFileSync 保证原子追加
    const fs = require('node:fs') as typeof import('node:fs')
    fs.appendFileSync(UPDATE_ERROR_LOG, line, 'utf-8')
  } catch (err) {
    // 落盘失败静默跳过——日志失败不能阻断升级主流程
    console.error('[update-error-log] failed to append:', err)
  }
}

/**
 * 确保日志目录存在。
 */
function ensureLogDir(): void {
  const dir = dirname(UPDATE_ERROR_LOG)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * 轮转检查：超 MAX_LOG_SIZE 重命名为 .log.1（覆盖旧 .1）。
 */
function maybeRotate(): void {
  if (!existsSync(UPDATE_ERROR_LOG)) return

  try {
    const stat = statSync(UPDATE_ERROR_LOG)
    if (stat.size <= MAX_LOG_SIZE) return

    const rotated = `${UPDATE_ERROR_LOG}.1`
    // 覆盖旧 .1（renameSync 原子覆盖）
    renameSync(UPDATE_ERROR_LOG, rotated)
    // 新文件由后续 appendFileSync 自动创建
  } catch {
    // 轮转失败不影响追加——继续写入当前文件
  }
}

/**
 * 读取日志文件内容（测试用）。
 *
 * 返回行数组（每行是 JSON 字符串），文件不存在返回空数组。
 * 仅供测试验证，不暴露为公开 API。
 */
export function _readLogForTest(): string[] {
  if (!existsSync(UPDATE_ERROR_LOG)) return []
  return readFileSync(UPDATE_ERROR_LOG, 'utf-8').split('\n').filter(Boolean)
}
