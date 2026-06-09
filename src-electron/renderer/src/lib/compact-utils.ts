/**
 * MergeBlock / StandaloneToolCard 共享工具函数
 */

// ── Time formatting ──

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MS_MIN_DISPLAY = 100 // Below this, show "<0.1s" to avoid "0.0s" noise

/** 格式化毫秒耗时为人类可读字符串 */
export function formatTime(ms: number): string {
  if (ms < MS_MIN_DISPLAY) return '<0.1s'
  if (ms < MS_PER_SECOND) return `${(ms / MS_PER_SECOND).toFixed(1)}s`
  const s = ms / MS_PER_SECOND
  if (s < SECONDS_PER_MINUTE) return `${s.toFixed(1)}s`
  const m = Math.floor(s / SECONDS_PER_MINUTE)
  const sec = Math.floor(s % SECONDS_PER_MINUTE)
  return `${m}m${sec}s`
}

// ── Tool input path extraction ──

const PATH_MAX_LEN = 40

interface ToolInputWithPath {
  path?: unknown
  file_path?: unknown
  command?: unknown
  /** subagent/extension 任务描述 */
  task?: unknown
  /** 子 agent 名称（如 'general-purpose'） */
  agent?: unknown
}

/** 从 tool call input 中提取短路径表示 */
export function toolPath(input: unknown, maxLen = PATH_MAX_LEN): string {
  try {
    const obj: unknown = typeof input === 'string' ? JSON.parse(input) : input
    if (obj && typeof obj === 'object') {
      const rec = obj as ToolInputWithPath

      // Subagent / extension: show task description
      if (typeof rec.task === 'string' && rec.task) {
        const prefix = typeof rec.agent === 'string' ? `${rec.agent}: ` : ''
        const text = prefix + rec.task
        return text.length > maxLen ? text.slice(0, maxLen) + '...' : text
      }

      const p = rec.path ?? rec.file_path ?? rec.command
      if (typeof p === 'string' && p) return p
    }
  // eslint-disable-next-line taste/no-silent-catch -- 优雅降级：解析失败时返回原始输入截断
  } catch (e) {
    console.warn('[compact-utils] toolPath parse error:', e)
  }
  return ''
}
