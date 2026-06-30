/**
 * API 门面入口 —— 聚合 domains，对外统一接口。
 *
 * 调用方（composables/features）：`import { session, chat, config, model, extension, plugin, settings } from '@/api'`
 *
 * 按 VITE_MOCK 切换：true → 内在 mock（不走 transport）；false → transport + ws-client。
 * 两套实现签名一致（domains 与 mock/index 同接口，门面三元要求两侧同构）。
 *
 * 三类契约（见 contract.md）：
 * - 请求-响应：session 列表、chat.getHistory、config.listProviders、config.scanSkills / scanAgents
 * - 订阅-推送：model.onModels、config.on[Providers|Skills|Agents|Defaults]、extension.onExtensions、plugin.onPlugins、chat.streamSubscribe
 * - 动作-ack：chat.send、model.switchModel、config.set / delete 系列、extension.toggle
 */
import * as realSession from './domains/session'
import * as realChat from './domains/chat'
import * as realConfig from './domains/config'
import * as realModel from './domains/model'
import * as realExtension from './domains/extension'
import * as realPlugin from './domains/plugin'
import * as realSettings from './domains/settings'
import * as realGit from './domains/git'
import * as realFile from './domains/file'
import * as realComposer from './domains/composer'
import * as mockApi from './mock'

const isMock = import.meta.env.VITE_MOCK === 'true'

export const session = isMock ? mockApi.session : realSession
export const chat = isMock ? mockApi.chat : realChat
export const config = isMock ? mockApi.config : realConfig
export const model = isMock ? mockApi.model : realModel
export const extension = isMock ? mockApi.extension : realExtension
export const plugin = isMock ? mockApi.plugin : realPlugin
export const settings = isMock ? mockApi.settings : realSettings
export const git = isMock ? mockApi.git : realGit
export const file = isMock ? mockApi.file : realFile

// composer：`#` 文件候选已接 real domain（file.search）；`@` 候选 real 返回空（已废弃）。
// mock 模式仍走 mockApi.composer（fixture 演示）。
export const composer = isMock ? mockApi.composer : realComposer
// search（⌘K 全局搜索）暂无 real domain，始终走 mock
export const search = mockApi.search

// 类型 re-export（供组件 import 类型用）
export type { ModelInfo } from './domains/model'
export type { SystemSettings } from './domains/settings'
export type { SearchItem } from './mock/search-data'
