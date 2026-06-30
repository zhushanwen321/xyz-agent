# 01 · 新建任务（New Task）测试流程

> 覆盖：⌘N 新建 → Landing 态（选目录 chip / 选分支 chip）→ 首发提交（延迟 create session + 发消息）
>
> 先读 [00-test-strategy-overview.md](./00-test-strategy-overview.md) 理解双轨制和公共前置。

## 1. 功能概述

「新建任务」是用户开启一个 AI coding session 的入口。核心交互：

```
用户按 ⌘N（或点新建按钮）
  → 进入 Landing 态（空 composer 卡片，顶部 directory/branch chip 行）
  → 用户选目录（点 directory chip → 弹 DirSelectPopover → 选工作区）
  → [可选] 选分支（点 branch chip → 弹 BranchSelectPopover → 切分支）
  → 输入消息 + 发送
  → 延迟 create session（首发提交时才建）+ 载入 panel + 发消息
  → 进入对话流（Landing 消失，MessageStream 出现）
```

**关键设计：统一延迟 create**。点「新建任务」**不立即 create session**，只进 Landing 空 chip 态。选目录只记 `pendingCwd`（不建 session）。首发提交（`submitFirstMessage`）才真正 create session。原因：避免用户点新建又退出留下僵尸空 session。

## 2. 组件树

```
Panel.vue (sessionId=null, messageCount=0, !isGenerating)
  └─ Landing.vue (data-testid="new-task-landing")  ← Landing 态渲染入口
       ├─ 时段问候语（上午好呀/下午好呀/晚上好呀）
       ├─ Composer.vue (variant="landing")  ← landing 内嵌 composer 卡片
       │    ├─ #meta-row slot（chip 行）
       │    │    ├─ directory chip (data-testid="chip-directory")
       │    │    │    └─ DirSelectPopover.vue (data-testid="dir-select-popover")
       │    │    │         ├─ workspace-item × N (data-testid="workspace-item")
       │    │    │         ├─ action-open-dir (data-testid="action-open-dir")
       │    │    │         └─ action-remote (data-testid="action-remote")
       │    │    └─ branch chip (data-testid="chip-branch")  ← 仅 git 目录显示
       │    │         └─ BranchSelectPopover.vue (data-testid="branch-select-popover")
       │    │              ├─ branch-item × N (data-testid="branch-item")
       │    │              ├─ action-create-branch (data-testid="action-create-branch")
       │    │              ├─ dirty-confirm (data-testid="dirty-confirm")  ← 工作区脏时确认
       │    │              └─ CreateBranchModal.vue (data-testid="branch-name-error" / "submit-btn")
       │    ├─ ComposerInput.vue (role="textbox")  ← contenteditable 输入区
       │    └─ 工具条（AddMenu / ContextCapacity / Model / ThinkingLevel / 发送按钮）
       └─ retry-history 按钮 (data-testid="retry-history")  ← 仅 historyError=true 时
```

**渲染条件**（`Panel.vue`）：
- `Landing` 渲染：`!isGenerating && isLandingView`，其中 `isLandingView = !sessionId || flow.state.value==='landing'`
- Landing 态 composer 由 Landing 内嵌，Panel 的 `showPanelComposer` 为 false（不重复渲染）

## 3. data-testid 清单

| testid | 文件:行 | 触发/可见条件 |
|--------|---------|--------------|
| `new-task-landing` | Landing.vue:96 | Landing 态恒显 |
| `chip-directory` | Landing.vue:138 | Landing 态恒显（directory chip 行） |
| `chip-branch` | Landing.vue:160 | 仅 git 目录（`gitInfo != null`）显示 |
| `retry-history` | Landing.vue:120 | 仅 `historyError=true`（getHistory 失败）时显示 |
| `dir-select-popover` | DirSelectPopover.vue:113 | 点 directory chip 后弹出 |
| `workspace-item` | DirSelectPopover.vue:141 | popover 内每个工作区项 |
| `action-open-dir` | DirSelectPopover.vue:168 | 「打开其他目录」（触发 OS dialog） |
| `action-remote` | DirSelectPopover.vue:181 | 「克隆远程仓库」 |
| `branch-select-popover` | BranchSelectPopover.vue:156 | 点 branch chip 后弹出 |
| `branch-item` | BranchSelectPopover.vue:199 | popover 内每个分支项 |
| `action-create-branch` | BranchSelectPopover.vue:232 | 「新建分支」 |
| `dirty-confirm` | BranchSelectPopover.vue:260 | 工作区脏时切分支的确认弹窗 |
| `dirty-confirm-cancel` / `dirty-confirm-ok` | BranchSelectPopover.vue:268/276 | 确认弹窗按钮 |
| `branch-name-error` | CreateBranchModal.vue:115 | 新建分支名校验错误 |
| `submit-btn` | CreateBranchModal.vue:131 | 新建分支提交按钮 |
| `composer-box` | Composer.vue:25 | composer 容器（Landing + Panel 态都有） |

## 4. 状态机（useNewTaskFlow）

`composables/features/useNewTaskFlow.ts`，状态枚举（line 32）：

```
'idle' | 'landing' | 'dir-popover' | 'branch-popover' | 'dir-dialog' | 'branch-modal' | 'completed' | 'cancelled'
```

状态转换图（line 73-80 transitions）：

```
idle ──startFlow──→ landing ──openDirPopover──→ dir-popover ──openDirDialog──→ dir-dialog
                       │                              │                           │
                       │                              ├──selectWorkspace──→ landing（记 pendingCwd）
                       │                              ├──cancel──→ landing
                       │                              └──openDirDialog cancel──→ dir-popover→landing
                       │
                       ├──openBranchPopover──→ branch-popover ──openBranchModal──→ branch-modal
                       │                              │                           │
                       │                              ├──selectBranch──→ landing
                       │                              └──confirmDirtySwitch──→ landing
                       │
                       ├──submitFirstMessage──→ completed（终态：create session + 发消息）
                       └──cancel──→ cancelled ──reenterFlow──→ landing

completed ──startFlow──→ idle ──→ landing（AC-3.12：终态再触发先销毁重建）
```

**关键状态字段**（line 84-92）：
- `state: Ref<NewTaskFlowState>` — 当前状态（初始 `idle`）
- `currentSession: Ref<SessionSummary | null>` — 当前 flow 绑定的 session（landing 态恒 null，首发提交才绑定）
- `pendingCwd: Ref<string | null>` — landing 选定但未 create 的 cwd（选目录只记值不建 session）
- `createInFlight: Ref<boolean>` — create 进行中（防双击并发）

## 5. MOCK 模式测试

### 5.1 启动 MOCK dev

```bash
cd src-electron && npm run dev:mock
```

启动后 app 默认进入 Landing 态（无活跃 session）。可手工测试完整流程。

### 5.2 集成测试（vitest，已有）

现有测试覆盖（renderer 集成层，mount 组件 + 断言 store）：

| 测试文件 | 覆盖用例 |
|---------|---------|
| [`__tests__/new-task/flow-integration.test.ts`](../../src-electron/renderer/src/__tests__/new-task/flow-integration.test.ts) | T1.1 startFlow 不 create / T3.1-T3.5 选目录链路 / submitFirstMessage 全链路 / sessionStore 同步 |
| [`__tests__/new-task/landing-precreate-session.test.ts`](../../src-electron/renderer/src/__tests__/new-task/landing-precreate-session.test.ts) | U4/U4b/U4c 选目录延迟 create / U5 首发提交才 create |

**运行**：
```bash
cd src-electron/renderer && npx vitest run src/__tests__/new-task/
```

**这些测试验证了什么**（构建者视角，白盒）：
- `startFlow()` 后 `state.value === 'landing'`，`currentSessionId.value === null`（延迟 create）
- `selectWorkspace(cwd)` 只更新 `pendingCwd`，不调 `sessionApi.create`
- `submitFirstMessage(text)` 调用链：`sessionApi.create(cwd)` → `session.appendSession` → `session.activeId =` → `panel.loadSession` → `chat.send` → `transition('completed')`
- 双击并发守卫：`createInFlight` 防止 create 调两次

### 5.3 集成测试如何 mock

```typescript
// 典型 mock 模式（flow-integration.test.ts）
vi.mock('@/api', () => ({
  session: {
    create: vi.fn().mockResolvedValue({ id: 'sess-1', cwd: '/foo', label: '...' }),
    list: vi.fn().mockResolvedValue([]),
    getCommands: vi.fn().mockResolvedValue({ sessionId: 'sess-1', commands: [] }),
    // ... 其他用到的
  },
  chat: { send: vi.fn().mockResolvedValue(undefined), streamSubscribe: vi.fn() },
  // composer 也要 mock（CommandPopover onMounted 调 getMentionCandidates）
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
}))
```

> **坑**：`vi.mock('@/api')` 必须 mock 所有被 mount 组件树用到的方法。漏 mock 会导致 `CommandPopover.onMounted` 调 `composer.getMentionCandidates()` → undefined → 未捕获 rejection。

## 6. 非 MOCK 模式测试

```bash
cd src-electron && npm run dev
```

**手工冒烟清单**（每项必做，MOCK 测不出真实 create）：

| 步骤 | 操作 | 期望 |
|------|------|------|
| 1 | 启动 app，按 ⌘N | 进入 Landing 态，显示 directory chip「选择目录」+ composer 输入区 |
| 2 | 点 directory chip | 弹出 DirSelectPopover，列出工作区 |
| 3 | 选一个真实 git 工作区 | popover 关闭，chip 显示目录名，branch chip 出现（git 目录） |
| 4 | 点 branch chip | 弹出 BranchSelectPopover，列出本地分支 |
| 5 | 输入消息，按 ⏎ | session 创建（runtime 日志可见），进入对话流，消息发出 |
| 6 | 检查 `~/.xyz-agent-dev/sessions/` | 新 session 文件出现（pi 延迟写入：首个 assistant 到达后才 flush，见 AGENTS.md 规则#6） |

**关键验证点**（MOCK 测不出）：
- `sessionApi.create(cwd)` 真实调 runtime → pi 创建 session 子进程
- pi session 文件延迟写入（首 assistant 前文件可能不存在）
- 非 git 目录时 branch chip 隐藏（`gitInfo == null`）

## 7. Playwright E2E 测试

### 7.1 测试场景

| 场景 | testid 锚点 | 期望 |
|------|------------|------|
| E2E-NT-1：首屏 Landing 渲染 | `new-task-landing` / `composer-box` / `chip-directory` | 三个元素 DOM 存在 |
| E2E-NT-2：点 directory chip 弹出选目录浮层 | `dir-select-popover` / `workspace-item` | popover 可见，含工作区项 |
| E2E-NT-3：选目录后 chip 回灌 | `chip-directory` 含目录名文本 | 文本从「选择目录」变为目录名 |
| E2E-NT-4：首发提交进入对话流 | `new-task-landing` 消失，MessageStream 出现 | Landing 不再可见，对话流可见 |

### 7.2 完整 E2E 示例代码

> 注意：以下代码是**范例模板**，尚未落地为 `e2e/new-task.spec.ts`（当前只有 file-tree.spec.ts）。落地时按此模板实现。

```typescript
import { test, expect } from './fixtures/launch-app'

test.describe('新建任务 E2E', () => {
  test('E2E-NT-1: 首屏 Landing 态渲染（composer 输入区 + chip 行）', async ({ page }) => {
    // app 启动后默认 Landing 态（无活跃 session）
    // 断言三视角的「观察者」视角：DOM 结构存在
    await expect(page.getByTestId('new-task-landing')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('composer-box')).toBeVisible()
    await expect(page.getByTestId('chip-directory')).toBeVisible()
    // directory chip 默认空态文案（首次启动延迟 create，无 cwd）
    await expect(page.getByTestId('chip-directory')).toContainText('选择目录')
  })

  test('E2E-NT-2: 点 directory chip → 弹出选目录浮层', async ({ page }) => {
    await expect(page.getByTestId('chip-directory')).toBeVisible({ timeout: 10_000 })
    // 点 directory chip 打开 DirSelectPopover
    await page.getByTestId('chip-directory').click()
    // popover 可见（reka-ui Popover portal 到 body，全局查）
    await expect(page.getByTestId('dir-select-popover')).toBeVisible({ timeout: 5_000 })
    // 至少有一个工作区项（mock data.ts fixtureSessions 提供）
    await expect(page.getByTestId('workspace-item').first()).toBeVisible()
  })

  test('E2E-NT-3: 选目录 → chip 回灌目录名', async ({ page }) => {
    await page.getByTestId('chip-directory').click()
    await expect(page.getByTestId('dir-select-popover')).toBeVisible({ timeout: 5_000 })
    // 点第一个工作区
    const firstWorkspace = page.getByTestId('workspace-item').first()
    const workspaceText = await firstWorkspace.textContent()
    await firstWorkspace.click()
    // popover 关闭
    await expect(page.getByTestId('dir-select-popover')).toHaveCount(0)
    // chip 显示目录名（不再显示「选择目录」）
    await expect(page.getByTestId('chip-directory')).not.toContainText('选择目录')
    // chip 文本包含工作区名（取末段目录名）
    const chipText = await page.getByTestId('chip-directory').textContent()
    expect(chipText).toBeTruthy()
  })

  test('E2E-NT-4: 首发提交 → 离开 Landing 进入对话流', async ({ page }) => {
    // 前置：先选目录（让 create 用真实 cwd）
    await page.getByTestId('chip-directory').click()
    await page.getByTestId('workspace-item').first().click()
    // 输入消息（contenteditable，用 pressSequentially 触发 input）
    await page.getByRole('textbox').click()
    await page.getByRole('textbox').pressSequentially('帮我写个 hello world')
    // 点发送按钮（title="发送 · ⏎"）
    await page.getByTitle('发送 · ⏎').click()
    // Landing 消失（state → completed）
    await expect(page.getByTestId('new-task-landing')).toHaveCount(0, { timeout: 10_000 })
    // 对话流出现：user 气泡可见（mock 流式约 3-4 秒，等终态文本）
    // user 消息文本「帮我写个 hello world」应出现在对话流
    await expect(page.getByText('帮我写个 hello world')).toBeVisible({ timeout: 10_000 })
  })
})
```

### 7.3 每步期望输入输出（E2E-NT-4 首发）

| 步骤 | 输入（用户操作） | 输出（DOM 变化 / mock 调用） |
|------|----------------|---------------------------|
| 1. 选目录 | 点 `workspace-item` | `selectWorkspace(cwd)` → `pendingCwd = cwd`；chip 文本变目录名 |
| 2. 输入消息 | `pressSequentially('...')` | `ComposerInput` input 事件 → `draft = '...'`；发送按钮 enable |
| 3. 点发送 | 点 `title="发送 · ⏎"` | `onSend()` → `submitFirstMessage(draft)` |
| 4. create session | （内部） | mock `session.create(cwd)` → sleep(40ms) → resolve SessionSummary |
| 5. 载入 panel | （内部） | `session.activeId = id`；`panel.loadSession`；`navigation.push` |
| 6. 发消息 | （内部） | `chat.send(text)` → mock `runSendStream` fire-and-forget |
| 7. 状态流转 | （内部） | `transition('completed')` → Landing `v-if` false → 消失 |
| 8. 对话流渲染 | （DOM） | MessageStream 出现，user 气泡可见，mock 流式开始（thinking→tool→text） |

## 8. 约束与盲区

| 约束 | 说明 |
|------|------|
| ⚠️ OS 原生 dialog 无法自动化 | 「打开其他目录」（`action-open-dir`）触发 Electron `dialog.showOpenDialog`，Playwright 无法交互系统对话框。E2E 测「选已有工作区」路径，`action-open-dir` 路径标 `[需手工]` |
| ⚠️ mock 不模拟 create 失败 | mock `session.create` 恒成功。失败路径（E2/E3 create reject）只能集成测试验证（flow-integration.test.ts 有覆盖） |
| ⚠️ branch chip 仅 git 目录 | 非 git 目录 `gitInfo == null` → branch chip 隐藏。mock fixture session 的 cwd 需是 git 仓库才能测 branch chip |
| ❌ dev 冒烟盲区 | Landing 态渲染依赖 `useNewTaskFlow` + `useChat` + 多个 store，模块加载错误（node:path 类）mock 测不出。必须 `npm run dev` 手工冒烟 |

## 9. 相关文档

- 组件 spec：[docs/page-design/v3/flow-2-code-review/](../page-design/v3/)（如有）
- 状态机源码：[`composables/features/useNewTaskFlow.ts`](../../src-electron/renderer/src/composables/features/useNewTaskFlow.ts)
- 集成测试：[`__tests__/new-task/`](../../src-electron/renderer/src/__tests__/new-task/)
- composer 子组件测试：[02-composer.md](./02-composer.md)
