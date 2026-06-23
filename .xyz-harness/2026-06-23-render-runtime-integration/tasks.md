# 派工单（Subagent 执行用）

> **本文件用途：** 这是给 **subagent-driven-development 控制器**用的派工单。每个 Task 是一次「派遣 implementer → spec review → code-quality review」的完整循环。
>
> **执行方式：** 控制器串行执行 Task 0 → 1 → 2 → ... → 7。每个 Task：① 把该 Task 的「Implementer Prompt」全文塞进 Task 工具 ② 收到 DONE 后派 spec-reviewer ③ spec 过后派 code-quality-reviewer ④ 都过后标记完成、进下一个。**不可并行派 implementer**（subagent-driven 铁律：会冲突）。
>
> **执行 worktree：** `~/Code/xyz-agent-workspace/refactor-arch-render-runtime`（分支同名）。所有路径相对 worktree 根。
>
> **完整规格来源：** 每个 Task 的 prompt 已内嵌该 Task 所需的全部代码和上下文（subagent **不读** plan.md/contract.md，控制器直接粘贴）。如需查证设计理由，控制器可读 `.xyz-harness/2026-06-23-render-runtime-integration/{plan,contract}.md`。

---

## 任务依赖图

```
T0 (WIP 提交)
 └─ T1 (events 全局通道 + routeInbound)  ← 订阅型 domain 的硬依赖
     └─ T2 (config+model+extension+plugin real domain 骨架)
         ├─ T3 (settings real domain 返工)
         │   └─ T4 (mock domain 对齐新契约 + 门面聚合)
         │       ├─ T5 (提取常量 + CommandPopover/ContextCapacityPopover 订阅骨架)
         │       │   └─ T6 (ModelSelectPopover/ThinkingLevelPopover + Composer 接线)
         │       │       └─ T7 (SettingsModal 订阅驱动返工)
         │       └─ T7
         └─ T4
```

**关键依赖：**
- T1 阻塞 T2+（real domain 的 `events.onGlobalType` 需 T1 先存在）
- T2 阻塞 T3（settings re-export config/extension）
- T2+T3 阻塞 T4（mock 签名必须与 real 一一对应）
- T4 阻塞 T5/T6/T7（组件/Modal 走 `@/api` 门面，需 mock+real 都就绪才能 `vue-tsc` 通过）

**总 Task 数：8（T0~T7）。** 每个 ≤5 文件、≤3000 行，满足 CLAUDE.md subagent 约束。

---

## 全局上下文（每个 Implementer Prompt 都要带上的背景）

以下背景块**粘贴到每个 Task 的 Implementer Prompt 的「## Context」段**（按需裁剪，保留该 Task 相关部分）：

```
## Context

项目：xyz-agent，Electron + Vue3 + TS + Pinia 桌面 AI 编程助手。
执行目录：~/Code/xyz-agent-workspace/refactor-arch-render-runtime（worktree，分支同名）。
不要在 refactor-architecture-design 分支工作——那是早期状态。

前端架构分层（src-electron/renderer/src/）：
- api/：门面层。index.ts 按 VITE_MOCK 切 real/mock（签名同构）。
  - domains/*.ts：real 实现（走 transport+pending+events）
  - mock/index.ts：mock 实现（内存 fixture + setTimeout）
  - events.ts：ServerMessage 订阅分发（session 路由 + 本次新增 global 通道）
  - transport.ts/pending.ts：出站管道 + 请求-响应 Promise 关联
- composables/useConnection.ts：入站分发器 routeInbound（transport→pending/events 桥）
- components/：Vue 组件。stores/：Pinia store。

协议 SSOT：src-electron/shared/src/protocol.ts（ClientMessageType 54 个 + ServerMessageType）。
关键认知：列表型数据（skills/agents/extensions/plugins/defaults）是纯 server-push 订阅，
后端无 get* 入口，sendInitialState 主动推。providers 有 config.getProviders 请求入口。

测试框架：vitest（禁止 node:test 和 tsx --test）。命令 npx vitest run。
类型检查：cd src-electron/renderer && npx vue-tsc --noEmit。
mock 模式：VITE_MOCK=true。Git commit 用英文。
全中文回答（思考也用中文）。
```

---

## Task 0：隔离未提交的 settings 变更为 WIP 提交

**目的：** worktree 当前有未提交的 settings 新增（6 组件 + 2 ts + 若干修改）。先 commit 一个 WIP，让后续 diff 干净。

**模型建议：** 便宜模型（纯 git 操作）。
**文件范围：** 0 新建（仅 git）。
**依赖：** 无（必须最先）。

### Implementer Prompt

```
You are implementing Task 0: 隔离未提交的 settings 变更为 WIP 提交

## Task Description

把 worktree 当前所有未提交变更（主要是新增的 settings 相关文件）提交为一个 WIP commit，建立干净基线。

## Context

[粘贴「全局上下文」块]

worktree 当前有大量未提交的 settings 新增（git status 会看到 ?? 的 settings.ts/settings-data.ts/5个Page.vue/ProviderEditModal.vue/ui/select/，以及 M 的 index.ts/mock/index.ts/SettingsModal.vue/AppShell.vue/Sidebar.vue/shared/settings.ts）。这些是上一轮刚落地的 settings 骨架，契约待后续 Task 返工。现在先整体提交隔离。

## Your Job

1. 运行 `cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime && git status --short`，确认未提交变更（记录到报告）。
2. 运行 `cd src-electron/renderer && npx vue-tsc --noEmit` 确认类型检查基线。若有 settings 相关报错，修复后继续（这些是新代码的基线问题，应修）。非 settings 的存量错误记录但不修。
3. 提交：
   ```bash
   cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime
   git add -A
   git commit -m "wip(settings): add settings domain skeleton + 5 sub-pages (contract pending rework)"
   ```
4. 确认 `git status` 干净，`git log -1` 显示新 commit。

## Report Format

报告：Status (DONE/BLOCKED)、git status 输出摘要、vue-tsc 是否有 settings 报错（如有，修了什么）、commit SHA。
```

### Spec Review 要点
- 是否所有 `??` 和 `M` 文件都进了 commit（git status 应干净）
- vue-tsc 的 settings 报错是否已修（不应带入已知类型错误）

---

## Task 1：events 全局通道 + routeInbound 分流

**目的：** 修复全局推送链路断裂——无 sessionId 的 server-push（config.providers/model.list/config.skills 等）不再被丢弃，走专用全局通道。
**模型建议：** 标准模型（TDD + 协议层，需理解 sessionId 隔离语义）。
**文件范围：** 2 改 + 1 新建测试 = 3 文件。
**依赖：** T0。

### Implementer Prompt

```
You are implementing Task 1: events 全局通道 + routeInbound 分流

## Task Description

修复前端全局推送链路断裂。当前 composables/useConnection.ts 的 routeInbound 只把有 sessionId 的消息 dispatch，无 sessionId 的（config.providers/model.list/config.skills/config.agents/config.plugins/config.extensions/config.defaults，共 7 条 sendInitialState 推送）被静默丢弃。新增 events.ts 的「全局通道」，routeInbound 按 sessionId 有无分流。

关键约束（CLAUDE.md line 98-108）：session 级消息的 sessionId 隔离规则不变。新增的是全局通道，不是放宽 sessionId 校验。两条通道互不串扰。

## Context

[粘贴「全局上下文」块]

现状代码（必读）：
- src-electron/renderer/src/api/events.ts：当前只有 on/off/dispatch（全按 sessionId 路由），35 行。
- src-electron/renderer/src/composables/useConnection.ts：routeInbound 函数在 line 38-49，
  关键行 `const sid = ...; if (sid) events.dispatch(sid, msg)` —— 无 sid 的消息被丢弃。

设计：events.ts 新增 globalAllHandlers（全类型）+ globalTypeHandlers（按 type）两个 Set/Map，
提供 onGlobal/onGlobalType/dispatchGlobal。routeInbound 改为：有 sid → dispatchSession，无 sid → dispatchGlobal。
保留 dispatch 旧名转发到 dispatchSession（向后兼容现有 chat.ts 的 events.on 调用）。

测试在 src-electron/renderer/src/__tests__/。参考现有 __tests__/useChat.test.ts 的 vitest 风格。

## Your Job（TDD）

1. 先写失败测试 src-electron/renderer/src/__tests__/events-global.test.ts：

```ts
import { describe, it, expect } from 'vitest'
import * as events from '../api/events'

describe('events 全局通道', () => {
  it('onGlobalType 注册后，dispatchGlobal 同 type 触发 handler，off 后不再触发', () => {
    const received: string[] = []
    const off = events.onGlobalType('config.skills', (msg) => {
      received.push(msg.type)
    })
    events.dispatchGlobal({ type: 'config.skills', payload: { skills: [] } })
    expect(received).toEqual(['config.skills'])
    off()
    events.dispatchGlobal({ type: 'config.skills', payload: { skills: [] } })
    expect(received).toEqual(['config.skills'])
  })

  it('onGlobal（全类型）收到所有 dispatchGlobal 消息', () => {
    const seen: string[] = []
    const off = events.onGlobal((msg) => seen.push(msg.type))
    events.dispatchGlobal({ type: 'config.providers', payload: {} })
    events.dispatchGlobal({ type: 'model.list', payload: {} })
    expect(seen).toEqual(['config.providers', 'model.list'])
    off()
  })

  it('dispatchSession 不触发 global handler（通道隔离）', () => {
    let globalHit = false
    const off = events.onGlobal(() => { globalHit = true })
    events.dispatchSession('sess-1', { type: 'message.text_delta', payload: { sessionId: 'sess-1' } })
    expect(globalHit).toBe(false)
    off()
  })

  it('dispatch（旧名）仍按 sessionId 路由，向后兼容', () => {
    const seen: string[] = []
    const off = events.on('sess-2', (msg) => seen.push(msg.type))
    events.dispatch('sess-2', { type: 'message.complete', payload: { sessionId: 'sess-2' } })
    expect(seen).toEqual(['message.complete'])
    off()
  })
})
```

2. 运行 `cd src-electron/renderer && npx vitest run src/__tests__/events-global.test.ts` 确认 FAIL（onGlobalType 不存在）。

3. 实现事件层：把 src-electron/renderer/src/api/events.ts 整体替换为：

```ts
/**
 * Events 层 —— ServerMessage 订阅分发。
 *
 * 两条独立通道：
 * - session 通道（on/off/dispatch/dispatchSession）：按 sessionId 路由。CLAUDE.md line 98
 *   要求 session 级消息必须含 sessionId。隔离规则不变。
 * - global 通道（onGlobal/onGlobalType/dispatchGlobal）：无 sessionId 的 server-push
 *   （config.providers / model.list / config.skills / config.agents / config.plugins /
 *   config.extensions / config.defaults）。sendInitialState 推 7 条 + 运行时广播。
 *
 * 两通道互不串扰。routeInbound（useConnection）按 payload.sessionId 有无决定走哪条。
 */
import type { ServerMessage } from '@xyz-agent/shared'

type MessageHandler = (msg: ServerMessage) => void

// ── session 通道（按 sessionId 路由）──
const sessionHandlers = new Map<string, Set<MessageHandler>>()

export function on(sessionId: string, handler: MessageHandler): () => void {
  let set = sessionHandlers.get(sessionId)
  if (!set) {
    set = new Set()
    sessionHandlers.set(sessionId, set)
  }
  set.add(handler)
  return () => off(sessionId, handler)
}

export function off(sessionId: string, handler: MessageHandler): void {
  sessionHandlers.get(sessionId)?.delete(handler)
}

/** 旧名兼容：转发到 dispatchSession */
export function dispatch(sessionId: string, msg: ServerMessage): void {
  dispatchSession(sessionId, msg)
}

export function dispatchSession(sessionId: string, msg: ServerMessage): void {
  sessionHandlers.get(sessionId)?.forEach((h) => h(msg))
}

// ── global 通道（无 sessionId 的 server-push）──
const globalAllHandlers = new Set<MessageHandler>()
const globalTypeHandlers = new Map<string, Set<MessageHandler>>()

export function onGlobal(handler: MessageHandler): () => void {
  globalAllHandlers.add(handler)
  return () => { globalAllHandlers.delete(handler) }
}

export function onGlobalType(type: string, handler: MessageHandler): () => void {
  let set = globalTypeHandlers.get(type)
  if (!set) {
    set = new Set()
    globalTypeHandlers.set(type, set)
  }
  set.add(handler)
  return () => { globalTypeHandlers.get(type)?.delete(handler) }
}

export function dispatchGlobal(msg: ServerMessage): void {
  globalAllHandlers.forEach((h) => h(msg))
  globalTypeHandlers.get(msg.type)?.forEach((h) => h(msg))
}
```

4. 运行测试确认 PASS：`cd src-electron/renderer && npx vitest run src/__tests__/events-global.test.ts`。

5. 修改 src-electron/renderer/src/composables/useConnection.ts 的 routeInbound 函数（当前 line 38-49）。只改这一个函数，其余不动。把整个 routeInbound 替换为：

```ts
function routeInbound(msg: ServerMessage): void {
  if (msg.id) {
    if (msg.type === 'error') {
      const message = typeof msg.payload?.message === 'string' ? msg.payload.message : 'request failed'
      pending.reject(msg.id, new Error(message))
    } else {
      pending.resolve(msg.id, msg.payload)
    }
  }
  const sid = typeof msg.payload?.sessionId === 'string' ? msg.payload.sessionId : undefined
  if (sid) {
    events.dispatchSession(sid, msg)
  } else {
    events.dispatchGlobal(msg)
  }
}
```

6. 类型检查：`cd src-electron/renderer && npx vue-tsc --noEmit`（应无错）。
7. 全量测试：`cd src-electron/renderer && npx vitest run`（全绿，现有测试不破坏）。
8. 提交：
```bash
cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime
git add src-electron/renderer/src/api/events.ts \
        src-electron/renderer/src/composables/useConnection.ts \
        src-electron/renderer/src/__tests__/events-global.test.ts
git commit -m "feat(events): add global channel for sessionless server-push (config.*/model.list)"
```

## Report Format

报告：Status、4 个测试是否全过、vue-tsc 结果、全量 vitest 结果、commit SHA、改了哪 3 个文件。
```

### Spec Review 要点
- events.ts 是否有 onGlobal/onGlobalType/dispatchGlobal 三个新 export + dispatch 旧名保留
- routeInbound 是否 `if (sid) dispatchSession else dispatchGlobal`（不是放宽 sid 校验）
- 测试是否覆盖：订阅触发、取消、通道隔离、旧名兼容

---

## Task 2：config + model + extension + plugin real domain 骨架

**目的：** 按 contract.md §2.3-2.6 的三类契约（请求/订阅/动作），建 4 个 real domain 文件。订阅型接口接 T1 新建的 `events.onGlobalType`。
**模型建议：** 标准模型（4 文件，需对照 protocol.ts 签名）。
**文件范围：** 4 新建。
**依赖：** T1（订阅接口需 events.onGlobalType）。

### Implementer Prompt

```
You are implementing Task 2: config + model + extension + plugin real domain 骨架

## Task Description

新建 4 个 real domain 文件，按三类契约（请求-响应 / 订阅-推送 / 动作-ack）实现。
订阅型（on*）接 events.onGlobalType；请求型接 pending+transport.send；动作型接 pending+transport.send（await 只为 catch 失败，状态变更靠订阅推回）。

## Context

[粘贴「全局上下文」块]

参考现有范式：
- 请求-响应：见 api/domains/session.ts 的 list()（pending.create + pending.register + transport.send）
- 订阅：events.onGlobalType(type, handler) 返回取消函数（Task 1 刚建）

协议 SSOT：src-electron/shared/src/protocol.ts。关键 ClientMessageType（本次用到）：
config.getProviders/setProvider/deleteProvider/discoverModels/scanSkills/setSkill/deleteSkill/
scanAgents/setAgent/deleteAgent；model.switch；extension.toggle。
关键 ServerMessageType（订阅源）：config.providers/config.skills/config.agents/config.defaults/
config.extensions/model.list/config.plugins。

shared 已导出类型：ProviderInfo/SkillInfo/AgentInfo/SetProviderData（从 protocol.ts/provider.ts），
ExtensionInfo（protocol.ts:265），PluginInfo（protocol.ts:288）。

类型来源若不确定，先读 protocol.ts 确认导出名，不要臆造。

## Your Job

新建以下 4 个文件（全部走 real transport，real 模式可用；mock 对齐在后续 Task 4）。

### 文件 1：src-electron/renderer/src/api/domains/config.ts

```ts
/**
 * Config 域 —— provider / skill / agent / defaults（请求 + 订阅 + 动作 混合）。
 * 形态：listProviders 请求；onProviders/onSkills/onAgents/onDefaults 订阅；
 *       set*/delete* 动作（状态变更由对应订阅通道推回）；
 *       scanSkills/scanAgents 请求（候选扫描）；discoverModels 请求。
 * 依赖方向：transport + pending（请求/动作）+ events（订阅）。
 */
import type {
  ProviderInfo,
  SkillInfo,
  AgentInfo,
  SetProviderData,
} from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'
import * as events from '../events'

// ── 请求-响应 ──
export function listProviders(): Promise<ProviderInfo[]> {
  const id = pending.create()
  const result = pending.register<ProviderInfo[]>(id)
  transport.send({ type: 'config.getProviders', id, payload: {} })
  return result
}

export function scanSkills(sources: string[]): Promise<SkillInfo[]> {
  const id = pending.create()
  const result = pending.register<SkillInfo[]>(id)
  transport.send({ type: 'config.scanSkills', id, payload: { sources } })
  return result
}

export function scanAgents(sources: string[]): Promise<AgentInfo[]> {
  const id = pending.create()
  const result = pending.register<AgentInfo[]>(id)
  transport.send({ type: 'config.scanAgents', id, payload: { sources } })
  return result
}

export function discoverModels(req: {
  baseUrl: string
  apiKey?: string
  providerType?: string
  providerId?: string
}): Promise<unknown> {
  const id = pending.create()
  const result = pending.register<unknown>(id)
  transport.send({ type: 'config.discoverModels', id, payload: req })
  return result
}

// ── 订阅-推送 ──
export function onProviders(handler: (providers: ProviderInfo[]) => void): () => void {
  return events.onGlobalType('config.providers', (msg) => {
    handler(msg.payload.providers as ProviderInfo[])
  })
}

export function onSkills(handler: (skills: SkillInfo[]) => void): () => void {
  return events.onGlobalType('config.skills', (msg) => {
    handler(msg.payload.skills as SkillInfo[])
  })
}

export function onAgents(handler: (agents: AgentInfo[]) => void): () => void {
  return events.onGlobalType('config.agents', (msg) => {
    handler(msg.payload.agents as AgentInfo[])
  })
}

export function onDefaults(handler: (defaultModel: string) => void): () => void {
  return events.onGlobalType('config.defaults', (msg) => {
    handler(msg.payload.defaultModel as string)
  })
}

// ── 动作-ack ──
export function setProvider(providerId: string, data: SetProviderData): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.setProvider', id, payload: { providerId, ...data } })
  return result
}

export function deleteProvider(providerId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.deleteProvider', id, payload: { providerId } })
  return result
}

export function setSkill(skill: SkillInfo): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.setSkill', id, payload: { skill } })
  return result
}

export function deleteSkill(skillId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.deleteSkill', id, payload: { skillId } })
  return result
}

export function setAgent(agent: AgentInfo): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.setAgent', id, payload: { agent } })
  return result
}

export function deleteAgent(agentId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.deleteAgent', id, payload: { agentId } })
  return result
}
```

### 文件 2：src-electron/renderer/src/api/domains/model.ts

```ts
/**
 * Model 域 —— 模型列表订阅 + 切换动作。
 * onModels 走订阅（sendInitialState 推 model.list）；switchModel 是动作
 * （确认由 model.switched 推回，本计划暂不订阅 switched）。
 * 依赖方向：events（订阅）+ transport + pending（动作）。
 */
import * as transport from '../transport'
import * as pending from '../pending'
import * as events from '../events'

/** 模型信息（从 model.list payload 推断；字段对照 runtime 确认） */
export interface ModelInfo {
  id: string
  name: string
  provider: string
  providerColor?: string
  tag?: string
}

export function onModels(handler: (models: ModelInfo[]) => void): () => void {
  return events.onGlobalType('model.list', (msg) => {
    handler(msg.payload.models as ModelInfo[])
  })
}

export function switchModel(
  sessionId: string,
  provider: string,
  modelId: string,
): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'model.switch', id, payload: { sessionId, provider, modelId } })
  return result
}
```

### 文件 3：src-electron/renderer/src/api/domains/extension.ts

```ts
/**
 * Extension 域 —— 本计划只建 onExtensions 订阅 + toggle 动作骨架。
 * install/uninstall 完整流程属后续真实集成，本计划不展开。
 * 依赖方向：events（订阅）+ transport + pending（动作）。
 */
import type { ExtensionInfo } from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'
import * as events from '../events'

export function onExtensions(handler: (extensions: ExtensionInfo[]) => void): () => void {
  return events.onGlobalType('config.extensions', (msg) => {
    handler(msg.payload.extensions as ExtensionInfo[])
  })
}

export function toggle(name: string, enabled: boolean): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'extension.toggle', id, payload: { name, enabled } })
  return result
}
```

### 文件 4：src-electron/renderer/src/api/domains/plugin.ts

```ts
/**
 * Plugin 域 —— 本计划只建 onPlugins 订阅骨架（解锁全局链路）。
 * toggle/install/permissions 等属后续真实集成。
 * 依赖方向：events（订阅）。
 */
import type { PluginInfo } from '@xyz-agent/shared'
import * as events from '../events'

export function onPlugins(handler: (plugins: PluginInfo[]) => void): () => void {
  return events.onGlobalType('config.plugins', (msg) => {
    handler(msg.payload.plugins as PluginInfo[])
  })
}
```

## 验证

1. 读 protocol.ts 确认 ProviderInfo/SkillInfo/AgentInfo/SetProviderData/ExtensionInfo/PluginInfo 都从 @xyz-agent/shared 可导入。若 SetProviderData 未 re-export，检查 shared/src/index.ts 的导出（如缺，在该 index 补 `export * from './protocol'` 或具体类型，不要在 domain 里改类型名）。
2. 类型检查：`cd src-electron/renderer && npx vue-tsc --noEmit`（应无错）。
3. 全量测试：`cd src-electron/renderer && npx vitest run`（全绿，新文件无副作用）。
4. 提交：
```bash
cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime
git add src-electron/renderer/src/api/domains/config.ts \
        src-electron/renderer/src/api/domains/model.ts \
        src-electron/renderer/src/api/domains/extension.ts \
        src-electron/renderer/src/api/domains/plugin.ts
git commit -m "feat(api): add config/model/extension/plugin real domain skeletons (request/subscribe/action contracts)"
```

## Report Format

报告：Status、4 文件是否创建、shared 类型是否都可用（若补了 index.ts 导出要说）、vue-tsc/vitest 结果、commit SHA。
```

### Spec Review 要点
- 4 个文件是否齐全，订阅型是否用 events.onGlobalType
- 是否有越界实现（install/uninstall/plugin toggle 等不该出现）
- 类型是否都从 @xyz-agent/shared 导入（不臆造）

---

## Task 3：settings real domain 返工

**目的：** 返工 settings.ts——删错误的 getSkills/getAgents/getExtensions Promise，改为转发 config/extension 域的订阅接口 + 纯前端 SystemSettings（localStorage）。
**模型建议：** 便宜模型（单文件返工，模式清晰）。
**文件范围：** 1 改（settings.ts）。
**依赖：** T2（re-export config/extension）。

### Implementer Prompt

```
You are implementing Task 3: settings real domain 返工

## Task Description

返工 src-electron/renderer/src/api/domains/settings.ts。当前它把 getSkills/getAgents/getExtensions 写成 Promise（错误——后端无对应 get 入口，这些是纯订阅）。改为：转发 config/extension 域的订阅接口；providers 保留请求入口；SystemSettings 走 localStorage（纯前端偏好，无后端）。

## Context

[粘贴「全局上下文」块]

现状（必须改）：settings.ts 当前是 getProviders/getSkills/getAgents/getExtensions/getSystem/updateSystem 全 Promise throw stub（约 30 行）。
目标：onProviders/onSkills/onAgents/onExtensions/onDefaults 转发 config/extension 域（Task 2 已建）；
listProviders/setProvider 转发 config 域；getSystem/updateSystem 走 localStorage。

settings.ts 是 SettingsModal 的统一数据入口（Modal 不直接散落 import config/extension）。
ExtensionInfo 来自 @xyz-agent/shared。

## Your Job

把 src-electron/renderer/src/api/domains/settings.ts 整体替换为：

```ts
/**
 * Settings 域 —— SettingsModal 数据源（返工：纠正订阅 vs 请求契约）。
 *
 * 返工前（错误）：getSkills/getAgents/getExtensions 全 Promise，real 模式后端不响应。
 * 返工后（正确）：providers 请求+订阅；skills/agents/extensions/defaults 纯订阅；
 *               setProvider 动作；system 纯前端 localStorage。
 *
 * 本域是 config/extension 订阅的薄封装，供 SettingsModal 统一从 @/api/settings 消费。
 */
import type { ExtensionInfo } from '@xyz-agent/shared'
import * as configDomain from './config'
import * as extensionDomain from './extension'

export interface SystemSettings {
  locale: 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
  themePreset: string
}

const SYSTEM_KEY = 'xyz-agent:system-settings'
const DEFAULT_SYSTEM: SystemSettings = { locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' }

// ── 订阅（转发 config / extension 域）──
export const onProviders = configDomain.onProviders
export const onSkills = configDomain.onSkills
export const onAgents = configDomain.onAgents
export const onExtensions = extensionDomain.onExtensions
export const onDefaults = configDomain.onDefaults

// ── 请求 ──
export const listProviders = configDomain.listProviders

// ── 动作 ──
export const setProvider = configDomain.setProvider

// ── 纯前端偏好（localStorage，不走 transport）──
export function getSystem(): Promise<SystemSettings> {
  const raw = localStorage.getItem(SYSTEM_KEY)
  let parsed: Partial<SystemSettings> = {}
  if (raw) {
    try { parsed = JSON.parse(raw) as Partial<SystemSettings> } catch { /* 损坏用默认 */ }
  }
  return Promise.resolve({ ...DEFAULT_SYSTEM, ...parsed })
}

export function updateSystem(patch: Partial<SystemSettings>): Promise<void> {
  void getSystem().then((cur) => {
    localStorage.setItem(SYSTEM_KEY, JSON.stringify({ ...cur, ...patch }))
  })
  return Promise.resolve()
}
```

## 验证

1. 类型检查：`cd src-electron/renderer && npx vue-tsc --noEmit`。
   注意：此时 api/index.ts 门面可能还指向旧 settings（mock 门面尚未对齐，Task 4 做）。
   若 index.ts 因 settings 签名变化报错，**先不改 index.ts**（Task 4 统一改），记录到报告。
   若只是 domains/settings.ts 自身类型无误即可。
2. 全量测试：`cd src-electron/renderer && npx vitest run`（若 index.ts 门面导致测试失败，记录但不在本 Task 修——Task 4 会同步 mock 和门面）。
3. 暂不提交（与 Task 4 mock 对齐后一起提交，避免中间态门面断裂）。报告里说明「待 Task 4 合并提交」。

## Report Format

报告：Status、settings.ts 是否替换、index.ts 是否有因签名变化的报错（预期有，记录）、vitest 结果、是否已提交（预期否，待 Task 4）。
```

### Spec Review 要点
- 是否删除了 getSkills/getAgents/getExtensions（不应再有这些 Promise）
- on* 是否都是转发（无重复实现）
- SystemSettings 是否走 localStorage（不走 transport）
- 是否遵守「暂不提交、不改 index.ts」

> **控制器注意：** Task 3 不单独提交。Task 3 完成后**立即**派 Task 4（mock + 门面），Task 4 完成后合并提交 settings.ts + mock + index.ts。spec review 对 Task 3 只审 settings.ts 文件本身。

---

## Task 4：mock domain 对齐 + 门面聚合（合并提交 Task 3）

**目的：** mock/index.ts 加 config/model/extension/plugin 块 + 返工 settings 块；api/index.ts 门面加 4 个新 domain。完成后与 Task 3 的 settings.ts 一起提交。
**模型建议：** 标准模型（多块 mock，需保证 real/mock 签名同构）。
**文件范围：** 2 改（mock/index.ts、api/index.ts）+ Task 3 的 settings.ts 合并。
**依赖：** T2 + T3。

### Implementer Prompt

```
You are implementing Task 4: mock domain 对齐 + 门面聚合

## Task Description

1. 在 src-electron/renderer/src/api/mock/index.ts 追加 config/model/extension/plugin 的 mock 实现，并返工 settings 块。
2. 修改 src-electron/renderer/src/api/index.ts 门面，聚合 4 个新 domain。
3. mock 与 real（Task 2/3 已建）签名必须一一对应（门面 isMock 三元要求两侧同构）。
4. 完成后提交（包含 Task 3 未提交的 settings.ts）。

## Context

[粘贴「全局上下文」块]

现状：
- mock/index.ts 已有 session、chat、settings（旧版，全 Promise get*）三块。顶部已定义 TIMING 常量（ack/startGap/chunk/done/switchCmd）和 sleep/emit 函数（line 25-68 区域）。本次追加的新块可直接用 sleep/TIMING。
- mock/index.ts 顶部 import 了 fixtureProviders/fixtureSkills/fixtureAgents/fixtureExtensions/fixtureSystem（from './settings-data'）。
- api/index.ts 当前聚合 session/chat/settings 三块（line 9-18）。
- Task 3 已改 domains/settings.ts（未提交），签名是 on*/listProviders/setProvider/getSystem/updateSystem。

real domain 签名（mock 必须对齐，见 Task 2/3 产出）：
- config: listProviders()/scanSkills(sources)/scanAgents(sources)/discoverModels(req)/onProviders(h)/onSkills(h)/onAgents(h)/onDefaults(h)/setProvider(id,data)/deleteProvider(id)/setSkill(skill)/deleteSkill(id)/setAgent(agent)/deleteAgent(id)
- model: onModels(h)/switchModel(sid,provider,modelId)
- extension: onExtensions(h)/toggle(name,enabled)
- plugin: onPlugins(h)
- settings: onProviders/onSkills/onAgents/onExtensions/onDefaults/listProviders/setProvider/getSystem/updateSystem

订阅型 mock 要点：注册后微任务触发一次初始值（模拟 sendInitialState 连接即推）。

## Your Job

### 步骤 1：在 mock/index.ts 追加 config/model/extension/plugin 块

在文件末尾（现有 settings 块之后）追加。注意：makeMockSubscription 是订阅型专用工厂；请求型直接返 fixture。

```ts
/* ── Config mock（订阅型：注册即触发初始值，模拟 sendInitialState）── */

type GlobalHandler<T> = (data: T) => void

/** mock 订阅工厂：注册后微任务触发一次初始值（模拟 sendInitialState 连接即推）。请求型不用这个。 */
function makeMockSubscription<T>(initial: () => T) {
  const handlers = new Set<GlobalHandler<T>>()
  return {
    subscribe(handler: GlobalHandler<T>): () => void {
      handlers.add(handler)
      queueMicrotask(() => handler(initial()))
      return () => { handlers.delete(handler) }
    },
  }
}

const providersSub = makeMockSubscription(() =>
  fixtureProviders.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) })),
)
const skillsSub = makeMockSubscription(() => fixtureSkills.map((s) => ({ ...s })))
const agentsSub = makeMockSubscription(() => fixtureAgents.map((a) => ({ ...a })))
const defaultsSub = makeMockSubscription(() => 'Anthropic/claude-sonnet-4.5')

export const config = {
  async listProviders() {
    await sleep(TIMING.ack)
    return fixtureProviders.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) }))
  },
  async scanSkills(_sources: string[]) {
    await sleep(TIMING.ack)
    return fixtureSkills.map((s) => ({ ...s }))
  },
  async scanAgents(_sources: string[]) {
    await sleep(TIMING.ack)
    return fixtureAgents.map((a) => ({ ...a }))
  },
  async discoverModels(_req: unknown) {
    await sleep(TIMING.ack)
    return { success: true, models: [] }
  },
  onProviders: (h: GlobalHandler<unknown>) => providersSub.subscribe(h),
  onSkills: (h: GlobalHandler<unknown>) => skillsSub.subscribe(h),
  onAgents: (h: GlobalHandler<unknown>) => agentsSub.subscribe(h),
  onDefaults: (h: GlobalHandler<string>) => defaultsSub.subscribe(h),
  async setProvider(_providerId: string, _data: unknown) { await sleep(TIMING.ack) },
  async deleteProvider(_providerId: string) { await sleep(TIMING.ack) },
  async setSkill(_skill: unknown) { await sleep(TIMING.ack) },
  async deleteSkill(_skillId: string) { await sleep(TIMING.ack) },
  async setAgent(_agent: unknown) { await sleep(TIMING.ack) },
  async deleteAgent(_agentId: string) { await sleep(TIMING.ack) },
}

/* ── Model mock ── */
import { MOCK_MODELS, type MockModel } from './composer-data'

function mockModelToInfo(m: MockModel): { id: string; name: string; provider: string; providerColor?: string; tag?: string } {
  return { id: m.id, name: m.name, provider: m.provider, providerColor: m.providerColor, tag: m.tag }
}
const modelsSub = makeMockSubscription(() => MOCK_MODELS.map(mockModelToInfo))

export const model = {
  onModels: (h: GlobalHandler<unknown>) => modelsSub.subscribe(h),
  async switchModel(_sessionId: string, _provider: string, _modelId: string) { await sleep(TIMING.ack) },
}

/* ── Extension mock ── */
const extensionsSub = makeMockSubscription((): unknown[] => [])
export const extension = {
  onExtensions: (h: GlobalHandler<unknown>) => extensionsSub.subscribe(h),
  async toggle(_name: string, _enabled: boolean) { await sleep(TIMING.ack) },
}

/* ── Plugin mock ── */
const pluginsSub = makeMockSubscription((): unknown[] => [])
export const plugin = {
  onPlugins: (h: GlobalHandler<unknown>) => pluginsSub.subscribe(h),
}
```

### 步骤 2：返工 mock/index.ts 的 settings 块

把现有的 `export const settings = { ... }`（旧版 getProviders/getSkills/getAgents/getExtensions/getSystem/updateSystem 全 Promise）整体替换为：

```ts
export const settings = {
  onProviders: config.onProviders,
  onSkills: config.onSkills,
  onAgents: config.onAgents,
  onExtensions: extension.onExtensions,
  onDefaults: config.onDefaults,
  listProviders: config.listProviders,
  setProvider: config.setProvider,
  async getSystem(): Promise<{ locale: string; theme: string; themePreset: string }> {
    const raw = localStorage.getItem('xyz-agent:system-settings')
    let parsed: Record<string, unknown> = {}
    if (raw) { try { parsed = JSON.parse(raw) } catch { /* 用默认 */ } }
    return { locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue', ...parsed }
  },
  async updateSystem(patch: Record<string, unknown>): Promise<void> {
    const cur = JSON.parse(localStorage.getItem('xyz-agent:system-settings') ?? '{}')
    localStorage.setItem('xyz-agent:system-settings', JSON.stringify({ ...cur, ...patch }))
  },
}
```

注意：mock 的 settings 块必须在 config/extension 块**之后**（因为转发引用它们）。若原 settings 块位置在前，把它移到新追加的 config/extension 块之后。

### 步骤 3：更新门面 api/index.ts

整体替换 src-electron/renderer/src/api/index.ts：

```ts
/**
 * API 门面入口 —— 聚合 domains，对外统一接口。
 * 调用方：import { session, chat, config, model, extension, plugin, settings } from '@/api'
 * 按 VITE_MOCK 切换：true → 内存 mock；false → transport + ws-client。两套签名一致。
 */
import * as realSession from './domains/session'
import * as realChat from './domains/chat'
import * as realConfig from './domains/config'
import * as realModel from './domains/model'
import * as realExtension from './domains/extension'
import * as realPlugin from './domains/plugin'
import * as realSettings from './domains/settings'
import * as mockApi from './mock'

const isMock = import.meta.env.VITE_MOCK === 'true'

export const session = isMock ? mockApi.session : realSession
export const chat = isMock ? mockApi.chat : realChat
export const config = isMock ? mockApi.config : realConfig
export const model = isMock ? mockApi.model : realModel
export const extension = isMock ? mockApi.extension : realExtension
export const plugin = isMock ? mockApi.plugin : realPlugin
export const settings = isMock ? mockApi.settings : realSettings

// 类型 re-export（供组件 import 类型用）
export type { ModelInfo } from './domains/model'
export type { SystemSettings } from './domains/settings'
```

### 步骤 4：验证 + 提交

1. 类型检查：`cd src-electron/renderer && npx vue-tsc --noEmit`（应无错——mock/real 签名同构，门面三元成立）。
2. 全量测试：`cd src-electron/renderer && npx vitest run`（全绿）。
3. 提交（含 Task 3 的 settings.ts）：
```bash
cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime
git add src-electron/renderer/src/api/domains/settings.ts \
        src-electron/renderer/src/api/mock/index.ts \
        src-electron/renderer/src/api/index.ts
git commit -m "refactor(api): align mock domains to new contracts + facade aggregation (config/model/extension/plugin + settings rework)"
```

## Report Format

报告：Status、mock 4 块是否追加、settings mock 块是否返工、index.ts 门面是否聚合 7 domain、vue-tsc/vitest 结果、commit SHA。
```

### Spec Review 要点
- mock 与 real 每个 domain 的方法名/参数数量是否一一对应（重点查 on*/list*/set*）
- settings mock 块是否移到 config/extension 之后（引用顺序）
- 门面是否 7 个 domain + 2 个类型 re-export
- makeMockSubscription 是否只在订阅型用（listProviders 等请求型不依赖它）

---

## Task 5：提取常量 + CommandPopover/ContextCapacityPopover 订阅骨架

**目的：** 把 CommandPopover 的 @/# 候选和 ContextCapacityPopover 的统计从「组件直接 import MOCK_*」改为常量模块 + 订阅骨架。
**模型建议：** 标准模型（2 组件改 + 2 新建常量，需理解订阅骨架模式）。
**文件范围：** 2 新建 + 2 改 = 4 文件。
**依赖：** T4（组件用 @/api，但本 Task 主要用 events.onGlobalType 直连，门面需就绪以保 vue-tsc）。

### Implementer Prompt

```
You are implementing Task 5: 提取常量 + CommandPopover/ContextCapacityPopover 订阅骨架

## Task Description

1. 新建常量模块：把 CommandPopover 的 @/# 候选（搜索能力，后端从零，暂用静态 fixture）抽到独立常量文件。
2. CommandPopover：@/# 改用常量；/ 命令建 session.commands 订阅骨架（payload 未契约化，handler 暂 fallback 到静态列表）。
3. ContextCapacityPopover：改用 context.update 订阅骨架（payload 未契约化，初始值用原 fixture 数值）。

## Context

[粘贴「全局上下文」块]

现状（必读）：
- src-electron/renderer/src/components/panel/CommandPopover.vue line 60-67 import MOCK_FILES/MOCK_MENTIONS/MOCK_SLASH_COMMANDS（from @/api/mock/composer-data）。line 90-113 的 items computed 三分支分别 map 这三个。
- src-electron/renderer/src/components/panel/ContextCapacityPopover.vue line 70-72 import MOCK_CONTEXT_STATS，line 72 const stats = MOCK_CONTEXT_STATS（静态）。
- events.onGlobalType(type, handler) 已在 Task 1 建好。session.commands 和 context.update 是 ServerMessageType（protocol.ts 已有），但 payload 结构未契约化——所以订阅骨架先建，handler 内暂不解析 payload（留 TODO），用静态 fallback。

铁律（CLAUDE.md）：组件不直接 import api/mock/*。改为常量模块或 @/api 门面。

## Your Job

### 文件 1（新建）：src-electron/renderer/src/components/panel/command-candidates.ts

```ts
/**
 * @ 引用 / # 文件候选（搜索能力，后端从零，第4项协议缺口）。
 * 当前为静态 fixture；后端搜索能力就绪后改为 api 调用。
 */
export interface MentionCandidate {
  id: string
  name: string
  kind: string
  icon: string
  path?: string
}

export interface FileCandidate {
  id: string
  name: string
  kind: string
  path?: string
}

export const MENTION_CANDIDATES: MentionCandidate[] = [
  { id: 'mention-auth-service', name: 'AuthService.ts', kind: '文件', icon: 'file', path: 'src/auth/AuthService.ts' },
  { id: 'mention-token-validator', name: 'TokenValidator', kind: '符号', icon: 'symbol' },
  { id: 'mention-form-validation', name: '表单校验规范', kind: '技能', icon: 'skill' },
  { id: 'mention-token-file', name: 'token.ts', kind: '文件', icon: 'file', path: 'src/auth/token.ts' },
]

export const FILE_CANDIDATES: FileCandidate[] = [
  { id: 'file-src-auth', name: 'src/auth/', kind: '目录', path: 'src/auth/' },
  { id: 'file-auth-service', name: 'AuthService.ts', kind: '文件', path: 'src/auth/AuthService.ts' },
  { id: 'file-token', name: 'token.ts', kind: '文件', path: 'src/auth/token.ts' },
]
```

### 文件 2（改）：CommandPopover.vue

修改 CommandPopover.vue 的 <script setup>：
1. 删除 `import { MOCK_FILES, MOCK_MENTIONS, MOCK_SLASH_COMMANDS, ... } from '@/api/mock/composer-data'`。
2. 改 import：`import { MENTION_CANDIDATES, FILE_CANDIDATES, type MentionCandidate, type FileCandidate } from './command-candidates'`。
3. 加 events import 和订阅骨架：

```ts
import { ref, computed, markRaw, onBeforeUnmount, watch } from 'vue'
import * as events from '@/api/events'
```

4. slash 命令改为 ref + 订阅骨架（初始用静态，订阅 handler 留 TODO）：

```ts
const slashCommands = ref<Array<{ id: string; name: string; kind: string; icon: string }>>([
  { id: 'cmd-commit', name: '/commit', kind: '提交', icon: 'terminal' },
  { id: 'cmd-review', name: '/review', kind: '审查', icon: 'star' },
  { id: 'cmd-fix', name: '/fix', kind: '修复', icon: 'wrench' },
])

let unsubCommands: (() => void) | null = null
// 订阅骨架：session.commands payload 契约化前（第4项 4e）用静态 fallback
unsubCommands = events.onGlobalType('session.commands', () => {
  // TODO(第4项 4e): payload 结构契约化后解析 msg.payload.commands
})
onBeforeUnmount(() => { unsubCommands?.() })
```

注意：CommandPopover 是否已有 onMounted？读现有代码确认生命周期钩子。若没有 onMounted，把订阅注册放在 setup 顶层（如上）；若组件用 defineProps 受控 open，确保订阅在组件挂载期间常驻（不随 open 切换）。onBeforeUnmount 取消。

5. items computed（原 line 90-113）改：
   - mention 分支：MOCK_MENTIONS → MENTION_CANDIDATES（类型 MentionCandidate）
   - file 分支：MOCK_FILES → FILE_CANDIDATES（类型 FileCandidate）
   - slash 分支：MOCK_SLASH_COMMANDS → slashCommands.value

保留 items 内的 icon 映射逻辑（如 `icon: f.kind === '目录' ? 'folder' : 'file'`）。

### 文件 3（改）：ContextCapacityPopover.vue

修改 ContextCapacityPopover.vue：
1. 删除 `import { MOCK_CONTEXT_STATS } from '@/api/mock/composer-data'`。
2. 加订阅骨架，stats 从常量变 ref（初始值用原 fixture 数值）：

```ts
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as events from '@/api/events'

interface ContextStats {
  used: number
  total: number
  percent: number
  cacheHit: number
  modelId: string
}

// 初始值用原 fixture 数值（context.update payload 未契约化，第4项 4e）
const stats = ref<ContextStats>({
  used: 69000,
  total: 1000000,
  percent: 6.9,
  cacheHit: 98.7,
  modelId: 'claude-sonnet-4.5',
})

let unsubContext: (() => void) | null = null
onMounted(() => {
  unsubContext = events.onGlobalType('context.update', () => {
    // TODO(第4项 4e): payload 结构契约化后解析 msg.payload
  })
})
onBeforeUnmount(() => { unsubContext?.() })
```

3. 模板里 stats 字段访问不变（结构相同），但现在是 ref——检查 template 是否需要 `.value`（Vue 模板自动解包 ref，通常不用改）。

### 文件 4（新建）：不需要（command-candidates.ts 已是文件1）。本 Task 实际 3 文件。

## 验证

1. 类型检查：`cd src-electron/renderer && npx vue-tsc --noEmit`。
2. 全量测试：`cd src-electron/renderer && npx vitest run`（全绿）。
3. 确认无残留：grep 确认 CommandPopover/ContextCapacityPopover 不再 import composer-data：
   `grep -n "composer-data" src-electron/renderer/src/components/panel/CommandPopover.vue src-electron/renderer/src/components/panel/ContextCapacityPopover.vue`（应无输出）。
4. 提交：
```bash
cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime
git add src-electron/renderer/src/components/panel/command-candidates.ts \
        src-electron/renderer/src/components/panel/CommandPopover.vue \
        src-electron/renderer/src/components/panel/ContextCapacityPopover.vue
git commit -m "refactor(panel): decouple CommandPopover/ContextCapacityPopover from MOCK imports (constants + subscribe skeleton)"
```

## Report Format

报告：Status、command-candidates.ts 是否新建、两组件是否删 composer-data import、订阅骨架是否建（session.commands/context.update）、vue-tsc/vitest/grep 结果、commit SHA。
```

### Spec Review 要点
- CommandPopover 的 @/# 是否用常量、/ 是否有订阅骨架
- ContextCapacityPopover 的 stats 是否变 ref + 订阅骨架
- 是否有越界（不该解析 payload，留 TODO；不该动 ContextChipsBar/ProgressZone）

---

## Task 6：ModelSelectPopover/ThinkingLevelPopover + Composer 接线

**目的：** ModelSelectPopover 改订阅 model.onModels；ThinkingLevelPopover 改常量模块；Composer 接 selected prop + 补全 onModelSelect 签名。
**模型建议：** 标准模型（3 组件改 + 1 新建常量，订阅+props 接线）。
**文件范围：** 1 新建 + 3 改 = 4 文件。
**依赖：** T5（同批组件迁移，模式一致）。

### Implementer Prompt

```
You are implementing Task 6: ModelSelectPopover/ThinkingLevelPopover + Composer 接线

## Task Description

1. 新建 thinking-levels.ts 常量（思考等级是前端固定枚举，非后端数据，不改成订阅）。
2. ModelSelectPopover：删 MOCK_MODELS import，改订阅 model.onModels；加 selected prop 接收外部当前模型。
3. ThinkingLevelPopover：删 MOCK_THINKING_LEVELS import，改用本地常量。
4. Composer：传 selected prop 给 ModelSelectPopover，补全 onModelSelect 签名（接收 modelId，占位更新本地 ref，真实 runtime 切换属后续，本 Task 不接 transport）。

## Context

[粘贴「全局上下文」块]

现状：
- ModelSelectPopover.vue line 72 import MOCK_MODELS（from @/api/mock/composer-data）。line 79 `const selected = ref('claude-sonnet-4.5')` 写死。line 92/105 用 MOCK_MODELS。emit select(modelId)。
- ThinkingLevelPopover.vue line 65 import MOCK_THINKING_LEVELS。line 33 v-for、line 79 computed 用它。
- Composer.vue line 39 `<ModelSelectPopover @select="onModelSelect" />`，line 151 onModelSelect() 空函数（无参）。
- model.onModels 已在 Task 4 建（@/api 门面）。ModelInfo 类型从 @/api re-export（Task 4 已加）。

思考等级备注：6 级（off/low/medium/high/xhigh/max）是前端固定枚举，后端 session.setThinkingLevel 只收 level 字符串不推送列表。所以用常量，不订阅。

## Your Job

### 文件 1（新建）：src-electron/renderer/src/components/panel/thinking-levels.ts

```ts
/**
 * 思考等级 6 级（前端固定枚举，非后端推送数据）。
 * 后端 session.setThinkingLevel 只接收 level 字符串，不推送等级列表。
 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ThinkingLevelOption {
  level: ThinkingLevel
  label: string
  en: string
  available: boolean
}

export const THINKING_LEVELS: ThinkingLevelOption[] = [
  { level: 'off', label: '关', en: 'off', available: true },
  { level: 'low', label: '低', en: 'low', available: true },
  { level: 'medium', label: '中', en: 'medium', available: true },
  { level: 'high', label: '高', en: 'high', available: true },
  { level: 'xhigh', label: '极高', en: 'xhigh', available: true },
  { level: 'max', label: '最高', en: 'max', available: true },
]
```

### 文件 2（改）：ModelSelectPopover.vue

修改 <script setup>（line 68-107 区域）：
1. 删 `import { MOCK_MODELS, type MockModel } from '@/api/mock/composer-data'`。
2. 加 import + 订阅：

```ts
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { model as modelApi, type ModelInfo } from '@/api'

const emit = defineEmits<{
  select: [modelId: string]
}>()

const props = defineProps<{
  selected?: string
}>()

const open = ref(false)
const selected = ref(props.selected ?? '')
const query = ref('')
const models = ref<ModelInfo[]>([])

watch(() => props.selected, (v) => { if (v) selected.value = v })

let unsub: (() => void) | null = null
onMounted(() => {
  unsub = modelApi.onModels((list) => { models.value = list })
})
onBeforeUnmount(() => { unsub?.() })

interface ModelGroup { provider: string; color: string; models: ModelInfo[] }

const groups = computed<ModelGroup[]>(() => {
  const q = query.value.trim().toLowerCase()
  const map = new Map<string, ModelGroup>()
  for (const m of models.value) {
    if (q && !m.name.toLowerCase().includes(q)) continue
    let g = map.get(m.provider)
    if (!g) {
      g = { provider: m.provider, color: m.providerColor ?? '', models: [] }
      map.set(m.provider, g)
    }
    g.models.push(m)
  }
  return [...map.values()]
})

const currentName = computed(
  () => models.value.find((m) => m.id === selected.value)?.name ?? selected.value,
)
```

3. 模板里所有 MOCK_MODELS 引用改 models.value（检查 v-for、:class 等）。
4. 注意：ModelInfo 字段（id/name/provider/providerColor/tag）与原 MockModel 结构一致，模板字段访问通常不变。

### 文件 3（改）：ThinkingLevelPopover.vue

1. 删 `import { MOCK_THINKING_LEVELS, type ... } from '@/api/mock/composer-data'`。
2. 改 `import { THINKING_LEVELS, type ThinkingLevelOption } from './thinking-levels'`。
3. 模板 line 33 `v-for="opt in MOCK_THINKING_LEVELS"` → `v-for="opt in THINKING_LEVELS"`。
4. line 79 `MOCK_THINKING_LEVELS.find(...)` → `THINKING_LEVELS.find(...)`。
5. 类型 MockThinkingLevel → ThinkingLevelOption（若用到）。

### 文件 4（改）：Composer.vue

1. line 39 `<ModelSelectPopover @select="onModelSelect" />` 改为传 selected prop：

```vue
<ModelSelectPopover :selected="currentModelId" @select="onModelSelect" />
```

2. 在 Composer setup 加 currentModelId ref（占位，后续接 store/订阅）：

```ts
const currentModelId = ref('claude-sonnet-4.5')
```

3. line 151 onModelSelect 补全签名（接收 modelId，更新本地 ref；真实 runtime 切换属后续）：

```ts
/** 模型切换（占位更新本地；真实 runtime 对接属后续真实集成） */
function onModelSelect(modelId: string): void {
  currentModelId.value = modelId
  // TODO(后续): 对接 runtime model.switch
}
```

注意 onThinkingSelect（line 156）本 Task 不动（保留原 TODO 空函数，真实切换属后续）。

## 验证

1. 类型检查：`cd src-electron/renderer && npx vue-tsc --noEmit`。
2. 全量测试：`cd src-electron/renderer && npx vitest run`（全绿）。
3. grep 确认无残留：
   `grep -rn "MOCK_MODELS\|MOCK_THINKING_LEVELS" src-electron/renderer/src/components/panel/`（应无输出，除非 ContextChipsBar/ProgressZone——它们不在本 Task 范围，但也不 import 这两个）。
4. 提交：
```bash
cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime
git add src-electron/renderer/src/components/panel/thinking-levels.ts \
        src-electron/renderer/src/components/panel/ModelSelectPopover.vue \
        src-electron/renderer/src/components/panel/ThinkingLevelPopover.vue \
        src-electron/renderer/src/components/panel/Composer.vue
git commit -m "refactor(panel): ModelSelectPopover subscribes model.onModels + ThinkingLevel constants + Composer wiring"
```

## Report Format

报告：Status、thinking-levels.ts 是否新建、ModelSelectPopover 是否订阅 model.onModels + 加 selected prop、ThinkingLevelPopover 是否改常量、Composer 是否接线、vue-tsc/vitest/grep 结果、commit SHA。
```

### Spec Review 要点
- ModelSelectPopover 是否真的订阅（onMounted 注册 + onBeforeUnmount 取消），不是直接 import
- selected prop 是否双向（props 接收 + watch 同步）
- ThinkingLevelPopover 是否改常量（非订阅——这是设计决策，review 要确认没误改成订阅）
- Composer onModelSelect 是否只补签名不接 transport（占位）

---

## Task 7：SettingsModal 订阅驱动返工

**目的：** SettingsModal 的 watch(open) → Promise.allSettled 拉取改为 onMounted 订阅常驻 + system 读 localStorage。
**模型建议：** 标准模型（数据流模式转变，需理解订阅驱动 vs 拉取驱动）。
**文件范围：** 1 改（SettingsModal.vue）。
**依赖：** T4（settings.on* 接口就绪）。

### Implementer Prompt

```
You are implementing Task 7: SettingsModal 订阅驱动返工

## Task Description

SettingsModal 当前用 watch(open) → Promise.allSettled([getProviders, getSkills, ...]) 拉数据（错误——skills/agents/extensions 是订阅型，real 模式后端不响应 get*）。改为：onMounted 注册 5 个订阅（providers/skills/agents/extensions/defaults）常驻 + system 读 localStorage；watch(open) 只在打开时可选刷新 providers。

## Context

[粘贴「全局上下文」块]

现状（必读）：src-electron/renderer/src/components/settings/SettingsModal.vue
- line 91 `import { settings } from '@/api'`
- line 128-132 数据状态 ref（providers/skills/agents/extensions/system）
- line 135-149 watch(open) 块：Promise.allSettled 拉 5 类数据
- line 161-164 onSystemUpdate

settings 接口（Task 4 已就绪）：onProviders/onSkills/onAgents/onExtensions/onDefaults（订阅，返回取消函数）、listProviders（请求）、getSystem/updateSystem（localStorage）、setProvider（动作）。
ExtensionInfo 类型从 @xyz-agent/shared。

契约认知：providers 是唯一有 get 入口的（config.getProviders）；skills/agents/extensions 纯订阅（无 get）。所以打开时不再 allSettled 拉 skills/agents——订阅 onMounted 注册即得。

## Your Job

修改 SettingsModal.vue 的 <script setup>：

1. import 调整（line 79 附近）：加 onMounted/onBeforeUnmount，引入类型：

```ts
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { settings, type SystemSettings } from '@/api'
import type { ProviderInfo, SkillInfo, AgentInfo, ExtensionInfo } from '@xyz-agent/shared'
```

注意：原文件可能在本地定义了 SystemSettings interface（line 107-111）——删除本地定义，改用从 @/api re-export 的（Task 4 已加 `export type { SystemSettings }`）。ExtensionItem 本地 interface（line 99-105）删除，改用 ExtensionInfo[]。

2. 数据状态（替换 line 128-132）：

```ts
const providers = ref<ProviderInfo[]>([])
const skills = ref<SkillInfo[]>([])
const agents = ref<AgentInfo[]>([])
const extensions = ref<ExtensionInfo[]>([])
const system = ref<SystemSettings>({ locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' })

const unsubs: Array<() => void> = []

onMounted(async () => {
  unsubs.push(settings.onProviders((p) => { providers.value = p }))
  unsubs.push(settings.onSkills((s) => { skills.value = s }))
  unsubs.push(settings.onAgents((a) => { agents.value = a }))
  unsubs.push(settings.onExtensions((e) => { extensions.value = e }))
  system.value = await settings.getSystem()
})

onBeforeUnmount(() => { unsubs.forEach((u) => u()) })
```

3. watch(open) 块（替换 line 135-149）——只刷新 providers，不再拉 skills/agents：

```ts
watch(() => props.open, (isOpen) => {
  if (!isOpen) return
  // 打开时可选刷新 providers（订阅会兜底，这里只为拿最新）；skills/agents 靠订阅
  settings.listProviders().then((p) => { providers.value = p }).catch(() => { /* 订阅兜底 */ })
})
```

4. onSystemUpdate（line 161-164）保持，但确认用 settings.updateSystem（已对齐 localStorage）：

```ts
async function onSystemUpdate(patch: Record<string, unknown>) {
  Object.assign(system.value, patch)
  await settings.updateSystem(patch)
}
```

5. 模板检查：ProviderPage/SkillPage/AgentPage/ExtensionPage 的 props 类型若用了本地 ExtensionItem，改 ExtensionInfo（结构兼容即可，读子页组件确认 props 定义）。getItemCount 不变。

## 验证

1. 类型检查：`cd src-electron/renderer && npx vue-tsc --noEmit`（重点查 ExtensionItem→ExtensionInfo、SystemSettings 本地定义删除后的引用）。
2. 全量测试：`cd src-electron/renderer && npx vitest run`（全绿）。
3. 确认无 getSkills/getAgents/getExtensions 残留：
   `grep -n "getSkills\|getAgents\|getExtensions" src-electron/renderer/src/components/settings/SettingsModal.vue`（应无输出）。
4. 提交：
```bash
cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime
git add src-electron/renderer/src/components/settings/SettingsModal.vue
git commit -m "refactor(settings): drive SettingsModal from subscriptions (rework Promise.allSettled to on* subscriptions)"
```

## Report Format

报告：Status、watch(allSettled) 是否改为 onMounted 订阅、本地 SystemSettings/ExtensionItem 是否删除、子页 props 类型是否兼容、vue-tsc/vitest/grep 结果、commit SHA。
```

### Spec Review 要点
- 是否删除 Promise.allSettled（不再有 getSkills/getAgents/getExtensions 调用）
- onMounted 订阅是否 5 个 on* + onBeforeUnmount 取消
- watch(open) 是否只刷新 providers（不拉 skills/agents）
- 本地 SystemSettings/ExtensionItem 是否删除（用 shared/api 的类型）

---

## 全部 Task 完成后的最终审查

控制器在 T7 完成后，派一个 **final code reviewer**（最强模型）审查整个实现（所有 commit）。审查清单：

1. **mock 模式全功能可用**：`VITE_MOCK=true` 跑 dev，SettingsModal 5 页有数据、ModelSelectPopover 列出模型、CommandPopover 三类候选、ContextCapacityPopover 显示统计。
2. **real 模式链路通**：routeInbound 不丢弃无 sessionId 消息（可加临时 console.log 验证 dispatchGlobal 被触发，验后删）。
3. **`npx vue-tsc --noEmit` 无错误。**
4. **`npx vitest run` 全绿。**
5. **无残留硬编码 import**：
   ```bash
   grep -rn "MOCK_MODELS\|MOCK_MENTIONS\|MOCK_FILES\|MOCK_SLASH_COMMANDS\|MOCK_CONTEXT_STATS\|MOCK_THINKING_LEVELS" src-electron/renderer/src/components/
   ```
   只允许 ContextChipsBar（MOCK_ATTACHED_CONTEXT）和 ProgressZone（MOCK_PROGRESS_STATES）——这两个明确不在范围。
6. **契约一致性**：mock 与 real 每个 domain 方法签名一一对应。

## 不在本计划范围（所有 Task 都不碰）

- Composer onThinkingSelect 真接 runtime、model.switch 真接 runtime（属后续真实集成）
- ContextChipsBar / ProgressZone / FileView（无后端通道 / 第4项）
- ProviderEditModal 的 setProvider 真接 transport（保留 setTimeout 模拟）
- message.file_changes / 附件 / 搜索 / discovery 写入 / payload 契约化（第4项）
