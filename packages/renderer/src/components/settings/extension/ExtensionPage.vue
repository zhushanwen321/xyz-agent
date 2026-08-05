<template>
  <!--
    Settings · Extension 菜单页（issues.md #5 方案 A · 安装多步流 + 内联候选展开 + 卸载确认）。
    刷新机制：finishInstall/uninstall 后 runtime 推 config.extensions → onExtensions 订阅（SettingsModal 持有）
    → extensions prop 流入本页，无需本页自建订阅。
    容器职责：header + 加载路径配置 + 装配子组件（安装流 ExtensionInstallFlow / 列表 ExtensionList）。
  -->
  <div class="flex flex-col gap-4">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.extension') }}</h1>
        <p class="desc">{{ t('settings.menu.extensionDesc') }}</p>
      </div>
    </header>

    <!-- 加载路径（Phase 4）：共享 LoadPaths 组件，kind=extension。
         extension 的「优先级」语义因资源类型而异（tool 靠前生效、hook 全部执行），
         故措辞用「加载顺序」而非优先级；新会话生效，无需重启提示。
         不复用 SettingsResourcePage：extension 的实体列表模型与 skill/agent 不同（安装多步流、来源标签）。 -->
    <LoadPaths
      kind="extension"
      :forced-dirs="forcedExtDirs"
      :dirs="extensionDirs"
      @update-dirs="onUpdateExtensionDirs"
    />

    <!-- 安装流（推荐扩展 + npm/dir/git 安装 + 候选内联展开） -->
    <ExtensionInstallFlow :extensions="extensions" />

    <!-- 已安装列表（行 = ExtensionDetail 信息区 + ExtensionActions 操作区） -->
    <ExtensionList :extensions="extensions" />
  </div>
</template>

<script setup lang="ts">
import { provide } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SkillDirConfig } from '@xyz-agent/shared'
import { LoadPaths, SETTINGS_CONFIG_API_KEY } from '@xyz-agent/ui/features/settings'
import { config } from '@/api'

provide(SETTINGS_CONFIG_API_KEY, config) // LoadPaths(SourceImportSection) 迁 ui，config 经 inject
import { getSettingsStore } from '@xyz-agent/core'
import type { ExtensionItem } from '@xyz-agent/core'
import { useToast } from '@/composables/useToast'
import ExtensionInstallFlow from './ExtensionInstallFlow.vue'
import ExtensionList from './ExtensionList.vue'

defineProps<{ extensions: ExtensionItem[] }>()
const settingsStore = getSettingsStore()
const { extensionDirs } = settingsStore
const { error: toastError } = useToast()
const { t } = useI18n()

// ── 加载路径配置（Phase 4，接 store.extensionDirs，回写 store.setExtensionDirs）──
/** 强制目录（ADR-0021 §1.1 桥接层硬编码注入，UI 只读展示） */
const forcedExtDirs = ['~/.xyz-agent/extensions', '.xyz-agent/extensions']

/** 加载路径变更 → store 持久化（只写 enabled 路径）。拖拽即时性由 LoadPaths 本地状态保证。 */
async function onUpdateExtensionDirs(dirs: SkillDirConfig[]): Promise<void> {
  try {
    await settingsStore.setExtensionDirs(dirs.filter((d) => d.enabled).map((d) => d.path))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}
</script>
