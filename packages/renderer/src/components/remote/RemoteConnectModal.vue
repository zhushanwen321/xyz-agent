<script setup lang="ts">
/**
 * RemoteConnectModal —— 远程连接配置 modal 壳（spec §七:159-216）。
 *
 * 职责：Dialog 壳 + reka-ui Tabs 三页（粘贴/手填/已保存）。Tabs 默认 active=paste（最常用入口）。
 * standalone prop（独立窗口，App.vue failed(auth) 分支 / Landing 状态条「切换」触发）— P1 阶段
 * standalone 与非 standalone 渲染一致（都渲染 Dialog+Tabs），预留未来「独立窗口含返回按钮」扩展。
 * close emit 由 Dialog update:open=false（点遮罩/Esc）或 cancel 按钮触发，父组件据此 v-if 摘除。
 *
 * 子组件各自封装连接流程（probeConnect→saveProfile→activateRemote→reload），
 * Modal 壳只负责 Tabs 切换 + standalone + close。
 *
 * 约束：直接 import reka-ui Tabs 系列（TC1 决策，dialog/index.ts:7 已直接 re-export reka-ui 模式）；
 * 用 xyz-ui Dialog/Button，禁原生元素/emoji/硬编码颜色；template≤400/script≤300。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from 'reka-ui'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import RemotePasteTab from './RemotePasteTab.vue'
import RemoteManualTab from './RemoteManualTab.vue'
import RemoteSavedTab from './RemoteSavedTab.vue'

defineProps<{
  /** standalone 模式（独立窗口打开）。P1 仅接收，渲染与非 standalone 一致。 */
  standalone?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()

/** Tabs 当前激活值（默认 paste，spec §七 粘贴是最常用入口） */
const activeTab = ref('paste')

/** 关闭：回传 close 语义，父组件 @close 设 showRemoteModal=false */
function onClose(): void {
  emit('close')
}
</script>

<template>
  <Dialog :open="true" @update:open="(v) => { if (!v) onClose() }">
    <DialogContent class="max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t('connection.remoteConnect.title') }}</DialogTitle>
        <DialogDescription>
          {{ t('connection.remoteConnect.subtitle') }}
        </DialogDescription>
      </DialogHeader>

      <!-- TabsRoot 用 modelValue（reka-ui v2 API：TabsRoot.props 含 modelValue + emits update:modelValue） -->
      <TabsRoot v-model="activeTab" class="flex flex-col gap-3">
        <TabsList class="flex gap-1 self-stretch rounded-md bg-surface-2 p-1">
          <TabsTrigger
            value="paste"
            data-testid="tab-trigger-paste"
            class="flex-1 rounded-sm px-3 py-1.5 text-[12px] text-muted transition-colors data-[state=active]:bg-bg-elevated data-[state=active]:text-fg"
          >
            {{ t('connection.remoteConnect.tabs.paste') }}
          </TabsTrigger>
          <TabsTrigger
            value="manual"
            data-testid="tab-trigger-manual"
            class="flex-1 rounded-sm px-3 py-1.5 text-[12px] text-muted transition-colors data-[state=active]:bg-bg-elevated data-[state=active]:text-fg"
          >
            {{ t('connection.remoteConnect.tabs.manual') }}
          </TabsTrigger>
          <TabsTrigger
            value="saved"
            data-testid="tab-trigger-saved"
            class="flex-1 rounded-sm px-3 py-1.5 text-[12px] text-muted transition-colors data-[state=active]:bg-bg-elevated data-[state=active]:text-fg"
          >
            {{ t('connection.remoteConnect.tabs.saved') }}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="paste" data-testid="tab-content-paste">
          <RemotePasteTab />
        </TabsContent>
        <TabsContent value="manual" data-testid="tab-content-manual">
          <RemoteManualTab />
        </TabsContent>
        <TabsContent value="saved" data-testid="tab-content-saved">
          <RemoteSavedTab />
        </TabsContent>
      </TabsRoot>

      <div class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" data-testid="modal-cancel-btn" @click="onClose">
          {{ t('common.cancel') }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
