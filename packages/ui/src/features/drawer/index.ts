/**
 * @xyz-agent/ui features/drawer barrel（W3 · p3-strangler-domains::drawer）。
 *
 * 导出跨端共享 drawer 容器 DrawerPanel（tab 栏 + 钉住/关闭 + widget 内容区 + status footer
 * + 内容面板 slot）。消费方（renderer 壳 PanelContainer，W4）经 '@xyz-agent/ui/features/drawer'
 * 子路径 import（对齐 ./features/settings / ./features/composer 子路径范式）。
 *
 * widget 缓冲数据经 props 注入（D3 壳喂数据，core/domain/drawer widget-buffers 为 SSOT）；
 * 桌面独占内容面板经默认 slot 挂载（D5 硬编码占位）。类型对齐 IF2 契约。
 */
/** status footer 条目（extension:status，statusKey 维度聚合，壳 useDrawerWidgetBuffers 传入） */
export interface DrawerStatusEntry {
  statusKey: string
  text: string
  textRaw?: string
}

export { default as DrawerPanel } from './DrawerPanel.vue'
