<template>
  <!--
    Settings · Skill 菜单页（handoff-skill.md · 层 A 加载路径 + 层 B 只读预览）。
    ADR-0020 §5：目录级管道模型——目录在 = 启用，无文件级开关。
    层 A 勾选/排序写 discovery.json（SSOT），层 B 只读预览扫描结果。
  -->
  <div class="flex flex-col gap-4">
    <!-- 层 A · 加载路径（共享组件，接 store skillDirs，emit 回写 store） -->
    <LoadPaths
      kind="skill"
      :forced-dirs="forcedDirs"
      :dirs="skillDirs"
      :disabled="false"
      @update-dirs="onUpdateDirs"
    />

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

      <!-- ADR §5：只读预览，无开关无 CRUD。来源 badge 链 + effective 标生效。 -->
      <div v-for="sk in filteredSkills" :key="sk.id" class="flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-2">
        <span class="flex-1 truncate text-[12px] font-medium text-fg">{{ sk.name }}</span>
        <!-- 来源 badge 链（多来源时展开，第一个标生效） -->
        <span
          v-for="(src, i) in skillSources(sk)"
          :key="src.source + src.sourcePath"
          class="rounded-sm px-1.5 py-0.5 text-[10px]"
          :class="[sourceBadgeClass(src.source), i === 0 ? 'ring-1 ring-inset ring-accent/40' : 'opacity-60']"
          :title="i === 0 ? '生效' : src.sourcePath"
        >{{ i === 0 ? `生效·${src.source}` : src.source }}</span>
        <!-- 单来源无 badge 链时，直接标 source + 生效 -->
        <span v-if="!skillSources(sk).length" class="rounded-sm px-1.5 py-0.5 text-[10px]" :class="sourceBadgeClass(sk.source)">{{ sk.source }}</span>
        <span v-if="sk.effective && !skillSources(sk).length" class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">生效</span>
        <span class="max-w-[200px] truncate text-[11px] text-subtle" :title="sk.description">{{ sk.description }}</span>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import LoadPaths from './LoadPaths.vue'
import type { SkillInfo, SkillDirConfig } from '@xyz-agent/shared'
import { config } from '@/api'

const props = defineProps<{
  skills: SkillInfo[]
  /** 加载路径配置（来自 settings store，ADR-0020 §1 discovery.json SSOT 视图） */
  skillDirs: SkillDirConfig[]
}>()

const emit = defineEmits<{
  /** 目录配置变更 → 父组件写回 store（setSkillDirs） */
  'update-skill-dirs': [dirs: SkillDirConfig[]]
}>()

// ADR-0020 §1.1 强制目录（桥接层硬编码注入，UI 只读）
const forcedDirs = ['~/.xyz-agent/skills', '.xyz-agent/skills']

const sourceTabs = [
  { id: 'all', label: '全部' },
  { id: 'pi', label: 'Pi' },
  { id: 'claude', label: 'Claude' },
  { id: 'agents', label: 'Agents' },
] as const

const activeSource = ref<string>('all')
const scanning = ref(false)
const actionError = ref('')

const filteredSkills = computed(() =>
  activeSource.value === 'all'
    ? props.skills
    : props.skills.filter((s) => s.source === activeSource.value),
)

/** 取 skill 的多来源 badge 链（ADR §5）；单来源时返回空数组（用主 source 标识）。 */
function skillSources(sk: SkillInfo): Array<{ source: string; sourcePath: string }> {
  return sk.sources ?? []
}

/** 加载路径变更（勾选/拖排序）→ emit 给父组件，由 SettingsModal 统一写 store（避免重复请求）。
 * 拖拽的即时性已由 LoadPaths 本地状态保证，这里只负责持久化（发后即忘）。 */
function onUpdateDirs(dirs: SkillDirConfig[]): void {
  actionError.value = ''
  emit('update-skill-dirs', dirs)
}

/** 重新扫描：config.scanSkills（请求-响应，结果经 onSkills 订阅推回持久态，裂缝①已修）。 */
async function onScan() {
  scanning.value = true
  actionError.value = ''
  try {
    await config.scanSkills(props.skillDirs.filter((d) => d.enabled).map((d) => d.path))
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    scanning.value = false
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
