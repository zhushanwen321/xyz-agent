/**
 * l2-tab-item.ts —— L2TabBar 的 tab 条目类型（W4 · T2）。
 *
 * 对齐 extension-host 层类型归位范式（view-host-source.ts / status-bar-source.ts
 * 等契约类型均落独立 .ts 文件，组件不导出类型——*.vue 模块命名导出
 * 在 tsc 下不可见）。
 */
import type { Component } from 'vue'

/** 单个二级 tab 条目。 */
export interface L2TabItem {
  viewId: string
  title: string
  /** 已解析的 lucide 图标组件（父层字典映射后传入）；无则纯文字 tab */
  icon?: Component
  /** pinned 态（父层本地 ref 维护，不持久化）——pinned 时 pin 按钮 accent + 常显 */
  pinned?: boolean
  /** builtin view（tasks plugin）不渲染 close 按钮 */
  builtin?: boolean
}
