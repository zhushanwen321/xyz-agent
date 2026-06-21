/**
 * Settings store —— 应用级配置状态（主题 / 语言 / 配色主题）。
 *
 * 模式参考 navigation.ts / sidebar.ts：defineStore + setup 语法（ref/computed），
 * 注释规范（依赖方向、骨架阶段说明）。
 *
 * 依赖方向：无（stores 间禁止互相 import；跨 store 协调由 composables/features 做）。
 * 骨架阶段：state/getter 合法初始值，action 简单赋值 + DOM data-theme 同步。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** 外观模式：暗色 / 亮色（ADR-0021-B 暗色为真默认） */
export type ThemeMode = 'dark' | 'light'

/** 配色主题：由 settings-shell spec §4 System 菜单定义，默认 cold-blue */
export type ColorTheme = string

export const useSettingsStore = defineStore('settings', () => {
  // State
  const theme = ref<ThemeMode>('dark')
  const language = ref<string>('zh-CN')

  /**
   * 配色主题（外观项扩展）。
   * 依据：settings-shell spec §4 System 菜单列出「配色主题」，draft 默认 cold-blue。
   * 骨架阶段仅保留内存状态，不持久化。
   */
  const colorTheme = ref<ColorTheme>('cold-blue')

  // Getters
  const isDark = computed(() => theme.value === 'dark')

  // Actions
  /**
   * 设置外观模式并同步到 DOM 的 [data-theme] 槽位。
   * 消费方：T01 已在 style.css 预留 [data-theme] 选择器。
   */
  function setTheme(t: ThemeMode): void {
    theme.value = t
    document.documentElement.setAttribute('data-theme', t)
  }

  function setLanguage(l: string): void {
    language.value = l
  }

  function setColorTheme(c: ColorTheme): void {
    colorTheme.value = c
  }

  return {
    theme,
    language,
    colorTheme,
    isDark,
    setTheme,
    setLanguage,
    setColorTheme,
  }
})
