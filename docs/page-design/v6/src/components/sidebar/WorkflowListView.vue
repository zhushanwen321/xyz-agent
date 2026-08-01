<script setup lang="ts">
/** WorkflowListView：从 mock workflows 渲染工作流卡片（两层视图）。
 *  v6（spec §7）：状态指示最左，无独立 workflow icon；
 *  进度条仅 running=accent，done=neutral-dim（降中性），
 *  failed=danger，paused=warn；卡片无 border。
 *  每卡片：状态 + name + slug + 进度条 + agents 计数 + 耗时（paused 显「· 暂停」）。
 *  点击卡片 → 本地 selectedId 切到视图 2 WorkflowDetail（选中卡片 bg-surface + name accent）。 */

import { computed, ref } from 'vue'
import { workflows, type WorkflowItem } from '@/mock/sessions'
import WorkflowDetail from './WorkflowDetail.vue'

type Status = WorkflowItem['status']

function fillClass(s: Status) {
  return `is-${s}`
}
function dotClass(s: Status) {
  return `is-${s}`
}

// 两层视图（spec §7）：列表 → 点击卡片 → 详情。
// selectedId 保留（返回列表后选中卡片仍高亮，spec 视图 1）；viewDetail 控制视图切换。
const selectedId = ref<string | null>(null)
const viewDetail = ref(false)
const selectedWf = computed(() =>
  workflows.find((w) => w.id === selectedId.value),
)

function select(id: string) {
  selectedId.value = id
  viewDetail.value = true
}
function backToList() {
  viewDetail.value = false
}

// running 卡片 abort 两段式确认（纯 UI 状态）
const hoveredId = ref<string | null>(null)
const pendingAbort = ref<string | null>(null)

function confirmAbort(id: string) {
  pendingAbort.value = id
}
function resetAbort() {
  pendingAbort.value = null
}
</script>

<template>
  <div class="wf-list">
    <!-- 视图 2：详情（WorkflowDetail） -->
    <WorkflowDetail
      v-if="viewDetail && selectedWf"
      :workflow="selectedWf"
      @back="backToList"
    />

    <!-- 视图 1：列表 -->
    <template v-else>
      <div
        v-for="wf in workflows"
        :key="wf.id"
        class="wf-card"
        :class="{ 'wf-card--sel': selectedId === wf.id }"
        role="button"
        tabindex="0"
        @click="select(wf.id)"
        @keydown.enter="select(wf.id)"
        @mouseenter="hoveredId = wf.id"
        @mouseleave="hoveredId = null; pendingAbort = null"
      >
      <div class="wf-card__row">
        <!-- 状态指示（最左）：running=spinner / 其他=圆点 -->
        <svg
          v-if="wf.status === 'running'"
          class="wf-card__spinner"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-6.22-8.56" />
        </svg>
        <span
          v-else
          class="wf-card__dot"
          :class="dotClass(wf.status)"
        ></span>

        <!-- name + slug -->
        <span class="wf-card__name">{{ wf.name }}</span>
        <span class="wf-card__slug">{{ wf.slug }}</span>

        <!-- running abort 按钮（X ghost，两段式确认） -->
        <div v-if="wf.status === 'running' && (hoveredId === wf.id || pendingAbort === wf.id)" class="wf-card__abort">
          <template v-if="pendingAbort === wf.id">
            <button
              class="wf-abort wf-abort--confirm"
              type="button"
              title="确认中止"
              @click.stop="resetAbort"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
          </template>
          <template v-else>
            <button
              class="wf-abort"
              type="button"
              title="中止工作流"
              @click.stop="confirmAbort(wf.id)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </template>
        </div>
      </div>

      <!-- 进度条 + agents 计数 + 耗时（spec §7 meta 行「N / M agents · 4m」，paused「· 暂停」） -->
      <div class="wf-card__prog">
        <div class="wf-card__pb">
          <div
            class="wf-card__pb-fill"
            :class="fillClass(wf.status)"
            :style="{ width: `${wf.progress}%` }"
          ></div>
        </div>
        <span class="wf-card__meta">{{ wf.agentsDone }} / {{ wf.agentsTotal }} agents</span>
        <span class="wf-card__elapsed">· {{ wf.status === 'paused' ? '暂停' : wf.elapsed }}</span>
      </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wf-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
}
.wf-card {
  position: relative;
  padding: 6px 8px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.wf-card:hover {
  background: var(--surface-hover);
}
/* 选中卡片高亮：bg-surface + name accent（spec §7 视图 1） */
.wf-card--sel {
  background: var(--surface);
}
.wf-card--sel .wf-card__name {
  color: var(--accent);
}
.wf-card__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wf-card__spinner {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  color: var(--accent);
  animation: spin 1.4s linear infinite;
}
.wf-card__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.wf-card__dot.is-running {
  background: var(--accent);
}
.wf-card__dot.is-done {
  background: var(--success);
}
.wf-card__dot.is-failed {
  background: var(--danger);
}
.wf-card__dot.is-paused {
  background: var(--warn);
}
.wf-card__name {
  min-width: 0;
  flex: 1;
  font-size: var(--text-sm);
  font-weight: 500;
  line-height: 1.35;
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-card__slug {
  flex-shrink: 0;
  margin-right: 4px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-mid);
}

/* running abort 按钮 */
.wf-card__abort {
  flex-shrink: 0;
  display: flex;
}
.wf-abort {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--neutral-dim);
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease);
}
.wf-abort:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.wf-abort svg {
  width: 12px;
  height: 12px;
}
/* 两段式确认：实心 danger */
.wf-abort--confirm {
  background: var(--danger);
  color: var(--danger-fg);
}
.wf-abort--confirm:hover {
  background: var(--danger);
  color: var(--danger-fg);
}

/* 进度条 + 计数 */
.wf-card__prog {
  margin-top: 4px;
  padding-left: 21px; /* 对齐 name（spinner 13/dot 7 + gap 8） */
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
}
.wf-card__pb {
  height: 3px;
  min-width: 40px;
  flex: 1;
  overflow: hidden;
  border-radius: 999px;
  background: var(--border);
}
.wf-card__pb-fill {
  height: 100%;
  border-radius: 999px;
}
/* v6：仅 running 用 accent，done 降 neutral-dim */
.wf-card__pb-fill.is-running {
  background: var(--accent);
}
.wf-card__pb-fill.is-done {
  background: var(--neutral-dim);
}
.wf-card__pb-fill.is-failed {
  background: var(--danger);
}
.wf-card__pb-fill.is-paused {
  background: var(--warn);
}
.wf-card__meta {
  white-space: nowrap;
}
.wf-card__elapsed {
  flex-shrink: 0;
  white-space: nowrap;
  color: var(--neutral-dim);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .wf-card__spinner {
    animation: none;
  }
}
</style>
