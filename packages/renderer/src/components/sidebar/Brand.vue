<script setup lang="ts">
/**
 * 品牌区：太极双鱼 logo（旋转，currentColor 适配主题）+ 产品名 + 版本号。
 * v6-master-spec §6.2 Brand 区。
 *
 * - logo 资产从 v6 demo 复制（TaijiLogo.vue，SVG 矢量，禁止手改 path d）。
 * - 产品名走 i18n（app.title）：中文「太极」/ 英文「TaiJi」，与 v6 demo 对齐。
 * - 版本号用真实 __APP_VERSION__ + piVersion（比 demo 硬编码更合理），由 Sidebar 经 props 传入。
 * - UpdateButton 由 Sidebar 通过 #trailing slot 注入（保留项目独立组件实现，
 *   审查报告 2-① 关联 #5 确认项目实现比 demo 内联更合理）。
 */
import { useI18n } from 'vue-i18n'
import TaijiLogo from '@/components/icons/TaijiLogo.vue'

const { t } = useI18n()

interface Props {
  /** 版本号文案（如 v0.8.40 · pi v0.82.1） */
  versionLabel?: string
}
withDefaults(defineProps<Props>(), {
  versionLabel: '',
})
</script>

<template>
  <div class="flex items-center gap-2 px-2 pb-3.5">
    <TaijiLogo :size="28" :duration="8" class="shrink-0 text-neutral-fg" />
    <div class="flex min-w-0 flex-col leading-[1.1]">
      <span class="truncate text-[13px] font-semibold text-neutral-fg">{{ t('app.title') }}</span>
      <span v-if="versionLabel" class="text-[10px] text-neutral-mid">{{ versionLabel }}</span>
    </div>
    <!-- trailing slot：Sidebar 注入 UpdateButton（ml-auto 推到右侧） -->
    <slot name="trailing" />
  </div>
</template>
