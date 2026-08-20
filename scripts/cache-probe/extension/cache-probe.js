/**
 * cache-probe.js — pi file-type extension（前缀稳定性数据收集探针）.
 *
 * 设计文档：docs/todo/cache-probe-design.md（§7.1 实现机制，含 §11 检查点 5
 * 的 spFull 口径升级：从 before_provider_request 的最终请求体提取）。
 *
 * 记录 9 个指纹 hash，变化时才向 session JSONL 写 custom entry（customType
 * = "cache-probe"）。custom entry 不进 LLM 上下文，探针零行为影响：
 *  - before_agent_start（每 turn 1 次）：算 7 个输入侧 hash 暂存 pending
 *    （systemPromptOptions 各字段 + getAllTools 注册表）
 *  - before_provider_request（每笔 LLM 请求，仅消费 turn 首笔）：从最终
 *    payload 提取 spFull（system 消息）与 toolsSent（tools 数组），与 pending
 *    合并对比，变化/基线时 appendEntry
 *  - agent_end：turn 内无 provider 请求则丢弃 pending（无请求即无归因价值）
 *
 * 写入时机选在 turn 首笔 provider 请求而非 before_agent_start，是为了让
 * spFull/toolsSent 是「LLM 实际收到的前缀」——链上其他 extension 的修改已被
 * 应用，消除 before_agent_start 链头视角盲区（设计文档 §7.1）。
 *
 * seq = 进程内 before_agent_start 触发计数（无论是否写 entry 都递增），
 * 脚本靠 seq 跳跃区分「无变化 turn」与「漏记」。
 *
 * Fail-safe：handler 全程捕获，异常时写 error entry（缺口可见非静默）并
 * 重置为需基线状态；appendEntry 本身失败时仅 stderr 诊断，绝不阻塞请求。
 */

import { createHash } from 'node:crypto'

const CUSTOM_TYPE = 'cache-probe'

/** 递归 sort keys 的稳定序列化（undefined 归一为 null，防 key 顺序抖动产生假变化）。 */
function stableStringify(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

function hashOf(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

/** 从 provider payload 提取 system 内容。OpenAI 兼容在 messages 内（role 为 system 或
 *  developer——pi 源码 openai-completions.ts:1176 的 useDeveloperRole 分支），Anthropic 在顶层 system。 */
function extractSystem(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (Array.isArray(payload.system)) return payload.system
  if (Array.isArray(payload.messages)) {
    const sys = payload.messages.filter((m) => m && (m.role === 'system' || m.role === 'developer'))
    if (sys.length > 0) return sys
  }
  return null
}

function stderr(msg) {
  try {
    process.stderr.write(`[cache-probe] ${msg}\n`)
  } catch {
    /* stderr 写失败也忽略 */
  }
}

export default function (pi) {
  let seq = 0
  let needsBaseline = true // 初始 true 兜底 extension 加载晚于 session_start 的情况
  let startReason = null
  let lastHashes = null
  let pending = null // { parts: 7 个输入侧 hash, cwd }，由 before_agent_start 产生、provider 首笔消费

  pi.on('session_start', (event) => {
    needsBaseline = true
    startReason = event?.reason ?? null
    lastHashes = null
    pending = null
  })

  pi.on('before_agent_start', (event) => {
    seq += 1
    try {
      const o = event?.systemPromptOptions ?? {}
      pending = {
        cwd: o.cwd ?? null,
        parts: {
          contextFiles: hashOf(o.contextFiles ?? null),
          skills: hashOf(o.skills ?? null),
          toolsList: hashOf([o.selectedTools ?? null, o.toolSnippets ?? null]),
          append: hashOf(o.appendSystemPrompt ?? null),
          guidelines: hashOf(o.promptGuidelines ?? null),
          customPrompt: hashOf(o.customPrompt ?? null),
          toolsReg: hashOf(
            (pi.getAllTools?.() ?? []).map((t) => ({
              name: t?.name ?? null,
              description: t?.description ?? null,
              parameters: t?.parameters ?? null,
              promptGuidelines: t?.promptGuidelines ?? null,
            })),
          ),
        },
      }
    } catch (err) {
      stderr(`before_agent_start failed: ${err instanceof Error ? err.message : String(err)}`)
      pending = null
      try {
        pi.appendEntry(CUSTOM_TYPE, { seq, error: String(err instanceof Error ? err.message : err) })
      } catch {
        /* appendEntry 失败已 stderr 记录 */
      }
      needsBaseline = true
    }
  })

  pi.on('before_provider_request', (event) => {
    if (!pending) return // turn 首笔已被消费，或本 turn 无 before_agent_start 上下文
    const { cwd, parts } = pending
    pending = null
    try {
      const payload = event?.payload
      const system = extractSystem(payload)
      const hashes = {
        ...parts,
        spFull: system === null ? 'no-system' : hashOf(system),
        toolsSent: Array.isArray(payload?.tools) ? hashOf(payload.tools) : 'no-tools',
      }
      if (needsBaseline) {
        pi.appendEntry(CUSTOM_TYPE, { seq, baseline: true, startReason, changed: ['*'], cwd, hashes })
      } else {
        const changed = Object.keys(hashes).filter((k) => lastHashes?.[k] !== hashes[k])
        if (changed.length > 0) {
          pi.appendEntry(CUSTOM_TYPE, { seq, baseline: false, changed, cwd, hashes })
        }
      }
      lastHashes = hashes
      needsBaseline = false
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      stderr(`before_provider_request failed: ${msg}`)
      try {
        pi.appendEntry(CUSTOM_TYPE, { seq, error: msg })
      } catch {
        /* appendEntry 失败已 stderr 记录 */
      }
      needsBaseline = true
    }
  })

  // turn 内没有任何 provider 请求（用户取消等）则丢弃 pending，防跨 turn 污染
  pi.on('agent_end', () => {
    pending = null
  })
}
