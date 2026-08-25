/**
 * format-utils.ts —— trace 块耗时格式化 + header 摘要截短。
 *
 * W2: formatDuration（从 Block.vue / BlockSubagent.vue 抽出，DRY）。
 * W3: shortenForHeader（bash 折叠头路径截短）+ tailLines（末行截取）。
 *
 * 接受 unknown（meta 字段 / progress 快照字段类型宽松），非数字返回空串。
 */

/** 时长格式化阈值 */
export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60000

/** 格式化时长（ms→s/min）。接受 unknown（meta 字段 / progress 快照字段类型宽松） */
export function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  if (ms >= MS_PER_MINUTE) return `${(ms / MS_PER_MINUTE).toFixed(1)}min`
  if (ms >= MS_PER_SECOND) return `${(ms / MS_PER_SECOND).toFixed(0)}s`
  return `${ms}ms`
}

/**
 * 路径截短——折叠头摘要展示（W3 D3）。
 *
 * 规则：
 * ① text 中所有 opts.home 前缀路径段 → `~`（home 缺省跳过）。
 * ② ≥3 段绝对路径（/a/b/c 形态）→ `…/` + 末两段（父目录+末段）。
 * ③ 其余不动（相对路径、两段绝对路径等）。
 *
 * URL 分段口径：scheme+host（如 `https://example.com`）不计入路径段；
 * 实现：预处理将 `://` URL 的 scheme+host 替换为占位符，路径截短后还原。
 * lookbehind `(?<![a-zA-Z0-9_])` 排除字母/数字/下划线后的 `/`（如 `cd /` 的 `d`），
 * 允许空格/引号后的 `/`。
 * 引号内路径同样生效（按字符位置匹配，不解析引号语义）。
 */
export function shortenForHeader(text: string, opts?: { home?: string }): string {
  if (!text) return ''
  let result: string = text

  // ① home 前缀替换
  const home = opts?.home
  if (home) {
    const hp = home.endsWith('/') ? home : home + '/'
    const idx = result.indexOf(hp)
    if (idx !== -1) {
      const before = result.slice(0, idx)
      const after = result.slice(idx + hp.length)
      // before 以 / 结尾（如 `cd /Users/z`）→ 退化为 ~/…
      result = (before.endsWith('/') ? before.slice(0, -1) : before) + '~/' + after
    }
  }

  // ② ≥3 段绝对路径截短（lookbehind 排除字母/数字/下划线后的 /，允许空格/引号后的 /）
  // 预处理：URL（://）scheme+host 占位保护，避免 example.com 被当作路径段
  const urlPlaceholders: string[] = []
  result = result.replace(/\w+:\/\/[^\s"']*/g, (url) => {
    const idx = urlPlaceholders.length
    urlPlaceholders.push(url)
    return `\u0000URL${idx}\u0000`
  })

  result = result.replace(
    /(?<![a-zA-Z0-9_])(\/(?:[^/\s"']+\/){2,})([^/\s"']+)(?=[\s"']|$)/g,
    (_match: string, prefix: string, last: string) => {
      const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
      const lastSlash = trimmed.lastIndexOf('/')
      const parent = trimmed.slice(lastSlash + 1)
      return `\u2026/${parent}/${last}`
    },
  )

  // 还原 URL 占位符
  result = result.replace(/\u0000URL(\d+)\u0000/g, (_m, idx) => urlPlaceholders[Number(idx)])

  return result
}

/**
 * 取末 n 行（W3）。
 */
export function tailLines(text: string, n: number): string[] {
  if (!text) return []
  const lines = text.split('\n')
  return lines.length <= n ? lines : lines.slice(-n)
}
