/**
 * API 门面入口（R4）—— 聚合 domains，对外统一接口。
 *
 * 调用方（composables/features）：`import { session, chat } from '@/api'`
 *
 * 按 VITE_MOCK 切换：true → 内存 mock（D2，不走 transport）；false → transport + ws-client。
 * 两套实现签名一致（domains 与 mock/index 同接口）。
 */
import * as realSession from './domains/session'
import * as realChat from './domains/chat'
import * as realSettings from './domains/settings'
import * as mockApi from './mock'

const isMock = import.meta.env.VITE_MOCK === 'true'

export const session = isMock ? mockApi.session : realSession
export const chat = isMock ? mockApi.chat : realChat
export const settings = isMock ? mockApi.settings : realSettings
