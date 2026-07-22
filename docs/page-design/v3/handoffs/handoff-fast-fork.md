# Handoff · fast-fork · 快速分叉（待开工型 · spec + draft 已立，待实现）

> 痛点1 主线。设计阶段已完成（spec + 终态 demo），本 handoff 是"设计 → 实现"的交接契约。
> 接手者读本文 + `../fast-fork/spec.md` + `../fast-fork/draft-fast-fork.html` 即可开工，不需读全量上下文。

## 1. 路径

- 目录：`v3/fast-fork/`
- 文件：
  - `spec.md`（✅ 设计规范 SSOT，详尽到实现锚点）
  - `draft-fast-fork.html`（✅ 终态交互 demo，可直接浏览器打开）
- 层级：L2 跨区联动 · 跨 Panel + Sidebar + Composer 三区
- 分支：`feat-fast-fork-session`（已切出，HEAD == main，无独有改动，从零开工）

## 2. 产物现状

**spec.md** 已覆盖：
- §0 背景与问题（v1 fork 三处阻断点 + 代码证据）
- §1 要收口的冲突（6 维裁决表）
- §2 核心裁决 · 三层改动（入口层 / 行为层 / 管理层）
- §3 反馈行规范（SystemNotice 变体）
- §4 Key States（12 个状态）
- §5 交互模型（端到端流程）
- §6 Content Requirements（文案表）
- §7 视觉规范（token 锚点）
- §8 实现锚点（精确到文件:行号的改动清单）
- §9 联动与依赖
- §10 Open Questions（5 项实现时再定）
- §11 反模式（8 条禁止）
- §12 验收 checklist（16 项）
- §14 路线图位置（与痛点2/3 的关系）

**draft-fast-fork.html** 是终态交互 demo，覆盖：
- App 骨架（sidebar + main panel + composer）
- 侧栏当前 session 下方的"本会话的分支"小列表（方案3）
- Panel 含 2 条 assistant 消息（第 2 条 streaming 态，演示"对话进行中也能 fork"）
- 每条 assistant hover 出两组按钮（复制/MD | fork 后台/fork 提问）
- composer fork 模式（三重视觉 + chip + placeholder 切换）
- demo bar（进入 fork 提问 / ⌘G 纯 fork / 重置）
- 快捷键监听（⌘G / ⌘⇧G / Esc / ⌘Enter）
- toast 反馈

## 3. 要做的事情（实现 checklist）

按依赖顺序，分 5 步：

### Step 1 · 基础层（前置依赖，痛点1 和痛点2 共同基础）

- [ ] `packages/shared/src/session.ts:20-44` SessionSummary 类型补 `parentSession?: string` 字段
- [ ] runtime `session.fork` RPC 响应回传 `parentSession`（现在 `session-fork.ts:141` 写了 JSONL header 但 RPC response 没带）
- [ ] 验证：fork 一个 session 后，前端能拿到新 session 的 parentSession 指向源

### Step 2 · Fork 入口层

- [ ] `packages/renderer/src/components/panel/message-stream/Turn.vue:248` 放开门控：去掉 `!isSessionActive`，保留 `!isSubagentVirtualId(sessionId)`
- [ ] `Turn.vue` 的 fork 按钮区从 1 个扩成 2 个（fork 后台 + fork 提问），中间加 `as-sep` 分隔
- [ ] 每条 assistant 消息 hover 都出 fork 按钮（不只 `lastAssistant`）—— `Turn.vue:479` 的 `onForkConfirm` 改为接受当前消息 entryId 参数
- [ ] 两个 fork 按钮 accent 高亮，与中性复制按钮区分（spec §7 token 锚点）

### Step 3 · Fork 行为层

- [ ] `packages/renderer/src/composables/features/useSidebar.ts:466-470` 去掉 `panel.split()` + `selectSession(standby)`，fork 后留在原线
- [ ] 新增 `forkSessionAsk(content: string)` 方法：原子地 fork + 发送首条 message
- [ ] 删除 `ForkConfirmModal.vue` + `Turn.vue:271` 的引用 + `forkOpen`/`openFork`/`onForkConfirm` 清理
- [ ] 实现反馈行（fork-notice）：在 message-stream 对话流插入，走 SystemNotice 变体（info-soft 底，非 banner）

### Step 4 · Composer fork 模式

- [ ] Composer 组件新增 `forkMode` ref + `enterForkMode()` / `exitForkMode()` 方法
- [ ] composer 容器 class 绑定 `fork-mode`（三重视觉：accent 边 + 3px accent-ring glow + 5% accent 底）
- [ ] composer-mode-row + mode-chip（"将发到新分支 · 与主线隔离" + ×）
- [ ] placeholder / 发送按钮文案切换（spec §6 表）
- [ ] 发送逻辑分支：forkMode 下调 `forkSessionAsk(content)`，发送后自动 `exitForkMode()`
- [ ] Esc 监听：fork 模式下退出

### Step 5 · 后台分支小列表 + 快捷键

- [ ] `SessionList.vue` 当前激活 session 下方渲染 `<ForkGroup>` 子组件
- [ ] ForkGroup 从 sessions filter `parentSession === currentSession.sessionFile`
- [ ] 折叠/展开 + fresh 高亮（3.2s 淡出）
- [ ] fork-ask 分支标题用提问预览，纯 fork 用"分支 N"
- [ ] 快捷键注册：`⌘G` → forkSession()，`⌘⇧G` → enterForkMode()，实现时核查现有快捷键表防冲突

## 4. 关联文档（md）

- `v3/fast-fork/spec.md` — 本单元设计 SSOT（必读）
- `v3/panel/spec.md` — Panel 4 zone 结构
- `v3/sidebar/spec.md` + `draft-session-item.html` — Session Item 原子（`.si` 类规范）
- `v3/panel/draft-message-stream.html` — 回合 action 行的现有结构（复制/MD 按钮）
- `docs/page-design/design-tokens.md` — 冷蓝暗色 token SSOT
- `docs/page-design/design-system.md` — 原语层（Card-Inline / Status Dot / 左色条反模式）

## 5. 关联 HTML（draft）

- `v3/fast-fork/draft-fast-fork.html` — **本单元终态 demo**（实现的视觉/交互参照）
- `v3/panel/draft-message-stream.html` — assistant 消息 action 行的现有形态（fork 按钮要嵌入这里）
- `v3/panel/draft-composer-states.html` — composer 现有状态（fork 模式是新增状态）
- `v3/sidebar/draft-session-item.html` — `.si` 原子 + 折叠子会话的现有范式（`§7 折叠子会话/分支节点`，fork-group 复用此结构）

## 6. 关键代码现状（explorer 摸清的证据，实现时定位用）

| 现状 | 文件:行号 | 改动 |
|---|---|---|
| fork 门控 | `packages/renderer/src/components/panel/message-stream/Turn.vue:248` | 去掉 `!isSessionActive` |
| fork 固定取末条 | `Turn.vue:477-483` `onForkConfirm` | 改为接受 entryId 参数 |
| fork 后 split+跳转 | `useSidebar.ts:466-470` | 去掉 split + selectSession |
| ForkConfirmModal 引用 | `Turn.vue:271` + `ForkConfirmModal.vue` | 删除 |
| SessionSummary 无 parentSession | `packages/shared/src/session.ts:20-44` | 补字段 |
| runtime 写了 JSONL 但不回传 | `packages/runtime/src/services/session-fork.ts:141` | RPC response 带 parentSession |
| 侧栏扁平 cwd 分组 | `SessionList.vue:10-34` | 当前 session 下方加 ForkGroup |
| SessionItem 只有 rename/delete | `SessionItem.vue:42-68` | 不改（fork 入口在 message-stream，不在侧栏） |
| panel 单/双状态机 | `stores/panel.ts:14-87` | 不改（5+ 路靠侧栏，不突破 panel） |
| SystemNotice 丢弃 summary | `SystemNotice.vue:38-41` | 反馈行不复用 SystemNotice，新建组件保留字段 |

## 7. 验收 P0（必过 checklist，对应 spec §12）

- [ ] streaming/pending 态 fork 按钮可见可点
- [ ] 每条 assistant 消息 hover 都出 fork 按钮（不只末条）
- [ ] 两个 fork 按钮并列（fork 后台 + fork 提问），accent 高亮
- [ ] fork 后不 split、不跳转，留在原线
- [ ] 对话流插反馈行（info-soft 底，非 banner）
- [ ] composer fork 模式三重视觉 + chip + placeholder 切换
- [ ] fork-ask 发送 = 原子操作，主线不参与
- [ ] fork-ask 发送后自动退出 fork 模式
- [ ] Esc 退出 fork 模式
- [ ] 侧栏当前 session 下方分支小列表（方案3）
- [ ] SessionSummary 带 parentSession，RPC 回传
- [ ] ForkConfirmModal 已删除
- [ ] ⌘G / ⌘⇧G 快捷键无冲突

## 8. 测试视角（遵循项目 TEST-STRATEGY.md 三视角）

实现后测试必须覆盖三个视角，避免"测试全绿但功能不可用"：

- **构建者（白盒）**：forkSession / forkSessionAsk 状态机、parentSession 字段流转、forkMode ref 切换
- **使用者（黑盒）**：mount Panel，用户能否完成"hover → fork 提问 → 打字 → 发送 → 看到反馈行 + 侧栏新增"完整旅程
- **观察者（形态）**：composer fork 模式三重视觉是否明显、反馈行是否在对话流正确位置、分支小列表是否在当前 session 正下方

**首屏冒烟（必含 1 条）**：mount Panel，断言 fork 按钮存在于每条 assistant 消息的 DOM。

## 9. Open Questions（实现时与用户确认，不阻塞开工）

1. fresh 高亮：3.2s 定时 vs "点过一次才消"
2. 反馈行：手动 × vs 自动消失（10s）
3. 多级 fork 递归：只展示直接子（一层）vs 递归全部
4. fork-ask 首条 message 呈现：普通气泡 vs 带元信息头
5. ⌘G 快捷键冲突核查（候选 ⌘F/⌘D 被占）

## 10. 不在本 handoff 范围（明确边界）

- **痛点2 merge**：依赖本 spec 的基础层（parentSession），但合并语义（倾向 iii 贴入 composer）待基础层就绪后单独讨论，不在本 handoff
- **痛点3 handoff 桥接**：handoff 产物的"在新 session 继续"按钮复用 fork 链路，但属独立 spec，不在本 handoff
- **panel 突破 2 上限**：明确不做（spec §11 反模式），5+ 路靠侧栏管理
