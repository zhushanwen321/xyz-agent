# P1 Gap Fix — Mock 数据泄漏 + 功能补全 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `npm run tauri dev` 时 mock 数据泄漏问题，补全 spec v3 中 P1 范围内的缺失功能点。

**Architecture:** 前端 Settings 组件当前直接 import `mock/data.ts`，需改为从 Sidecar WS 获取。WS 协议补全 context.update / session.compact 等消息类型。Sidecar 当前使用 Subprocess RPC，暂保持不变（Direct SDK 迁移是独立大任务，不在此计划范围内）。

**Tech Stack:** Vue 3, Pinia, WebSocket, Tauri v2, TypeScript

---

## 问题清单

### P0 — Mock 数据泄漏 (阻塞正常开发)

**根因**：4 个 Settings 组件 + App.vue 直接 `import { mockXxx } from '../../mock/data'`，不经过 WS。`npm run tauri dev` 时 sidecar 正常启动但前端仍然显示 mock 数据。

| 文件 | 硬编码的 mock import |
|------|---------------------|
| `App.vue` | `mockSubAgentTree, mockDoneItems, mockAlertItems, mockOverviewCards` |
| `ProviderPane.vue` | `mockProviders, mockModels` |
| `SkillsPane.vue` | `mockSkills` |
| `AgentsPane.vue` | `mockAgents, mockModels, mockGlobalParams` |
| `ProviderCard.vue` | `type MockProvider, MockModel` (类型依赖) |
| `ProviderModal.vue` | `type MockProvider, MockModel` (类型依赖) |
| `SkillCard.vue` | `type MockAgent` → 实际是 `MockSkill` |
| `AgentCard.vue` | `type MockAgent` |

**修复策略**：
1. 所有 Settings 组件改为从 Pinia store 获取数据，store 通过 WS 与 sidecar 通信
2. Mock 数据仅通过 `mock-ws.ts` 在 `VITE_MOCK=true` 时注入，不直接被组件 import
3. `mock/data.ts` 中的类型（MockProvider、MockModel 等）迁移到 `shared/` 包，去掉 "Mock" 前缀

### P1 — 功能缺失

| # | 缺失功能 | Spec 章节 |
|---|---------|----------|
| 1 | WriteToolRenderer | §4.4.2 |
| 2 | useSession composable | §4.3/§7.1 |
| 3 | WS 协议补全 (context.update, session.compact, session.clear, message.thinking_start/end, message.status, message.tool_call_pending, session.compacting) | §5.2-5.3 |
| 4 | Settings store 缺 toolPermissions 字段 + ToolPermissions.vue | §4.6.1 |
| 5 | Settings store theme 缺 'system' 选项 | §3.3 |
| 6 | ContextBar 自动压缩 (>85%) | §4.5.2 |
| 7 | Sidebar Session CRUD + 搜索 + 虚拟滚动 | §4.3 |

### P2 — 不在本计划范围

| 项目 | 原因 |
|------|------|
| Sidecar Direct SDK (pi-bridge.ts) | 大架构变更，独立计划 |
| project-context.ts | 依赖 Direct SDK |
| vue-sonner 替换 ToastContainer | UI 不阻塞功能 |
| @tanstack/vue-virtual 虚拟滚动 | 性能优化，不影响功能 |
| Sidecar 崩溃重启 | Rust 侧健壮性 |
| StreamingText.vue (逐字光标) | 视觉增强 |

---

## 文件结构

### 新增文件

```
shared/src/settings.ts          — ToolPermission 类型 + Settings 相关类型
src/src/composables/useSession.ts — Session CRUD composable
src/src/stores/provider.ts      — Provider + Model 状态 store (从 mock 数据解耦)
src/src/components/chat/ToolRenderers/WriteToolRenderer.vue — 第 5 个渲染器
src/src/components/settings/ToolPermissions.vue — 工具权限配置 Tab
```

### 修改文件

```
shared/src/protocol.ts          — 补全 WS 消息类型
shared/src/index.ts             — 导出新类型
src/src/App.vue                 — 移除 mock import，使用 store 数据
src/src/stores/settings.ts      — 加 toolPermissions + theme 'system'
src/src/stores/chat.ts          — 加 contextLimit / contextUsagePercent
src/src/components/settings/ProviderPane.vue  — 从 store 获取数据
src/src/components/settings/SkillsPane.vue    — 从 store 获取数据
src/src/components/settings/AgentsPane.vue    — 从 store 获取数据
src/src/components/settings/ProviderCard.vue  — 用 shared 类型替换 Mock 类型
src/src/components/settings/ProviderModal.vue — 用 shared 类型替换 Mock 类型
src/src/components/settings/SkillCard.vue     — 用 shared 类型替换 Mock 类型
src/src/components/settings/AgentCard.vue     — 用 shared 类型替换 Mock 类型
src/src/components/settings/index.ts          — 导出 ToolPermissions
src/src/components/layout/SettingsView.vue    — 加工具权限 Tab
src/src/components/chat/ContextBar.vue         — 自动压缩逻辑
src/src/composables/useChat.ts                — 监听 context.update
src/src/mock/mock-ws.ts                       — 补全新消息类型的模拟
sidecar/src/server.ts                         — 补全新消息路由
sidecar/src/session-pool.ts                   — compact/clear 方法
```

---

## Task 1: 补全 WS 协议类型 (shared/protocol.ts)

**Files:**
- Modify: `shared/src/protocol.ts`
- Modify: `shared/src/settings.ts` (新建)
- Modify: `shared/src/index.ts`
- Modify: `shared/src/provider.ts`

- [ ] **Step 1: 补全 shared/src/protocol.ts**

在 `ClientMessageType` 中新增:
```typescript
export type ClientMessageType =
  | 'session.create' | 'session.delete' | 'session.list' | 'session.switch' | 'session.history'
  | 'session.compact' | 'session.clear'              // 新增
  | 'message.send' | 'message.abort'
  | 'config.getProviders' | 'config.setProvider' | 'config.deleteProvider'
  | 'config.setToolPermissions'                       // 新增
  | 'model.list' | 'model.switch'
  | 'tool.approve' | 'tool.deny' | 'tool.always_allow'
  | 'ping'
```

在 `ServerMessageType` 中新增:
```typescript
export type ServerMessageType =
  | 'session.created' | 'session.deleted' | 'session.list' | 'session.history'
  | 'session.compacting'                              // 新增
  | 'message.text_delta' | 'message.thinking_delta'
  | 'message.thinking_start' | 'message.thinking_end' // 新增
  | 'message.tool_call_start' | 'message.tool_call_end'
  | 'message.tool_call_pending'                       // 新增
  | 'message.complete' | 'message.error'
  | 'message.status'                                  // 新增
  | 'config.providers' | 'config.providerUpdated'
  | 'context.update'                                  // 新增
  | 'model.list' | 'model.switched'
  | 'pong' | 'error'
```

- [ ] **Step 2: 创建 shared/src/settings.ts**

```typescript
export type ToolPermission = 'allow' | 'ask' | 'deny'

export type ThemeMode = 'light' | 'dark' | 'system'
```

- [ ] **Step 3: 更新 shared/src/provider.ts — ModelInfo 补全**

```typescript
export interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerName: string
  tags?: string[]          // 新增: 如 'fast', 'reasoning'
  contextWindow?: number   // 新增: 上下文窗口 token 数
  enabled?: boolean        // 新增: 是否启用
}
```

- [ ] **Step 4: 更新 shared/src/index.ts 导出**

新增:
```typescript
export type { ToolPermission, ThemeMode } from './settings'
```

- [ ] **Step 5: 验证编译**

Run: `cd ~/Code/xyz-agent && npx tsc --noEmit -p shared/tsconfig.json`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add shared/
git commit -m "feat: complete WS protocol types — add compact/clear/context.update/tool_call_pending/thinking events"
```

---

## Task 2: 创建 Provider Store — 从 mock 数据解耦

**Files:**
- Create: `src/src/stores/provider.ts`

**目标**: 将 ProviderPane/SkillsPane/AgentsPane 从直接 import mock 数据改为从 store 读取。Store 的数据源是 WS 事件（sidecar 推送或 mock-ws 模拟）。

- [ ] **Step 1: 创建 src/src/stores/provider.ts**

```typescript
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'

export const useProviderStore = defineStore('provider', () => {
  const providers = ref<ProviderInfo[]>([])
  const models = ref<ModelInfo[]>([])
  const skills = ref<SkillInfo[]>([])
  const agents = ref<AgentInfo[]>([])

  function setProviders(list: ProviderInfo[]) { providers.value = list }
  function setModels(list: ModelInfo[]) { models.value = list }
  function setSkills(list: SkillInfo[]) { skills.value = list }
  function setAgents(list: AgentInfo[]) { agents.value = list }

  const enabledModels = computed(() => models.value.filter(m => m.enabled !== false))

  return {
    providers, models, skills, agents,
    setProviders, setModels, setSkills, setAgents,
    enabledModels,
  }
})
```

其中 `SkillInfo` 和 `AgentInfo` 类型需要定义（从 mock/data.ts 的 MockSkill / MockAgent 剥离业务无关字段）。

- [ ] **Step 2: 在 shared/src/ 补充 SkillInfo / AgentInfo 类型**

在 `shared/src/provider.ts` 末尾添加:

```typescript
export interface SkillInfo {
  id: string
  name: string
  description: string
  enabled: boolean
  source: string           // 如 'pi-agent', 'project', 'custom'
  triggers: string[]       // 触发词
}

export interface AgentInfo {
  id: string
  name: string
  description: string
  enabled: boolean
  modelStrategy: string
  icon?: string
}
```

- [ ] **Step 3: Commit**

```bash
git add src/src/stores/provider.ts shared/src/provider.ts shared/src/index.ts
git commit -m "feat: add provider store + SkillInfo/AgentInfo shared types"
```

---

## Task 3: 解耦 Settings 组件 — ProviderPane 从 store 读取

**Files:**
- Modify: `src/src/components/settings/ProviderPane.vue`
- Modify: `src/src/components/settings/ProviderCard.vue`
- Modify: `src/src/components/settings/ProviderModal.vue`
- Modify: `src/src/components/settings/ModelRow.vue`

- [ ] **Step 1: 修改 ProviderPane.vue — 用 store 替换 mock import**

将:
```typescript
import type { MockProvider, MockModel } from '../../mock/data'
import { mockProviders, mockModels } from '../../mock/data'
const providers = ref<MockProvider[]>([...mockProviders])
const models = ref<MockModel[]>(mockModels.map(m => ({ ...m })))
```

改为:
```typescript
import { useProviderStore } from '../../stores/provider'
const providerStore = useProviderStore()
const providers = computed(() => providerStore.providers)
const models = computed(() => providerStore.models)
```

所有操作函数（toggleProvider, toggleModel 等）改为通过 `send()` 发 WS 消息。

- [ ] **Step 2: 修改 ProviderCard.vue — 用 shared 类型替换 Mock 类型**

将 `import type { MockProvider, MockModel } from '../../mock/data'` 改为 `import type { ProviderInfo, ModelInfo } from '@xyz-agent/shared'`，更新 props 类型。

- [ ] **Step 3: 修改 ProviderModal.vue — 同上**

- [ ] **Step 4: 修改 ModelRow.vue — 用 shared 的 ModelInfo**

- [ ] **Step 5: 验证 tauri dev 编译**

Run: `npm run dev:vite`
Expected: 无编译错误

- [ ] **Step 6: Commit**

```bash
git add src/src/components/settings/
git commit -m "fix: decouple ProviderPane from mock data — read from provider store"
```

---

## Task 4: 解耦 Settings 组件 — SkillsPane + AgentsPane

**Files:**
- Modify: `src/src/components/settings/SkillsPane.vue`
- Modify: `src/src/components/settings/AgentsPane.vue`
- Modify: `src/src/components/settings/SkillCard.vue`
- Modify: `src/src/components/settings/AgentCard.vue`

- [ ] **Step 1: 修改 SkillsPane.vue**

将 `import { mockSkills } from '../../mock/data'` 改为从 provider store 读取 `skills`。

- [ ] **Step 2: 修改 AgentsPane.vue**

将 `import { mockAgents, mockModels, mockGlobalParams } from '../../mock/data'` 改为从 provider store 读取 `agents` 和 `models`。GlobalParams 改为从 settings store 读取。

- [ ] **Step 3: 修改 SkillCard.vue / AgentCard.vue — 类型替换**

将 `import type { MockSkill } from '../../mock/data'` 改为 `import type { SkillInfo } from '@xyz-agent/shared'`。

- [ ] **Step 4: Commit**

```bash
git add src/src/components/settings/
git commit -m "fix: decouple SkillsPane/AgentsPane from mock data"
```

---

## Task 5: 解耦 App.vue — 移除 mock import

**Files:**
- Modify: `src/src/App.vue`

- [ ] **Step 1: 移除 App.vue 中的 mock 数据引用**

将:
```typescript
import { mockSubAgentTree, mockDoneItems, mockAlertItems, mockOverviewCards } from './mock/data'
const mockTreeNodes: any[] = mockSubAgentTree ? [mockSubAgentTree as any] : []
```

改为:
```typescript
// P4/P5 功能, 暂用空数据
const emptyTreeNodes: any[] = []
const emptyItems: any[] = []
```

同时更新模板中的 prop 绑定。

- [ ] **Step 2: 确认 tauri dev 启动无 mock 数据**

Run: `npm run dev`
Expected: Settings 页面为空（无 Provider/Skill/Agent），非 mock 模式下侧边栏为空

- [ ] **Step 3: 确认 mock:dev 仍正常**

Run: `npm run mock:dev`
Expected: Settings 页面显示 mock 数据（通过 mock-ws.ts 注入 store）

- [ ] **Step 4: 更新 mock-ws.ts — 在 mockConnect 中将 mock 数据推送到 store**

mock-ws.ts 的 `fireInitialData()` 中已有的 `respond()` 调用会把数据推到 event-bus。需要确认 useChat / useSession 等会处理这些事件并把数据写入 store。

如果 store 数据是通过 WS 事件注入的（config.providers / model.list / session.list），那 mock-ws 只需 emit 正确的事件即可。但 Provider store 的 `setProviders()` 需要在某个 composable 中监听 `config.providers` 事件调用。

新增 `src/src/composables/useProvider.ts` 完善（当前只有骨架），监听 WS 事件写入 store。

- [ ] **Step 5: Commit**

```bash
git add src/src/App.vue src/src/mock/ src/src/composables/useProvider.ts src/src/stores/provider.ts
git commit -m "fix: remove mock data from App.vue, mock data only via mock-ws events"
```

---

## Task 6: 补全 useSession composable

**Files:**
- Create: `src/src/composables/useSession.ts`
- Modify: `src/src/composables/useChat.ts` (监听 session.history 事件)

- [ ] **Step 1: 创建 useSession.ts**

```typescript
import { onMounted, onUnmounted } from 'vue'
import { useSessionStore } from '../stores/session'
import { useChatStore } from '../stores/chat'
import { send } from '../lib/ws-client'
import { on, off } from '../lib/event-bus'
import type { ServerMessage } from '@xyz-agent/shared'

export function useSession() {
  const sessionStore = useSessionStore()
  const chatStore = useChatStore()

  function loadSessions() {
    send({ type: 'session.list', payload: {} })
  }

  function createSession(cwd: string) {
    send({ type: 'session.create', payload: { cwd } })
  }

  function deleteSession(sessionId: string) {
    send({ type: 'session.delete', payload: { sessionId } })
  }

  function switchSession(sessionId: string) {
    sessionStore.switchSession(sessionId)
    send({ type: 'session.history', payload: { sessionId } })
  }

  function onSessionList(msg: ServerMessage) {
    const groups = msg.payload.groups as Array<{ cwd: string, sessions: any[] }>
    const all = groups.flatMap(g => g.sessions)
    sessionStore.setSessions(all)
  }

  function onSessionCreated(msg: ServerMessage) {
    const s = msg.payload as any
    sessionStore.addSession({
      id: s.session.id,
      label: s.session.label ?? 'New Session',
      cwd: s.session.cwd,
      status: 'active',
      lastActiveAt: Date.now(),
      modelId: '',
      tokenCount: 0,
    })
    sessionStore.switchSession(s.session.id)
  }

  function onSessionDeleted(msg: ServerMessage) {
    sessionStore.removeSession(msg.payload.sessionId as string)
  }

  function onSessionHistory(msg: ServerMessage) {
    chatStore.replaceMessages((msg.payload.messages as any[]) ?? [])
  }

  const handlers: Record<string, (msg: ServerMessage) => void> = {
    'session.list': onSessionList,
    'session.created': onSessionCreated,
    'session.deleted': onSessionDeleted,
    'session.history': onSessionHistory,
  }

  onMounted(() => {
    for (const [evt, fn] of Object.entries(handlers)) on(evt, fn)
  })
  onUnmounted(() => {
    for (const [evt, fn] of Object.entries(handlers)) off(evt, fn)
  })

  return { loadSessions, createSession, deleteSession, switchSession }
}
```

- [ ] **Step 2: 在 App.vue 中初始化 useSession + loadSessions**

在 `App.vue` 的 `onMounted` 中调用 `loadSessions()`。

- [ ] **Step 3: 验证 mock:dev 下侧边栏显示 mock sessions**

- [ ] **Step 4: Commit**

```bash
git add src/src/composables/useSession.ts src/src/App.vue
git commit -m "feat: add useSession composable — session CRUD via WS"
```

---

## Task 7: 补全 Settings Store + ToolPermissions

**Files:**
- Modify: `src/src/stores/settings.ts`
- Create: `src/src/components/settings/ToolPermissions.vue`
- Modify: `src/src/components/layout/SettingsView.vue`

- [ ] **Step 1: 补全 settings.ts**

```typescript
import type { ToolPermission, ThemeMode } from '@xyz-agent/shared'

// 在 store 内新增:
const theme = ref<ThemeMode>('system')   // 从 'light'|'dark' 扩展为三选
const toolPermissions = ref<Record<string, ToolPermission>>({
  read: 'allow', grep: 'allow', find: 'allow', ls: 'allow',
  bash: 'ask', edit: 'ask', write: 'ask',
})

function setToolPermission(tool: string, perm: ToolPermission) {
  toolPermissions.value = { ...toolPermissions.value, [tool]: perm }
}

// persist 添加 toolPermissions:
// persist: { pick: ['theme', 'locale', 'defaultModel', 'toolPermissions'] }
```

- [ ] **Step 2: 创建 ToolPermissions.vue**

Spec §4.6.1 的设计。表格列出所有工具名 + 权限 Select 下拉。底部 "重置为默认" 按钮。

```vue
<template>
  <div class="tool-permissions">
    <h3>工具权限</h3>
    <div v-for="(perm, tool) in settingsStore.toolPermissions" :key="tool" class="perm-row">
      <span class="tool-name">{{ tool }}</span>
      <Select
        :model-value="perm"
        :options="permissionOptions"
        @update:model-value="settingsStore.setToolPermission(tool, $event)"
      />
    </div>
    <Button variant="ghost" @click="resetDefaults">重置为默认</Button>
  </div>
</template>
```

- [ ] **Step 3: 在 SettingsView.vue 中注册第三个 Tab**

SettingsView 当前有 Provider / Skills / Agents 三个 Tab。新增 ToolPermissions 作为第四个。

- [ ] **Step 4: Commit**

```bash
git add src/src/stores/settings.ts src/src/components/settings/ToolPermissions.vue src/src/components/layout/SettingsView.vue
git commit -m "feat: add tool permissions config — settings store + ToolPermissions tab"
```

---

## Task 8: 补全 ContextBar 自动压缩

**Files:**
- Modify: `src/src/stores/chat.ts` — 加 contextLimit / contextUsagePercent
- Modify: `src/src/composables/useChat.ts` — 监听 context.update 事件
- Modify: `src/src/components/chat/ContextBar.vue` — 自动压缩逻辑

- [ ] **Step 1: 在 chat store 中新增 context 追踪**

```typescript
const contextLimit = ref(200000)       // 默认 200k tokens
const contextUsagePercent = ref(0)

function updateContextInfo(usagePercent: number, inputTokens: number, limit: number) {
  contextUsagePercent.value = usagePercent
  contextLimit.value = limit
}
```

导出 `contextUsagePercent` computed。

- [ ] **Step 2: 在 useChat.ts 中监听 context.update**

```typescript
function onContextUpdate(msg: ServerMessage) {
  chatStore.updateContextInfo(
    msg.payload.usagePercent as number,
    msg.payload.inputTokens as number,
    msg.payload.contextLimit as number,
  )
}
// 加入 eventMap: 'context.update': onContextUpdate
```

- [ ] **Step 3: ContextBar.vue 添加自动压缩**

```typescript
watch(() => chatStore.contextUsagePercent, (pct) => {
  if (pct > 85 && chatStore.isGenerating) {
    send({ type: 'session.compact', payload: { sessionId: sessionStore.currentSessionId! } })
    // Toast 提示
  }
})
```

- [ ] **Step 4: Commit**

```bash
git add src/src/stores/chat.ts src/src/composables/useChat.ts src/src/components/chat/ContextBar.vue
git commit -m "feat: context auto-compaction — listen context.update, trigger compact at 85%"
```

---

## Task 9: 补全 WriteToolRenderer

**Files:**
- Create: `src/src/components/chat/ToolRenderers/WriteToolRenderer.vue`
- Modify: `src/src/lib/register-tool-renderers.ts`

- [ ] **Step 1: 创建 WriteToolRenderer.vue**

与 ReadToolRenderer 类似，但显示 "写入" 标识 + 目标路径 + 内容折叠。

```vue
<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  toolName: string
  input: Record<string, unknown>
  output?: string
  status: 'running' | 'completed' | 'error'
  expanded: boolean
}>()

const isExpanded = ref(props.expanded)
</script>

<template>
  <div class="write-tool-renderer">
    <div class="write-header" @click="isExpanded = !isExpanded">
      <span class="tool-icon">W</span>
      <span class="file-path">{{ input.path }}</span>
      <span class="status-badge" :class="status">{{ status }}</span>
    </div>
    <div v-if="isExpanded" class="write-content">
      <pre><code>{{ input.content }}</code></pre>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 注册到 tool-renderer-registry**

在 `register-tool-renderers.ts` 中添加:
```typescript
import WriteToolRenderer from '../components/chat/ToolRenderers/WriteToolRenderer.vue'
registry.register('write', WriteToolRenderer)
```

- [ ] **Step 3: Commit**

```bash
git add src/src/components/chat/ToolRenderers/WriteToolRenderer.vue src/src/lib/register-tool-renderers.ts
git commit -m "feat: add WriteToolRenderer — file write tool visualization"
```

---

## Task 10: 更新 mock-ws.ts — 补全新事件模拟

**Files:**
- Modify: `src/src/mock/mock-ws.ts`

- [ ] **Step 1: 在 fireInitialData 中推送 config.providers / model.list 到 store**

确保 mock-ws 的 respond 通过 event-bus 推送的事件能被 composable 监听并写入 store。当前 mock-ws 已有 session.list / message 模拟，需要补充:

1. `config.providers` — 推送 mockProviders（类型需对齐 shared ProviderInfo）
2. `model.list` — 推送 mockModels（类型需对齐 shared ModelInfo）

- [ ] **Step 2: 模拟 message.thinking_start / thinking_delta / thinking_end 流程**

在 `handleMessage` 的 `message.send` 分支中，先发送 thinking 事件再发送 text_delta。

- [ ] **Step 3: 验证 mock:dev 完整流程**

Run: `npm run mock:dev`
Expected:
- 侧边栏显示 3 个 session groups
- Settings → Provider 显示 5 个 mock providers
- Settings → Skills 显示 6 个 mock skills
- Settings → Agents 显示 4 个 mock agents
- 发送消息 → 思考 → 流式文本 → 工具调用 → 完成

- [ ] **Step 4: Commit**

```bash
git add src/src/mock/
git commit -m "fix: mock-ws push providers/models/skills via event-bus, simulate thinking flow"
```

---

## Task 11: 集成验证 — 两种模式都正常

- [ ] **Step 1: tauri dev (非 mock) 验证**

Run: `npm run dev`
Expected:
- 应用启动，无 mock 数据
- 侧边栏空（无 session）
- Settings 页面空（无 provider/skill/agent），但结构完整（4 个 tab）
- Statusbar 显示 "Connecting..." 或 "Disconnected"（sidecar 尝试连接）

- [ ] **Step 2: mock:dev 验证**

Run: `npm run mock:dev`
Expected:
- 侧边栏有 mock sessions
- Settings 有 mock 数据
- Chat 可以发送消息并看到流式回复

- [ ] **Step 3: ESLint 全量检查**

Run: `npm run lint`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: P1 gap fix complete — mock isolation + missing features"
```

---

## 依赖关系

```
Task 1 (WS 协议类型)
  ├→ Task 2 (Provider Store)
  │    ├→ Task 3 (ProviderPane 解耦)
  │    ├→ Task 4 (SkillsPane/AgentsPane 解耦)
  │    └→ Task 10 (mock-ws 更新)
  ├→ Task 5 (App.vue 解耦) — 可与 Task 3/4 并行
  ├→ Task 6 (useSession) — 依赖 Task 1
  ├→ Task 7 (ToolPermissions) — 依赖 Task 1
  ├→ Task 8 (ContextBar) — 依赖 Task 1
  └→ Task 9 (WriteToolRenderer) — 无依赖

Task 11 (集成验证) — 依赖全部
```

**可并行组**:
- 组 A: Task 1 (基础)
- 组 B: Task 2 + Task 9 (并行)
- 组 C: Task 3 + Task 4 + Task 5 + Task 6 (并行)
- 组 D: Task 7 + Task 8 (并行)
- 组 E: Task 10
- 组 F: Task 11

## 预估工作量

| Task | 文件数 | 预估行数 | 复杂度 |
|------|--------|---------|--------|
| 1 | 4 | ~80 | 简单 |
| 2 | 3 | ~100 | 简单 |
| 3 | 4 | ~200 | 中等 |
| 4 | 4 | ~150 | 中等 |
| 5 | 2 | ~80 | 简单 |
| 6 | 2 | ~120 | 中等 |
| 7 | 3 | ~150 | 中等 |
| 8 | 3 | ~80 | 简单 |
| 9 | 2 | ~60 | 简单 |
| 10 | 1 | ~100 | 中等 |
| 11 | 0 | ~0 | 验证 |
| **总计** | **~20** | **~1120** | — |
