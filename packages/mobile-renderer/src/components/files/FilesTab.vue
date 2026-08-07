<script setup lang="ts">
/**
 * FilesTab —— Files tab content 包装（spec P4 §3.1 + slice C1 + w1-C2 + D6 文件内容查看）。
 *
 * 三态（与 SessionsTab 对称，移动端 stack 导航）：
 *  - 无 sessionId：显示「请先选择会话」提示（不渲染 MobileFilesView）。
 *  - 有 sessionId + 未选文件：渲染 MobileFilesView（只读文件树）。
 *  - 有 sessionId + 已选文件：渲染 MobileFileDetail（复用桌面 DetailPane，图片走 signUrl，spec D6）。
 *
 * 选中态切换：MobileFilesView 点文件 → emit select → 本组件 showDetail=true → 渲染 MobileFileDetail。
 * MobileFileDetail 返回按钮 → emit back → showDetail=false → 回到文件树。
 *
 * MobileShell 持有 currentSessionId（从 SessionsTab 选中态透传），传入本组件。
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MobileFilesView from './MobileFilesView.vue'
import MobileFileDetail from './MobileFileDetail.vue'
import { useFileTreeStore } from '@/stores/fileTree'

const props = defineProps<{ sessionId: string | null }>()

const { t } = useI18n()
const fileTreeStore = useFileTreeStore()

/** 是否进入文件详情态（点文件后切到 MobileFileDetail）。默认 false（文件树态）。 */
const showDetail = ref(false)

/** 切 session 时重置详情态 + 清全局 selectedPath。
 *  必要：showDetail 是本地 ref，KeepAlive 复用同实例；fileTreeStore.selectedPath 是
 *  跨 session 全局焦点（store 不按 session 隔离 selectedPath）。不重置会显示
 *  MobileFileDetail + 上一 session 的 selectedPath（脏态）。 */
watch(
  () => props.sessionId,
  () => {
    showDetail.value = false
    fileTreeStore.selectFile(null)
  },
)

function onSelectFile(): void {
  showDetail.value = true
}

function onBackToTree(): void {
  showDetail.value = false
}
</script>

<template>
  <div class="files-tab h-full" data-testid="mobile-files-tab">
    <!-- 无 session：提示用户先选择会话 -->
    <div
      v-if="!sessionId"
      class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid="mobile-files-select-session"
    >
      <span class="text-sm text-muted">{{ t('mobile.files.selectSession') }}</span>
    </div>
    <!-- 有 session + 未选文件：渲染只读文件树 -->
    <MobileFilesView
      v-else-if="!showDetail"
      :session-id="sessionId"
      @select="onSelectFile"
    />
    <!-- 有 session + 已选文件：渲染文件内容详情（复用桌面 DetailPane，spec D6） -->
    <MobileFileDetail
      v-else
      :session-id="sessionId"
      @back="onBackToTree"
    />
  </div>
</template>
