<script setup lang="ts">
import { ref } from 'vue'
import { providers as initialProviders, type Provider } from '@/mock/sessions'
import UiSwitch from './UiSwitch.vue'
import UiInput from './UiInput.vue'

/** ProviderPage：模型供应商管理。从 mock providers 渲染 provider-card。
 * row-head（状态点 + 启用开关 + 名称 + 默认 pill + 模型数 + dirty + 删除）+ 展开区（凭据/模型/验证）+ save-bar。*/
const providers = ref<Provider[]>(JSON.parse(JSON.stringify(initialProviders)))
// 首个 connected provider 展开示意
const expandedId = ref<string>(
  initialProviders.find((p) => p.status === 'connected')?.id ?? initialProviders[0]?.id ?? '',
)

const showKey = ref<Record<string, boolean>>({})
const apiKey = ref<Record<string, string>>({ 'p-1': 'sk-zhipu-••••••••••••3f2a', 'p-2': 'sk-ant-••••••••••••8b1c' })
const modelName = ref<Record<string, string>>({
  'p-1': 'glm-4.6',
  'p-2': 'claude-sonnet-4',
})

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? '' : id
}
function toggleEnabled(p: Provider) {
  p.enabled = !p.enabled
  p.dirty = true
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">供应商</h1>
        <p class="desc">管理模型供应商的连接、凭据与可用模型。</p>
      </div>
      <div class="head-actions">
        <button class="btn btn-ghost btn-md">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          导入
        </button>
        <button class="btn btn-default btn-md">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          添加供应商
        </button>
      </div>
    </header>

    <div class="provider-list">
      <section v-for="p in providers" :key="p.id" class="provider-card">
        <!-- row-head -->
        <div class="row-head">
          <span
            class="status-dot"
            :class="p.status === 'connected' ? 'ok' : 'neutral'"
            :title="p.status === 'connected' ? '已连接' : '未配置'"
          ></span>
          <UiSwitch :checked="p.enabled" @update:checked="toggleEnabled(p)" />
          <span class="name" @click="toggleExpand(p.id)">{{ p.name }}</span>
          <span v-if="p.isDefault" class="default-pill">默认</span>
          <span class="model-count">{{ p.modelCount }} 个模型</span>
          <span v-if="p.dirty" class="dirty-badge">未保存</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-icon expand-btn" :class="{ down: expandedId === p.id }" title="展开" @click="toggleExpand(p.id)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="btn btn-ghost btn-icon del-btn" title="删除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>

        <!-- 展开区 -->
        <div v-if="expandedId === p.id" class="expand-body">
          <!-- 凭据子区 -->
          <div class="sub-section">
            <div class="sub-label">凭据</div>
            <div class="cred-row">
              <UiInput
                :model-value="showKey[p.id] ? apiKey[p.id] : (apiKey[p.id] ? '••••••••••••••••' : '')"
                placeholder="输入 API Key"
                :mono="true"
                class="key-input"
              />
              <button class="btn btn-ghost btn-md eye-btn" :title="showKey[p.id] ? '隐藏' : '显示'" @click="showKey[p.id] = !showKey[p.id]">
                <svg v-if="!showKey[p.id]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
              </button>
              <button v-if="apiKey[p.id]" class="btn btn-ghost btn-md clear-btn" title="清除">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>

          <!-- 模型清单 -->
          <div class="sub-section">
            <div class="sub-label">模型清单</div>
            <div class="model-list">
              <div v-for="i in 3" :key="i" class="model-row">
                <UiInput :model-value="i === 1 ? modelName[p.id] : (i === 2 ? 'glm-4.5-air' : 'glm-4-flash')" :mono="true" class="model-name-input" />
                <span v-if="i === 1" class="thinking-pill">思考</span>
                <span v-else-if="i === 2" class="compat-chip">兼容</span>
                <span v-else class="spacer-tag"></span>
                <button class="btn btn-ghost btn-icon" title="移除模型">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>
            <button class="btn btn-ghost btn-sm add-model-btn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              添加模型
            </button>
          </div>

          <!-- 验证 / 高级（折叠态） -->
          <details class="adv-details">
            <summary class="adv-summary">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              验证 / 高级
            </summary>
            <div class="adv-body">
              <button class="btn btn-secondary btn-md">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                测试连接
              </button>
            </div>
          </details>

          <!-- save-bar -->
          <div class="save-bar">
            <span class="spacer"></span>
            <button class="btn btn-ghost btn-md">取消</button>
            <button class="btn btn-default btn-md">保存</button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
}
.head-text {
  min-width: 0;
}
.title {
  font-size: 18px;
  font-weight: 700;
  color: var(--neutral-fg);
  letter-spacing: -0.01em;
}
.desc {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.head-actions {
  display: flex;
  gap: var(--space-2);
  flex-shrink: 0;
}

.provider-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.provider-card {
  background: var(--bg-card);
  border-radius: 10px;
  overflow: hidden;
}
.row-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  min-height: 48px;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.ok {
  background: var(--success);
}
.status-dot.neutral {
  background: var(--neutral-dim);
}
.name {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--neutral-fg);
  cursor: pointer;
}
.default-pill {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.model-count {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.dirty-badge {
  height: 18px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.spacer {
  flex: 1;
}
.expand-btn svg,
.del-btn svg {
  width: 16px;
  height: 16px;
}
.expand-btn svg {
  transition: transform var(--duration-fast) var(--ease);
  transform: rotate(180deg);
}
.expand-btn.down svg {
  transform: rotate(0deg);
}
.del-btn:hover {
  color: var(--danger);
}

.expand-body {
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.sub-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.sub-label {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--neutral-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cred-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
.key-input {
  flex: 1;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.model-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.model-name-input {
  flex: 1;
}
.thinking-pill {
  height: 22px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--reasoning-soft);
  color: var(--reasoning);
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.compat-chip {
  height: 22px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--info-soft);
  color: var(--info);
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.spacer-tag {
  width: 44px;
  flex-shrink: 0;
}
.add-model-btn {
  align-self: flex-start;
}

.adv-summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.adv-summary::-webkit-details-marker {
  display: none;
}
.adv-summary svg {
  width: 14px;
  height: 14px;
  transition: transform var(--duration-fast) var(--ease);
}
.adv-details[open] .adv-summary svg {
  transform: rotate(180deg);
}
.adv-body {
  padding-top: var(--space-3);
}

.save-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-4);
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
  position: sticky;
  bottom: 0;
  background: var(--bg-card);
  margin: 0 calc(-1 * var(--space-4)) calc(-1 * var(--space-4));
  padding: var(--space-3) var(--space-4);
}
</style>
