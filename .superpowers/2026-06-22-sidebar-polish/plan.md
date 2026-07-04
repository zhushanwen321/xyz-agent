# Sidebar 打磨实现计划

> **给 agentic worker：** 必备子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 来逐任务执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 补齐 Sidebar 与 v3-demo 设计稿的 4 处差异（搜索入口、会话项 3 行、hover 操作、文件视图 mock）

**架构：** 沿现有分层（Component → Features → Store → API）扩展，不引入新架构。文件视图作为 Sidebar 的第二个子视图（与 SessionList 平级），通过 SegmentedTab 切换。

**技术栈：** Vue 3 + Pinia + Tailwind CSS + lucide-vue-next + xyz-ui（Button/Dialog/Input/ScrollArea）

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src-electron/renderer/src/components/sidebar/SessionItem.vue` | 会话项 3 行布局 + hover 操作按钮 |
| 修改 | `src-electron/renderer/src/components/sidebar/Sidebar.vue` | 添加搜索入口 + ⌘K 快捷键 + SearchModal 挂载 |
| 修改 | `src-electron/renderer/src/composables/features/useSidebar.ts` | 添加 renameSession / deleteSession 动作 |
| 修改 | `src-electron/renderer/src/api/domains/session.ts` | 添加 rename / remove API 方法 |
| 修改 | `src-electron/renderer/src/api/mock/index.ts` | mock 实现 rename / remove |
| 修改 | `src-electron/renderer/src/api/mock/data.ts` | 添加 fixtureFileChanges + mock 文件树 |
| 修改 | `src-electron/renderer/src/stores/session.ts` | 添加 updateLabel / removeFromList |
| 创建 | `src-electron/renderer/src/components/sidebar/FileView.vue` | 文件视图组件（树形目录 + M/A/D 状态） |
| 修改 | `src-electron/renderer/src/components/sidebar/SegmentedTab.vue` | 无需改动，已支持 files tab |

---

## 任务 1: 会话信息 3 行布局

**文件：**
- 修改：`src-electron/renderer/src/components/sidebar/SessionItem.vue`

**设计稿参考：** `docs/designs/v3-demo/sidebar/draft-five-states.html` §A 会话项

- [ ] **步骤 1：修改模板为 3 行布局**

将 SessionItem.vue 的 `<div class="min-w-0">` 块改为：

```vue
<div class="min-w-0 flex-1">
  <div
    class="truncate text-[12.5px] leading-[1.35]"
    :class="active ? 'text-accent' : 'text-fg'"
  >
    {{ session.label }}
  </div>
  <div class="mt-0.5 truncate font-mono text-[10.5px] leading-[1.3] text-subtle">
    {{ dirName }}
  </div>
  <div v-if="session.gitBranch" class="mt-0.5 font-mono text-[10.5px] leading-[1.3] text-accent truncate">
    {{ session.gitBranch }}
  </div>
</div>
```

- [ ] **步骤 2：调整时间列对齐**

将时间列的 `pt-0.5` 改为 `pt-1`，使其与第 3 行（分支行）底部对齐：

```vue
<span class="shrink-0 pt-1 font-mono text-[10px] leading-[1.35] text-subtle group-hover:invisible">
  {{ timeLabel }}
</span>
```

- [ ] **步骤 3：验证视觉效果**

运行 `npm run dev`，检查 Sidebar 会话项是否显示 3 行（标题/目录/分支），分支行是否与时间列底部对齐。

- [ ] **步骤 4：提交**

```bash
git add src-electron/renderer/src/components/sidebar/SessionItem.vue
git commit -m "feat(sidebar): session item 3-line layout (title/dir/branch)"
```

---

## 任务 2: 搜索按钮入口

**文件：**
- 修改：`src-electron/renderer/src/components/sidebar/Sidebar.vue`

**设计稿参考：** `docs/designs/v3-demo/sidebar/draft-five-states.html` `.a-nav` 区

- [ ] **步骤 1：添加 searchOpen 状态和 SearchModal 导入**

在 `<script setup>` 中添加：

```typescript
import { ref } from 'vue'
import SearchModal from '@/components/overlays/SearchModal.vue'

const searchOpen = ref(false)
```

- [ ] **步骤 2：在 nav 区添加搜索按钮**

在新建任务按钮后面添加：

```vue
<Button
  variant="ghost"
  class="group h-auto justify-start gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-muted hover:bg-surface-hover hover:text-fg"
  @click="searchOpen = true"
>
  <Search class="size-[15px] text-subtle transition-colors group-hover:text-muted" />
  <span class="flex-1 text-left">搜索</span>
  <kbd class="rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle">⌘ K</kbd>
</Button>
```

需要从 lucide 导入 Search 图标：

```typescript
import { Plus, LayoutGrid, Search } from '@lucide/vue'
```

- [ ] **步骤 3：在模板底部挂载 SearchModal**

在 `</div>` 闭合标签之前添加：

```vue
<SearchModal v-model:open="searchOpen" />
```

- [ ] **步骤 4：添加 ⌘K 快捷键**

在 `useEventListener` 的 keydown handler 中添加：

```typescript
} else if (e.key === 'k' || e.key === 'K') {
  e.preventDefault()
  searchOpen.value = true
}
```

- [ ] **步骤 5：更新注释，移除 DEFERRED 标记**

删除模板注释中的 `搜索（⌘K，G-022）` DEFERRED 说明。

- [ ] **步骤 6：验证功能**

运行 `npm run dev`，点击搜索按钮和按 ⌘K，确认 SearchModal 弹出。

- [ ] **步骤 7：提交**

```bash
git add src-electron/renderer/src/components/sidebar/Sidebar.vue
git commit -m "feat(sidebar): add search button + ⌘K shortcut"
```

---

## 任务 3: hover 操作按钮（重命名/删除）

**文件：**
- 修改：`src-electron/renderer/src/components/sidebar/SessionItem.vue`
- 修改：`src-electron/renderer/src/composables/features/useSidebar.ts`
- 修改：`src-electron/renderer/src/api/domains/session.ts`
- 修改：`src-electron/renderer/src/api/mock/index.ts`
- 修改：`src-electron/renderer/src/api/mock/data.ts`
- 修改：`src-electron/renderer/src/stores/session.ts`

**设计稿参考：** `docs/designs/v3-demo/sidebar/draft-five-states.html` `.a-actions` 区

### 任务 3.1: API 层

- [ ] **步骤 1：添加 session.rename 和 session.remove API**

在 `src-electron/renderer/src/api/domains/session.ts` 中添加：

```typescript
/** 重命名 session */
export function rename(sessionId: string, label: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'session.rename', id, payload: { sessionId, label } })
  return result
}

/** 删除 session */
export function remove(sessionId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'session.delete', id, payload: { sessionId } })
  return result
}
```

- [ ] **步骤 2：mock 实现**

在 `src-electron/renderer/src/api/mock/index.ts` 中添加 rename 和 delete 的 mock：

```typescript
import { fixtureSessions, fixtureMessages, createSession } from './data'

// 在 mock 对象中添加
rename: async (sessionId: string, label: string) => {
  const session = fixtureSessions.find(s => s.id === sessionId)
  if (session) session.label = label
},

remove: async (sessionId: string) => {
  const idx = fixtureSessions.findIndex(s => s.id === sessionId)
  if (idx !== -1) {
    fixtureSessions.splice(idx, 1)
    delete fixtureMessages[sessionId]
  }
},
```

### 任务 3.2: Store 层

- [ ] **步骤 3：添加 session store 操作**

在 `src-electron/renderer/src/stores/session.ts` 中添加：

```typescript
/** 更新 session label（乐观更新） */
function updateLabel(id: string, label: string): void {
  const session = list.value.find(s => s.id === id)
  if (session) session.label = label
}

/** 从列表移除 session */
function removeFromList(id: string): void {
  list.value = list.value.filter(s => s.id !== id)
  if (activeId.value === id) {
    activeId.value = list.value[0]?.id ?? null
  }
}
```

### 任务 3.3: Features 层

- [ ] **步骤 4：添加 useSidebar 动作**

在 `src-electron/renderer/src/composables/features/useSidebar.ts` 中添加：

```typescript
/** 重命名 session（API + 乐观更新 store） */
async function renameSession(id: string, label: string): Promise<void> {
  await sessionApi.rename(id, label)
  session.updateLabel(id, label)
}

/** 删除 session（API + 从列表移除） */
async function deleteSession(id: string): Promise<void> {
  await sessionApi.remove(id)
  session.removeFromList(id)
  chat.clearSession(id)  // 需要确认 chat store 是否有此方法
  // 如果当前删除的是 active session，切换到列表第一个
  if (session.activeId === id) {
    const next = session.list[0]
    if (next) await selectSession(next.id)
  }
}
```

### 任务 3.4: 组件层

- [ ] **步骤 5：SessionItem 添加 hover 操作按钮**

在 SessionItem.vue 模板的时间列旁边添加：

```vue
<!-- hover 操作按钮（重命名/删除） -->
<div class="hidden gap-1 pt-0.5 group-hover:flex">
  <button
    class="flex size-[22px] items-center justify-center rounded-[5px] border border-border-strong bg-surface text-muted transition-colors hover:bg-surface-hover hover:text-fg"
    @click.stop="emit('rename', session.id)"
  >
    <Pencil class="size-[13px]" />
  </button>
  <button
    class="flex size-[22px] items-center justify-center rounded-[5px] border border-border-strong bg-surface text-muted transition-colors hover:bg-surface-hover hover:text-danger"
    @click.stop="emit('delete', session.id)"
  >
    <Trash2 class="size-[13px]" />
  </button>
</div>
```

导入图标：

```typescript
import { Pencil, Trash2 } from 'lucide-vue-next'
```

添加 emit：

```typescript
const emit = defineEmits<{
  select: [sessionId: string]
  rename: [sessionId: string]
  delete: [sessionId: string]
}>()
```

- [ ] **步骤 6：SessionList 传递事件**

在 `SessionList.vue` 中添加 emit 声明和传递：

```typescript
const emit = defineEmits<{
  select: [sessionId: string]
  rename: [sessionId: string]
  delete: [sessionId: string]
  newSession: []
}>()
```

模板中：

```vue
<SessionItem
  ...
  @rename="emit('rename', $event)"
  @delete="emit('delete', $event)"
/>
```

- [ ] **步骤 7：Sidebar 处理事件**

在 `Sidebar.vue` 中：

```vue
<SessionList
  ...
  @rename="onRenameSession"
  @delete="onDeleteSession"
/>
```

```typescript
async function onRenameSession(id: string): void {
  // TODO: 弹出重命名对话框（当前先用 prompt）
  const label = window.prompt('输入新名称')
  if (label) await renameSession(id, label)
}

async function onDeleteSession(id: string): Promise<void> {
  if (window.confirm('确定删除此会话？')) {
    await deleteSession(id)
  }
}
```

- [ ] **步骤 8：验证功能**

运行 `npm run dev`，hover 会话项，确认操作按钮出现、时间隐藏。点击重命名/删除确认功能正常。

- [ ] **步骤 9：提交**

```bash
git add -A
git commit -m "feat(sidebar): session hover actions (rename/delete)"
```

---

## 任务 4: 文件视图 Mock

**文件：**
- 创建：`src-electron/renderer/src/components/sidebar/FileView.vue`
- 修改：`src-electron/renderer/src/api/mock/data.ts`
- 修改：`src-electron/renderer/src/components/sidebar/Sidebar.vue`

**设计稿参考：** `docs/designs/v3-demo/sidebar/draft-five-states.html` §B 文件视图

### 任务 4.1: Mock 数据

- [ ] **步骤 1：定义文件变更类型**

在 `src-electron/shared/src/session.ts` 中添加：

```typescript
export type FileChangeType = 'M' | 'A' | 'D'

export interface FileChange {
  path: string
  type: FileChangeType
}

export interface FileTreeNode {
  name: string
  type: 'file' | 'dir'
  children?: FileTreeNode[]
  changeType?: FileChangeType
  expanded?: boolean
}
```

- [ ] **步骤 2：添加 fixtureFileChanges**

在 `src-electron/renderer/src/api/mock/data.ts` 中添加：

```typescript
import type { FileTreeNode } from '@xyz-agent/shared'

export const fixtureFileChanges: Record<string, FileTreeNode[]> = {
  s1: [
    {
      name: 'src',
      type: 'dir',
      expanded: true,
      children: [
        {
          name: 'auth',
          type: 'dir',
          expanded: true,
          children: [
            { name: 'index.ts', type: 'file', changeType: 'M' },
            { name: 'schema.ts', type: 'file', changeType: 'A' },
          ],
        },
        {
          name: 'components',
          type: 'dir',
          children: [
            { name: 'Login.vue', type: 'file', changeType: 'M' },
          ],
        },
      ],
    },
    { name: 'package.json', type: 'file', changeType: 'M' },
  ],
  s2: [
    {
      name: 'src',
      type: 'dir',
      expanded: true,
      children: [
        { name: '.eslintrc.cjs', type: 'file', changeType: 'M' },
      ],
    },
  ],
  s4: [],
  s5: [
    {
      name: 'src',
      type: 'dir',
      expanded: true,
      children: [
        {
          name: 'fsm',
          type: 'dir',
          expanded: true,
          children: [
            { name: 'state-machine.ts', type: 'file', changeType: 'M' },
            { name: 'transitions.ts', type: 'file', changeType: 'D' },
          ],
        },
      ],
    },
  ],
}
```

### 任务 4.2: FileView 组件

- [ ] **步骤 3：创建 FileView.vue 骨架**

创建 `src-electron/renderer/src/components/sidebar/FileView.vue`：

```vue
<template>
  <!--
    展示组件 · 文件视图（子视图 B，draft-five-states §B）。
    树形目录 + 文件列表，按扩展名着色，M/A/D 状态标签。
    数据来源：mock/data.ts 的 fixtureFileChanges，按 sessionId 索引。
  -->
  <ScrollArea class="file-view h-full">
    <div class="flex flex-col gap-0.5 px-1">
      <!-- 头部：改动文件计数 + 当前 session 信息 -->
      <div class="flex items-center gap-2 px-2 py-1.5">
        <span class="font-mono text-[10px] uppercase tracking-wider text-subtle">改动文件</span>
        <span class="rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle">
          {{ fileCount }}
        </span>
      </div>
      <div v-if="sessionLabel" class="truncate px-2 font-mono text-[10.5px] text-muted">
        {{ sessionLabel }} · {{ branch || 'main' }}
      </div>

      <!-- 文件树 -->
      <div class="mt-1 flex flex-col gap-px">
        <template v-for="node in tree" :key="node.name">
          <FileTreeNode
            :node="node"
            :depth="0"
            @toggle="toggleDir"
          />
        </template>
      </div>

      <!-- 空态 -->
      <div v-if="fileCount === 0" class="flex flex-col items-center justify-center gap-2 py-8 text-center">
        <FolderOpen class="size-5 text-subtle" />
        <p class="text-[11.5px] text-subtle opacity-55">暂无改动文件</p>
      </div>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FileTreeNode as FileTreeNodeType } from '@xyz-agent/shared'
import { FolderOpen } from 'lucide-vue-next'
import { ScrollArea } from '@/components/ui/scroll-area'
import FileTreeNode from './FileTreeNode.vue'

const props = defineProps<{
  tree: FileTreeNodeType[]
  sessionLabel?: string
  branch?: string
}>()

const fileCount = computed(() => countFiles(props.tree))

function countFiles(nodes: FileTreeNodeType[]): number {
  return nodes.reduce((sum, node) => {
    if (node.type === 'file') return sum + 1
    return sum + countFiles(node.children ?? [])
  }, 0)
}

function toggleDir(path: string): void {
  // TODO: 实现目录展开/折叠状态持久化
}
</script>
```

- [ ] **步骤 4：创建 FileTreeNode.vue 子组件**

创建 `src-electron/renderer/src/components/sidebar/FileTreeNode.vue`：

```vue
<template>
  <template v-if="node.type === 'dir'">
    <div
      class="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors hover:bg-surface-hover"
      :style="{ paddingLeft: `${depth * 10 + 8}px` }"
      @click="emit('toggle', node.name)"
    >
      <ChevronRight
        class="size-3 text-subtle transition-transform"
        :class="{ 'rotate-90': node.expanded }"
      />
      <Folder class="size-3.5 text-muted" />
      <span class="flex-1 truncate text-muted">{{ node.name }}</span>
      <span class="font-mono text-[9.5px] text-subtle">{{ childCount }}</span>
    </div>
    <template v-if="node.expanded && node.children">
      <FileTreeNode
        v-for="child in node.children"
        :key="child.name"
        :node="child"
        :depth="depth + 1"
        @toggle="emit('toggle', $event)"
      />
    </template>
  </template>
  <template v-else>
    <div
      class="flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-surface-hover"
      :style="{ paddingLeft: `${depth * 10 + 18}px` }"
    >
      <component :is="fileIcon" class="size-3.5" :class="fileIconColor" />
      <span class="flex-1 truncate font-mono text-[12px] text-fg">{{ node.name }}</span>
      <span v-if="node.changeType" class="rounded-sm px-1 py-0.5 font-mono text-[10px]" :class="changeBadgeClass">
        {{ node.changeType }}
      </span>
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { FileTreeNode } from '@xyz-agent/shared'
import { ChevronRight, Folder, FileText, FileCode, FileJson, FileType } from 'lucide-vue-next'

const props = defineProps<{
  node: FileTreeNode
  depth: number
}>()

const emit = defineEmits<{
  toggle: [name: string]
}>()

const childCount = computed(() => props.node.children?.length ?? 0)

const ext = computed(() => {
  const parts = props.node.name.split('.')
  return parts.length > 1 ? parts.pop()! : ''
})

const fileIcon = computed(() => {
  switch (ext.value) {
    case 'ts': case 'tsx': return FileCode
    case 'json': return FileJson
    default: return FileText
  }
})

const fileIconColor = computed(() => {
  switch (ext.value) {
    case 'ts': case 'tsx': return 'text-info'
    case 'vue': return 'text-success'
    case 'json': return 'text-warning'
    case 'md': return 'text-muted'
    default: return 'text-subtle'
  }
})

const changeBadgeClass = computed(() => {
  switch (props.node.changeType) {
    case 'M': return 'bg-warning/12 text-warning'
    case 'A': return 'bg-success/12 text-success'
    case 'D': return 'bg-danger/12 text-danger'
    default: return ''
  }
})
</script>
```

- [ ] **步骤 5：修改 Sidebar 集成 FileView**

在 `Sidebar.vue` 中：

```vue
<template v-else>
  <FileView
    :tree="fileTree"
    :session-label="currentSessionLabel"
    :branch="currentBranch"
  />
</template>
```

```typescript
import FileView from './FileView.vue'
import { fixtureFileChanges } from '@/api/mock/data'

const fileTree = computed(() => {
  return session.activeId ? fixtureFileChanges[session.activeId] ?? [] : []
})

const currentSession = computed(() =>
  session.list.find(s => s.id === session.activeId)
)

const currentSessionLabel = computed(() => currentSession.value?.label)
const currentBranch = computed(() => currentSession.value?.gitBranch)
```

- [ ] **步骤 6：验证文件视图**

运行 `npm run dev`，切换到文件 tab，确认：
- 会话 s1 显示完整的文件树（src/auth/...）
- M/A/D 状态标签颜色正确
- 文件图标按扩展名着色
- 空会话显示空态

- [ ] **步骤 7：提交**

```bash
git add -A
git commit -m "feat(sidebar): file view with mock tree + M/A/D status"
```

---

## 最终验证

- [ ] **全量检查**

1. `npm run dev` 启动开发模式
2. Sidebar 会话项显示 3 行（标题/目录/分支）
3. 点击搜索按钮或 ⌘K 弹出 SearchModal
4. hover 会话项显示重命名/删除按钮
5. 切换到文件 tab 显示文件树
6. `npm run lint` 无报错
7. `npm run typecheck` 无报错

- [ ] **最终提交**

```bash
git add -A
git commit -m "feat(sidebar): polish 4 items to match v3-demo design"
```
