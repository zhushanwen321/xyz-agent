<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import ShellView from './views/ShellView.vue'
import SettingsOverlay from './components/settings/SettingsOverlay.vue'
import SearchModal from './components/overlays/SearchModal.vue'
import AskUserOverlay from './components/overlays/AskUserOverlay.vue'
import ConfirmDialog from './components/overlays/ConfirmDialog.vue'
import {
  searchModalOpen,
  settingsOpen,
  askUserOpen,
  confirmOpen,
  handleEscape,
  openSearch,
  closeAskUser,
  closeConfirm,
  sidebarCollapsed,
} from './composables/useStore'

/** AskUserOverlay 多问题 demo（spec §3 多问题 tab 形态：2-3 题，含一道多选 + Other）*/
const askUserDemoQuestions = [
  {
    id: 'commit-strategy',
    title: '提交策略',
    options: [
      { value: 'commit-first', label: '先提交再继续', desc: '创建一个 WIP commit，完成后继续任务' },
      { value: 'discard', label: '放弃改动', desc: 'git checkout . 丢弃所有未提交变更' },
      { value: 'stash', label: '暂存到 stash', desc: '不可用：当前已有 stash 冲突', disabled: true },
    ],
  },
  {
    id: 'runtime',
    title: '运行环境',
    options: [
      { value: 'local-node', label: '本地 Node', desc: '使用当前工作区 Node 22', multiple: true },
      { value: 'docker', label: 'Docker 容器', desc: '在隔离容器中运行', multiple: true },
      { value: 'other', label: '其他环境…', desc: '自定义运行环境', multiple: true, isOther: true },
    ],
  },
  {
    id: 'notify',
    title: '通知',
    options: [
      { value: 'notify-yes', label: '完成后通知', desc: '任务完成时发送通知' },
      { value: 'notify-no', label: '不通知', desc: '静默完成任务' },
    ],
  },
]

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') handleEscape()
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    openSearch()
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
    e.preventDefault()
    sidebarCollapsed.value = !sidebarCollapsed.value
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="app-root">
    <ShellView />
    <SearchModal v-if="searchModalOpen" />
    <SettingsOverlay v-if="settingsOpen" />
    <!-- §4.6 AskUserOverlay · companion 场景（composer 上方 companion-band），demo 全局浮起 -->
    <div v-if="askUserOpen" class="au-band">
      <AskUserOverlay
        :questions="askUserDemoQuestions"
        context=""
        confirm-text="提交"
        @confirm="closeAskUser"
        @cancel="closeAskUser"
      />
    </div>
    <!-- §4.6 ConfirmDialog · 确认场景 -->
    <ConfirmDialog
      v-if="confirmOpen"
      variant="danger"
      title="确认删除"
      desc="此操作不可撤销"
      confirm-text="删除"
      cancel-text="取消"
      @confirm="closeConfirm"
      @cancel="closeConfirm"
    />
  </div>
</template>

<style scoped>
.app-root {
  width: 100%;
  height: 100%;
  position: relative;
}
/* companion-band：固定在 composer 上方区域，demo 简化为右下浮起 */
.au-band {
  position: fixed;
  right: 24px;
  bottom: 120px;
  width: 360px;
  max-width: calc(100vw - 48px);
  z-index: var(--z-overlay);
}
</style>
