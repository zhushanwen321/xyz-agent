# 拆分 session.activeId 双语义：per-panel send + focusedSessionId

## 背景

`session.activeId` 身兼多职，在 split panel 下产生三类不一致：
1. **send 串读**：`useChat.send/steer/followUp/abort/compact` 全部读 `session.activeId`，在 standby panel 的 composer 发消息会发到 active panel 的 session（正确性 bug）
2. **高亮不跟随**：panel focus 切换时 sidebar 高亮不动（本 bug）
3. **执行态**：已被 `unify-session-active-state` 解决（derivedStatus 去掉 activeId 依赖）

已完成的迁移（本次不改）：
- `useComposerModelThinking` → per-panel sessionId 读取 ✅
- `useSessionDerivations.derivedStatus` → 移除 activeId 依赖 ✅
- `Turn.vue editAndResend(sessionId, ...)` → 已显式 sid ✅

pi 并发模型已确认：每个 session 独立 pi 进程，两 panel 可真正并发发消息，send 不需要 switchSession，runtime 侧 `MessageDispatcher` 天然 per-session 路由，**无需任何 runtime 改动**。

## 两个阶段（严格串行）

阶段二依赖阶段一：若先让 sidebar 高亮跟随 focusedSessionId 但 send 仍读 activeId，会出现"高亮 B、发到 A"的新不一致。必须先让 send 脱离 activeId。

---

## W1（阶段一）：useChat 全部 action 改显式 sessionId

**目标**：send/steer/followUp/abort/compact 加 `sessionId` 首参，与 `editAndResend` 签名对齐。Composer/Turn/useNewTaskFlow 调用处传各自 panel 的 sessionId。

### 改动文件

**1. `packages/renderer/src/composables/features/useChat.ts`**（核心）
- `send(sessionId: string, text: string)`：line 122 `const sid = session.activeId` → 用参数 `sessionId`；移除 `if (!sid) return`（参数保证非空，由调用方保证）。内部 busy 转 steer 的递归调用改为 `await steer(sessionId, trimmed)`
- `steer(sessionId: string, text: string)`：line 155 同理
- `followUp(sessionId: string, text: string)`：line 179 同理；内部退化 send 改为 `await send(sessionId, trimmed)`
- `abort(sessionId: string)`：line 210 同理
- `compact(sessionId: string, customInstructions?: string)`：line 233 同理
- `editAndResend` 签名不变（已正确）
- `session` store 引用保留（ensureStreamSubscription 的跨 store 协调 + session.* 事件处理仍需要），但 send 系列不再从它读 activeId
- 更新文件头注释 + 各方法 JSDoc，标注 per-session 语义

**2. `packages/renderer/src/components/panel/Composer.vue`**
- line 285 `await send(text)` → `await send(props.sessionId!, text)`（canSend 已守卫 sessionId 场景；variant=landing 走 submitFirstMessage 分支，不走 send）
- line 279 `await compact(customInstructions)` → `await compact(props.sessionId!, customInstructions)`
- line 324 `await abort()` → `await abort(props.sessionId!)`
- line 300 `await submit(draft.value, steer)` → steer 已加 sid：`submit(draft.value, (t) => steer(props.sessionId!, t))`
- line 306 followUp 同理
- onSend 里 panel 分支（非 landing）props.sessionId 必非 null（landing 走另一分支），用 `!` 断言

**3. `packages/renderer/src/composables/features/useNewTaskFlow.ts`**
- line 206 `await chat.send(trimmed)` → `await chat.send(newSid, trimmed)`（newSid = currentSession.value!.id，line 196 已定义）
- line 205 注释"activeId 已设 → useChat.send 能取到 sid"更新为 per-session sid 语义

**4. `packages/renderer/src/components/panel/message-stream/Turn.vue`**
- line 267 `editAndResend` 调用已传显式 sessionId（props.sessionId），无需改，确认即可

### W1 测试适配

**5. `packages/renderer/src/__tests__/useChat.test.ts`**
- 所有 `send('hello')` / `steer(...)` / `abort()` / `compact()` 调用加首参 sid（如 `send('s-subscribe', 'hello')`）
- mock 工厂不变（apiMock.send 等签名不变，那是 api 层）
- 各测试已有的 `session.activeId = 's-xxx'` 可保留（不再被 send 读取，但保留无害）或移除（清理）

**6. `packages/renderer/src/__tests__/fg1-dataflow.test.ts`** / **`session-renamed-sync.test.ts`** / **`session-state-changed-sync.test.ts`**
- 检查并适配 send/steer/abort/compact 调用的签名（加首参 sid）

### W1 验证
- `cd packages/renderer && npx vitest run` 全绿
- `pnpm --filter @xyz-agent/frontend run typecheck` EXIT 0

---

## W2（阶段二）：引入 focusedSessionId，UI 焦点脱离 activeId

**目标**：新增从 `panel.activePanelId` 派生的 `focusedSessionId`，UI 消费方（sidebar 高亮/文件树/overview/searchModal）改读它。panel focus 切换 → 高亮自动跟随（本 bug 修复）。

### 设计：focusedSessionId 放哪

放在 **features 层 composable**（`useSidebar` 或新建轻量 `usePanelFocus`），因为派生需同时读 panel store（activePanelId + panels）——符合 R2「跨 store 协调在 features 层」。不放在 panel store 内（store 不派生跨域状态），不放在 session store（不该依赖 panel store）。

选择：**在 `useSidebar` 内新增 `focusedSessionId` computed 并 export**（useSidebar 已是 session↔panel 桥接的归位点，且 Sidebar.vue 已实例化它）。不新建文件，避免过度拆分。

```ts
// useSidebar.ts
const panel = usePanelStore()
const focusedSessionId = computed<string | null>(() => {
  const leaf = panel.panels.find((p) => p.id === panel.activePanelId)
  return leaf?.sessionId ?? null
})
// export { ..., focusedSessionId }
```

### 改动文件

**1. `packages/renderer/src/composables/features/useSidebar.ts`**
- 新增 `focusedSessionId` computed（上述），加入 return
- 新增 `focusedSession` computed（从 session.list 按 focusedSessionId 查，给 FileView 的 label/branch 用）——或复用现有 `session.active` 的逻辑改读 focusedSessionId

**2. `packages/renderer/src/components/sidebar/Sidebar.vue`**
- line 82 `:active-id="session.activeId"` → `:active-id="focusedSessionId"`
- line 92-93 FileView `v-if` + `:session-id="session.activeId"` → `focusedSessionId`
- line 94-95 `:session-label` / `:branch` 从 `currentSession`（读 session.active）→ 改读 focusedSession
- line 124 SearchModal `:active-session-id="session.activeId"` → `focusedSessionId`
- line 177 `currentSession` computed 改读 focusedSession
- line 185 `fileCount` 的 `const sid = session.activeId` → `focusedSessionId`
- 从 useSidebar 取 focusedSessionId / focusedSession

**3. `packages/renderer/src/components/overview/Overview.vue`**
- line 40 `:active="s.id === session.activeId"` → `:active="s.id === focusedSessionId"`
- 从 useSidebar 取 focusedSessionId

**4. `packages/renderer/src/components/workspace/Workspace.vue`**
- line 49 `hasSession` computed `session.activeId !== null` → `focusedSessionId !== null`
- 从 useSidebar 取 focusedSessionId

**5. `packages/renderer/src/components/shell/AppShell.vue`**
- line 63 `session.activeId = cur.sessionId` — **保留不动**。导航回退/前进时设 activeId 是"导航锚点"语义，syncSessionToPanel 会把 session 载入 panel 并 setActive，focusedSessionId 随之派生更新。activeId 在此仍作为导航栈的配套状态，不删除。

### activeId 的最终语义（W2 后）

`session.activeId` 收敛为：
- **导航/启动锚点**：useNewTaskFlow（landing 不变量：startFlow 清 null / submitFirstMessage 设值）、useSidebar.selectSession（设值供导航 push）、AppShell 导航 watch（回退/前进恢复）
- **不再驱动** UI 高亮（→ focusedSessionId）、send 目标（→ 显式 sid）、执行态（→ isActive）
- `session.active` computed 保留（仍有消费者如导航逻辑），但 UI 高亮消费方全部改读 focusedSession

### W2 测试

**6. 新增 `packages/renderer/src/__tests__/panel/focused-session-id.test.ts`**
- T1：单 panel，activePanelId=root，leaf.sessionId='s1' → focusedSessionId='s1'
- T2：split 后左 panel sessionId='s1'（active），右 panel sessionId='s2' → focusedSessionId='s1'；setActive(右) → focusedSessionId='s2'（核心 bug 回归）
- T3：split 后右 panel sessionId=null（standby 空态）→ setActive(右) → focusedSessionId=null
- T4：mount Sidebar，split 双 panel，setActive(右 s2) → 断言 SessionList 右侧 session 高亮（`:active` prop 为 true），左侧不高亮（DOM 断言，满足测试规范 §5 用户可见断言）

**7. 适配现有测试**
- `panel.store.test.ts`：已有 split/setActive 测试，可能需加 focusedSessionId 断言
- 涉及 Sidebar mount 的测试（如有）：active-id prop 来源变更适配

### W2 验证
- `cd packages/renderer && npx vitest run` 全绿
- `pnpm --filter @xyz-agent/frontend run typecheck` EXIT 0
- 手动验证（dev 模式）：split 双 panel，各载入不同 session，点击切 panel focus，确认 sidebar 高亮 + 文件树跟随

---

## 不做（范围控制）

- **不改 runtime**：MessageDispatcher 天然 per-session 路由，无需改动
- **不删 session.activeId**：收敛为导航语义，保留。useNewTaskFlow/AppShell 的 activeId 写入不动
- **不改 useChat 的 ensureStreamSubscription 跨 store 协调**：session.* 事件处理保留读 sessionStore（更新 label/state），这不依赖 activeId
- **不做 landing 态双 panel 的 pendingModel 单例问题**（sess_1f37b3c0 标注 deferred，v1 不存在双 landing）
- **不改 SearchModal 内部逻辑**：只改传入的 active-session-id 数据源

## 风险点

1. **W1 send→steer 递归调用传 sid**：send 内部 busy 转 steer 必须传同一 sessionId，不能漏。这是 W1 唯一需要小心的逻辑链
2. **W2 focusedSessionId 在 useSidebar 实例化时机**：useSidebar 被 6+ 组件实例化（refCount 保护），focusedSessionId 是 computed 不涉及注册，安全。但需确认 Overview/Workspace 能取到 useSidebar 的 focusedSessionId（它们已实例化 useSidebar 或可新增）
3. **AppShell 导航 watch 的 activeId 写入与 focusedSessionId 的关系**：导航回退到 session B → 设 activeId=B → syncSessionToPanel 载入 panel + setActive → focusedSessionId 派生=B。链条正确，但需测试覆盖（T2 变体）