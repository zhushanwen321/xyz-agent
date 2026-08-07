/**
 * GUI custom 组件注册表的 provide/inject key（类型安全，防拼写漂移）。
 *
 * 从独立 .ts 文件导出（而非 <script setup> 内 export，后者被 Vue SFC 编译器禁止）。
 * GuiComponentRenderer inject 此 key，内置 extension 编译期 provide 自有组件（P2+ 实现）。
 */
import type { Component, InjectionKey } from 'vue'

export const GUI_CUSTOM_REGISTRY_KEY: InjectionKey<Record<string, Component>> = Symbol('gui-custom-registry')
