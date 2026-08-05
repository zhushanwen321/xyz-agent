/**
 * companion-band-source.ts —— CompanionBand 的依赖注入契约（W2 · T1，clarify Q1）。
 *
 * CompanionBand 内部消费 W1 交付的 createDialogRequestQueue(transport, sessionIdRef, source)
 * 三参数工厂，本文件定义其 transport / source 的 provide/inject 键（对齐 W3/W4 先例：
 * status-bar-source.ts / view-host-source.ts 的注入模式）。
 *
 * 壳（P5）provide 真实实现：
 *  - DialogRequestSource：把 S2 MessageBusBridge 的 InternalEventBus.on('ui-request')
 *    / WS extension.ui_timeout 适配成 W1 定义的事件源接口；
 *  - UiResponseTransport：转发 extension.ui_response（pi 源）/ plugin.uiResponse（plugin 源）。
 *
 * 单测 global.provide mock；未注入时组件静默空态不崩（design-review R3）。
 */
import type { InjectionKey } from 'vue'
import type { DialogRequestSource, UiResponseTransport } from './dialog-request-queue'

/** dialog 请求事件源（S2 bridge 适配入口）。 */
export const DIALOG_REQUEST_SOURCE_KEY: InjectionKey<DialogRequestSource> = Symbol('dialog-request-source')

/** dialog 响应回传通道（pi 源 sendPiResponse / plugin 源 sendPluginResponse）。 */
export const UI_RESPONSE_TRANSPORT_KEY: InjectionKey<UiResponseTransport> = Symbol('ui-response-transport')

export type { DialogRequest, DialogRequestOption, DialogRequestSource, UiResponseTransport } from './dialog-request-queue'
