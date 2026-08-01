<script setup lang="ts">
/**
 * TerminalView · drawer 集成终端
 * L2 多实例 tab（每 tab 一个独立 PTY 实例）+ tv-toolbar（clear/kill）+ tv-screen
 * bg-input 凹陷底色（非纯黑），工具栏同色去 border
 */
import { computed, ref } from 'vue'
import { terminalInstanceTab } from '@/composables/useStore'

/** 终端实例 */
interface TermInstance {
  id: string
  label: string
  alive: boolean
  cmd: string
  lines: { kind: 'out' | 'ok'; text: string }[]
}

const instances = ref<TermInstance[]>([
  {
    id: 'pty-1',
    label: 'pty-1 · dev',
    alive: true,
    cmd: 'npm run dev',
    lines: [
      { kind: 'out', text: '> xyz-agent@0.1.0 dev' },
      { kind: 'out', text: '> vite' },
      { kind: 'out', text: 'VITE v5.3.4 ready in 312 ms' },
      { kind: 'out', text: '➜ Local: http://localhost:1421/' },
    ],
  },
  {
    id: 'pty-2',
    label: 'pty-2 · build',
    alive: true,
    cmd: 'npm run build',
    lines: [
      { kind: 'out', text: '> xyz-agent@0.1.0 build' },
      { kind: 'out', text: '> vite build' },
      { kind: 'out', text: 'vite v5.3.4 building for production...' },
      { kind: 'out', text: '✓ 342 modules transformed.' },
      { kind: 'ok', text: '✓ built in 4.21s' },
    ],
  },
  {
    id: 'pty-3',
    label: 'pty-3 · test',
    alive: false,
    cmd: 'npm test',
    lines: [
      { kind: 'out', text: '> xyz-agent@0.1.0 test' },
      { kind: 'ok', text: '✓ 18 passed (18)' },
    ],
  },
])

const current = computed<TermInstance | undefined>(() => instances.value[terminalInstanceTab.value] ?? instances.value[0])

/** 关闭实例（移除 + 校正选中 index） */
function closeInstance(i: number) {
  instances.value.splice(i, 1)
  if (i < terminalInstanceTab.value) terminalInstanceTab.value -= 1
  else if (terminalInstanceTab.value >= instances.value.length) terminalInstanceTab.value = Math.max(0, instances.value.length - 1)
}

/** clear/kill 占位态 */
const cleared = ref(false)
function clearScreen() {
  cleared.value = true
}
function killPty() {
  /* demo 占位 */
}
</script>

<template>
  <div class="tv-v6">
    <!-- L2 多实例 tab 栏 + 新增按钮 -->
    <div class="b-l2">
      <div
        v-for="(inst, i) in instances"
        :key="inst.id"
        class="b-l2-tab"
        :class="{ on: terminalInstanceTab === i }"
        @click="terminalInstanceTab = i; cleared = false"
      >
        <span class="tt-name">{{ inst.label }}</span>
        <span class="tt-close" title="关闭实例" @click.stop="closeInstance(i)">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </span>
      </div>

      <div class="b-l2-newtab" title="新开终端实例（本期仅占位，功能后续实现）">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        新实例
      </div>

      <span class="spacer"></span>
      <span class="tv-instance-label">{{ current?.id ?? '—' }}</span>
    </div>

    <!-- 工具栏（clear/kill，同色无 border）-->
    <div class="tv-toolbar">
      <button class="tv-btn" title="清屏" @click="clearScreen">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
      <button
        class="tv-btn"
        :class="{ disabled: !current?.alive }"
        title="终止 PTY"
        :disabled="!current?.alive"
        @click="killPty"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
      </button>
      <span class="tv-spacer"></span>
    </div>

    <!-- 终端屏幕（bg-input 同色；无实例时空态）-->
    <div class="tv-screen">
      <template v-if="current">
        <template v-if="!cleared">
          <div><span class="tv-prompt">$</span> <span class="tv-cmd">{{ current.cmd }}</span></div>
          <div v-for="(ln, i) in current.lines" :key="i" :class="ln.kind === 'ok' ? 'tv-ok' : 'tv-out'">{{ ln.text }}</div>
        </template>
        <div><span class="tv-prompt">$</span> <span class="tv-cursor"></span></div>
      </template>
      <div v-else class="tv-empty">无终端实例</div>
    </div>
  </div>
</template>

<style scoped>
.tv-v6 {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-input);
  min-height: 0;
  overflow: hidden;
}

/* L2 二级 tab 栏：surface + hairline（方案 G） */
.b-l2 {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  background: var(--surface);
  border-bottom: 1px solid var(--hairline);
  min-height: 34px;
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none; /* 隐藏滚动条（Firefox）*/
  flex-shrink: 0;
}
.b-l2::-webkit-scrollbar { display: none; } /* 隐藏滚动条（Chrome/Safari）*/
.b-l2-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 150px;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  transition: all var(--duration-fast) var(--ease);
}
.b-l2-tab:hover {
  color: var(--neutral-fg);
}
.b-l2-tab.on {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.b-l2-tab.on:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.b-l2-tab .tt-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}
.b-l2-tab .tt-close {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  flex-shrink: 0;
  opacity: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity var(--duration-fast) var(--ease);
}
.b-l2-tab:hover .tt-close,
.b-l2-tab.on .tt-close {
  opacity: 0.6;
}
.b-l2-tab .tt-close:hover {
  opacity: 1;
  background: var(--surface-2);
}

.b-l2-newtab {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 20px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--neutral-dim);
  transition: all var(--duration-fast) var(--ease);
  flex-shrink: 0;
}
.b-l2-newtab:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}

.b-l2 .spacer {
  flex: 1;
}
.tv-instance-label {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
}

/* 工具栏：同色 bg-input，去 border */
.tv-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--bg-input);
  flex-shrink: 0;
}
.tv-btn {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  border: 0;
  cursor: pointer;
  background: transparent;
  color: var(--neutral-mid);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-fast) var(--ease);
}
.tv-btn:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.tv-btn.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 工具栏 spacer（spec §5：tv-toolbar 内右对齐占位） */
.tv-toolbar .tv-spacer {
  flex: 1;
}
.tv-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}

/* 终端屏幕 */
.tv-screen {
  flex: 1;
  min-height: 0;
  padding: 10px 14px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--neutral-fg);
  overflow: auto;
}
.tv-screen .tv-prompt {
  color: var(--accent);
}
.tv-screen .tv-cmd {
  color: var(--neutral-fg);
}
.tv-screen .tv-out {
  color: var(--neutral-mid);
}
.tv-screen .tv-ok {
  color: var(--success);
}
.tv-screen .tv-cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  background: var(--neutral-fg);
  vertical-align: middle;
  animation: tv-blink 1.1s step-end infinite;
}
.tv-screen .tv-empty {
  padding: 24px 0;
  text-align: center;
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
@keyframes tv-blink {
  0%, 50% { opacity: 1; }
  50.01%, 100% { opacity: 0; }
}
</style>
