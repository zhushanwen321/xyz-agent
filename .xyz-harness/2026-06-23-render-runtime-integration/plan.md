# 前端 ↔ Runtime 对接改造计划（第1项 全局推送链路 + 第2项 mock 改造）

> **给 agentic worker：** 必备子技能：使用 `subagent-driven-development`（推荐）或 `executing-plans` 逐任务执行。步骤用复选框（`- [ ]`）跟踪。
>
> **执行 worktree：** `~/Code/xyz-agent-workspace/refactor-arch-render-runtime`（分支同名）。所有路径相对 worktree 根。**不要在 `refactor-architecture-design` 分支执行**——那是早期状态，无本计划涉及的代码。

**目标：** 修复全局推送链路断裂（无 sessionId 消息被丢弃）+ 把 mock 改造从「组件硬编码 import」推进到「api 门面契约化」，并为真实集成铺好订阅型 domain 骨架。

**架构：** 入站分发器 `routeInbound` 增加「全局通道」分流（无 sessionId 的 server-push 走 `events.onGlobal`，有 sessionId 的仍走 `events.dispatch`）。domain 层按三类契约（请求/订阅/动作）重写——列表数据用订阅、编辑用动作、状态变更靠订阅推回。组件统一从 `@/api` 门面取数据，删除所有 `import { MOCK_* }`。

**技术栈：** Vue 3 + TS + Pinia + vitest。mock 由 `VITE_MOCK=true` 切换（`api/index.ts` 按 `isMock` 注入 real/mock 门面）。

**前置依赖：** 本计划的「接口形态判定」全部基于 [`contract.md`](./contract.md)（2a 契约表，执行前需 review）。任务 2b 起每一步的签名都以该表为准。

---

## 背景事实（改前必读，避免重复调研）

| 事实 | 证据 | 计划意义 |
|------|------|---------|
| 断裂点：无 sessionId 消息被丢弃 | `composables/useConnection.ts:47-48` `if (sid) events.dispatch(sid, msg)` | 任务 1 修复对象 |
| events 无全局通道 | `api/events.ts` 只有 `on/off/dispatch`（sessionId 路由） | 任务 1 新增 `onGlobal` |
| sendInitialState 推 7 条（全无 sessionId） | `runtime/src/transport/server.ts:220-258` | 这些是全局订阅的数据源 |
| settings domain 全 Promise（错） | `api/domains/settings.ts:24-28` getSkills/Agents/Extensions throw stub | 任务 2e 返工 |
| 7+ 处组件硬编码 import MOCK_* | 见下方「组件迁移清单」表 | 任务 2d |
| Composer 两 TODO 空函数 | `components/panel/Composer.vue:151,156` | **本计划不动**（属第3项真实集成） |
| CLAUDE.md line 98-108：缺 sessionId 消息应被忽略 | 「payload 必须含 sessionId」 | 任务 1 设计约束（见下） |

**CLAUDE.md 约束如何影响任务 1：** 规则原文是「涉及特定 session 的消息必须含 sessionId，缺失应被忽略」。这条规则的**意图是防止 session 消息广播到所有 panel**——它管的是 session 级消息，不是全局广播。`config.providers`/`model.list`/`config.skills` 等本来就是**全局无 session 语义**的推送，不应被「忽略」，而应走专用全局通道。任务 1 的设计是「**新增全局通道分流**」而非「放宽 sessionId 校验」——session 级消息的隔离规则保持不变。

---

## 组件迁移清单（任务 2d 的对象，handoff 2.4 核对版）

| 组件 | 硬编码 | 迁移后对接 | 本计划处理 |
|------|--------|-----------|-----------|
| `panel/ModelSelectPopover.vue:72` | MOCK_MODELS | `model.onModels` 订阅 | ✅ 任务 2d-1 |
| `panel/ThinkingLevelPopover.vue:65` | MOCK_THINKING_LEVELS | 保留 fixture（思考等级是前端枚举常量，非后端数据） | ⚠ 任务 2d-2（见备注） |
| `panel/CommandPopover.vue:61-63` | MOCK_FILES/MENTIONS/SLASH_COMMANDS | `session.commands` 订阅骨架（payload 未契约化，mock 仍用 fixture） | ✅ 任务 2d-3 |
| `panel/ContextCapacityPopover.vue:70` | MOCK_CONTEXT_STATS | `context.update` 订阅骨架（同上） | ✅ 任务 2d-4 |
| `panel/ContextChipsBar.vue:32` | MOCK_ATTACHED_CONTEXT | 无后端通道（附件缺口，第4项） | ❌ 不动 |
| `panel/ProgressZone.vue:89` | MOCK_PROGRESS_STATES | 无后端通道（pi 无 todo，第4项） | ❌ 不动 |
| `sidebar/Sidebar.vue:143` + `FileView.vue` | fixtureFileChanges | `message.file_changes`（第4项 4a，ADR-0024） | ❌ 不动 |

**ThinkingLevelPopover 备注：** 思考等级 6 级（off/low/medium/high/xhigh/max）是**前端固定枚举**，后端 `session.setThinkingLevel` 只接收一个 level 字符串，不推送等级列表。因此 `MOCK_THINKING_LEVELS` 是合理的常量 fixture，**不该改成订阅**。任务 2d-2 只把它从「组件直接 import mock」改成「从常量模块 import」（语义归位），并保留 Composer 的 `onThinkingSelect` TODO（真实切换属第3项）。

**ComponentPopover 三类候选备注：** `/` 命令有 `session.commands` 订阅通道；`@` 引用和 `#` 文件是搜索/扫描能力（handoff 2.6 标注后端从零）。任务 2d-3 只为 `session.commands` 建订阅骨架，`@`/`#` 候选**继续用 fixture**（从 mock 常量取，不再硬编码 import 到组件）。

---

## 文件结构（变更总览）

**任务 1（推送链路，2 文件）：**
- 修改 `src-electron/renderer/src/api/events.ts`（+onGlobal/onGlobalType/dispatchGlobal/dispatchSession）
- 修改 `src-electron/renderer/src/composables/useConnection.ts:38-49`（routeInbound 分流）

**任务 2（mock 改造）：**
- 新建 `src-electron/renderer/src/api/domains/{config,model,extension,plugin}.ts`
- 返工 `src-electron/renderer/src/api/domains/settings.ts`（重写）
- 返工 `src-electron/renderer/src/api/mock/index.ts`（settings 对齐 + 加新 domain mock）
- 返工 `src-electron/renderer/src/api/index.ts`（门面加 config/model/extension/plugin）
- 新建 `src-electron/renderer/src/__tests__/events-global.test.ts`
- 新建 `src-electron/renderer/src/__tests__/config-domain.test.ts`
- 修改 4 个组件（ModelSelectPopover / CommandPopover / ContextCapacityPopover / ThinkingLevelPopover）
- 修改 `src-electron/renderer/src/components/settings/SettingsModal.vue`（消费方式返工）
- 新建 `src-electron/renderer/src/composables/useGlobalData.ts`（订阅编排，供组件用）

---

## 任务 0：隔离未提交的 settings 变更

**目的：** worktree 当前有未提交的 settings 新增（6 组件 + 2 ts + 若干修改）。先 commit 一个 WIP，让后续 diff 干净，回滚有界。

**文件：** 无新建，仅 git 操作。

- [ ] **步骤 1：确认 worktree 状态**

运行：`cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime && git status --short`
预期：看到 `??` 的 settings 文件（settings.ts/settings-data.ts/5个Page.vue/ProviderEditModal.vue/ui/select/）+ `M` 的 index.ts/mock/index.ts/SettingsModal.vue/AppShell.vue/Sidebar.vue/shared/settings.ts。

- [ ] **步骤 2：确认类型检查通过（提交前基线）**

运行：`cd src-electron/renderer && npx vue-tsc --noEmit`
预期：无错误（或仅已有的非 settings 错误）。若 settings 相关报错，先修，再提交。

- [ ] **步骤 3：提交 WIP**

```bash
cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime
git add -A
git commit -m "wip(settings): add settings domain skeleton + 5 sub-pages (contract pending rework in task 2e)"
```

预期：提交成功。`git status` 干净。这条 commit 是已知「契约待返工」的快照，任务 2e 在此基线上 diff。

---

## 任务 1：全局推送链路修复

**目的：** 让 `config.providers`/`model.list`/`config.skills`/`config.agents`/`config.plugins`/`config.extensions`/`config.defaults` 等无 sessionId 的 server-push 被消费，而非静默丢弃。这是订阅型 domain 的实现前提。

**约束（CLAUDE.md line 98-108）：** session 级消息的 sessionId 隔离不变。新增的是「全局通道」，session 通道逻辑零改动。

### 任务 1.1：events.ts 增加全局通道

**文件：**
- 修改：`src-electron/renderer/src/api/events.ts`（当前 35 行，新增全局路由）

- [ ] **步骤 1：编写失败测试 `__tests__/events-global.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import * as events from '../api/events'

describe('events 全局通道', () => {
  beforeEach(() => {
    // events 模块级 Map 无法重置，测试用唯一 type 名隔离
  })

  it('onGlobalType 注册后，dispatchGlobal 同 type 触发 handler', () => {
    const received: string[] = []
    const off = events.onGlobalType('config.skills', (msg) => {
      received.push(msg.type)
    })
    events.dispatchGlobal({ type: 'config.skills', payload: { skills: [] } })
    expect(received).toEqual(['config.skills'])
    off()
    events.dispatchGlobal({ type: 'config.skills', payload: { skills: [] } })
    expect(received).toEqual(['config.skills']) // 取消后不再触发
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
    events.onGlobal(() => { globalHit = true })
    events.dispatchSession('sess-1', { type: 'message.text_delta', payload: { sessionId: 'sess-1' } })
    expect(globalHit).toBe(false)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd src-electron/renderer && npx vitest run src/__tests__/events-global.test.ts`
预期：FAIL，提示 `events.onGlobalType is not a function`。

- [ ] **步骤 3：实现 events.ts 全局通道**

把 `src-electron/renderer/src/api/events.ts` 整体替换为：

```ts
/**
 * Events 层 —— ServerMessage 订阅分发。
 *
 * 两条独立通道：
 * - **session 通道**（on/off/dispatch/dispatchSession）：按 sessionId 路由，CLAUDE.md line 98
 *   要求「涉及 session 的消息必须含 sessionId，缺失应忽略」。session 级消息隔离不变。
 * - **global 通道**（onGlobal/onGlobalType/dispatchGlobal）：无 sessionId 的 server-push
 *   （config.providers / model.list / config.skills / config.agents / config.plugins /
 *   config.extensions / config.defaults）。sendInitialState 推 7 条 + 运行时广播。
 *
 * 两条通道互不串扰：dispatchSession 不触发 global handler，反之亦然。routeInbound
 * （useConnection）按 msg.payload.sessionId 是否存在决定走哪条。
 *
 * 依赖方向：transport（接收原始 ServerMessage）→ events（按 sessionId 有无分流）。
 */
import type { ServerMessage } from '@xyz-agent/shared'

type MessageHandler = (msg: ServerMessage) => void

// ── session 通道（按 sessionId 路由）──
const sessionHandlers = new Map<string, Set<MessageHandler>>()

/** 按 sessionId 订阅 ServerMessage，返回取消函数 */
export function on(sessionId: string, handler: MessageHandler): () => void {
  let set = sessionHandlers.get(sessionId)
  if (!set) {
    set = new Set()
    sessionHandlers.set(sessionId, set)
  }
  set.add(handler)
  return () => off(sessionId, handler)
}

/** 取消订阅（按 sessionId + handler） */
export function off(sessionId: string, handler: MessageHandler): void {
  sessionHandlers.get(sessionId)?.delete(handler)
}

/** 按 sessionId 派发（兼容旧名，内部转发 dispatchSession） */
export function dispatch(sessionId: string, msg: ServerMessage): void {
  dispatchSession(sessionId, msg)
}

/** 按 sessionId 派发 ServerMessage 给已注册 handler（session 通道） */
export function dispatchSession(sessionId: string, msg: ServerMessage): void {
  sessionHandlers.get(sessionId)?.forEach((h) => h(msg))
}

// ── global 通道（无 sessionId 的 server-push）──
const globalAllHandlers = new Set<MessageHandler>()
const globalTypeHandlers = new Map<string, Set<MessageHandler>>()

/** 订阅所有全局 ServerMessage（不区分 type），返回取消函数 */
export function onGlobal(handler: MessageHandler): () => void {
  globalAllHandlers.add(handler)
  return () => globalAllHandlers.delete(handler)
}

/** 订阅指定 type 的全局 ServerMessage，返回取消函数 */
export function onGlobalType(type: string, handler: MessageHandler): () => void {
  let set = globalTypeHandlers.get(type)
  if (!set) {
    set = new Set()
    globalTypeHandlers.set(type, set)
  }
  set.add(handler)
  return () => globalTypeHandlers.get(type)?.delete(handler)
}

/** 派发全局 ServerMessage（global 通道） */
export function dispatchGlobal(msg: ServerMessage): void {
  globalAllHandlers.forEach((h) => h(msg))
  globalTypeHandlers.get(msg.type)?.forEach((h) => h(msg))
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`cd src-electron/renderer && npx vitest run src/__tests__/events-global.test.ts`
预期：PASS（3 个 it 全过）。

- [ ] **步骤 5：确认现有测试未被破坏**

运行：`cd src-electron/renderer && npx vitest run`
预期：全绿（现有 `useChat.test.ts`/`fg1-dataflow.test.ts` 等不依赖 onGlobal，dispatch 旧名仍保留转发）。

### 任务 1.2：routeInbound 分流

**文件：**
- 修改：`src-electron/renderer/src/composables/useConnection.ts:38-49`

- [ ] **步骤 1：修改 routeInbound 分流逻辑**

把 `useConnection.ts` 的 `routeInbound` 函数（line 38-49）替换为：

```ts
/**
 * 入站消息分发器（features 层串联 transport→pending/events 的唯一桥）。
 *
 * 对每条入站 ServerMessage：
 *   1. 若 msg.id 命中 pending → resolve（普通响应）/ reject（error envelope）
 *   2. 按 payload.sessionId 是否存在分流：
 *      - 有 sessionId → events.dispatchSession（session 通道，CLAUDE.md line 98 隔离）
 *      - 无 sessionId → events.dispatchGlobal（global 通道，config.*/model.list 等广播）
 *
 * pending 与 events 独立：一条 message.status 既 resolve send 的 pending，
 * 又安全地走 dispatch（store 无此 case → no-op）。
 */
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

**注意：** `routeInbound` 里 `events.dispatch` 旧调用改为 `events.dispatchSession`（新名）。原 `dispatch` 别名仍保留（events.ts 步骤 3 已保留转发），但分发器用语义更明确的新名。

- [ ] **步骤 2：类型检查**

运行：`cd src-electron/renderer && npx vue-tsc --noEmit`
预期：无错误。

- [ ] **步骤 3：全量测试**

运行：`cd src-electron/renderer && npx vitest run`
预期：全绿。

- [ ] **步骤 4：手动验证（mock 模式下 global 通道无副作用）**

运行：`cd src-electron/renderer && VITE_MOCK=true npx vitest run src/__tests__/events-global.test.ts`
预期：PASS（mock 模式 routeInbound 只收 pong，dispatchGlobal 无 handler 时 no-op，安全）。

- [ ] **步骤 5：提交**

```bash
cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime
git add src-electron/renderer/src/api/events.ts \
        src-electron/renderer/src/composables/useConnection.ts \
        src-electron/renderer/src/__tests__/events-global.test.ts
git commit -m "feat(events): add global channel for sessionless server-push (config.*/model.list)"
```

---

## 任务 2：mock 改造（domain 契约 + 组件解耦）

> **前置：** 执行前确认 [`contract.md`](./contract.md) 的 Review 检查清单（§5）已通过。任务 2b 起的签名以该表为准。

### 任务 2b：建 real domain 骨架

**目的：** 按 contract.md §2 的签名，建 config/model/extension/plugin 的 real domain（内部走 transport/events，real 模式可用），并返工 settings domain。real domain 的订阅型接口接 `events.onGlobalType`，请求/动作型接 `pending`+`transport.send`。

**文件：**
- 新建：`src-electron/renderer/src/api/domains/config.ts`
- 新建：`src-electron/renderer/src/api/domains/model.ts`
- 新建：`src-electron/renderer/src/api/domains/extension.ts`
- 新建：`src-electron/renderer/src/api/domains/plugin.ts`
- 返工：`src-electron/renderer/src/api/domains/settings.ts`

#### 任务 2b-1：config.ts

- [ ] **步骤 1：编写 config.ts（按 contract.md §2.3 签名）**

新建 `src-electron/renderer/src/api/domains/config.ts`：

```ts
/**
 * Config 域 —— provider / skill / agent / defaults（请求 + 订阅 + 动作 混合）。
 *
 * 契约见 .xyz-harness/2026-06-23-render-runtime-integration/contract.md §2.3。
 * 形态：listProviders 请求；onProviders/onSkills/onAgents/onDefaults 订阅；
 *       setProvider/deleteProvider/setSkill/deleteSkill/setAgent/deleteAgent 动作；
 *       scanSkills/scanAgents 请求（候选扫描）；discoverModels 请求。
 *
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

// ── 动作-ack（状态变更由对应订阅通道推回）──
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

#### 任务 2b-2：model.ts

- [ ] **步骤 1：编写 model.ts（按 contract.md §2.4）**

新建 `src-electron/renderer/src/api/domains/model.ts`：

```ts
/**
 * Model 域 —— 模型列表订阅 + 切换动作。
 *
 * 契约见 contract.md §2.4。onModels 走订阅（sendInitialState 推 model.list）；
 * switch 是动作（状态变更由 model.switched 推回，本计划暂不订阅 switched，第3项接）。
 *
 * 依赖方向：events（订阅）+ transport + pending（动作）。
 */
import * as transport from '../transport'
import * as pending from '../pending'
import * as events from '../events'

/** 模型信息（从 model.list payload 推断；字段实施时对照 runtime 确认） */
export interface ModelInfo {
  id: string
  name: string
  provider: string
  providerColor?: string
  tag?: string
}

/** 订阅模型列表（config.providers 解析后的聚合模型，sendInitialState 推） */
export function onModels(handler: (models: ModelInfo[]) => void): () => void {
  return events.onGlobalType('model.list', (msg) => {
    handler(msg.payload.models as ModelInfo[])
  })
}

/** 切换当前 session 的模型（动作；确认由 model.switched push，第3项消费） */
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

#### 任务 2b-3：extension.ts + plugin.ts

- [ ] **步骤 1：编写 extension.ts（骨架，contract.md §2.5）**

新建 `src-electron/renderer/src/api/domains/extension.ts`：

```ts
/**
 * Extension 域 —— 本计划只建 onExtensions 订阅 + toggle 动作骨架。
 * install/uninstall 完整流程属第3项真实集成，本计划不展开。
 *
 * 契约见 contract.md §2.5。
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

- [ ] **步骤 2：编写 plugin.ts（骨架，contract.md §2.6）**

新建 `src-electron/renderer/src/api/domains/plugin.ts`：

```ts
/**
 * Plugin 域 —— 本计划只建 onPlugins 订阅骨架（解锁全局链路）。
 * toggle/install/permissions 等属第3项。
 *
 * 契约见 contract.md §2.6。
 */
import type { PluginInfo } from '@xyz-agent/shared'
import * as events from '../events'

export function onPlugins(handler: (plugins: PluginInfo[]) => void): () => void {
  return events.onGlobalType('config.plugins', (msg) => {
    handler(msg.payload.plugins as PluginInfo[])
  })
}
```

#### 任务 2b-4：返工 settings.ts

- [ ] **步骤 1：重写 settings.ts（删错误 Promise，contract.md §2.7）**

整体替换 `src-electron/renderer/src/api/domains/settings.ts`：

```ts
/**
 * Settings 域 —— SettingsModal 数据源（返工：纠正订阅 vs 请求契约）。
 *
 * 返工前（错误）：getSkills/getAgents/getExtensions 全 Promise，real 模式后端不响应。
 * 返工后（正确）：providers 请求+订阅；skills/agents/extensions/defaults 纯订阅；
 *               setProvider 动作；system 纯前端 localStorage。
 *
 * 契约见 contract.md §2.7。本域是 config/extension 订阅的薄封装，
 * 供 SettingsModal 统一从 @/api/settings 消费（不直接散落 import config/extension）。
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

// ── 订阅（转发 config / extension 域，供 SettingsModal 统一入口）──
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
    try { parsed = JSON.parse(raw) as Partial<SystemSettings> } catch { /* 损坏数据用默认 */ }
  }
  return Promise.resolve({ ...DEFAULT_SYSTEM, ...parsed })
}

export function updateSystem(patch: Partial<SystemSettings>): Promise<void> {
  // 同步读当前值再合并写回（getSystem 已做容错）
  void getSystem().then((cur) => {
    localStorage.setItem(SYSTEM_KEY, JSON.stringify({ ...cur, ...patch }))
  })
  return Promise.resolve()
}
```

**说明：** `onExtensions` 直接转发 `extensionDomain.onExtensions`，不引入 model 域（settings 不需要 model 列表，ModelSelectPopover 自己订阅 `model.onModels`）。`updateSystem` 用 `getSystem().then` 链式合并，避免重复 localStorage 解析逻辑。`ExtensionInfo` 来自 `@xyz-agent/shared`（protocol.ts:265 已定义）。

- [ ] **步骤 2：类型检查**

运行：`cd src-electron/renderer && npx vue-tsc --noEmit`
预期：无错误。若 `SetProviderData`/`ExtensionInfo` 未从 `@xyz-agent/shared` 导出，检查 shared 是否 re-export（protocol.ts 顶部 `import type { SkillInfo, AgentInfo } from './provider'`，provider.ts 应有这些类型；ExtensionInfo 在 protocol.ts line 265 已定义）。

- [ ] **步骤 3：暂不提交（与 2c mock 一起测）**

### 任务 2c：建 mock domain 实现

**目的：** mock 门面对齐新契约。订阅型 mock 需模拟「注册即触发初始值」（因为 real 模式 sendInitialState 连接即推）。

**文件：**
- 修改：`src-electron/renderer/src/api/mock/index.ts`（settings 对齐 + 加 config/model/extension/plugin）

- [ ] **步骤 1：编写 config/model/extension/plugin 的 mock**

在 `src-electron/renderer/src/api/mock/index.ts` 末尾追加（保留现有 session/chat/settings 块，settings 块在步骤 2 返工）：

```ts
/* ── Config mock（订阅型：注册即触发初始值，模拟 sendInitialState）── */

import { fixtureProviders, fixtureSkills, fixtureAgents } from './settings-data'

type GlobalHandler<T> = (data: T) => void

/**
 * mock 订阅工厂：注册后微任务触发一次初始值（模拟 sendInitialState 连接即推）。
 * 订阅型接口（onSkills/onModels/...）用这个；请求型（listProviders）直接返 fixture。
 */
function makeMockSubscription<T>(initial: () => T) {
  const handlers = new Set<GlobalHandler<T>>()
  return {
    subscribe(handler: GlobalHandler<T>): () => void {
      handlers.add(handler)
      // 微任务触发初始帧（模拟连接后推送；避免同步触发时组件未挂载完）
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
  // 请求型：直接返 fixture 深拷贝（不依赖 sub）
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
  // 订阅型
  onProviders: (h: GlobalHandler<unknown>) => providersSub.subscribe(h),
  onSkills: (h: GlobalHandler<unknown>) => skillsSub.subscribe(h),
  onAgents: (h: GlobalHandler<unknown>) => agentsSub.subscribe(h),
  onDefaults: (h: GlobalHandler<string>) => defaultsSub.subscribe(h),
  // 动作型（mock 仅 ack，状态变更不广播——real 模式由订阅推回）
  async setProvider(_providerId: string, _data: unknown) { await sleep(TIMING.ack) },
  async deleteProvider(_providerId: string) { await sleep(TIMING.ack) },
  async setSkill(_skill: unknown) { await sleep(TIMING.ack) },
  async deleteSkill(_skillId: string) { await sleep(TIMING.ack) },
  async setAgent(_agent: unknown) { await sleep(TIMING.ack) },
  async deleteAgent(_agentId: string) { await sleep(TIMING.ack) },
}
```

**说明：** 请求型（`listProviders`/`scan*`/`discoverModels`）直接返 fixture 深拷贝，不依赖 sub；订阅型（`on*`）用 `makeMockSubscription` 注册即触发初始值；动作型（`set*`/`delete*`）仅 `sleep` ack，不广播（real 模式状态由订阅通道推回，mock 保持简单）。三类分开，签名与 `domains/config.ts` 一一对应。

- [ ] **步骤 2：编写 model/extension/plugin mock + settings mock 返工**

继续在 `mock/index.ts` 追加。model 用 composer-data 的 MOCK_MODELS 转 ModelInfo：

```ts
import { MOCK_MODELS, type MockModel } from './composer-data'

function mockModelToInfo(m: MockModel): { id: string; name: string; provider: string; providerColor?: string; tag?: string } {
  return { id: m.id, name: m.name, provider: m.provider, providerColor: m.providerColor, tag: m.tag }
}

const modelsSub = makeMockSubscription(() => MOCK_MODELS.map(mockModelToInfo))

export const model = {
  onModels: (h: GlobalHandler<any>) => modelsSub.subscribe(h),
  async switchModel(_sessionId: string, _provider: string, _modelId: string) { await sleep(TIMING.ack) },
}

/* ── Extension mock ── */
const extensionsSub = makeMockSubscription((): any[] => [])  // fixture 暂空，第3项接真实

export const extension = {
  onExtensions: (h: GlobalHandler<any>) => extensionsSub.subscribe(h),
  async toggle(_name: string, _enabled: boolean) { await sleep(TIMING.ack) },
}

/* ── Plugin mock ── */
const pluginsSub = makeMockSubscription((): any[] => [])

export const plugin = {
  onPlugins: (h: GlobalHandler<any>) => pluginsSub.subscribe(h),
}
```

**返工 settings mock 块：** 把 `mock/index.ts` 现有的 `export const settings = {...}`（line 192-222，全 Promise get*）替换为对齐新契约的版本——删 `getSkills/getAgents/getExtensions`，加 `onSkills/onAgents/onExtensions/onProviders/onDefaults` 转发到上面的 sub，`getSystem/updateSystem` 走 localStorage（与 real 一致）：

```ts
export const settings = {
  // 订阅（转发到 mock sub）
  onProviders: config.onProviders,
  onSkills: config.onSkills,
  onAgents: config.onAgents,
  onExtensions: extension.onExtensions,
  onDefaults: config.onDefaults,
  // 请求
  listProviders: config.listProviders,
  // 动作
  setProvider: config.setProvider,
  // 纯前端偏好（localStorage）
  async getSystem(): Promise<any> {
    const raw = localStorage.getItem('xyz-agent:system-settings')
    return raw ? JSON.parse(raw) : { locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' }
  },
  async updateSystem(patch: Record<string, unknown>): Promise<void> {
    const cur = JSON.parse(localStorage.getItem('xyz-agent:system-settings') ?? '{}')
    localStorage.setItem('xyz-agent:system-settings', JSON.stringify({ ...cur, ...patch }))
  },
}
```

- [ ] **步骤 3：更新门面 api/index.ts 加新 domain**

修改 `src-electron/renderer/src/api/index.ts`，加 config/model/extension/plugin：

```ts
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
```

- [ ] **步骤 4：类型检查**

运行：`cd src-electron/renderer && npx vue-tsc --noEmit`
预期：无错误。mock 与 real 签名必须一一对应（门面三元要求两侧同构）。

- [ ] **步骤 5：提交（2b + 2c 合并）**

```bash
cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime
git add src-electron/renderer/src/api/domains/ \
        src-electron/renderer/src/api/mock/index.ts \
        src-electron/renderer/src/api/index.ts
git commit -m "refactor(api): rework domain contracts to request/subscribe/action (config/model/extension/plugin + settings rework)"
```

### 任务 2d：组件迁移（删硬编码 import）

**目的：** 7+ 处组件 `import { MOCK_* }` 改走 `@/api` 门面或常量模块。

#### 任务 2d-1：ModelSelectPopover → model.onModels

**文件：** `src-electron/renderer/src/components/panel/ModelSelectPopover.vue`

- [ ] **步骤 1：改组件订阅 model.onModels**

修改 `ModelSelectPopover.vue` 的 `<script setup>`（line 68-107 区域）。把 `import { MOCK_MODELS } from '@/api/mock/composer-data'` 改为订阅：

```ts
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { model as modelApi, type ModelInfo } from '@/api'

const emit = defineEmits<{
  select: [modelId: string]
}>()

// 接收外部当前选中（Composer 传入），替代写死的 'claude-sonnet-4.5'
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

**注意：** `ModelInfo` 类型需从 `@/api` re-export 供组件用。在 `api/index.ts` 末尾加一行（若任务 2b-2 已建 `domains/model.ts` 导出了 `ModelInfo`）：

```ts
// api/index.ts 末尾追加
export type { ModelInfo } from './domains/model'
```

模板里 `MOCK_MODELS` 的所有引用同步改成 `models.value`（`groups` computed 已改，检查 template 的 `v-for` 是否还有遗漏）。

- [ ] **步骤 2：改 Composer 传 selected prop + 接 select 事件**

`Composer.vue` line 39 `<ModelSelectPopover @select="onModelSelect" />` 改为传入当前 model（若有 store 字段；若无先用 ref 占位）：

```vue
<ModelSelectPopover :selected="currentModelId" @select="onModelSelect" />
```

`onModelSelect`（line 151 TODO）本计划**不接 runtime**（属第3项），但把签名补全接收 modelId：

```ts
function onModelSelect(modelId: string): void {
  // TODO(第3项): 对接 runtime model.switch
  currentModelId.value = modelId
}
```

`currentModelId` 在 Composer 内 `const currentModelId = ref('claude-sonnet-4.5')`（占位，第3项接 store/订阅）。

#### 任务 2d-2：ThinkingLevelPopover → 常量模块

**文件：** `src-electron/renderer/src/components/panel/ThinkingLevelPopover.vue`

- [ ] **步骤 1：把 import 从 mock 改为常量**

思考等级是前端固定枚举（非后端数据，见计划开头的清单备注）。把 `import { MOCK_THINKING_LEVELS } from '@/api/mock/composer-data'` 改为从**常量模块**导入。新建 `src-electron/renderer/src/components/panel/thinking-levels.ts`：

```ts
/** 思考等级 6 级（前端固定枚举，非后端推送数据）。后端 session.setThinkingLevel 只收 level 字符串。 */
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

ThinkingLevelPopover.vue 改 `import { THINKING_LEVELS } from './thinking-levels'`，模板/computed 里 `MOCK_THINKING_LEVELS` 全改 `THINKING_LEVELS`。`onThinkingSelect` 保留 TODO（第3项）。

#### 任务 2d-3：CommandPopover → session.commands 订阅骨架 + 候选常量

**文件：** `src-electron/renderer/src/components/panel/CommandPopover.vue`

- [ ] **步骤 1：分离三类数据源**

`@`/`#` 候选无后端通道（搜索能力，第4项），抽到常量模块。`/` 命令建 `session.commands` 订阅骨架。

新建 `src-electron/renderer/src/components/panel/command-candidates.ts`：

```ts
/** @ 引用 / # 文件候选（搜索能力，后端从零，第4项协议缺口）。当前为静态 fixture。 */
export interface MentionCandidate { id: string; name: string; kind: string; icon: string; path?: string }
export interface FileCandidate { id: string; name: string; kind: string; path?: string }

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

CommandPopover.vue 改：
- `import { MENTION_CANDIDATES, FILE_CANDIDATES } from './command-candidates'`（替代 MOCK_MENTIONS/MOCK_FILES）
- `MOCK_SLASH_COMMANDS` 改为订阅 `session.commands`（payload 未契约化，订阅骨架先建，handler 内容暂时 fallback 到静态命令列表）

```ts
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import * as events from '@/api/events'

const slashCommands = ref<Array<{ id: string; name: string; kind: string; icon: string }>>([
  { id: 'cmd-commit', name: '/commit', kind: '提交', icon: 'terminal' },
  { id: 'cmd-review', name: '/review', kind: '审查', icon: 'star' },
  { id: 'cmd-fix', name: '/fix', kind: '修复', icon: 'wrench' },
])

// 订阅骨架：session.commands payload 契约化前用静态 fallback
let unsub: (() => void) | null = null
onMounted(() => {
  unsub = events.onGlobalType('session.commands', (msg) => {
    // TODO(第4项 4e): payload 结构契约化后解析 msg.payload.commands
    // 当前 payload 未定，保持静态 fallback
  })
})
onBeforeUnmount(() => { unsub?.() })
```

`items` computed（line 90-113）的 mention/file 分支改用 `MENTION_CANDIDATES`/`FILE_CANDIDATES`，slash 分支用 `slashCommands.value`。

#### 任务 2d-4：ContextCapacityPopover → context.update 订阅骨架

**文件：** `src-electron/renderer/src/components/panel/ContextCapacityPopover.vue`

- [ ] **步骤 1：改 import + 订阅骨架**

`ContextCapacityPopover.vue` line 70-72 的 `import { MOCK_CONTEXT_STATS }` + `const stats = MOCK_CONTEXT_STATS` 改为：

```ts
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as events from '@/api/events'

interface ContextStats { used: number; total: number; percent: number; cacheHit: number; modelId: string }

// 初始值用原 fixture 数据（context.update payload 未契约化，第4项 4e）
const stats = ref<ContextStats>({ used: 69000, total: 1000000, percent: 6.9, cacheHit: 98.7, modelId: 'claude-sonnet-4.5' })

let unsub: (() => void) | null = null
onMounted(() => {
  unsub = events.onGlobalType('context.update', (msg) => {
    // TODO(第4项 4e): payload 结构契约化后解析 msg.payload
  })
})
onBeforeUnmount(() => { unsub?.() })
```

模板里 `stats` 的字段访问不变（结构相同），只是从常量变成 ref。`MOCK_CONTEXT_STATS` 可保留在 composer-data.ts 作 fixture（其他地方未用），但组件不再 import。

- [ ] **步骤 2：类型检查全部迁移组件**

运行：`cd src-electron/renderer && npx vue-tsc --noEmit`
预期：无错误。检查无残留 `MOCK_MODELS/MOCK_MENTIONS/MOCK_FILES/MOCK_SLASH_COMMANDS/MOCK_CONTEXT_STATS/MOCK_THINKING_LEVELS` 在 components/ 下的 import（ContextChipsBar/ProgressZone 保留，它们本计划不动）。

- [ ] **步骤 3：全量测试**

运行：`cd src-electron/renderer && npx vitest run`
预期：全绿。

- [ ] **步骤 4：提交**

```bash
cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime
git add src-electron/renderer/src/components/panel/ \
        src-electron/renderer/src/api/index.ts
git commit -m "refactor(panel): decouple composer popovers from hardcoded MOCK imports (model/commands/context via api facade)"
```

### 任务 2e：SettingsModal 消费方式返工

**目的：** SettingsModal 的 `watch(open) → Promise.allSettled([getSkills,...])` 改为订阅驱动。

**文件：** `src-electron/renderer/src/components/settings/SettingsModal.vue`

- [ ] **步骤 1：改 SettingsModal 数据加载为订阅**

修改 `SettingsModal.vue` line 135-149 的 `watch(open)` 块。当前：

```ts
watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  const [p, s, a, e, sys] = await Promise.allSettled([
    settings.getProviders(), settings.getSkills(), settings.getAgents(),
    settings.getExtensions(), settings.getSystem(),
  ])
  // ...
})
```

改为：providers/extensions 订阅常驻 + system 读 localStorage；打开时不再 allSettled 拉 skills/agents（它们是订阅，注册即得）：

```ts
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { settings } from '@/api'
import type { ProviderInfo, SkillInfo, AgentInfo, ExtensionInfo } from '@xyz-agent/shared'

// 数据状态（订阅驱动，组件挂载即有数据）
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

// 打开时可选刷新 providers（确保最新）；不再拉 skills/agents（订阅已覆盖）
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    settings.listProviders().then((p) => { providers.value = p }).catch(() => {/* 订阅会兜底 */})
  }
})
```

- [ ] **步骤 2：类型检查 + 测试**

运行：`cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run`
预期：无错误，全绿。

- [ ] **步骤 3：提交**

```bash
cd ~/Code/xyz-agent-workspace/refactor-arch-render-runtime
git add src-electron/renderer/src/components/settings/SettingsModal.vue
git commit -m "refactor(settings): drive SettingsModal from subscriptions (rework getSkills/Agents/Extensions promises to on* subscriptions)"
```

---

## 验收标准（全部任务完成后）

- [ ] **mock 模式（VITE_MOCK=true）全功能可用：** SettingsModal 5 页有数据、ModelSelectPopover 列出模型、CommandPopover 三类候选、ContextCapacityPopover 显示统计。
- [ ] **real 模式（VITE_MOCK=false）链路通：** routeInbound 不再丢弃无 sessionId 消息；config.providers/model.list/config.skills/config.agents/config.plugins 等被 onGlobal 消费（即便 real domain 是 stub，订阅 handler 能被触发，证明链路通）。
- [ ] **`npx vue-tsc --noEmit` 无错误。**
- [ ] **`npx vitest run` 全绿。**
- [ ] **无残留：** `grep -r "MOCK_MODELS\|MOCK_MENTIONS\|MOCK_FILES\|MOCK_SLASH_COMMANDS\|MOCK_CONTEXT_STATS\|MOCK_THINKING_LEVELS" src-electron/renderer/src/components/` 只剩 ContextChipsBar（MOCK_ATTACHED_CONTEXT）和 ProgressZone（MOCK_PROGRESS_STATES）——这两个本计划明确不动。
- [ ] **契约 review：** `contract.md` §5 检查清单全部确认。

---

## 不在本计划范围（明确边界，避免 scope creep）

- **第3项真实集成：** Composer 两 TODO（model.switch/setThinkingLevel 真接 runtime）、Fork 改 tree-fork、Settings 5 子页 CRUD 实装、13 个 ServerMessage 消费、real domain 订阅实装。本计划只建骨架 + 契约，不接真实数据流。
- **第4项协议缺口：** message.file_changes（ADR-0024）、附件/多模态、搜索 Overlays、discovery.json 写入、context.update/session.commands payload 契约化、pi todo 推送。ContextChipsBar/ProgressZone/FileView 不动。
- **ProviderEditModal 的 setProvider：** 保留当前 setTimeout 模拟，第3项 3c 接 `config.setProvider`。

## 下一步（本计划完成后）

1. review `contract.md`，确认形态判定。
2. 开第3项计划（真实集成），以本计划产出的 domain 骨架 + 契约为输入。
3. 第4项里 4a（file_changes）ADR-0024 已就绪，可随时启动。
