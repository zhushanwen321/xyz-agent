export const UI_PACKAGE_NAME = '@xyz-agent/ui'

// RenderingProtocol 层的公共面（GuiComponentRenderer / AnsiText / 注册表机制）经
// `@xyz-agent/ui/rendering-protocol` 子路径暴露。7 原语是 RenderingProtocol 内部
// 实现细节，不经顶层导出（AC4：原语不经顶层暴露，消费方走 ./rendering-protocol 子路径）。
