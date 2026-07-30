import ReasoningBlock from './components/ReasoningBlock.js'
import ToolCallCard from './components/ToolCallCard.js'
import RightDrawerContent from './components/RightDrawerContent.js'
import ProcessPanel from './components/ProcessPanel.js'
import { ref } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.js'

export default {
  components: { ReasoningBlock, ToolCallCard, RightDrawerContent, ProcessPanel },
  setup() {
    const drawerOpen = ref(true)
    const drawerTab = ref('diff')
    const processOverlay = ref(false)
    return { drawerOpen, drawerTab, processOverlay }
  },
  template: `
    <div class="flex flex-col h-full relative overflow-hidden">
      <!-- Header -->
      <div class="h-12 flex items-center justify-between px-5 border-b border-white/[0.06] text-sm text-text-secondary flex-shrink-0 z-30">
        <div class="flex items-center">
          <span class="text-text-primary font-medium">subagent-skeleton</span>
          <span class="mx-2 text-text-tertiary">/</span>
          <span class="bg-white/[0.04] px-2 py-0.5 rounded text-xs">feat-subagent-enhance</span>
        </div>
        <div class="flex items-center gap-1">
          <button
            class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:bg-panel-hover"
            :class="drawerOpen && drawerTab==='browser' ? 'bg-panel-hover text-text-primary' : ''"
            @click="drawerOpen = true; drawerTab = 'browser'"
            title="浏览器">
            🌐
          </button>
          <button
            class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:bg-panel-hover"
            :class="drawerOpen && drawerTab==='diff' ? 'bg-panel-hover text-text-primary' : ''"
            @click="drawerOpen = true; drawerTab = 'diff'"
            title="代码 Diff">
            ⎇
          </button>
          <button
            class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:bg-panel-hover"
            :class="drawerOpen && drawerTab==='terminal' ? 'bg-panel-hover text-text-primary' : ''"
            @click="drawerOpen = true; drawerTab = 'terminal'"
            title="终端">
            &gt;_
          </button>
        </div>
      </div>

      <!-- Stage: stream column + right zone -->
      <div class="flex flex-1 min-h-0">
        <!-- Message stream: always left 50% -->
        <div class="relative w-1/2 flex flex-col min-w-0">
          <div class="flex-1 overflow-y-auto thin-scroll py-5">
            <div class="w-full px-6">
              <div class="flex justify-end mb-6">
                <div class="max-w-[80%] bg-panel-hover border border-white/[0.06] rounded-2xl rounded-tr-md px-4 py-3 text-[14px] leading-relaxed">
                  我倾向 <strong>SubagentHub</strong> ——它准确表达了"所有子代理操作（执行/查询/配置/状态）汇聚于此的进程级枢纽"，且 <code class="font-mono text-accent bg-base px-1 rounded">getHub()</code> / <code class="font-mono text-accent bg-base px-1 rounded">hub.execute()</code> 读起来直白。
                </div>
              </div>

              <div class="flex gap-3 mb-2">
                <div class="w-7 h-7 rounded-full bg-accent flex items-center justify-center text-white text-xs font-bold flex-shrink-0">Z</div>
                <div class="flex-1 min-w-0">
                  <div class="text-[13px] text-text-secondary mb-2">ZCode · 工作中 44 秒</div>
                  <div class="text-[14px] leading-relaxed text-text-primary mb-4">
                    好，先讨论清楚再动手。让我系统盘点三个维度——用事实，不凭记忆。先看 runtime 当前对外暴露的完整 public 面：
                  </div>

                  <reasoning-block title="思考过程 持续了几秒" status="done">
                    <tool-call-card command="已执行 echo &quot;=== index.ts 调 hub 的什么 ===&quot; &amp;&amp; grep -n &quot;rt.\|runtime.\|getRuntime\..." />
                  </reasoning-block>

                  <reasoning-block title="探索中 1 搜索" status="running">
                    <div class="text-text-secondary text-xs">现在精确追每个 public 成员的上游调用方（谁调它）+ 下游依赖（它内部碰什么）。先看所有调用方文件引用了 runtime 的什么：</div>
                  </reasoning-block>
                </div>
              </div>
            </div>
          </div>

          <!-- Process mini chip + overlay when drawer open -->
          <process-panel
            :drawer-open="drawerOpen"
            @expand="processOverlay = true"
          />

          <!-- Process overlay card: appears when mini chip clicked while drawer open -->
          <transition
            enter-active-class="transition-all duration-200 ease-out"
            leave-active-class="transition-all duration-200 ease-in"
            enter-from-class="opacity-0 scale-95"
            leave-to-class="opacity-0 scale-95"
          >
            <div
              v-if="drawerOpen && processOverlay"
              class="absolute top-2 right-4 z-20 float-panel p-4 w-[260px] max-h-[calc(100vh-180px)] overflow-y-auto thin-scroll"
            >
              <div class="flex items-center justify-between mb-3">
                <span class="text-sm font-medium text-text-primary">进程</span>
                <div class="flex items-center gap-2">
                  <span class="text-xs text-text-secondary">9/9</span>
                  <button class="text-xs text-text-secondary hover:text-text-primary" @click="processOverlay = false">✕</button>
                </div>
              </div>
              <div class="text-xs text-text-secondary mb-3">已完成 6 项</div>
              <div class="space-y-2.5">
                <div class="flex items-start gap-2 text-xs text-text-secondary">
                  <span class="text-success mt-0.5">✓</span>
                  <span>notifier: 全部方法</span>
                </div>
                <div class="flex items-start gap-2 text-xs text-text-secondary">
                  <span class="text-success mt-0.5">✓</span>
                  <span>runtime.ts: constructor + initSession 等 5 个委托（合并 6 个 inject）+ execute/query/reset</span>
                </div>
                <div class="flex items-start gap-2 text-xs text-text-secondary">
                  <span class="text-success mt-0.5">✓</span>
                  <span>tsc + eslint 验证全绿</span>
                </div>
              </div>
            </div>
          </transition>

          <!-- Composer -->
          <div class="w-full px-6 pb-5 flex-shrink-0">
            <div class="bg-base border border-white/[0.06] rounded-2xl px-4 py-3 flex items-end gap-3">
              <button class="w-7 h-7 flex items-center justify-center rounded-lg text-text-secondary hover:bg-panel-hover">+</button>
              <textarea placeholder="继续输入以排队后续修改" class="flex-1 bg-transparent resize-none outline-none text-[14px] text-text-primary placeholder:text-text-tertiary h-6 max-h-32"></textarea>
              <div class="flex items-center gap-2 text-text-secondary text-xs">
                <span class="px-2 py-1 rounded hover:bg-panel-hover cursor-pointer">完全访问 ▾</span>
                <span class="px-2 py-1 rounded hover:bg-panel-hover cursor-pointer">GLM-5.2 ▾</span>
                <span class="px-2 py-1 rounded hover:bg-panel-hover cursor-pointer">最高 ▾</span>
                <button class="w-7 h-7 bg-accent rounded-lg text-white flex items-center justify-center">➤</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Right zone: process card when closed, drawer when open -->
        <div class="relative w-1/2 min-w-0">
          <!-- Full process card when drawer closed -->
          <transition
            enter-active-class="transition-all duration-200 ease-out"
            leave-active-class="transition-all duration-200 ease-in"
            enter-from-class="opacity-0 translate-x-4"
            leave-to-class="opacity-0 translate-x-4"
          >
            <div
              v-if="!drawerOpen"
              class="absolute top-2 left-4 right-4 bottom-4 float-panel p-4 overflow-y-auto thin-scroll"
            >
              <div class="flex items-center justify-between mb-3">
                <span class="text-sm font-medium text-text-primary">进程</span>
                <span class="text-xs text-text-secondary">9/9</span>
              </div>
              <div class="text-xs text-text-secondary mb-3">已完成 6 项</div>
              <div class="space-y-2.5">
                <div class="flex items-start gap-2 text-xs text-text-secondary">
                  <span class="text-success mt-0.5">✓</span>
                  <span>notifier: 全部方法</span>
                </div>
                <div class="flex items-start gap-2 text-xs text-text-secondary">
                  <span class="text-success mt-0.5">✓</span>
                  <span>runtime.ts: constructor + initSession 等 5 个委托（合并 6 个 inject）+ execute/query/reset</span>
                </div>
                <div class="flex items-start gap-2 text-xs text-text-secondary">
                  <span class="text-success mt-0.5">✓</span>
                  <span>tsc + eslint 验证全绿</span>
                </div>
              </div>
            </div>
          </transition>

          <!-- Drawer when open -->
          <transition
            enter-active-class="transition-transform duration-200 ease-out"
            leave-active-class="transition-transform duration-200 ease-in"
            enter-from-class="translate-x-full"
            leave-to-class="translate-x-full"
          >
            <div
              v-if="drawerOpen"
              class="absolute inset-0 bg-base border-l border-white/[0.06] flex flex-col z-10"
            >
              <right-drawer-content :tab="drawerTab" @update:tab="drawerTab = $event" @close="drawerOpen = false" />
            </div>
          </transition>
        </div>
      </div>
    </div>`
}
