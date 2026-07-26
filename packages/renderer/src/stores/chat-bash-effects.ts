/**
 * Bash 执行相关 message effect（composer-bash-execute W3）。
 *
 * 从 chat-message-effects.ts 巨石提取（超 500 行 ESLint max-lines）。
 *
 * - message.bashStart：创建 loading 态 system 消息（status='streaming'），承载 command + excludeFromContext。
 * - message.bashResult：锢定唯一的 streaming bash 消息，更新为 complete 态（runtime isBashRunning
 *   互斥保证同时只有一个 streaming bash）。
 *
 * 与 toolCall 互斥（bash 不走工具链，不挂 assistant turn，作独立 system 消息穿插渲染）。
 */
// type-only import：编译期擦除，不构成运行时循环依赖（主文件 runtime import 本文件的 handler 值）
import type { Message, ServerMessage } from '@xyz-agent/shared'
import type { MessageEffectContext, MessageEffectHandler } from './chat-message-effects'
import { readString, readNumber, readBool } from './chat-readers'
import { commitMessages } from './chat-mutations'

/** payload 读取用宽松 record（与主文件其他 effect 一致，readers 安全窄化） */
type Payload = Record<string, unknown>

/**
 * message.bashStart：append 一条 streaming 态 system 消息，承载 command + excludeFromContext。
 * bashResult 到达后锢定该消息（status==='streaming' + bashExecution）更新为 complete。
 */
export const bashStartEffect: MessageEffectHandler = (ctx: MessageEffectContext, sid: string, payload: Payload) => {
  const { messages } = ctx
  const command = readString(payload, 'command') ?? ''
  const excludeFromContext = readBool(payload, 'excludeFromContext') ?? false
  const timestamp = readNumber(payload, 'timestamp') ?? Date.now()
  const prev = messages.value.get(sid) ?? []
  const bashMsg: Message = {
    id: `bash-${crypto.randomUUID()}`,
    role: 'system',
    content: '',
    status: 'streaming',
    bashExecution: { command, output: '', exitCode: null, cancelled: false, truncated: false, excludeFromContext, timestamp },
    timestamp: Date.now(),
  } as Message
  commitMessages(messages, sid, [...prev, bashMsg])
}

/**
 * message.bashResult：锢定唯一的 streaming bash 消息，更新为 complete 态。
 * abortBash 路径复用此 effect（cancelled=true 自动处理，无独立 abort effect）。
 */
export const bashResultEffect: MessageEffectHandler = (ctx: MessageEffectContext, sid: string, payload: Payload) => {
  const { messages } = ctx
  const prev = messages.value.get(sid) ?? []
  let changed = false
  const next = prev.map((m) => {
    if (m.bashExecution && m.status === 'streaming') {
      changed = true
      return {
        ...m,
        status: 'complete' as const,
        bashExecution: {
          ...m.bashExecution,
          output: readString(payload, 'output') ?? '',
          exitCode: readNumber(payload, 'exitCode') ?? null,
          cancelled: readBool(payload, 'cancelled'),
          truncated: readBool(payload, 'truncated'),
        },
      }
    }
    return m
  })
  if (changed) commitMessages(messages, sid, next)
}

/** 供 messageEffects 表展开的类型化入口 */
export const bashEffects: Partial<Record<ServerMessage['type'], MessageEffectHandler>> = {
  'message.bashStart': bashStartEffect,
  'message.bashResult': bashResultEffect,
}
