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

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? '' : id
}
function toggleEnabled(p: Provider) {
  p.enabled = !p.enabled
  p.dirty = true
}
const advOpen = ref<Record<string, boolean>>({})

/** M4 authHeader：把 API Key 写入 Authorization 头（凭据子区 switch 行） */
const authHeader = ref<Record<string, boolean>>({ 'p-1': true, 'p-2': true })

/** M5 模型列表：per provider 本地 ref（替代硬编码数组） */
const models = ref<Record<string, string[]>>({
  'p-1': ['glm-4.6', 'glm-4.5-air', 'glm-4-flash'],
  'p-2': ['claude-sonnet-4.5', 'claude-haiku-4'],
})
/** 默认模型：spec §0 无独立 defaultProvider，由 defaultModel（providerId/modelId）反推 */
const defaultModel = ref<Record<string, string>>({ 'p-1': 'glm-4.6' })

/** M5 模型添加表单（本地状态） */
const newModelName = ref('')
const newModelInputType = ref<'text' | 'image'>('text')

function addModel(p: Provider) {
  const name = newModelName.value.trim()
  if (!name) return
  models.value[p.id] = [...(models.value[p.id] ?? []), name]
  newModelName.value = ''
}

/** M7 设为默认：写 defaultModel（复合键语义，非默认 model 在高级抽屉内显示入口） */
function setDefaultModel(p: Provider, m: string) {
  defaultModel.value[p.id] = m
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
        <button class="btn btn-secondary btn-sm">
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
          <span v-if="p.isDefault" class="default-pill">默认供应商</span>
          <span class="model-count">{{ p.modelCount }} 个模型</span>
          <span v-if="p.dirty" class="dirty-badge"><span class="dot"></span>未保存</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-icon expand-btn" :class="{ down: expandedId === p.id }" title="展开" @click="toggleExpand(p.id)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="btn btn-danger btn-icon-sm del-btn" title="删除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>

        <!-- 展开区 -->
        <div v-if="expandedId === p.id" class="expand-body">
          <!-- 凭据子区 -->
          <div class="sub-section">
            <div class="sub-label">凭据</div>
            <div class="cred-grid">
              <div class="cred-field">
                <label class="field-label">名称</label>
                <UiInput :model-value="p.name" placeholder="供应商名称" />
              </div>
              <div class="cred-field">
                <label class="field-label">类型</label>
                <select class="type-select">
                  <option>OpenAI Compatible</option>
                  <option>Anthropic</option>
                  <option>Custom</option>
                </select>
              </div>
              <div class="cred-field cred-field-wide">
                <label class="field-label">Base URL</label>
                <UiInput :model-value="p.id === 'p-1' ? 'https://open.bigmodel.cn/api/paas/v4' : 'https://api.anthropic.com'" :mono="true" />
              </div>
              <div class="cred-field cred-field-wide">
                <label class="field-label">API Key</label>
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
              <!-- M4 authHeader：把 API Key 写入 Authorization 头（fld-full switch 行） -->
              <div class="cred-field cred-field-wide">
                <div class="auth-header-row">
                  <span class="auth-header-label">Auth Header</span>
                  <span class="auth-header-desc">把 API Key 写入 Authorization 头</span>
                  <span class="spacer"></span>
                  <UiSwitch
                    :checked="!!authHeader[p.id]"
                    aria-label="把 API Key 写入 Authorization 头"
                    @update:checked="authHeader[p.id] = $event"
                  />
                </div>
              </div>
            </div>
          </div>

          <!-- 模型清单 -->
          <div class="sub-section">
            <div class="sub-label">模型清单</div>
            <div class="model-list">
              <div v-for="m in models[p.id] ?? []" :key="m" class="model-row">
                <UiSwitch :checked="true" :aria-label="'启用 ' + m" />
                <UiInput :model-value="m" :mono="true" class="model-name-input" />
                <span v-if="defaultModel[p.id] === m" class="default-dot" title="默认模型"></span>
                <span v-if="m === 'glm-4.6'" class="thinking-pill">思考</span>
                <span v-else-if="m === 'glm-4.5-air'" class="compat-chip">兼容</span>
                <span v-else class="spacer-tag"></span>
                <button class="btn btn-ghost btn-icon adv-chevron" :class="{ down: advOpen[p.id + m] }" :title="'高级 ' + m" @click="advOpen[p.id + m] = !advOpen[p.id + m]">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                <button class="btn btn-ghost btn-icon" title="移除模型">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
                <div v-if="advOpen[p.id + m]" class="model-adv-drawer">
                  <div class="cred-grid">
                    <div class="cred-field">
                      <label class="field-label">输入类型</label>
                      <select class="type-select"><option>text</option><option>multimodal</option></select>
                    </div>
                    <div class="cred-field">
                      <label class="field-label">上下文窗口</label>
                      <UiInput model-value="128000" :mono="true" />
                    </div>
                    <div class="cred-field">
                      <label class="field-label">思考</label>
                      <select class="type-select"><option>auto</option><option>on</option><option>off</option></select>
                    </div>
                    <div class="cred-field">
                      <label class="field-label">兼容性</label>
                      <UiInput model-value="openai" :mono="true" />
                    </div>
                  </div>
                  <!-- M7 设为默认：非默认 model 显示，点击置默认标记 + dot 转移 -->
                  <button
                    v-if="defaultModel[p.id] !== m"
                    class="btn btn-ghost btn-sm set-default-btn"
                    @click="setDefaultModel(p, m)"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    设为默认
                  </button>
                </div>
              </div>
            </div>
            <!-- M5 模型添加表单（紧凑：名称 input + 输入 seg + 添加按钮） -->
            <div class="model-add-row">
              <UiInput
                v-model="newModelName"
                placeholder="模型名称"
                :mono="true"
                class="model-add-input"
              />
              <div class="input-seg" role="group" aria-label="输入类型">
                <button
                  type="button"
                  class="input-seg__btn"
                  :class="{ 'input-seg__btn--active': newModelInputType === 'text' }"
                  @click="newModelInputType = 'text'"
                >文本</button>
                <button
                  type="button"
                  class="input-seg__btn"
                  :class="{ 'input-seg__btn--active': newModelInputType === 'image' }"
                  @click="newModelInputType = 'image'"
                >图片</button>
              </div>
              <button class="btn btn-default btn-dense" @click="addModel(p)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                添加
              </button>
            </div>
          </div>

          <!-- 验证 -->
          <div class="sub-section">
            <div class="sub-label">验证</div>
            <div class="verify-row">
              <button class="btn btn-secondary btn-md">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                测试连接
              </button>
              <span class="verify-result">点击「测试连接」验证凭据与可达性。</span>
            </div>
          </div>

          <!-- 高级（折叠态） -->
          <details class="adv-details">
            <summary class="adv-summary">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              高级
            </summary>
            <div class="adv-body">
              <div class="cred-field cred-field-wide">
                <label class="field-label">自定义 Headers</label>
                <textarea class="headers-area" rows="3" placeholder="X-Org-Id: …&#10;Authorization: Bearer …"></textarea>
              </div>
              <div class="cred-field">
                <label class="field-label">Coding Plan 额度</label>
                <UiInput model-value="" placeholder="如 1000" :mono="true" />
              </div>
            </div>
          </details>

          <!-- save-bar -->
          <div class="save-bar">
            <span class="bar-dirty-badge"><span class="dot"></span>未保存</span>
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
  position: sticky;
  top: 0;
  background: var(--bg-elevated);
  z-index: var(--z-sticky);
}
.head-text {
  min-width: 0;
}
.title {
  font-size: 20px;
  font-weight: 600;
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
  width: 7px;
  height: 7px;
  border-radius: 999px;
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
  padding: 2px 6px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--text-2xs);
  font-weight: 500;
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
  gap: 6px;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--text-2xs);
  font-weight: 600;
  flex-shrink: 0;
}
.dirty-badge .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--warn);
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
  color: var(--neutral-fg);
}
.cred-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
.key-input {
  flex: 1;
}
.cred-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
.cred-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.cred-field-wide {
  grid-column: 1 / -1;
}
.field-label {
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  font-weight: 500;
}
.type-select {
  height: 40px;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 0 12px;
  font-size: 13px;
  color: var(--neutral-fg);
  outline: none;
  cursor: pointer;
}
.headers-area {
  width: 100%;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: var(--space-3);
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--neutral-fg);
  line-height: 1.7;
  resize: vertical;
  outline: none;
}
.headers-area:focus {
  box-shadow: 0 0 0 1px var(--accent-ring) inset;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.model-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
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
.default-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--info);
  flex-shrink: 0;
}
.adv-chevron svg {
  width: 14px;
  height: 14px;
  transition: transform var(--duration-fast) var(--ease);
  transform: rotate(-90deg);
}
.adv-chevron.down svg {
  transform: rotate(0deg);
}
.model-adv-drawer {
  grid-column: 1 / -1;
  width: 100%;
  margin-top: var(--space-2);
  padding: var(--space-3);
  background: var(--surface-2);
  border-radius: var(--radius);
}
.verify-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.verify-result {
  font-size: var(--text-sm);
  color: var(--neutral-dim);
}

/* M4 authHeader switch 行（fld-full，底纹浮起） */
.auth-header-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-2);
  border-radius: var(--radius);
}
.auth-header-label {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--neutral-fg);
}
.auth-header-desc {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}

/* M5 模型添加表单 */
.model-add-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-2);
  background: var(--surface-2);
  border-radius: var(--radius);
}
.model-add-input {
  flex: 1;
  min-width: 0;
}
/* 输入 seg：文本/图片 双按钮（bg-input 容器 + 选中浮起） */
.input-seg {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--bg-input);
  border-radius: var(--radius);
  flex-shrink: 0;
}
.input-seg__btn {
  height: 26px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  border: 0;
  background: transparent;
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease);
}
.input-seg__btn:hover {
  color: var(--neutral-fg);
}
.input-seg__btn--active {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}

/* M7 设为默认（高级抽屉底部） */
.set-default-btn {
  margin-top: var(--space-3);
}
.set-default-btn svg {
  width: 14px;
  height: 14px;
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
  background: var(--surface);
  margin: 0 calc(-1 * var(--space-4)) calc(-1 * var(--space-4));
  padding: var(--space-3) var(--space-4);
}
.bar-dirty-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  color: var(--warn);
  font-weight: 600;
}
.bar-dirty-badge .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--warn);
}
</style>
