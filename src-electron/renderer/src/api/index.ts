/**
 * API 门面入口（R4）—— 聚合 domains，对外统一接口。
 *
 * 调用方（composables/features）：`import { session, chat } from '@/api'`
 *
 * 骨架阶段：re-export domain namespace。实现阶段按需替换为 mock 门面注入。
 */
import * as session from './domains/session'
import * as chat from './domains/chat'

export { session, chat }
