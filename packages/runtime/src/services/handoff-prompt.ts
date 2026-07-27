/**
 * Handoff prompt —— agent-driven handoff 的 prompt 构建。
 *
 * 主 session 跑 handoff turn 时发送给 pi 的 prompt 由本文件组装：
 * - HANDOFF_PROMPT_TEMPLATE：基于 ~/.agents/skills/handoff/SKILL.md 改写，
 *   保留全部指令（生成文档 / suggested skills / 不重复 artifact / 脱敏 /
 *   写文件到 temp 目录），改为适合直接作为 prompt 发送的文本。
 * - buildHandoffPrompt：reply 存在时 sanitize 后追加定制后缀。
 * - sanitizeReply：trust boundary 外的 reply 清洗（去 CR/LF + trim + 截断）。
 *
 * 纯函数模块，无副作用，无 import 依赖。
 */

/** reply 截断阈值（来自客户端 payload，trust boundary 外）。 */
export const REPLY_MAX_LENGTH = 5000

/**
 * Handoff turn prompt 模板。
 *
 * 基于 ~/.agents/skills/handoff/SKILL.md 改写：保留 skill 的全部指令
 * （生成文档 / suggested skills / 不重复 artifact / 脱敏 / 写 temp 目录），
 * 改为适合直接作为 prompt 发送给 pi agent 的祈使句文本。
 */
export const HANDOFF_PROMPT_TEMPLATE = `Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save the document to the temporary directory of the user's OS - not the current workspace.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

The handoff document is the only output the next session will receive as its first message, so make it complete and self-contained.`

/**
 * sanitize 客户端传入的 reply（trust boundary 外）。
 * 去换行（CR/LF → 空格）+ 截断 + trim。
 */
export function sanitizeReply(reply: string): string {
  return reply.replace(/[\r\n]/g, ' ').trim().slice(0, REPLY_MAX_LENGTH)
}

/**
 * 构建 handoff turn prompt。
 *
 * reply 存在（非空字符串）时 sanitize 后在末尾追加定制后缀，
 * 告知 agent 下一 session 的关注点；reply 为 undefined / 空串时
 * 返回纯模板。
 */
export function buildHandoffPrompt(reply?: string): string {
  if (!reply) return HANDOFF_PROMPT_TEMPLATE
  const sanitized = sanitizeReply(reply)
  if (!sanitized) return HANDOFF_PROMPT_TEMPLATE
  return `${HANDOFF_PROMPT_TEMPLATE}\n\nThe next session will focus on: ${sanitized}`
}
