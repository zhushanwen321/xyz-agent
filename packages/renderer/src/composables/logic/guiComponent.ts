/**
 * 结构化 GUI 组件提取纯逻辑（extension GUI 协议 E5）。
 *
 * extension 经 customStart / tool RPC 把结构化组件放进 details.__gui__，
 * 渲染层用 extractGui 解析 → 交 GuiComponentRenderer 渲染；无 __gui__ 返回 undefined
 * 由调用方落回纯文本兜底。封装为共享纯函数，消除多处内联 extractGui(...)?.component 重复。
 */
import { extractGui } from '@xyz-agent/extension-protocol'
import type { GuiComponent } from '@xyz-agent/extension-protocol'
import type { Message } from '@xyz-agent/shared'

/**
 * 从消息 details.__gui__ 提取结构化渲染组件。
 * 无 __gui__ 时返回 undefined（由模板落回 SystemNotice / ToolText 纯文本兜底）。
 */
export function extractGuiComponent(message: Message): GuiComponent | undefined {
  return extractGui(message.details)?.component
}
