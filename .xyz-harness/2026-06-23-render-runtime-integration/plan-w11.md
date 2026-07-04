# W11+ 前端↔runtime 集成第三轮 实现计划

> **给 agentic worker：** 必备子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 来逐任务执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。
>
> **前置：** [spec-w11.md](./spec-w11.md)（verdict: pass，3 轮追踪 CONVERGED）+ [waves.md](./waves.md)（W01-W10 已完成）。
> **验证基线（每 wave）：** `cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run`，git 干净后提交。
> **派工方式：** 串行 W11→W18（同 waves.md 铁律，不可并行 implementer）。

**目标：** 完成 spec-w11 的 12 个 FR——收尾闭环（mock 流式 + 消息流 UI 补全）+ 后端就绪能力对接（Extension 安装/compact/widget）+ git-zone 加回（含后端 git.* 命令）+ Side Drawer 容器。

**架构：** 三层不变（transport handler → services → infra）。前端 api/index.ts 三元门面（mock/real 同构）。本轮新增 git.* 命令协议（后端 spawn git，复用既有 git-info/reconciler 基础设施）。

**技术栈：** Vue 3 + TypeScript + Pinia + Tailwind（renderer）/ Node.js WebSocket（runtime）/ shared TS 类型（协议层）。

---

## Wave 依赖图

```
W11 (契约地基：ToolCallStatus+pending / FileChangeStatus+unmerged / ExtensionInfo+tools / protocol git.*)
 ├─ W12 (mock 全套流式剧本) ← 依赖 W11 pending 枚举
 │   └─ W13 (消息流收尾：tool_call_pending case + auto_retry UI + queue pending 气泡) ← 依赖 W12 验证
 ├─ W14 (Extension 安装/卸载多步流) ← 依赖 W11 ExtensionInfo tools
 ├─ W15 (compact：slash command + session domain + 订阅) ← 独立
 ├─ W16 (git-zone 后端：git.* 协议 + handler + IGitExecutor + U 映射) ← 依赖 W11 FileChangeStatus unmerged
 │   └─ W17 (git-zone 前端 + SideDrawer 容器 + widget 对接) ← 依赖 W16 + SideDrawer 为 widget 铺位
 └─ W18 (session.list server-push + FileView file_changes 聚合) ← 相对独立
```

**关键依赖：**
- **W11 阻塞 W12/W14/W16**：类型枚举扩展是地基
- **W12 阻塞 W13**：UI 补全需 mock 流式验证
- **W16 阻塞 W17**：前端 git-zone 依赖后端 git.* 命令
- **W15/W18 独立**：可插任意点（建议 W14 后）

---

## 各 Wave 文件结构分解

### W11 · 契约地基（shared 类型扩展）
| 文件 | 动作 | 职责 |
|---|---|---|
| `shared/src/message.ts:3` | 修改 | ToolCallStatus 加 `'pending'` |
| `shared/src/message.ts:89` | 修改 | FileChangeStatus 加 `'unmerged'` |
| `shared/src/protocol.ts:343-352` | 修改 | ExtensionInfo 加 `tools?: string[]` |
| `shared/src/protocol.ts:9-30` | 修改 | ClientMessageType 加 `git.status/stage/unstage/commit` |
| `shared/src/protocol.ts:170-201` | 修改 | ServerMessageType 加 `git.status:result` |
| `shared/src/protocol.ts:47-102` | 修改 | ClientMessageMap 加 git.* payload + git.status:result 结构 |
| `shared/src/protocol.ts:217-251` | 修改 | ServerMessageMapBase 加 `message.tool_call_pending` + `git.status:result` 精确条目 |

### W12 · mock 全套流式剧本
| 文件 | 动作 | 职责 |
|---|---|---|
| `renderer/src/api/mock/index.ts:184-213` | 修改 | send 补 thinking/tool_call/file_changes 流（固定剧本） |
| `renderer/src/api/mock/index.ts:226-237` | 修改 | steer/followUp 补 queue_update 推送 |

### W13 · 消息流收尾（tool_call_pending + retry/queue UI）
| 文件 | 动作 | 职责 |
|---|---|---|
| `renderer/src/stores/chat-chunk-processor.ts:355` | 修改 | default 前加 `case 'message.tool_call_pending'` |
| `renderer/src/components/panel/message-stream/` | 新建 | RetryIndicator.vue + QueuePending.vue |
| `renderer/src/components/panel/Panel.vue:37-43` | 修改 | composer-band 加 retry/queue 独立行 |

### W14 · Extension 安装/卸载多步流
| 文件 | 动作 | 职责 |
|---|---|---|
| `renderer/src/api/domains/extension.ts` | 修改 | 加 install/uninstall/installDir/installGit/finishInstall/cancelInstall + onDiscovered |
| `renderer/src/api/mock/index.ts:414-423` | 修改 | mock extension 补同构方法 |
| `renderer/src/components/settings/ExtensionPage.vue` | 修改 | 安装按钮 handler + 候选选择 UI + 卸载调 uninstall |

### W15 · compact（slash command 触发）
| 文件 | 动作 | 职责 |
|---|---|---|
| `renderer/src/api/domains/session.ts` | 修改 | 加 `compact(sessionId)` |
| `renderer/src/api/mock/index.ts:118-175` | 修改 | mock session 加 compact |
| `renderer/src/components/panel/Composer.vue` | 修改 | slash `/compact` 检测 → 调 compact |
| `renderer/src/composables/features/useChat.ts` | 修改 | compact 状态（compacting/compacted）订阅 |

### W16 · git-zone 后端（git.* 命令协议）
| 文件 | 动作 | 职责 |
|---|---|---|
| `runtime/src/services/ports/git-executor.ts` | 新建 | IGitExecutor port（stage/unstage/commit spawn） |
| `runtime/src/infra/git/git-executor-impl.ts` | 新建 | IGitExecutor 实现（execFileSync 范式） |
| `runtime/src/infra/pi/file-change-reconciler.ts:50-65` | 修改 | xyToStatus 加 U unmerged 映射 + staged/unstaged 拆分 |
| `runtime/src/services/git-status-service.ts` | 新建 | buildGitStatus（复用 reconcileFileChanges 解析 + readGitInfo 分支 + numstat 行数） |
| `runtime/src/transport/git-message-handler.ts` | 新建 | git.* handler（status/stage/unstage/commit） |
| `runtime/src/transport/server.ts:64,124-132` | 修改 | setServices 注入 + routes 注册 git.* |

### W17 · git-zone 前端 + SideDrawer + widget
| 文件 | 动作 | 职责 |
|---|---|---|
| `renderer/src/api/domains/git.ts` | 新建 | git domain（status/stage/unstage/commit + onStatusResult） |
| `renderer/src/api/mock/index.ts` | 修改 | mock git domain |
| `renderer/src/api/index.ts` | 修改 | 导出 git |
| `renderer/src/components/panel/GitZone.vue` | 新建 | 四态展示 + 暂存/提交/取消暂存/Diff 按钮 |
| `renderer/src/components/panel/Panel.vue:37-43` | 修改 | composer-band 加 GitZone |
| `renderer/src/components/workspace/SideDrawer.vue` | 新建 | 抽屉容器（开/关/钉住 + tab） |
| `renderer/src/components/workspace/SideDrawerTab.vue` | 新建 | Terminal/Browser tab（widget 渲染） |
| `renderer/src/api/domains/extension.ts` | 修改 | 加 onWidget/onStatus（session 通道） |

### W18 · session.list server-push + FileView 聚合
| 文件 | 动作 | 职责 |
|---|---|---|
| `renderer/src/composables/features/useSidebar.ts:217-228` | 修改 | 加 session.list onGlobalType 订阅（不重载历史） |
| `renderer/src/api/mock/index.ts` | 修改 | mock session.list server-push 模拟 |
| `renderer/src/components/sidebar/FileView.vue` | 修改 | 数据源从 fixture 改 chat store 聚合（跨回合并集）+ U 标注 + 行数 + 过滤 |
| `renderer/src/components/sidebar/FileTreeRow.vue` | 修改 | 加 U（冲突）badge + 行数显示 |

---

## 各 Wave 详细规格

> 因篇幅，W11-W14 详细任务步骤见本文件下方；W15-W18 见 [plan-w11-part2.md](./plan-w11-part2.md)。

---

## W11 · 契约地基（shared 类型扩展）

**目的：** 扩展 shared 类型枚举，为 W12-W17 提供类型守卫基础。唯一动 shared 的 wave（类似 W01 的角色）。

**文件（1 个，多处修改）：** `src-electron/shared/src/message.ts` + `src-electron/shared/src/protocol.ts`

### 任务 11-1：ToolCallStatus 加 pending

**文件：** 修改 `src-electron/shared/src/message.ts:3`

- [ ] **步骤 1：修改 ToolCallStatus 枚举**

```ts
// message.ts:3 原：
export type ToolCallStatus = 'running' | 'completed' | 'error'
// 改为：
export type ToolCallStatus = 'running' | 'pending' | 'completed' | 'error'
```

- [ ] **步骤 2：验证 shared tsc**

运行：`cd src-electron && npx tsc --noEmit -p shared/tsconfig.json`（或 workspace 根 `npx tsc --noEmit`）
预期：0 错误（pending 是新增值，向后兼容）

- [ ] **步骤 3：提交**

```bash
git add src-electron/shared/src/message.ts
git commit -m "feat(shared): add 'pending' to ToolCallStatus enum (W11-1)"
```

### 任务 11-2：FileChangeStatus 加 unmerged

**文件：** 修改 `src-electron/shared/src/message.ts:89`

- [ ] **步骤 1：修改 FileChangeStatus 枚举**

```ts
// message.ts:89 原：
export type FileChangeStatus = 'added' | 'modified' | 'deleted'
// 改为：
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'unmerged'
```

- [ ] **步骤 2：验证 + 提交**

```bash
cd src-electron && npx tsc --noEmit -p shared/tsconfig.json
git add src-electron/shared/src/message.ts
git commit -m "feat(shared): add 'unmerged' to FileChangeStatus enum (W11-2)"
```

### 任务 11-3：ExtensionInfo 加 tools

**文件：** 修改 `src-electron/shared/src/protocol.ts:343-352`

- [ ] **步骤 1：ExtensionInfo 加 tools 字段**

```ts
// protocol.ts ExtensionInfo 接口末尾加（source 字段后）：
export interface ExtensionInfo {
  name: string
  dirName: string
  version: string
  description: string
  path: string
  enabled: boolean
  source: 'built-in' | 'user-installed'
  /** 扩展提供的工具名列表（runtime scanExtensions 采集，前端 ExtensionPage 展示用） */
  tools?: string[]
}
```

- [ ] **步骤 2：验证 + 提交**

```bash
cd src-electron && npx tsc --noEmit -p shared/tsconfig.json
git add src-electron/shared/src/protocol.ts
git commit -m "feat(shared): add tools field to ExtensionInfo (W11-3)"
```

### 任务 11-4：protocol 加 git.* ClientMessageType + payload

**文件：** 修改 `src-electron/shared/src/protocol.ts`

- [ ] **步骤 1：ClientMessageType 加 git.***

在 `protocol.ts:30`（`'file.read'` 后）加：
```ts
  | 'git.status' | 'git.stage' | 'git.unstage' | 'git.commit'
```

- [ ] **步骤 2：ClientMessageMap 加 git.* payload**

在 `protocol.ts:101`（`'file.read'` 条目后）加：
```ts
  'git.status': { sessionId: string }
  'git.stage': { sessionId: string; filePaths?: string[] }
  'git.unstage': { sessionId: string; filePaths?: string[] }
  'git.commit': { sessionId: string; message?: string }
```

- [ ] **步骤 3：ServerMessageType 加 git.status:result**

在 `protocol.ts:201`（`'file.read:result'` 后）加：
```ts
  | 'git.status:result'
```

- [ ] **步骤 4：定义 GitFileStatus + git.status:result payload 接口**

在 `protocol.ts` 的 ExtensionInfo 接口后（约 L353）加：
```ts
/** git status 单文件状态（XY 码映射后） */
export interface GitFileStatus {
  path: string
  /** 原始 git porcelain XY 码（2 字符，如 ' M', 'M ', '??', 'UU'） */
  xyCode: string
  status: FileChangeStatus
}

/** git.status:result payload */
export interface GitStatusResult {
  sessionId: string
  isRepo: boolean
  branch?: string
  stagedCount: number
  unstagedCount: number
  stats: { add: number; del: number }
  hasConflict: boolean
  files: GitFileStatus[]
}
```

- [ ] **步骤 5：ServerMessageMapBase 加精确条目**

在 `protocol.ts:251`（`'message.file_changes'` 条目后）加：
```ts
  // tool_call_pending（W13 消费，payload 含 toolCallId）
  'message.tool_call_pending': { sessionId: string; toolCallId: string; toolName?: string }
  // git.status:result（W16 后端生产，W17 前端消费）
  'git.status:result': GitStatusResult
```

- [ ] **步骤 6：ClientMessage 联合加 git.* 成员**

在 `protocol.ts:158`（file.read 成员后）加：
```ts
  | { type: 'git.status'; id?: string; payload: ClientMessageMap['git.status'] }
  | { type: 'git.stage'; id?: string; payload: ClientMessageMap['git.stage'] }
  | { type: 'git.unstage'; id?: string; payload: ClientMessageMap['git.unstage'] }
  | { type: 'git.commit'; id?: string; payload: ClientMessageMap['git.commit'] }
```

- [ ] **步骤 7：验证 + 提交**

```bash
cd src-electron && npx tsc --noEmit -p shared/tsconfig.json
git add src-electron/shared/src/protocol.ts
git commit -m "feat(shared): add git.* protocol (status/stage/unstage/commit) + tool_call_pending payload (W11-4)"
```

### W11 Review 要点
- [ ] ToolCallStatus 含 pending；FileChangeStatus 含 unmerged
- [ ] ExtensionInfo 含 tools?（dirName 已在，不重复加）
- [ ] git.* 4 个 ClientMessageType + ClientMessageMap payload + ClientMessage 联合成员
- [ ] git.status:result ServerMessageType + GitStatusResult/GitFileStatus 接口 + ServerMessageMapBase 精确条目
- [ ] message.tool_call_pending ServerMessageMapBase 精确条目（toolCallId/toolName）
- [ ] shared + runtime + renderer 三侧 tsc 全 0 错（runtime/renderer 消费侧可能需适配新枚举）

---

## W12 · mock 全套流式剧本

**目的：** mock send 补 thinking/tool_call/file_changes 流，让 W05-W10 已实装的渲染组件在 mock 模式能看到实时效果。

**文件（1）：** `src-electron/renderer/src/api/mock/index.ts`

### 任务 12-1：send 补 thinking 流

**文件：** 修改 `src-electron/renderer/src/api/mock/index.ts:184-213`（send 函数）

- [ ] **步骤 1：在 message_start 后、text_delta 前插入 thinking 流**

当前 send（L184-213）结构：`message_start → text_delta 循环 → complete`。
在 `message_start` emit 后（L194 后）、text_delta 循环前插入：

```ts
    // ── thinking 流（W12：让 ReasoningBlock 在 mock 可见）──
    const thinkingText = '让我分析一下这个请求…\n首先需要理解上下文，然后规划步骤。'
    emit(sessionId, {
      type: 'message.thinking_start',
      id: messageId,
      payload: { sessionId, messageId },
    })
    for (const chunk of splitChunks(thinkingText)) {
      if (cancelled.has(sessionId)) return
      await sleep(TIMING.chunk)
      emit(sessionId, {
        type: 'message.thinking_delta',
        id: messageId,
        payload: { sessionId, messageId, delta: chunk },
      })
    }
    emit(sessionId, {
      type: 'message.thinking_end',
      id: messageId,
      payload: { sessionId, messageId },
    })
```

- [ ] **步骤 2：验证 mock 模式 thinking 块可见**

运行：`cd src-electron/renderer && npx vitest run`（现有测试不应破）
手动（可选）：`VITE_MOCK=true npm run dev`，发消息确认 thinking 折叠块出现

- [ ] **步骤 3：提交**

```bash
git add src-electron/renderer/src/api/mock/index.ts
git commit -m "feat(mock): add thinking stream to mock send (W12-1)"
```

### 任务 12-2：send 补 tool_call + file_changes 流

**文件：** 修改 `src-electron/renderer/src/api/mock/index.ts`（send 函数，thinking 流后）

- [ ] **步骤 1：thinking_end 后、text_delta 前插入 tool_call 流**

```ts
    // ── tool_call 流（W12：让 ToolCallCard 在 mock 可见）──
    const toolCallId = nextId('tc')
    emit(sessionId, {
      type: 'message.tool_call_start',
      id: toolCallId,
      payload: { sessionId, messageId, toolCallId, toolName: 'write_file', input: { path: 'src/app.ts' } },
    })
    await sleep(TIMING.chunk * 2)
    // tool_call_pending（W13 消费用，先推让 case 有数据）
    emit(sessionId, {
      type: 'message.tool_call_pending',
      id: toolCallId,
      payload: { sessionId, toolCallId, toolName: 'write_file' },
    })
    await sleep(TIMING.chunk)
    emit(sessionId, {
      type: 'message.tool_call_end',
      id: toolCallId,
      payload: { sessionId, toolCallId, output: '文件已写入', status: 'completed' },
    })
```

- [ ] **步骤 2：tool_call_end 后、text_delta 前插入 file_changes（accumulating→ready）**

```ts
    // ── file_changes 流（W12：让 ChangeSetCard 在 mock 可见）──
    const mockFileChanges = [
      { filePath: 'src/app.ts', status: 'modified' as const, addLines: 12, delLines: 3 },
      { filePath: 'src/utils.ts', status: 'added' as const, addLines: 45, delLines: 0 },
    ]
    // accumulating（增量，isFullSet=false）
    emit(sessionId, {
      type: 'message.file_changes',
      id: nextId('fc'),
      payload: { sessionId, messageId, fileChanges: [mockFileChanges[0]], changeSetStatus: 'accumulating', isFullSet: false },
    })
    await sleep(TIMING.chunk)
    // ready（全集，isFullSet=true）
    emit(sessionId, {
      type: 'message.file_changes',
      id: nextId('fc'),
      payload: { sessionId, messageId, fileChanges: mockFileChanges, changeSetStatus: 'ready', isFullSet: true },
    })
```

- [ ] **步骤 3：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run
git add src-electron/renderer/src/api/mock/index.ts
git commit -m "feat(mock): add tool_call + file_changes stream to mock send (W12-2)"
```

### 任务 12-3：steer/followUp 补 queue_update 推送

**文件：** 修改 `src-electron/renderer/src/api/mock/index.ts:226-237`

- [ ] **步骤 1：steer 补 queue_update 推送**

```ts
  // 原 steer（L226-230）改为：
  async steer(sessionId: string, text: string): Promise<void> {
    await sleep(TIMING.ack)
    // 推 queue_update 模拟 steer 排队（W12：让 pending 气泡在 mock 可见）
    pushSession(sessionId, {
      type: 'message.queue_update',
      id: nextId('q'),
      payload: { sessionId, steering: [text] },
    })
  },
```

- [ ] **步骤 2：followUp 补 queue_update 推送**

```ts
  // 原 followUp（L233-237）改为：
  async followUp(sessionId: string, text: string): Promise<void> {
    await sleep(TIMING.ack)
    pushSession(sessionId, {
      type: 'message.queue_update',
      id: nextId('q'),
      payload: { sessionId, followUp: [text] },
    })
  },
```

- [ ] **步骤 3：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run
git add src-electron/renderer/src/api/mock/index.ts
git commit -m "feat(mock): add queue_update push to steer/followUp (W12-3)"
```

### W12 Review 要点
- [ ] mock send 发 thinking_start/delta/end（ReasoningBlock 可见）
- [ ] mock send 发 tool_call_start/pending/end（ToolCallCard 可见）
- [ ] mock send 发 file_changes accumulating→ready（ChangeSetCard 可见）
- [ ] mock steer/followUp 发 queue_update（queue pending 气泡可见）
- [ ] abort 时 cancelled Set 检查覆盖新增的流式循环（不产孤儿事件）
- [ ] renderer vitest 全绿（现有 60 测试不破）

---

## W13 · 消息流收尾（tool_call_pending + retry/queue UI）

**目的：** 补 tool_call_pending store case（硬漏接）+ auto_retry/queue 的 UI 消费（store 有数据无组件读）。

**文件（3）：** chat-chunk-processor.ts + 新建 RetryIndicator.vue/QueuePending.vue + Panel.vue

### 任务 13-1：tool_call_pending store case

**文件：** 修改 `src-electron/renderer/src/stores/chat-chunk-processor.ts:355`（default 前）

- [ ] **步骤 1：default 前加 tool_call_pending case**

在 `case 'message.file_changes'`（L345）块后、`default:`（L355）前加：

```ts
    case 'message.tool_call_pending': {
      // W13：tool 排队等待执行，标记 pending 态（W11 已扩 ToolCallStatus 含 'pending'）
      const { toolCallId, toolName } = msg.payload as { sessionId: string; toolCallId: string; toolName?: string }
      const msgList = messages.value.get(sessionId)
      if (!msgList) return
      const last = msgList[msgList.length - 1]
      if (!last || last.role !== 'assistant') return
      // 找到对应 toolCall，标 pending；不存在则追加（pending 可能在 start 前到达）
      const existing = last.toolCalls.find((tc) => tc.id === toolCallId)
      if (existing) {
        existing.status = 'pending'
      } else {
        last.toolCalls.push({
          id: toolCallId,
          toolName: toolName ?? 'unknown',
          input: null,
          status: 'pending',
          startTime: Date.now(),
        })
      }
      messages.value = new Map(messages.value)
      return
    }
```

- [ ] **步骤 2：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run
git add src-electron/renderer/src/stores/chat-chunk-processor.ts
git commit -m "fix(chat): handle message.tool_call_pending (was silently dropped) (W13-1)"
```

### 任务 13-2：QueuePending 气泡组件

**文件：** 新建 `src-electron/renderer/src/components/panel/message-stream/QueuePending.vue`

- [ ] **步骤 1：创建组件**

```vue
<template>
  <!--
    queue pending 气泡（panel/spec.md:52）。
    steer/followUp 提交未进入对话流时，composer 上方显 pending 气泡。
    进入 message-stream（message_start 到达）后由父组件清 queue → 气泡消失。
  -->
  <div v-if="queue && (queue.steering?.length || queue.followUp?.length)" class="queue-pending flex items-center justify-end gap-1.5 px-3 py-1 text-[11px] text-muted">
    <Loader2 class="size-3 animate-spin" />
    <template v-if="queue.steering?.length">
      <span class="rounded-sm border border-dashed border-border px-1.5 py-0.5">steer: {{ queue.steering[0].slice(0, 30) }}{{ queue.steering[0].length > 30 ? '…' : '' }}</span>
    </template>
    <template v-if="queue.followUp?.length">
      <span class="rounded-sm border border-dashed border-border px-1.5 py-0.5">follow-up: {{ queue.followUp[0].slice(0, 30) }}{{ queue.followUp[0].length > 30 ? '…' : '' }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { Loader2 } from '@lucide/vue'
import type { QueueState } from '@/stores/chat-store-types'

defineProps<{ queue?: QueueState | null }>()
</script>
```

- [ ] **步骤 2：提交**

```bash
git add src-electron/renderer/src/components/panel/message-stream/QueuePending.vue
git commit -m "feat(panel): add QueuePending bubble component (W13-2)"
```

### 任务 13-3：RetryIndicator 组件

**文件：** 新建 `src-electron/renderer/src/components/panel/message-stream/RetryIndicator.vue`

- [ ] **步骤 1：创建组件**

```vue
<template>
  <!--
    auto_retry 指示位（chat store retryStates 有数据但无 UI 消费，W13 补）。
    显示重试中 + attempt/maxAttempts + errorMessage。
  -->
  <div v-if="retry" class="retry-indicator flex items-center gap-1.5 px-3 py-1 text-[11px] text-warning">
    <RefreshCw class="size-3 animate-spin" />
    <span>自动重试中{{ retry.attempt ? `（第 ${retry.attempt} 次${retry.maxAttempts ? `/${retry.maxAttempts}` : ''}）` : '' }}</span>
    <span v-if="retry.errorMessage" class="truncate text-subtle">：{{ retry.errorMessage.slice(0, 40) }}</span>
  </div>
</template>

<script setup lang="ts">
import { RefreshCw } from '@lucide/vue'
import type { RetryState } from '@/stores/chat-store-types'

defineProps<{ retry?: RetryState | null }>()
</script>
```

- [ ] **步骤 2：提交**

```bash
git add src-electron/renderer/src/components/panel/message-stream/RetryIndicator.vue
git commit -m "feat(panel): add RetryIndicator component (W13-3)"
```

### 任务 13-4：Panel.vue 接入 retry/queue 独立行

**文件：** 修改 `src-electron/renderer/src/components/panel/Panel.vue:37-43`（composer-band）

- [ ] **步骤 1：composer-band 顶部加 retry/queue 行**

```vue
<!-- ③④ companion zones：retry/queue 独立行 + progress / composer 垂直 6px 紧凑成「带」。 -->
<div class="composer-band flex flex-shrink-0 flex-col gap-1.5">
  <!-- retry/queue 指示行（W13，composer 上方独立行，对齐 panel/spec.md:52） -->
  <RetryIndicator v-if="sessionId" :retry="chat.getRetryState(sessionId)" />
  <QueuePending v-if="sessionId" :queue="chat.getQueueState(sessionId)" />
  <!-- ③ progress-zone（composer 上方） -->
  <ProgressZone phase="running" />
  <!-- ④ composer（FG5，S1/S2/S5/S6 主路径） -->
  <Composer v-if="sessionId" :session-id="sessionId" />
</div>
```

- [ ] **步骤 2：import + chat store 注入**

在 `<script setup>` 加：
```ts
import RetryIndicator from './message-stream/RetryIndicator.vue'
import QueuePending from './message-stream/QueuePending.vue'
import { useChatStore } from '@/stores/chat'
const chat = useChatStore()
```

注意：Panel.vue 当前可能未引入 chat store——需确认 `useChatStore` 导出名（chat.ts defineStore 的导出）。若 store 用 `export function useChatStore()` 则直接用。

- [ ] **步骤 3：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run
git add src-electron/renderer/src/components/panel/Panel.vue
git commit -m "feat(panel): wire RetryIndicator + QueuePending into composer-band (W13-4)"
```

### W13 Review 要点
- [ ] message.tool_call_pending 有 store case（grep 命中），标 status='pending'
- [ ] RetryIndicator 消费 getRetryState，显示 attempt/maxAttempts
- [ ] QueuePending 消费 getQueueState，显示 steer/followUp 气泡（虚线脉冲）
- [ ] Panel.vue composer-band 顶部有 retry/queue 独立行
- [ ] mock 模式 steer 后能看到 pending 气泡（W12 queue_update 驱动）

---

## W14 · Extension 安装/卸载多步流

**目的：** extension domain 补 6 个动作方法 + ExtensionPage 接按钮（安装 npm/dir/git + 候选选择 + 卸载）。

**文件（3）：** extension.ts + mock/index.ts + ExtensionPage.vue

### 任务 14-1：extension domain 补 install 系列方法

**文件：** 修改 `src-electron/renderer/src/api/domains/extension.ts`

- [ ] **步骤 1：加 install/uninstall/installDir/installGit/finishInstall/cancelInstall + onDiscovered**

在 extension.ts 末尾（toggle 后）加：

```ts
import type { ExtensionDiscoveredPayload } from '@xyz-agent/shared'

// ── 多步安装流（W14）──

/** npm 安装（source 如 'pi-foo' 或 '@scope/pkg'） */
export function install(source: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'extension.install', id, payload: { source } })
  return result
}

/** 本地目录安装（返回 discovered 候选，前端选后再 finishInstall） */
export function installDir(path: string): Promise<ExtensionDiscoveredPayload> {
  const id = pending.create()
  const result = pending.register<ExtensionDiscoveredPayload>(id)
  transport.send({ type: 'extension.installDir', id, payload: { path } })
  return result
}

/** Git URL 安装（返回 discovered 候选） */
export function installGit(url: string): Promise<ExtensionDiscoveredPayload> {
  const id = pending.create()
  const result = pending.register<ExtensionDiscoveredPayload>(id)
  transport.send({ type: 'extension.installGit', id, payload: { url } })
  return result
}

/** 候选选择后完成安装 */
export function finishInstall(tempDir: string, selected: string[]): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'extension.finishInstall', id, payload: { tempDir, selected } })
  return result
}

/** 取消安装（清理 tempDir） */
export function cancelInstall(tempDir: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'extension.cancelInstall', id, payload: { tempDir } })
  return result
}

/** 卸载 */
export function uninstall(name: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'extension.uninstall', id, payload: { name } })
  return result
}
```

注意：`ExtensionDiscoveredPayload` 已在 protocol.ts:356-359 定义（`{ tempDir, candidates: ExtensionInfo[] }`），确认 shared re-export。

- [ ] **步骤 2：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit
git add src-electron/renderer/src/api/domains/extension.ts
git commit -m "feat(api): add extension install/uninstall multi-step methods (W14-1)"
```

### 任务 14-2：mock extension 补同构方法

**文件：** 修改 `src-electron/renderer/src/api/mock/index.ts:414-423`（extension 对象）

- [ ] **步骤 1：mock extension 补 install 系列同构方法**

在 mock extension 对象（L414-423）的 toggle 后加：

```ts
  async install(_source: string) {
    await sleep(TIMING.ack)
    // mock：直接广播当前快照（模拟 install 后 config.extensions 刷新）
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
  async installDir(_path: string) {
    await sleep(TIMING.ack)
    // mock：返回空候选（真实发现由 runtime extension.installDir 驱动）
    return { tempDir: 'mock-temp', candidates: [] }
  },
  async installGit(_url: string) {
    await sleep(TIMING.ack)
    return { tempDir: 'mock-temp', candidates: [] }
  },
  async finishInstall(_tempDir: string, _selected: string[]) {
    await sleep(TIMING.ack)
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
  async cancelInstall(_tempDir: string) {
    await sleep(TIMING.ack)
  },
  async uninstall(name: string) {
    await sleep(TIMING.ack)
    const idx = fixtureExtensions.findIndex((e) => e.name === name)
    if (idx >= 0) fixtureExtensions.splice(idx, 1)
    extensionsSub.broadcast(fixtureExtensions.map((e) => ({ ...e })))
  },
```

- [ ] **步骤 2：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run
git add src-electron/renderer/src/api/mock/index.ts
git commit -m "feat(mock): add extension install/uninstall mock methods (W14-2)"
```

### 任务 14-3：ExtensionPage 安装按钮 handler

**文件：** 修改 `src-electron/renderer/src/components/settings/ExtensionPage.vue`

- [ ] **步骤 1：安装按钮接 handler（三 tab 分派）**

在 ExtensionPage.vue `<script setup>` 加 emit 注入 + 安装逻辑：

```ts
import * as extensionApi from '@/api/extension'

const installing = ref(false)
const discovered = ref<ExtensionDiscoveredPayload | null>(null)

async function onInstall() {
  const input = installInput.value.trim()
  if (!input) return
  installing.value = true
  actionError.value = ''
  try {
    if (activeTab.value === 'npm') {
      await extensionApi.install(input)
    } else if (activeTab.value === 'dir') {
      discovered.value = await extensionApi.installDir(input)
    } else if (activeTab.value === 'git') {
      discovered.value = await extensionApi.installGit(input)
    }
    installInput.value = ''
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    installing.value = false
  }
}

async function onFinishInstall(selected: string[]) {
  if (!discovered.value) return
  try {
    await extensionApi.finishInstall(discovered.value.tempDir, selected)
    discovered.value = null
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}

function onCancelInstall() {
  if (discovered.value) {
    extensionApi.cancelInstall(discovered.value.tempDir).catch(() => {})
    discovered.value = null
  }
}
```

模板安装按钮改为：
```vue
<Button :disabled="!installInput.trim() || installing" @click="onInstall">
  {{ installing ? '安装中…' : '安装' }}
</Button>
```

- [ ] **步骤 2：候选选择 UI（discovered 非空时弹候选列表）**

模板加候选选择区（安装按钮下方）：
```vue
<!-- 候选选择（installDir/installGit 后出现）-->
<div v-if="discovered?.candidates.length" class="mt-2 rounded-md border border-border p-2">
  <p class="mb-1.5 text-[12px] text-fg">发现 {{ discovered.candidates.length }} 个候选扩展：</p>
  <label v-for="c in discovered.candidates" :key="c.name" class="flex items-center gap-2 py-0.5 text-[12px]">
    <input type="checkbox" :value="c.name" v-model="selectedCandidates" />
    <span class="font-mono">{{ c.name }}</span>
    <span class="text-subtle">{{ c.description }}</span>
  </label>
  <div class="mt-1.5 flex gap-2">
    <Button size="sm" :disabled="!selectedCandidates.length" @click="onFinishInstall(selectedCandidates)">完成安装</Button>
    <Button size="sm" variant="ghost" @click="onCancelInstall">取消</Button>
  </div>
</div>
```

script 加 `const selectedCandidates = ref<string[]>([])`，discovered 变化时重置。

- [ ] **步骤 3：卸载弹窗接 uninstall**

卸载确认按钮改为：
```vue
<Button variant="danger" size="sm" @click="confirmUninstall">卸载</Button>
```
script 加：
```ts
async function confirmUninstall() {
  if (!confirmTarget) return
  try {
    await extensionApi.uninstall(confirmTarget)
    confirmTarget.value = ''
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
    confirmTarget.value = ''
  }
}
```

- [ ] **步骤 4：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run
git add src-electron/renderer/src/components/settings/ExtensionPage.vue
git commit -m "feat(settings): wire extension install/uninstall multi-step UI (W14-3)"
```

### W14 Review 要点
- [ ] extension domain 有 install/uninstall/installDir/installGit/finishInstall/cancelInstall（与后端 handles 对齐）
- [ ] mock extension 同构补全（api/index.ts 三元两侧签名一致）
- [ ] ExtensionPage 安装按钮按 tab 分派命令；候选选择 UI（discovered 后出现）
- [ ] 卸载确认弹窗真调 uninstall（非空壳）
- [ ] 错误回显（actionError，含 details.hint 若后端返回）
