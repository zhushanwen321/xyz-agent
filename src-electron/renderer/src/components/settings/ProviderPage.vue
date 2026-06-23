<template>
  <!--
    Settings · Provider 菜单页（draft-provider.html §1-§5）。
    行布局：启用开关(左) → 名称(点击展开) → 默认pill → 模型数 → 编辑 → 删除
    模型表格：输入类型 icon + 上下文 + thinking pill + 默认按钮
  -->
  <div class="flex flex-col gap-3">
    <!-- page-header -->
    <div class="flex items-center justify-between">
      <span />
      <Button
        class="gap-1.5 rounded-sm px-2.5 py-1.5 text-[12px] font-medium [&_svg]:size-3.5"
        @click="editingProvider = null"
      >
        <Plus />
        添加供应商
      </Button>
    </div>

    <!-- 空状态 -->
    <div v-if="!providers.length" class="flex flex-col items-center gap-2 py-16 text-center">
      <div class="grid size-16 place-items-center rounded-full border-2 border-dashed border-border-strong">
        <Settings class="size-7 text-subtle" />
      </div>
      <p class="text-[14px] font-medium text-fg">还没有供应商</p>
      <p class="text-[12px] text-muted">添加第一个供应商，连接 AI 模型开始对话。</p>
    </div>

    <!-- 实体列表 -->
    <div v-for="p in providers" :key="p.id" class="overflow-hidden rounded-md border border-border bg-bg">
      <!-- 行头 -->
      <div class="flex items-center gap-3 px-4 py-3">
        <span class="size-[7px] shrink-0 rounded-full" :class="statusDot(p.status)" />

        <!-- 启用开关（名称左侧） -->
        <Label class="relative inline-flex shrink-0 cursor-pointer" @click.stop>
          <input type="checkbox" :checked="p.enabled" class="peer sr-only" />
          <div class="h-5 w-9 rounded-full bg-border-strong after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-full" />
        </Label>

        <!-- 供应商名称（点击展开/收起） -->
        <span
          class="flex-1 cursor-pointer truncate text-[13px] font-medium text-fg"
          @click="toggleExpand(p.id)"
        >{{ p.name }}</span>

        <!-- 默认供应商 pill / 设为默认按钮 -->
        <Button
          v-if="p.id === defaultProviderId"
          variant="ghost"
          class="h-auto shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent hover:bg-accent-soft"
        >默认供应商</Button>
        <Button
          v-else
          variant="secondary"
          class="h-auto shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] text-subtle hover:border-accent hover:text-accent"
          @click.stop="setDefaultProvider(p.id)"
        >设为默认</Button>

        <span class="shrink-0 text-[11px] text-subtle">{{ p.models.length }} 模型</span>

        <!-- 编辑 + 删除按钮 -->
        <Button
          variant="ghost"
          class="size-6 shrink-0 rounded-sm p-0 text-subtle hover:bg-surface-hover hover:text-fg [&_svg]:size-[13px]"
          title="编辑供应商"
          @click.stop="editingProvider = p"
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          class="size-6 shrink-0 rounded-sm p-0 text-subtle hover:bg-[rgba(239,68,68,0.12)] hover:text-danger [&_svg]:size-[13px]"
          title="删除供应商"
          @click.stop="deleteTarget = p"
        >
          <Trash2 />
        </Button>
      </div>

      <!-- 展开详情：凭据与连接 + 模型清单 -->
      <div v-if="expanded.has(p.id)" class="border-t border-border">
        <!-- 凭据与连接 -->
        <div class="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 px-4 py-3 text-[12px]">
          <span class="text-muted">API 类型</span>
          <span class="font-mono text-fg">{{ p.api ?? '-' }}</span>
          <span class="text-muted">Base URL</span>
          <span class="font-mono text-fg">{{ p.baseUrl ?? '-' }}</span>
          <span class="text-muted">API Key</span>
          <span class="text-fg">{{ p.apiKeySet ? '已配置' : '未配置' }}</span>
        </div>

        <!-- 模型清单表格 -->
        <div v-if="p.models.length" class="border-t border-border px-4 py-3">
          <p class="mb-2 text-[11px] uppercase tracking-wider text-muted">模型清单</p>
          <Table class="text-[12px]">
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead class="pb-1.5">模型</TableHead>
                <TableHead class="pb-1.5 text-center">输入</TableHead>
                <TableHead class="pb-1.5 text-right">上下文</TableHead>
                <TableHead class="pb-1.5 text-right">思考</TableHead>
                <TableHead class="pb-1.5 text-right">默认</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="m in p.models" :key="m.id">
                <TableCell class="py-2 font-mono text-fg">{{ m.id }}</TableCell>
                <!-- 输入类型 icon -->
                <TableCell class="py-2 text-center">
                  <div class="flex justify-center gap-0.5">
                    <FileText
                      class="size-3"
                      :class="m.input?.includes('text') ? 'text-info' : 'text-subtle opacity-30'"
                    />
                    <ImageIcon
                      class="size-3"
                      :class="m.input?.includes('image') ? 'text-info' : 'text-subtle opacity-30'"
                    />
                  </div>
                </TableCell>
                <TableCell class="py-2 text-right tabular-nums text-subtle">{{ formatCtx(m.contextWindow) }}</TableCell>
                <TableCell class="py-2 text-right">
                  <Button
                    variant="ghost"
                    class="h-auto rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-semibold hover:bg-transparent"
                    :class="thinkingPillClass(m)"
                    @click.stop="cycleThinking(p.id, m.id)"
                  >{{ thinkingLabel(m) }}</Button>
                </TableCell>
                <TableCell class="py-2 text-right">
                  <Button
                    v-if="m.id !== defaultModelId"
                    variant="secondary"
                    class="h-auto rounded-sm px-1.5 py-0.5 text-[10px] text-subtle hover:border-info hover:text-info"
                    @click.stop="setDefaultModel(m.id)"
                  >设为默认</Button>
                  <span v-else class="rounded-sm bg-info/10 px-1.5 py-0.5 text-[10px] text-info">默认模型</span>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <ProviderEditModal :provider="editingProvider" @close="editingProvider = null" />

    <!-- 删除确认弹窗 -->
    <Dialog :open="!!deleteTarget" @update:open="deleteTarget = null">
      <DialogContent class="max-w-[360px]">
        <DialogHeader>
          <DialogTitle>删除 {{ deleteTarget?.name }}？</DialogTitle>
          <DialogDescription>将移除其下所有模型配置。此操作不可撤销。</DialogDescription>
        </DialogHeader>
        <div class="flex justify-end gap-2 pt-4">
          <Button variant="ghost" @click="deleteTarget = null">取消</Button>
          <Button variant="danger" @click="deleteTarget = null">确认删除</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Settings, Plus, Pencil, Trash2, FileText, ImageIcon } from '@lucide/vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Label } from '@/components/ui/label'
import type { ProviderInfo } from '@xyz-agent/shared'
import ProviderEditModal from './ProviderEditModal.vue'

defineProps<{ providers: ProviderInfo[] }>()

// 上下文窗口格式化用的单位换算常量
const CONTEXT_K = 1000
const CONTEXT_M = 1_000_000

const expanded = ref(new Set<string>())
const editingProvider = ref<ProviderInfo | null>(null)
const deleteTarget = ref<ProviderInfo | null>(null)
const defaultProviderId = ref('anthropic')
const defaultModelId = ref('claude-sonnet-4')

function toggleExpand(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function setDefaultProvider(id: string) { defaultProviderId.value = id }
function setDefaultModel(id: string) { defaultModelId.value = id }
function cycleThinking(_pid: string, _mid: string) { /* mock */ }

function formatCtx(v?: number): string {
  if (!v) return '--'
  if (v >= CONTEXT_M) return `${(v / CONTEXT_M).toFixed(v % CONTEXT_M === 0 ? 0 : 1)}M`
  return `${Math.round(v / CONTEXT_K)}K`
}

function thinkingLabel(m: { thinkingLevelMap?: Record<string, string | null> }): string {
  if (!m.thinkingLevelMap) return '开关'
  const v = Object.values(m.thinkingLevelMap)[0]
  if (v === null || v === undefined) return '开关'
  if (v.includes('xhigh') || v.includes('high')) return '高/顶'
  return '全档'
}

function thinkingPillClass(m: { thinkingLevelMap?: Record<string, string | null> }): string {
  const label = thinkingLabel(m)
  if (label === '全档') return 'bg-info/10 text-info'
  if (label === '高/顶') return 'bg-accent-soft text-accent'
  return 'bg-surface text-muted'
}

function statusDot(status: ProviderInfo['status']): string {
  const map = { connected: 'bg-success', not_configured: 'bg-subtle', error: 'bg-danger' }
  return map[status]
}
</script>
