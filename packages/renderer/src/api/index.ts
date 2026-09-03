/**
 * API 门面入口 —— 壳层 env 装配（tc-transport-consolidation 终态）。
 *
 * 调用方（composables/features）：`import { session, chat, config, model, extension, plugin, settings } from '@/api'`
 *
 * real 侧直接聚合 @xyz-agent/core/transport/api/domains/* 真源（中间件已下沉 core，
 * 壳不再持有域实现；settings 域的 Electron IPC 5 函数在 ./domains/settings 平台门面，
 * 不在本门面聚合范围）。按 VITE_MOCK 切换：true → core mock（不走 transport）；
 * false → core transport + ws-client。两套实现签名一致（core domains 与 mock/index
 * 同接口，门面三元要求两侧同构）。
 *
 * 三类契约（见 contract.md）：
 * - 请求-响应：session 列表、chat.getHistory、config.listProviders、config.scanSkills / scanAgents
 * - 订阅-推送：model.onModels、config.on[Providers|Skills|Agents|Defaults]、extension.onExtensions、plugin.onPlugins、chat.streamSubscribe
 * - 动作-ack：chat.send、model.switchModel、config.set / delete 系列、extension.toggle
 */
import * as realSession from '@xyz-agent/core/transport/api/domains/session'
import * as realChat from '@xyz-agent/core/transport/api/domains/chat'
import * as realConfig from '@xyz-agent/core/transport/api/domains/config'
import * as realModel from '@xyz-agent/core/transport/api/domains/model'
import * as realExtension from '@xyz-agent/core/transport/api/domains/extension'
import * as realPlugin from '@xyz-agent/core/transport/api/domains/plugin'
import * as realSettings from '@xyz-agent/core/transport/api/domains/settings'
import * as realGit from '@xyz-agent/core/transport/api/domains/git'
import * as realFile from '@xyz-agent/core/transport/api/domains/file'
import * as realComposer from '@xyz-agent/core/transport/api/domains/composer'
import * as realWorkspace from '@xyz-agent/core/transport/api/domains/workspace'
import * as realQuota from '@xyz-agent/core/transport/api/domains/quota'
import * as realPreset from '@xyz-agent/core/transport/api/domains/preset'
import * as realProject from '@xyz-agent/core/transport/api/domains/project'
import * as mockApi from '@xyz-agent/core/transport/mock'

const isMock = import.meta.env.VITE_MOCK === 'true'

// [tc-transport-consolidation] core mock 不读 import.meta.env——VITE_E2E 构建期值在此注入。
// isMock 构建期常量分支包裹：生产构建下整句随死分支 DCE，mock 模块链整体摇除（A7 探针门）。
if (isMock) {
  mockApi.setMockE2E(import.meta.env.VITE_E2E === 'true')
}

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
export const workspace = isMock ? mockApi.workspace : realWorkspace
export const quota = isMock ? mockApi.quota : realQuota
export const project = isMock ? mockApi.project : realProject
// preset：pi 启动预设域（pi-launch-presets wave1）。mock 轨走 mockApi.preset 占位（空列表 + 默认 id），
// real 轨走真实 RPC（preset.list/getDefault/setDefault）。
export const preset = isMock ? mockApi.preset : realPreset
// search（⌘K 全局搜索）编排归 useSearch composable（D-026，#5）：mock 轨走 mockApi.search fixture，
// real 轨走真实 3 源聚合（命令/file/session domain）。本门面不再导出 search（useSearch 内部判 VITE_MOCK）。

// 类型 re-export（供组件 import 类型用）
export type { ModelInfo } from '@xyz-agent/core/transport/api/domains/model'
// [W4] SystemSettings 类型已迁 @xyz-agent/core；此处保留 re-export 路径兼容（消费方主要已改 import core）。
export type { SystemSettings } from '@xyz-agent/core'
// D-028：SearchItem SSOT 归 lib/search-types，门面 re-export 改指领域层（非 mock）
export type { SearchItem } from '@xyz-agent/core'
