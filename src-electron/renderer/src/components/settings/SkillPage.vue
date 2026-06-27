<template>
  <!--
    Settings · Skill 菜单页（handoff-skill.md · 层 A 加载路径 + 层 B 只读预览）。
  -->
  <div class="flex flex-col gap-4">
    <!-- 层 A · 加载路径 -->
    <section>
      <h3 class="mb-2 text-[12px] font-medium text-fg">加载路径</h3>

      <!-- 强制目录 -->
      <div class="mb-2 rounded-md border border-border bg-bg">
        <div class="px-3 py-2 text-[11px] text-muted">强制目录（不可关闭）</div>
        <div v-for="dir in forcedDirs" :key="dir" class="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px]">
          <span class="size-4 shrink-0 rounded bg-surface-hover text-center text-[10px] leading-4 text-subtle">&#10003;</span>
          <span class="font-mono text-fg opacity-60">{{ dir }}</span>
          <span class="ml-auto text-[10px] text-subtle">强制</span>
        </div>
      </div>

      <!-- 可选目录 -->
      <div class="rounded-md border border-border bg-bg">
        <div class="px-3 py-2 text-[11px] text-muted">可选目录（可勾选、可拖动排序）</div>
        <div v-for="dir in optionalDirs" :key="dir.path" class="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px]">
          <span class="cursor-grab text-subtle hover:text-fg" title="拖动排序">&#x2801;&#x2801;</span>
          <Checkbox :model-value="dir.enabled" class="shrink-0" :aria-label="`启用目录 ${dir.path}`" />
          <span class="font-mono text-fg">{{ dir.path }}</span>
        </div>
      </div>
    </section>

    <!-- 层 B · Skill 只读预览 -->
    <section>
      <!-- 来源 tab 过滤 -->
      <div class="mb-2 flex items-center gap-2">
        <h3 class="text-[12px] font-medium text-fg">已发现的 Skill</h3>
        <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-subtle">{{ filteredSkills.length }}</span>
        <Button
          variant="secondary"
          class="ml-1 gap-1.5 rounded-sm px-2 py-0.5 text-[11px] [&_svg]:size-3"
          :disabled="scanning"
          @click="onScan"
        >
          <RefreshCw v-if="scanning" class="animate-spin" />
          {{ scanning ? '扫描中…' : '重新扫描' }}
        </Button>
        <div class="ml-auto flex gap-0.5">
          <Button
            variant="ghost"
            v-for="tab in sourceTabs"
            :key="tab.id"
            class="h-auto rounded-sm px-2 py-0.5 text-[11px]"
            :class="activeSource === tab.id ? 'bg-surface-hover text-fg' : 'text-muted hover:text-fg'"
            @click="activeSource = tab.id"
          >{{ tab.label }}</Button>
        </div>
      </div>

      <p v-if="actionError" class="mb-2 text-[11px] text-danger">{{ actionError }}</p>

      <div v-if="!filteredSkills.length" class="py-8 text-center text-[12px] text-muted">未发现 Skill</div>

      <div v-for="sk in filteredSkills" :key="sk.id" class="flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-2">
        <span class="flex-1 truncate text-[12px] font-medium text-fg">{{ sk.name }}</span>
        <span class="rounded-sm px-1.5 py-0.5 text-[10px]" :class="sourceBadgeClass(sk.source)">{{ sk.source }}</span>
        <!-- 启用开关：Switch 原语，调 config.setSkill 持久化 enabled -->
        <Switch
          :model-value="sk.enabled"
          class="shrink-0"
          :aria-label="`${sk.name} 启用开关`"
          @click.stop
          @update:model-value="onToggleEnabled(sk, $event)"
        />
        <span v-if="sk.enabled" class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">生效</span>
        <span class="max-w-[200px] truncate text-[11px] text-subtle" :title="sk.description">{{ sk.description }}</span>
        <Button
          variant="ghost"
          class="size-5 shrink-0 rounded-sm p-0 text-subtle hover:bg-[rgba(239,68,68,0.12)] hover:text-danger [&_svg]:size-3"
          title="删除 Skill"
          @click.stop="deleteTarget = sk"
        >
          <Trash2 />
        </Button>
      </div>
    </section>

    <!-- 删除确认弹窗（hide-close：内容区已有「取消」按钮作为唯一关闭入口） -->
    <Dialog :open="!!deleteTarget" @update:open="deleteTarget = null">
      <DialogContent hide-close class="max-w-[360px]">
        <DialogHeader>
          <DialogTitle>删除 {{ deleteTarget?.name }}？</DialogTitle>
          <DialogDescription>将从已发现清单移除。此操作不可撤销。</DialogDescription>
        </DialogHeader>
        <div class="flex justify-end gap-2 pt-4">
          <Button variant="ghost" @click="deleteTarget = null">取消</Button>
          <Button variant="danger" :disabled="deleting" @click="confirmDelete">
            {{ deleting ? '删除中…' : '确认删除' }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { RefreshCw, Trash2 } from '@lucide/vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import type { SkillInfo } from '@xyz-agent/shared'
import { config } from '@/api'

const props = defineProps<{ skills: SkillInfo[] }>()

const forcedDirs = ['~/.xyz-agent/skills', '.xyz-agent/skills']
const optionalDirs = [
  { path: '~/.pi/agent/skills', enabled: true },
  { path: '~/.claude/skills', enabled: true },
  { path: '~/.agents/skills', enabled: true },
  { path: '.agents/skills', enabled: false },
]

const sourceTabs = [
  { id: 'all', label: '全部' },
  { id: 'pi', label: 'Pi' },
  { id: 'claude', label: 'Claude' },
  { id: 'agents', label: 'Agents' },
] as const

const activeSource = ref<string>('all')
const scanning = ref(false)
const deleting = ref(false)
const deleteTarget = ref<SkillInfo | null>(null)
const actionError = ref('')

const filteredSkills = computed(() =>
  activeSource.value === 'all'
    ? props.skills
    : props.skills.filter((s) => s.source === activeSource.value),
)

/** 重新扫描：config.scanSkills（请求-响应，结果经 onSkills 订阅推回持久态）。
 * sources 取当前启用的可选目录 + 强制目录（简化：传可选目录路径）。 */
async function onScan() {
  scanning.value = true
  actionError.value = ''
  try {
    await config.scanSkills(optionalDirs.filter((d) => d.enabled).map((d) => d.path))
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    scanning.value = false
  }
}

/** 启用开关 → config.setSkill（带 enabled，状态经 onSkills 订阅推回） */
async function onToggleEnabled(sk: SkillInfo, enabled: boolean) {
  actionError.value = ''
  try {
    await config.setSkill({ ...sk, enabled })
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}

/** 确认删除 → config.deleteSkill（状态经 onSkills 订阅推回） */
async function confirmDelete() {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  actionError.value = ''
  try {
    await config.deleteSkill(target.id)
    deleteTarget.value = null
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    deleting.value = false
  }
}

function sourceBadgeClass(source: string): string {
  const map: Record<string, string> = {
    pi: 'bg-accent-soft text-accent',
    claude: 'bg-amber-500/10 text-amber-500',
    agents: 'bg-emerald-500/10 text-emerald-500',
    piinstall: 'bg-violet-500/10 text-violet-500',
  }
  return map[source] ?? 'bg-surface text-muted'
}
</script>
