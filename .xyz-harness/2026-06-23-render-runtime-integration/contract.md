# 2a · Domain 接口契约表（请求 / 订阅 / 动作 三类形态）

> **状态：推荐草案，执行 2b 前需 review。**
> **SSOT：** `src-electron/shared/src/protocol.ts`（ClientMessageType 54 个 + ServerMessageType 全集）。
> 本文不写实现代码，只定义每个 domain 接口的**形态分类**和**签名**。实现见主计划 `plan.md` 任务 2b/2c/2d/2e。

---

## 0. 为什么要先定这张表

54 个 ClientMessageType 里**只有 `config.getProviders` 一个 `get*` 主动拉取入口**（外加 `model.list` 这种以请求-响应命名的特例）。其余列表型数据（skills / agents / extensions / plugins / defaults / context / commands）是**纯 server-push 订阅**——后端从不响应 `getSkills` 这种请求，前端发也白发。

现有的 `api/domains/settings.ts` 把 `getSkills/getAgents/getExtensions` 全写成 `Promise<T[]>`，踩的正是这个坑：real 模式下后端不回，`Promise.allSettled` 吞掉 reject，页面空白。**第 2 项必须先纠正契约形态，再写实现。**

domain 接口按消费语义分三类，签名风格各异：

| 形态 | 签名特征 | 后端配合 | 举例 |
|------|---------|---------|------|
| **请求-响应（Request）** | `fn(args): Promise<T>`，走 `pending.create/register` + `transport.send` | runtime handler 收到 ClientMessage 后 `reply(ws, id, type, payload)` | `session.list`、`config.getProviders` |
| **订阅-推送（Subscription）** | `onXxx(handler): () => void`（返回取消函数），handler 收 `ServerMessage` | runtime 主动推 ServerMessage（`sendInitialState` 或运行时广播），**不响应任何 get 请求** | `onSkills`、`onModels`、`onExtensions` |
| **动作-ack（Action）** | `fn(args): Promise<void>`，只关心"成功/失败"，不取返回数据 | runtime 回 `error` envelope（失败）或不回（成功）；状态变更由**配套订阅通道**推送 | `config.setSkill`、`model.switch` |

**关键原则：** 列表数据用「订阅」，编辑/切换用「动作」。动作触发后，**新状态由订阅通道推回来**，调用方不靠动作的返回值刷新 UI。这避免了「动作成功但前端没更新」的竞态（因为状态来源永远是订阅，单一数据流）。

---

## 1. 三类形态的 domain 签名范式

实现时三类形态各有固定写法，对照现有 `session.ts`/`chat.ts` 即可。

### 1.1 请求-响应范式

```ts
// 范式：现有 domains/session.ts 的 list() 就是这个形状
export function listProviders(): Promise<ProviderInfo[]> {
  const id = pending.create()
  const result = pending.register<ProviderInfo[]>(id)
  transport.send({ type: 'config.getProviders', id, payload: {} })
  return result
}
```
- 调用方 `await`，拿结构化数据。
- 后端必须 `reply(ws, msg.id, type, payload)`。
- 失败走统一 `error` envelope → `pending.reject`。

### 1.2 订阅-推送范式（★ 本计划新增的核心范式）

```ts
// 范式：events.on(sessionId, handler) 的全局版
import * as events from '../events'

/** 订阅已导入 skills 列表变更（config.skills push）。返回取消函数。 */
export function onSkills(handler: (skills: SkillInfo[]) => void): () => void {
  return events.onGlobal('config.skills', (msg) => {
    handler(msg.payload.skills as SkillInfo[])
  })
}
```
- **不走 pending**，不 `await`。调用方在组件 `onMounted` 注册、`onBeforeUnmount` 取消。
- 数据来源是 `sendInitialState` 推送的初始帧 + 运行时变更广播。
- `events.onGlobal` 是主计划**任务 1** 新增的 API（当前只有 `on(sessionId, handler)`，无全局通道）。

### 1.3 动作-ack 范式

```ts
export function setSkill(skill: SkillInfo): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'config.setSkill', id, payload: { skill } })
  return result
}
```
- `await` 只为 catch 失败。**不取返回数据**——状态由 `onSkills` 订阅推回。
- 成功时 runtime 可回空 `reply` 或不回（pending 超时兜底）；失败回 `error` envelope。

---

## 2. 接口 → 形态 → 签名 完整映射表

### 2.1 Session 域（已实现，列出供对照，**本次不改**）

| 接口 | 形态 | ClientMessage | 签名 | 现状 |
|------|------|--------------|------|------|
| `list()` | 请求 | `session.list` | `() => Promise<SessionSummary[]>` | ✅ 已实现 |
| `create(title?)` | 请求 | `session.create` | `(label?: string) => Promise<SessionSummary>` | ✅ |
| `switchSession(id)` | 请求 | `session.switch` | `(sessionId: string) => Promise<void>` | ✅ |
| `rename(id, label)` | 请求 | `session.rename` | `(sessionId: string, label: string) => Promise<void>` | ✅ |
| `remove(id)` | 请求 | `session.delete` | `(sessionId: string) => Promise<void>` | ✅ |

### 2.2 Chat 域（已实现，列出供对照）

| 接口 | 形态 | ClientMessage | 签名 | 现状 |
|------|------|--------------|------|------|
| `getHistory(sessionId)` | 请求 | `session.history` | `(sessionId: string) => Promise<Message[]>` | ✅ |
| `send(sessionId, text)` | 动作 | `message.send` | `(sessionId: string, text: string) => Promise<void>` | ✅ |
| `steer(sessionId, text)` | 动作 | `message.steer` | `(sessionId: string, text: string) => Promise<void>` | ✅ |
| `followUp(sessionId, text)` | 动作 | `message.follow_up` | `(sessionId: string, text: string) => Promise<void>` | ✅ |
| `abort(sessionId)` | 动作 | `message.abort` | `(sessionId: string) => Promise<void>` | ✅ |
| `streamSubscribe(sessionId, h)` | 订阅(sessionId 路由) | — | `(sid, h: (msg: ServerMessage) => void) => () => void` | ✅ |

### 2.3 Config 域（★ 新建，`domains/config.ts`）

| 接口 | 形态 | ClientMessage / ServerMessage | 签名 | 后端语义 |
|------|------|------------------------------|------|---------|
| `listProviders()` | **请求** | `config.getProviders` / `config.providers` | `() => Promise<ProviderInfo[]>` | sendInitialState 推 + 主动拉双通道；保留请求态供 modal 打开时刷新 |
| `onProviders(h)` | **订阅** | `config.providers`（push） | `(h: (providers: ProviderInfo[]) => void) => () => void` | sendInitialState line 229 推 |
| `setProvider(id, data)` | **动作** | `config.setProvider` | `(providerId: string, data: SetProviderData) => Promise<void>` | 状态变更由 `config.providerUpdated` push |
| `deleteProvider(id)` | **动作** | `config.deleteProvider` | `(providerId: string) => Promise<void>` | 同上 |
| `discoverModels(req)` | **请求** | `config.discoverModels` / `config.discoveredModels` | `(req: { baseUrl; apiKey?; providerType?; providerId? }) => Promise<DiscoveredModels>` | 失败用 `success:false` 降级（protocol.ts 错误契约第 3 类） |
| `onDefaults(h)` | **订阅** | `config.defaults`（push） | `(h: (defaultModel: string) => void) => () => void` | sendInitialState line 238 推；无对应 get |
| **`onSkills(h)`** | **订阅** | `config.skills`（push） | `(h: (skills: SkillInfo[]) => void) => () => void` | sendInitialState line 245 推；**无 getSkills** |
| `scanSkills(sources)` | **请求** | `config.scanSkills` / `config.scannedSkills` | `(sources: string[]) => Promise<SkillInfo[]>` | 候选扫描（设置页"添加来源"用） |
| `setSkill(skill)` | **动作** | `config.setSkill` | `(skill: SkillInfo) => Promise<void>` | 状态由 `onSkills` 推回 |
| `deleteSkill(skillId)` | **动作** | `config.deleteSkill` | `(skillId: string) => Promise<void>` | 同上 |
| **`onAgents(h)`** | **订阅** | `config.agents`（push） | `(h: (agents: AgentInfo[]) => void) => () => void` | sendInitialState line 249 推；**无 getAgents** |
| `scanAgents(sources)` | **请求** | `config.scanAgents` / `config.scannedAgents` | `(sources: string[]) => Promise<AgentInfo[]>` | 候选扫描 |
| `setAgent(agent)` | **动作** | `config.setAgent` | `(agent: AgentInfo) => Promise<void>` | 状态由 `onAgents` 推回 |
| `deleteAgent(agentId)` | **动作** | `config.deleteAgent` | `(agentId: string) => Promise<void>` | 同上 |

**类型来源：** `ProviderInfo`/`SkillInfo`/`AgentInfo`/`SetProviderData` 来自 `@xyz-agent/shared`（protocol.ts + provider.ts）。`DiscoveredModels` 从 `config.discoveredModels` payload 形状提取（实施时读 runtime handler 确认）。

### 2.4 Model 域（★ 新建，`domains/model.ts`）

| 接口 | 形态 | ClientMessage / ServerMessage | 签名 | 后端语义 |
|------|------|------------------------------|------|---------|
| **`onModels(h)`** | **订阅** | `model.list`（push） | `(h: (models: ModelInfo[]) => void) => () => void` | sendInitialState line 231 推。**注意：`model.list` 既是 push type 又曾有请求语义，但实际无对应 get 入口——按订阅处理** |
| `switch(sessionId, provider, modelId)` | **动作** | `model.switch` | `(sessionId: string, provider: string, modelId: string) => Promise<void>` | 当前选中的确认由 `model.switched` push（订阅可加，见下） |
| `onModelSwitched(h)` | **订阅**（可选） | `model.switched`（push） | `(h: (e: { sessionId: string; provider: string; modelId: string }) => void) => () => void` | 真实集成阶段（第3项）才消费；本计划只建骨架，可选 |

**注意 `model.list` 的歧义：** 它在 ClientMessageType（line 74）和 ServerMessageType（line 180）都存在。ClientMessage 侧发 `model.list` 请求，后端可能 `reply`。**契约判定为订阅优先**：sendInitialState 已主动推，组件订阅即可拿到初始列表；是否额外保留请求态待 review（若 runtime handler 实现了请求-响应，则可并存，见任务 2b 备注）。

### 2.5 Extension 域（★ 新建，`domains/extension.ts`）

| 接口 | 形态 | ClientMessage / ServerMessage | 签名 | 后端语义 |
|------|------|------------------------------|------|---------|
| **`onExtensions(h)`** | **订阅** | `config.extensions`（push） | `(h: (extensions: ExtensionInfo[]) => void) => () => void` | 运行时广播；sendInitialState 未列（需实施时确认是否补） |
| `toggle(name, enabled)` | **动作** | `extension.toggle` | `(name: string, enabled: boolean) => Promise<void>` | 状态由 `onExtensions` 推回 |
| `install(source)` | **动作** | `extension.install` | `(source: string) => Promise<void>` | 触发 `extension.discovered` UI request 流（复杂，第3项） |

**本计划范围只建 `onExtensions` + `toggle` 骨架**（mock 用）。install/uninstall 完整流程属第3项真实集成，本计划不展开（避免占位符）。

### 2.6 Plugin 域（★ 新建骨架，`domains/plugin.ts`）

| 接口 | 形态 | ClientMessage / ServerMessage | 签名 | 后端语义 |
|------|------|------------------------------|------|---------|
| **`onPlugins(h)`** | **订阅** | `config.plugins`（push） | `(h: (plugins: PluginInfo[]) => void) => () => void` | sendInitialState line 255 推 |

**本计划范围：** 只建 `onPlugins` 订阅骨架（解锁全局链路）。toggle/install/permissions 等全留第3项。

### 2.7 Settings 域（★ 返工，`domains/settings.ts` 重写）

**这是本次返工重点。** 现状全 Promise 是错的，按下表纠正：

| 接口 | 形态 | 旧（错） | 新（正确） | 后端依据 |
|------|------|---------|-----------|---------|
| `listProviders()` | 请求 | `getProviders()` | `listProviders(): Promise<ProviderInfo[]>` | `config.getProviders`（唯一合法 get） |
| `onProviders(h)` | 订阅 | ❌ 无 | `(h: (p: ProviderInfo[]) => void) => () => void` | `config.providers` push |
| **`onSkills(h)`** | **订阅** | ❌ `getSkills(): Promise` | **`(h: (s: SkillInfo[]) => void) => () => void`** | `config.skills` push，无 get |
| **`onAgents(h)`** | **订阅** | ❌ `getAgents(): Promise` | **`(h: (a: AgentInfo[]) => void) => () => void`** | `config.agents` push，无 get |
| **`onExtensions(h)`** | **订阅** | ❌ `getExtensions(): Promise` | **`(h: (e: ExtensionInfo[]) => void) => () => void`** | `config.extensions` push，无 get |
| `onDefaults(h)` | 订阅 | ❌ 无 | `(h: (defaultModel: string) => void) => () => void` | `config.defaults` push |
| `setProvider(...)` | 动作 | ❌ 无 | `(providerId, data) => Promise<void>` | `config.setProvider` |
| `getSystem()` | 请求(前端) | `getSystem(): Promise` | `getSystem(): Promise<SystemSettings>` | **纯前端偏好**，localStorage，无后端 |
| `updateSystem(patch)` | 动作(前端) | `updateSystem(): Promise` | `updateSystem(patch): Promise<void>` | 纯前端 localStorage |

**SystemSettings 是纯前端偏好**（locale/theme/themePreset），无对应 ClientMessage/ServerMessage——保持请求/动作形态，但实现走 localStorage 而非 transport（mock 与 real 一致）。

**SettingsModal 消费方式返工：** 现状 `watch(open) → Promise.allSettled([getProviders, getSkills, ...])` 要改成：
- providers：`onProviders` 订阅 + 打开时可选 `listProviders()` 刷新
- skills/agents/extensions：纯 `onXxx` 订阅（组件挂载即订阅，数据由 sendInitialState + 变更广播驱动）
- system：`onMounted` 读 localStorage（同步）

---

## 3. 关键判定理由（review 时重点看这几条）

1. **skills/agents/extensions 为何是纯订阅：** protocol.ts 无 `config.getSkills/getAgents/getExtensions` ClientMessage（只有 `scan*` 候选扫描）。sendInitialState line 245/249 主动推 `config.skills`/`config.agents`。前端发 get 无人响应。**铁证。**

2. **`model.list` 为何按订阅处理：** sendInitialState line 231 主动推 `model.list` ServerMessage。即便 ClientMessage 也有 `model.list`，主路径靠订阅拿初始列表即可。是否并存请求态，取决于 runtime 是否实现了 `model.list` 的请求-响应 reply（实施任务 2b 时读 handler 确认；不确定就先只做订阅，YAGNI）。

3. **为何动作触发后状态靠订阅推回、不靠返回值：** 避免竞态。例如 `setSkill` 成功后，新列表由 `config.skills` 广播推回所有订阅者；若靠动作返回值刷新，多面板/多订阅者会漏更新。单一数据源（订阅）是更稳的心智模型。

4. **为何不把 ContextChipsBar / ProgressZone 纳入本计划：** handoff 2.4 标注它们"无后端通道"（附件缺口 / pi 无 todo 概念），属第4项协议缺口，本计划（第1+2项）不动它们。ContextCapacityPopover 的 `context.update`、CommandPopover 的 `session.commands` 虽有订阅通道，但 payload 结构未契约化（handoff 2.6），本计划**只建订阅骨架、mock 仍用 fixture 占位**，等第4项契约化后再接真实数据。

5. **ProviderEditModal 的 `setProvider` 是真实集成（第3项），本计划不接 transport：** 第2项只把 settings domain 契约改对、建骨架（real domain 内部仍可 throw stub 或最小实现）。`ProviderEditModal` 当前 `setTimeout` 模拟保留，第3项 3c 再接 `config.setProvider`。

---

## 4. domain 文件落点与门面聚合

```
src-electron/renderer/src/api/
├── index.ts              # 门面：isMock ? mock : real（已存在，需加新 domain）
├── events.ts             # +onGlobal/onGlobalType/dispatchGlobal/dispatchSession（任务1）
├── pending.ts            # 不变
├── transport.ts          # 不变
├── domains/
│   ├── session.ts        # 不变
│   ├── chat.ts           # 不变
│   ├── config.ts         # ★ 新建（请求+订阅+动作混合）
│   ├── model.ts          # ★ 新建（订阅为主）
│   ├── extension.ts      # ★ 新建（订阅骨架）
│   ├── plugin.ts         # ★ 新建（订阅骨架）
│   └── settings.ts       # ★ 返工（重写，删 getSkills/Agents/Extensions Promise）
└── mock/
    ├── index.ts          # ★ 返工（settings 对齐新契约；加 config/model/extension/plugin mock）
    ├── data.ts           # session/chat fixture，不变
    ├── settings-data.ts  # 基本不变（fixture 复用）
    └── composer-data.ts  # 基本不变（fixture 复用，组件不再直接 import）
```

**门面签名对齐：** mock 与 real 同名同签名，`api/index.ts` 按 `isMock` 切换。订阅型接口 mock 实现需模拟"注册即触发初始值"（详见主计划任务 2c）。

---

## 5. Review 检查清单（给 reviewer）

执行 2b 前确认以下几点，任一有异议请先在本文档标注，不要带进实现：

- [ ] skills/agents/extensions/plugins/defaults 是否一律纯订阅（无请求态）？
- [ ] `model.list` 先只做订阅，不并存请求态（YAGNI）？
- [ ] SystemSettings 保持纯前端 localStorage，不走 transport？
- [ ] 动作触发后状态一律靠订阅推回，不靠返回值？
- [ ] extension/plugin 本计划只建 `onExtensions`/`onPlugins` + extension.toggle 骨架，install 全流程留第3项？
- [ ] ContextChipsBar/ProgressZone 本计划不碰（后端无通道）？
