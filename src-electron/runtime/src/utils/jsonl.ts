/**
 * JSONL 解析工具（G2）。
 *
 * 统一散落各处的「逐行 JSON.parse + 跳过空行/畸形行」循环：
 * - infra/pi/session-file-utils.extractSessionName（原倒序找首条匹配）
 * - services/session-history.loadHistory（原正序 filter + 收集）
 *
 * 共性骨架：split 行 → 跳空行 → JSON.parse → 失败静默跳过 → 成功 yield。
 * 各消费方对返回的 entries 再做自己的领域过滤（type 判定 / 取字段等）。
 */

/**
 * 把 JSONL 文本解析成成功解析的条目数组（按行序，跳过空行与畸形行）。
 *
 * 等价于：
 * ```ts
 * raw.split('\n')
 *   .map(l => l.trim())
 *   .filter(Boolean)
 *   .flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
 * ```
 * 但显式循环更可读、不产生中间数组。
 *
 * @param raw JSONL 文本（各行 JSON 对象，以 \n 分隔）
 * @returns 成功解析的条目（unknown[]；消费方自行收窄类型 + 过滤）
 */
export function parseJsonl(raw: string): unknown[] {
  const entries: unknown[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed))
    // eslint-disable-next-line taste/no-silent-catch -- JSONL: skip malformed line, keep parsing
    } catch {
      // skip malformed line
    }
  }
  return entries
}
