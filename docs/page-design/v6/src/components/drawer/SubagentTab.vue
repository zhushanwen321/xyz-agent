<script setup lang="ts">
/**
 * SubagentTab · 嵌套只读对话流（subagent tab）
 * 返回按钮（从 workflow 进入才显）+ subagent 信息（agent · slug · model · thinking）
 * + 2-3 条只读消息（assistant 文本 + tool block 只读）+ 只读提示条
 */
import { ref } from 'vue'
import { drawerTab, subagentSessionId } from '@/composables/useStore'

/** 是否从 workflow tab 进入（显返回） */
const fromWorkflow = ref(true)

/** 返回 workflow tab */
function backToWorkflow() {
  drawerTab.value = 'workflow'
}

/** 有选中 subagent 才渲染对话流（spec §10 空态：未选中显提示） */
const hasSelected = () => subagentSessionId.value !== null

interface SaTurn {
  user: string
  asst?: string
  blocks?: { name: string; meta?: string }[]
}

const turns: SaTurn[] = [
  {
    user: '查找本仓库的认证流程实现',
    asst: '我来搜索认证相关的代码。',
    blocks: [{ name: 'grep "authenticate"', meta: '12 文件 / 38 匹配' }],
  },
  {
    user: '列出关键函数',
    blocks: [{ name: 'read src/auth/session.ts' }],
    asst: '关键函数：refreshToken()、validateSession()。',
  },
  {
    user: '总结认证刷新机制',
    asst: '认证主流程走 token 刷新，过期前 60s 由 refreshToken() 续期。',
  },
]
</script>

<template>
  <div class="sa-v6">
    <!-- 空态：未选中 subagent（spec §10）入口 = 直接点 L1 subagent tab / 初始无选中 -->
    <div v-if="!hasSelected()" class="sa-empty">
      <svg class="sa-empty-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
      </svg>
      <span class="sa-empty-text">未选中 subagent</span>
      <span class="sa-empty-sub">从 workflow 的 agent call 点击进入查看对话流</span>
    </div>

    <template v-else>
    <!-- 标题栏：surface + hairline（方案 G），去 border-b -->
    <div class="sa-header">
      <button v-if="fromWorkflow" class="sa-back" title="返回 workflow tab" @click="backToWorkflow">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
        </svg>
      </button>
      <svg class="sa-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
      </svg>
      <span class="sa-agent">researcher</span>
      <span class="sa-slug">· find-auth-flow</span>
      <span class="sa-meta">glm-5.2 · thinking medium</span>
    </div>

    <!-- 嵌套 MessageStream（只读） -->
    <div class="sa-stream">
      <div v-for="(t, i) in turns" :key="i" class="sa-turn">
        <div class="sa-user">{{ t.user }}</div>
        <div class="sa-asst">
          <div v-if="t.blocks" class="sa-block-group">
            <div v-for="(b, j) in t.blocks" :key="j" class="sa-block">
              <svg class="sa-block-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <span class="sa-block-name">{{ b.name }}</span>
              <span v-if="b.meta" class="sa-block-meta">{{ b.meta }}</span>
            </div>
          </div>
          <div v-if="t.asst" class="sa-asst-text">{{ t.asst }}</div>
        </div>
      </div>
    </div>

    <!-- 只读提示条（无 composer） -->
    <div class="sa-readonly-hint">
      <svg class="sa-ro-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      <span>只读 · subagent 为 background 任务，无输入区</span>
    </div>
    </template>
  </div>
</template>

<style scoped>
.sa-v6 {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  min-height: 0;
  overflow: hidden;
}

/* 标题栏：surface + hairline（方案 G） */
.sa-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--surface);
  border-bottom: 1px solid var(--hairline);
  flex-shrink: 0;
}
.sa-header .sa-back {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  border: 0;
  cursor: pointer;
  background: transparent;
  color: var(--neutral-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all var(--duration-fast) var(--ease);
}
.sa-header .sa-back:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.sa-header .sa-ico {
  width: 14px;
  height: 14px;
  color: var(--neutral-dim);
  flex-shrink: 0;
}
.sa-header .sa-agent {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-fg);
  font-weight: 500;
}
.sa-header .sa-slug {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
.sa-header .sa-meta {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
}

/* 嵌套 MessageStream */
.sa-stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sa-turn {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sa-user {
  align-self: flex-end;
  max-width: 76%;
  background: var(--surface-hover);
  border-radius: var(--radius) var(--radius) var(--radius-sm) var(--radius);
  padding: 6px 10px;
  font-size: var(--text-sm);
  color: var(--neutral-fg);
}
.sa-asst {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sa-asst-text {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  line-height: 1.6;
  padding: 2px 0;
}

/* 嵌套 tool block（只读） */
.sa-block-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sa-block {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: var(--surface-2);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
}
.sa-block .sa-block-ico {
  width: 12px;
  height: 12px;
  color: var(--neutral-dim);
  flex-shrink: 0;
}
.sa-block .sa-block-name {
  color: var(--neutral-fg);
}
.sa-block .sa-block-meta {
  color: var(--neutral-dim);
  margin-left: auto;
}

/* 只读提示条 */
.sa-readonly-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--bg-input);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  flex-shrink: 0;
}
.sa-readonly-hint .sa-ro-ico {
  width: 12px;
  height: 12px;
  opacity: 0.7;
  flex-shrink: 0;
}
/* 空态（spec §10）*/
.sa-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--neutral-dim);
  padding: 24px;
  text-align: center;
}
.sa-empty .sa-empty-ico {
  width: 28px;
  height: 28px;
  opacity: 0.4;
}
.sa-empty .sa-empty-text {
  font-size: var(--text-sm);
}
.sa-empty .sa-empty-sub {
  font-size: var(--text-xs);
  opacity: 0.6;
}
</style>
