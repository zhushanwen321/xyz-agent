export const UI_PACKAGE_NAME = '@xyz-agent/ui'

// ── shadcn-vue 原语（W6 从 renderer components/ui 迁入 message-stream 消费子集）──
export * from './primitives'

// ── features/chat（w6 chat-ui-and-shell：chat 域展示组件 + ChatView 薄壳 + deps token）──
export * from './features/chat'

// RenderingProtocol 层的公共面（GuiComponentRenderer / AnsiText / 注册表机制）经
// `@xyz-agent/ui/rendering-protocol` 子路径暴露。7 原语是 RenderingProtocol 内部
// 实现细节，不经顶层导出（AC4：原语不经顶层暴露，消费方走 ./rendering-protocol 子路径）。
