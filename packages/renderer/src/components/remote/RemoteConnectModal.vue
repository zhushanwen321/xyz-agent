<script setup lang="ts">
/**
 * RemoteConnectModal —— 远程连接配置 modal（T4 stub 占位）。
 *
 * 本 wave（p1-s2-w2）仅接线挂载点：App.vue failed(auth) 分支点 [修改连接信息] 打开本 modal。
 * stub 阶段渲染占位 UI（标题 + 提示 + 关闭按钮），不实现 profile 编辑表单。
 * T4 wave 替换为真实 profile 编辑（url/token/deviceName 表单 + 保存 + 自动重连），
 * standalone prop 届时控制是否含返回/最小化按钮（独立窗口 vs 嵌入式）。
 *
 * 约束：用 xyz-ui Dialog/DialogContent + Button，禁止原生 button/dialog；无 Emoji。
 */
import { useI18n } from 'vue-i18n'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

defineProps<{
  /** standalone 模式（独立窗口打开，非嵌入式）。stub 阶段仅接收，T4 控制按钮组。 */
  standalone?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()

/** 关闭：回传 close 语义，App.vue @close 设 showRemoteModal=false */
function onClose(): void {
  emit('close')
}
</script>

<template>
  <Dialog :open="true" @update:open="(v) => { if (!v) onClose() }">
    <DialogContent class="max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ t('connection.editConnection') }}</DialogTitle>
        <DialogDescription>
          {{ t('connection.failedAuth') }}
        </DialogDescription>
      </DialogHeader>
      <!-- T4 wave replaces this body with the real profile edit form -->
      <div data-testid="remote-connect-modal-body" class="py-2 text-[12.5px] text-muted">
        {{ t('connection.remoteConnectStubHint') }}
      </div>
      <div class="flex justify-end gap-2 pt-4">
        <Button variant="ghost" @click="onClose">
          {{ t('common.cancel') }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
