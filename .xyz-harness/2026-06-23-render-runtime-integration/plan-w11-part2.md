# W15-W18 详细任务规格（plan-w11.md 续）

> 续 [plan-w11.md](./plan-w11.md)。W11-W14 见主文件。

---

## W15 · compact（slash command 触发）

**目的：** session domain 加 compact + Composer 检测 `/compact` slash command 触发 + 订阅 compacting/compacted。

**文件（4）：** session.ts + mock/index.ts + Composer.vue + useChat.ts

### 任务 15-1：session domain 加 compact

**文件：** 修改 `src-electron/renderer/src/api/domains/session.ts`（setThinkingLevel 后，L70）

- [ ] **步骤 1：加 compact 方法**

```ts
/** 压缩当前会话上下文（pi compact 命令，C8 经 slash command 触发） */
export function compact(sessionId: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'session.compact', id, payload: { sessionId } })
  return result
}
```

- [ ] **步骤 2：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit
git add src-electron/renderer/src/api/domains/session.ts
git commit -m "feat(api): add session.compact method (W15-1)"
```

### 任务 15-2：mock session 加 compact

**文件：** 修改 `src-electron/renderer/src/api/mock/index.ts:118-175`（session 对象）

- [ ] **步骤 1：mock session 补 compact**

在 setThinkingLevel（L170）后加：
```ts
  async compact(sessionId: string): Promise<void> {
    await sleep(TIMING.ack)
    // 模拟 compacting → compacted 广播（session 通道）
    pushSession(sessionId, {
      type: 'session.compacting',
      id: nextId('cmp'),
      payload: { sessionId, status: 'compacting' },
    })
    const t = setTimeout(() => {
      timers.delete(t)
      pushSession(sessionId, {
        type: 'session.compacted',
        id: nextId('cmp'),
        payload: { sessionId, status: 'compacted' },
      })
    }, TIMING.chunk * 3)
    timers.add(t)
  },
```

- [ ] **步骤 2：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run
git add src-electron/renderer/src/api/mock/index.ts
git commit -m "feat(mock): add session.compact with compacting/compacted push (W15-2)"
```

### 任务 15-3：useChat 加 compact 状态订阅

**文件：** 修改 `src-electron/renderer/src/composables/features/useChat.ts`

- [ ] **步骤 1：加 compact 状态 ref + 订阅**

在 useChat 内加（参考现有 streamSubscribe 模式）：
```ts
const isCompacting = ref(false)

// 在 ensureStreamSubscription 或单独的 ensureCompactSubscription 中加：
// 订阅 session.compacting / session.compacted（session 通道）
function ensureCompactSubscription(sessionId: string): () => void {
  return events.on(sessionId, (msg) => {
    if (msg.type === 'session.compacting') {
      isCompacting.value = true
    } else if (msg.type === 'session.compacted') {
      isCompacting.value = false
    }
  })
}
```

在 return 加 `isCompacting` + `compact: (sid: string) => sessionApi.compact(sid)`。

- [ ] **步骤 2：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run
git add src-electron/renderer/src/composables/features/useChat.ts
git commit -m "feat(chat): add compact state subscription (W15-3)"
```

### 任务 15-4：Composer /compact 检测

**文件：** 修改 `src-electron/renderer/src/components/panel/Composer.vue`

- [ ] **步骤 1：onSend 前检测 /compact**

在 onSend（L195）开头加 slash command 检测：
```ts
async function onSend(): Promise<void> {
  const text = draft.value.trim()
  // C8：/compact slash command 触发压缩
  if (text === '/compact' || text === '/compact ') {
    draft.value = ''
    if (props.sessionId) {
      try {
        await compact(props.sessionId)
      } catch (e) {
        // 错误作为 assistant 消息插入（CLAUDE.md 规则）
        throw e
      }
    }
    return
  }
  // ... 原有 send 逻辑
}
```

从 useChat 解构补 `compact` + `isCompacting`。

- [ ] **步骤 2：UI 显示 compacting 态**

composer 工具条或输入区加 compacting 指示（最简：disabled + 文案）：
```vue
<!-- 输入区 placeholder 随 compacting 变化 -->
<ComposerInput
  :placeholder="isCompacting ? '正在压缩上下文…' : '输入消息，⌘+Enter 发送'"
  :disabled="isCompacting"
/>
```

- [ ] **步骤 3：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run
git add src-electron/renderer/src/components/panel/Composer.vue
git commit -m "feat(composer): wire /compact slash command trigger (W15-4)"
```

### W15 Review 要点
- [ ] session domain 有 compact 方法；mock 同构
- [ ] useChat 订阅 session.compacting/compacted，isCompacting 状态正确
- [ ] Composer 输入 `/compact` 触发压缩（非 send）；compacting 时输入区 disabled
- [ ] compact 与 compactionSummary system 行区分（前者用户触发，后者 pi 主动摘要）

---

## W16 · git-zone 后端（git.* 命令协议）

**目的：** 新建 git.* 命令全链路——protocol（W11 已加类型）→ port + impl → reconciler 加 U 映射 → service → handler → server 路由。

**文件（6）：** 新建 git-executor port/impl + git-status-service + git-message-handler；修改 reconciler + server。

### 任务 16-1：reconciler xyToStatus 加 U unmerged 映射

**文件：** 修改 `src-electron/runtime/src/infra/pi/file-change-reconciler.ts:50-65`

- [ ] **步骤 1：xyToStatus 加 U 分支**

```ts
// 原 xyToStatus（L50-65）加 U 分支（在 D 判断后、A 前）：
export function xyToStatus(xy: string): FileChangeStatus {
  if (xy === '??') return 'added'
  if (xy[1] === 'D' || xy[0] === 'D') return 'deleted'
  // U 映射（W16）：unmerged 冲突（UU/AA/DD/AU/UA/DU/UD）
  if (xy[0] === 'U' || xy[1] === 'U' || (xy[0] === 'A' && xy[1] === 'A') || (xy[0] === 'D' && xy[1] === 'D')) {
    return 'unmerged'
  }
  if (xy[0] === 'A') return 'added'
  if (xy[0] === 'R' || xy[0] === 'C') return 'modified'
  if (xy[0] === 'M' || xy[1] === 'M') return 'modified'
  return 'modified'
}
```

- [ ] **步骤 2：验证 runtime tsc + 测试**

```bash
cd src-electron && npx tsc --noEmit -p runtime/tsconfig.json
cd src-electron/renderer && npx vitest run
```
预期：0 错（unmerged 是 W11 已加的合法枚举值）

- [ ] **步骤 3：提交**

```bash
git add src-electron/runtime/src/infra/pi/file-change-reconciler.ts
git commit -m "feat(reconciler): add U unmerged mapping to xyToStatus (W16-1)"
```

### 任务 16-2：新建 IGitExecutor port + impl

**文件：** 新建 `src-electron/runtime/src/services/ports/git-executor.ts` + `src-electron/runtime/src/infra/git/git-executor-impl.ts`

- [ ] **步骤 1：port 定义**

```ts
// services/ports/git-executor.ts
/**
 * Git 执行器 port —— stage/unstage/commit 的 spawn git 封装。
 * 🔒 三层架构：services 定义 port，infra/git/git-executor-impl.ts 实现。
 * status 不在此 port（由 git-status-service 用 reconcileFileChanges + readGitInfo 组合）。
 */
export interface IGitExecutor {
  /** git add（filePaths 空 = git add -A） */
  stage(cwd: string, filePaths?: string[]): void
  /** git reset HEAD（filePaths 空 = reset 全部） */
  unstage(cwd: string, filePaths?: string[]): void
  /** git commit -m message（message 空 = 用 git 默认） */
  commit(cwd: string, message?: string): void
}
```

- [ ] **步骤 2：impl 实现（execFileSync 安全范式）**

```ts
// infra/git/git-executor-impl.ts
import { execFileSync } from 'node:child_process'
import type { IGitExecutor } from '../../services/ports/git-executor.js'

const GIT_TIMEOUT_MS = 10_000

export class GitExecutorImpl implements IGitExecutor {
  stage(cwd: string, filePaths?: string[]): void {
    const args = ['add', ...(filePaths?.length ? filePaths : ['-A'])]
    execFileSync('git', args, { cwd, stdio: 'pipe', timeout: GIT_TIMEOUT_MS })
  }

  unstage(cwd: string, filePaths?: string[]): void {
    const args = ['reset', 'HEAD', ...(filePaths?.length ? filePaths : ['.'])]
    execFileSync('git', args, { cwd, stdio: 'pipe', timeout: GIT_TIMEOUT_MS })
  }

  commit(cwd: string, message?: string): void {
    const args = message ? ['commit', '-m', message] : ['commit']
    // message 经参数传递（非 shell 拼接），防注入（npm-git-installer.ts:36 范式）
    execFileSync('git', args, { cwd, stdio: 'pipe', timeout: GIT_TIMEOUT_MS })
  }
}
```

- [ ] **步骤 3：提交**

```bash
git add src-electron/runtime/src/services/ports/git-executor.ts src-electron/runtime/src/infra/git/git-executor-impl.ts
git commit -m "feat(git): add IGitExecutor port + impl (stage/unstage/commit) (W16-2)"
```

### 任务 16-3：新建 git-status-service（buildGitStatus）

**文件：** 新建 `src-electron/runtime/src/services/git-status-service.ts`

- [ ] **步骤 1：buildGitStatus（复用 reconcileFileChanges + readGitInfo + numstat）**

```ts
// services/git-status-service.ts
import { reconcileFileChanges } from '../infra/pi/file-change-reconciler.js'
import { readGitInfo } from './git-info.js'
import { execSync } from 'node:child_process'
import type { GitStatusResult, GitFileStatus } from '@xyz-agent/shared'
import type { FileChangeStatus } from '@xyz-agent/shared'

const NUMSTAT_TIMEOUT_MS = 5000

/**
 * 构建 git.status:result（W16）。
 * 复用 reconcileFileChanges 的 porcelain 解析（W16-1 已加 U 映射），
 * 补充 branch（readGitInfo）+ staged/unstaged 计数 + stats（numstat）+ isRepo 标志。
 * 注：reconcileFileChanges 的 xyToStatus 坍缩了 staged/unstaged 区分（W11 H-R3-01 提示），
 * 此处重新解析原始 porcelain 保留 XY 双码供 staged/unstaged 拆分。
 */
export function buildGitStatus(cwd: string, sessionId: string): GitStatusResult {
  // 1. 分支
  const info = readGitInfo(cwd)

  // 2. porcelain 原始输出（重新解析，保留 XY 双码）
  let rawOutput = ''
  try {
    rawOutput = execSync('git status --porcelain', { cwd, timeout: 5000, encoding: 'utf-8' })
  } catch {
    // git 失败 → 非 git 仓库或 git 未安装
    return { sessionId, isRepo: false, stagedCount: 0, unstagedCount: 0, stats: { add: 0, del: 0 }, hasConflict: false, files: [] }
  }

  const lines = rawOutput.split('\n').filter((l) => l.length > 0)
  const files: GitFileStatus[] = []
  let stagedCount = 0
  let unstagedCount = 0
  let hasConflict = false

  for (const line of lines) {
    const xy = line.slice(0, 2)
    const path = line.slice(3).split(' -> ').pop()!.trim() // 重命名取目标
    // 复用 reconcileFileChanges 的映射逻辑（含 U，W16-1）
    const status = xyToStatusLocal(xy)
    files.push({ path, xyCode: xy, status })
    if (status === 'unmerged') hasConflict = true
    // staged = X 码非空格（index 有改动）；unstaged = Y 码非空格（worktree 有改动）
    if (xy[0] !== ' ' && xy[0] !== '?') stagedCount++
    if (xy[1] !== ' ' && xy !== '??') unstagedCount++
  }

  // 3. stats（numstat，+N/-N 汇总）
  let add = 0, del = 0
  try {
    const numstat = execSync('git diff --numstat HEAD', { cwd, timeout: NUMSTAT_TIMEOUT_MS, encoding: 'utf-8' })
    for (const line of numstat.split('\n')) {
      const parts = line.split('\t')
      const a = parseInt(parts[0], 10)
      const d = parseInt(parts[1], 10)
      if (!Number.isNaN(a)) add += a
      if (!Number.isNaN(d)) del += d
    }
  } catch {
    // numstat 失败（如无 HEAD）→ stats 留 0
  }

  return {
    sessionId,
    isRepo: info !== undefined,
    branch: info?.branch,
    stagedCount,
    unstagedCount,
    stats: { add, del },
    hasConflict,
    files,
  }
}

/** 与 file-change-reconciler xyToStatus 同构的本地映射（避免循环依赖） */
function xyToStatusLocal(xy: string): FileChangeStatus {
  if (xy === '??') return 'added'
  if (xy[1] === 'D' || xy[0] === 'D') return 'deleted'
  if (xy[0] === 'U' || xy[1] === 'U' || (xy[0] === 'A' && xy[1] === 'A') || (xy[0] === 'D' && xy[1] === 'D')) return 'unmerged'
  if (xy[0] === 'A') return 'added'
  if (xy[0] === 'R' || xy[0] === 'C') return 'modified'
  if (xy[0] === 'M' || xy[1] === 'M') return 'modified'
  return 'modified'
}
```

- [ ] **步骤 2：提交**

```bash
git add src-electron/runtime/src/services/git-status-service.ts
git commit -m "feat(git): add buildGitStatus service (status/staged/unstaged/stats/conflict) (W16-3)"
```

### 任务 16-4：新建 git-message-handler + server 路由

**文件：** 新建 `src-electron/runtime/src/transport/git-message-handler.ts` + 修改 `server.ts`

- [ ] **步骤 1：git-message-handler**

```ts
// transport/git-message-handler.ts
import type { ClientMessage, ClientMessageType } from '@xyz-agent/shared'
import type { WsType } from './server.js'
import type { MessageHandlerContext } from './message-context.js'
import type { ISessionService } from '../interfaces.js'
import { buildGitStatus } from '../services/git-status-service.js'
import type { IGitExecutor } from '../services/ports/git-executor.js'
import { toErrorMessage } from '../utils/errors.js'

export interface GitHandlerContext extends MessageHandlerContext {
  sessionService: ISessionService
  gitExecutor: IGitExecutor
}

export class GitMessageHandler {
  readonly handles: ClientMessageType[] = ['git.status', 'git.stage', 'git.unstage', 'git.commit']

  constructor(private ctx: GitHandlerContext) {}

  async handleGitMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    const payload = msg.payload as { sessionId: string; filePaths?: string[]; message?: string }
    const sid = payload.sessionId
    if (!sid) {
      this.ctx.sendError(ws, 'invalid_payload', 'Missing sessionId', msg.id)
      return
    }
    // cwd 从 sessionService 取（session-service.ts:221 getSession）
    const session = this.ctx.sessionService.getSession(sid)
    if (!session?.cwd) {
      this.ctx.sendError(ws, 'session_not_found', `Session ${sid} not found or no cwd`, msg.id, { sessionId: sid })
      return
    }
    const cwd = session.cwd

    switch (msg.type) {
      case 'git.status': {
        const result = buildGitStatus(cwd, sid)
        this.ctx.reply(ws, msg.id, 'git.status:result', result as unknown as Record<string, unknown>)
        return
      }
      case 'git.stage': {
        try {
          this.ctx.gitExecutor.stage(cwd, payload.filePaths)
          // stage 后刷新 status 回推
          const result = buildGitStatus(cwd, sid)
          this.ctx.reply(ws, msg.id, 'git.status:result', result as unknown as Record<string, unknown>)
        } catch (e) {
          this.ctx.sendError(ws, 'git_stage_failed', toErrorMessage(e), msg.id, { sessionId: sid })
        }
        return
      }
      case 'git.unstage': {
        try {
          this.ctx.gitExecutor.unstage(cwd, payload.filePaths)
          const result = buildGitStatus(cwd, sid)
          this.ctx.reply(ws, msg.id, 'git.status:result', result as unknown as Record<string, unknown>)
        } catch (e) {
          this.ctx.sendError(ws, 'git_unstage_failed', toErrorMessage(e), msg.id, { sessionId: sid })
        }
        return
      }
      case 'git.commit': {
        try {
          this.ctx.gitExecutor.commit(cwd, payload.message)
          const result = buildGitStatus(cwd, sid)
          this.ctx.reply(ws, msg.id, 'git.status:result', result as unknown as Record<string, unknown>)
        } catch (e) {
          const msg_str = toErrorMessage(e)
          // 冲突态 commit 失败检测
          const code = msg_str.includes('conflict') || msg_str.includes('unmerged') ? 'git_conflict' : 'git_commit_failed'
          this.ctx.sendError(ws, code, msg_str, msg.id, { sessionId: sid })
        }
        return
      }
    }
  }
}
```

- [ ] **步骤 2：server.ts 注入 + 路由**

修改 `server.ts`：
1. import GitMessageHandler + GitExecutorImpl
2. setServices 构造 gitHandler（加 gitExecutor: new GitExecutorImpl()）
3. routes Map 加 git.* 注册

在 setServices（L98 treeMessageHandler 构造后）加：
```ts
    this.gitMessageHandler = new GitMessageHandler({
      ...messaging,
      sessionService: this.sessionService,
      gitExecutor: new GitExecutorImpl(),
    })
```

routes Map（L131 plugin 后）加：
```ts
      ...this.gitMessageHandler.handles.map(t => [t, (msg: ClientMessage, ws: WsType) => this.gitMessageHandler.handleGitMessage(msg, ws)] as const),
```

字段声明（L53 treeMessageHandler 后）加 `private gitMessageHandler!: GitMessageHandler`

- [ ] **步骤 3：验证 runtime tsc + 测试**

```bash
cd src-electron && npx tsc --noEmit -p runtime/tsconfig.json
cd src-electron/runtime && npx vitest run
```

- [ ] **步骤 4：提交**

```bash
git add src-electron/runtime/src/transport/git-message-handler.ts src-electron/runtime/src/transport/server.ts
git commit -m "feat(git): add git-message-handler + server routing (W16-4)"
```

### W16 Review 要点
- [ ] xyToStatus 含 U unmerged 映射
- [ ] IGitExecutor port + impl（execFileSync 安全范式，message 参数传递）
- [ ] buildGitStatus 复用 reconcileFileChanges 解析 + readGitInfo 分支 + numstat 行数
- [ ] git-message-handler 4 case（status/stage/unstage/commit），cwd 从 sessionService.getSession 取
- [ ] server routes 注册 git.*
- [ ] 冲突 commit 失败 code=git_conflict
- [ ] runtime tsc 0 错 + vitest 全绿

---

## W17 · git-zone 前端 + SideDrawer + widget

**目的：** git domain + GitZone.vue 四态 + SideDrawer 容器 + widget 订阅。

**文件（8）：** 新建 git.ts + GitZone.vue + SideDrawer.vue + SideDrawerTab.vue；修改 api/index + Panel.vue + extension.ts。

### 任务 17-1：git domain（前端 API）

**文件：** 新建 `src-electron/renderer/src/api/domains/git.ts`

- [ ] **步骤 1：git domain 方法**

```ts
// api/domains/git.ts
import type { GitStatusResult } from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'

export function status(sessionId: string): Promise<GitStatusResult> {
  const id = pending.create()
  const result = pending.register<GitStatusResult>(id)
  transport.send({ type: 'git.status', id, payload: { sessionId } })
  return result
}

export function stage(sessionId: string, filePaths?: string[]): Promise<GitStatusResult> {
  const id = pending.create()
  const result = pending.register<GitStatusResult>(id)
  transport.send({ type: 'git.stage', id, payload: { sessionId, filePaths } })
  return result
}

export function unstage(sessionId: string, filePaths?: string[]): Promise<GitStatusResult> {
  const id = pending.create()
  const result = pending.register<GitStatusResult>(id)
  transport.send({ type: 'git.unstage', id, payload: { sessionId, filePaths } })
  return result
}

export function commit(sessionId: string, message?: string): Promise<GitStatusResult> {
  const id = pending.create()
  const result = pending.register<GitStatusResult>(id)
  transport.send({ type: 'git.commit', id, payload: { sessionId, message } })
  return result
}
```

- [ ] **步骤 2：api/index.ts 导出 git + mock 同构**

修改 `api/index.ts`：
```ts
import * as realGit from './domains/git'
// ...
export const git = isMock ? mockApi.git : realGit
```

mock/index.ts 加 git 对象（补 mock fixture git 状态）。

- [ ] **步骤 3：提交**

```bash
git add src-electron/renderer/src/api/domains/git.ts src-electron/renderer/src/api/index.ts src-electron/renderer/src/api/mock/index.ts
git commit -m "feat(api): add git domain (status/stage/unstage/commit) (W17-1)"
```

### 任务 17-2：GitZone.vue 四态组件

**文件：** 新建 `src-electron/renderer/src/components/panel/GitZone.vue`

- [ ] **步骤 1：四态组件（对齐 draft-companion-zones §2）**

组件含：分支显示 + stats（+N/-N）+ 状态 pill（clean/staged/conflict）+ 暂存/取消暂存/提交（弹 message 输入框）/Diff 按钮。Diff 按钮触发 SideDrawer 打开（emit）。

```vue
<template>
  <!-- git-zone（panel/spec.md zone ⑤，draft-companion-zones §2 四态）。
       干净压缩单行；已暂存/有 diff 显 stats+操作；冲突红 pill+danger 竖条。 -->
  <div v-if="status?.isRepo" class="git-zone flex items-center gap-2 px-3 py-1.5 text-[12px]" :class="zoneClass">
    <GitBranch class="size-3.5 shrink-0 text-muted" />
    <span class="font-mono text-subtle">{{ status.branch }}</span>

    <!-- 冲突 pill -->
    <span v-if="status.hasConflict" class="rounded-sm bg-danger-soft px-1.5 py-0.5 text-[10px] text-danger">
      {{ conflictCount }} 文件冲突
    </span>
    <!-- staged pill -->
    <span v-else-if="status.stagedCount > 0" class="rounded-sm bg-success-soft px-1.5 py-0.5 text-[10px] text-success">
      已暂存 {{ status.stagedCount }}
    </span>

    <!-- stats -->
    <span v-if="status.stats.add > 0 || status.stats.del > 0" class="flex items-center gap-1 text-[10px] tabular-nums">
      <span class="text-success">+{{ status.stats.add }}</span>
      <span class="text-danger">-{{ status.stats.del }}</span>
    </span>

    <!-- 操作按钮（右侧） -->
    <div class="ml-auto flex items-center gap-1.5">
      <!-- 冲突态：只显解决冲突 -->
      <Button v-if="status.hasConflict" size="sm" variant="danger" @click="emit('open-drawer', 'conflict')">解决冲突</Button>
      <template v-else>
        <!-- staged：取消暂存 + 提交 + Diff -->
        <Button v-if="status.stagedCount > 0" size="sm" variant="ghost" @click="onUnstage">取消暂存</Button>
        <Button v-if="status.stagedCount > 0" size="sm" @click="onCommit">提交</Button>
        <!-- unstaged：暂存 + Diff -->
        <Button v-if="status.unstagedCount > 0" size="sm" variant="ghost" @click="onStage">暂存</Button>
        <!-- Diff（触发 SideDrawer） -->
        <Button size="sm" variant="ghost" :disabled="status.stagedCount === 0 && status.unstagedCount === 0" @click="emit('open-drawer', 'diff')">
          <FileDiff class="size-3" /> Diff
        </Button>
      </template>
    </div>

    <!-- commit message 输入弹窗（C13：前端弹输入框，可选 message） -->
    <Dialog v-if="showCommitDialog" :open="showCommitDialog" @update:open="showCommitDialog = false">
      <div class="p-4">
        <p class="mb-2 text-[13px] text-fg">提交信息（可选）</p>
        <Input v-model="commitMessage" placeholder="留空使用默认" @keydown.enter="confirmCommit" />
        <div class="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" @click="showCommitDialog = false">取消</Button>
          <Button size="sm" @click="confirmCommit">提交</Button>
        </div>
      </div>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { GitBranch, FileDiff } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog } from '@/components/ui/dialog'
import * as gitApi from '@/api/git'
import type { GitStatusResult } from '@xyz-agent/shared'

const props = defineProps<{ sessionId: string; status: GitStatusResult | null }>()
const emit = defineEmits<{ 'open-drawer': [tab: string] }>()

const showCommitDialog = ref(false)
const commitMessage = ref('')

const conflictCount = computed(() => props.status?.files.filter((f) => f.status === 'unmerged').length ?? 0)
const zoneClass = computed(() => props.status?.hasConflict ? 'border-l-2 border-danger bg-danger-soft/30' : '')

async function onStage() {
  const r = await gitApi.stage(props.sessionId)
  emit('status-update', r)
}
async function onUnstage() {
  const r = await gitApi.unstage(props.sessionId)
  emit('status-update', r)
}
function onCommit() {
  commitMessage.value = ''
  showCommitDialog.value = true
}
async function confirmCommit() {
  showCommitDialog.value = false
  const r = await gitApi.commit(props.sessionId, commitMessage.value || undefined)
  emit('status-update', r)
}
</script>
```

注意：需加 `'status-update'` 到 defineEmits（父组件 Panel 刷新 status）。实际实现时根据 vue-tsc 反馈调整 emits。

- [ ] **步骤 2：提交**

```bash
git add src-electron/renderer/src/components/panel/GitZone.vue
git commit -m "feat(panel): add GitZone four-state component (W17-2)"
```

### 任务 17-3：SideDrawer 容器 + Tab

**文件：** 新建 `src-electron/renderer/src/components/workspace/SideDrawer.vue` + `SideDrawerTab.vue`

- [ ] **步骤 1：SideDrawer 容器（开/关 + tab 切换）**

```vue
<!-- SideDrawer.vue：右抽屉容器（panel/spec.md，git-zone Diff 按钮触发）。
     tab 承载 Terminal/Browser（widget）。Diff 审批内容本轮排除。 -->
<template>
  <transition name="drawer-slide">
    <aside v-if="open" class="side-drawer absolute right-0 top-0 z-30 flex h-full w-1/2 flex-col border-l border-border bg-bg shadow-lg">
      <!-- header：tab + 关闭 -->
      <header class="flex items-center gap-1 border-b border-border px-3 py-2">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="rounded-sm px-2 py-1 text-[12px]"
          :class="activeTab === t.id ? 'bg-surface text-fg' : 'text-subtle hover:text-fg'"
          @click="activeTab = t.id"
        >{{ t.label }}</button>
        <button class="ml-auto text-muted hover:text-fg" @click="emit('close')">
          <X class="size-4" />
        </button>
      </header>
      <!-- tab 内容 -->
      <div class="flex-1 overflow-auto">
        <SideDrawerTab v-if="activeTab === 'terminal'" type="terminal" :session-id="sessionId" />
        <SideDrawerTab v-else-if="activeTab === 'browser'" type="browser" :session-id="sessionId" />
        <div v-else-if="activeTab === 'diff'" class="p-4 text-[12px] text-subtle">
          Diff 审批暂未实装（本轮排除）
        </div>
      </div>
    </aside>
  </transition>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { X } from '@lucide/vue'
import SideDrawerTab from './SideDrawerTab.vue'

defineProps<{ open: boolean; sessionId: string }>()
const emit = defineEmits<{ close: [] }>()

const tabs = [
  { id: 'terminal', label: '终端' },
  { id: 'browser', label: '浏览器' },
] as const
const activeTab = ref<(typeof tabs)[number]['id'] | 'diff'>('terminal')
</script>

<style scoped>
.drawer-slide-enter-active, .drawer-slide-leave-active { transition: transform 0.2s ease; }
.drawer-slide-enter-from, .drawer-slide-leave-to { transform: translateX(100%); }
</style>
```

- [ ] **步骤 2：SideDrawerTab（widget 渲染）**

```vue
<!-- SideDrawerTab.vue：Terminal/Browser widget 内容（消费 extension:widget/extension:status） -->
<template>
  <div class="p-3 font-mono text-[12px] text-fg">
    <div v-if="!lines.length" class="text-subtle">{{ type === 'terminal' ? '无终端输出' : '无浏览器预览' }}</div>
    <pre v-for="(line, i) in lines" :key="i" class="whitespace-pre-wrap">{{ line }}</pre>
  </div>
</template>

<script setup lang="ts">
import { ref, onUnmounted, watch } from 'vue'
import * as extensionApi from '@/api/extension'

const props = defineProps<{ type: 'terminal' | 'browser'; sessionId: string }>()

const lines = ref<string[]>([])
let unsub: (() => void) | null = null

function subscribe() {
  unsub?.()
  lines.value = []
  // widgetKey 按 type 映射（G-010 执行时细化：terminal→pi terminal widget，browser→pi browser widget）
  unsub = extensionApi.onWidget(props.sessionId, (widgetKey, widgetLines) => {
    // 简化：同 widgetKey 追加（Terminal append 语义，G-011）
    if (widgetKey.startsWith(props.type)) {
      lines.value.push(...widgetLines)
    }
  })
}

watch(() => props.sessionId, subscribe, { immediate: true })
onUnmounted(() => unsub?.())
</script>
```

- [ ] **步骤 3：提交**

```bash
git add src-electron/renderer/src/components/workspace/SideDrawer.vue src-electron/renderer/src/components/workspace/SideDrawerTab.vue
git commit -m "feat(workspace): add SideDrawer container + tab (W17-3)"
```

### 任务 17-4：extension domain 加 onWidget/onStatus

**文件：** 修改 `src-electron/renderer/src/api/domains/extension.ts`

- [ ] **步骤 1：加 onWidget/onStatus（session 通道）**

```ts
import * as events from '../events'

/**
 * 订阅 extension:widget（session 通道，payload 含 sessionId → routeInbound 走 dispatchSession）。
 * widgetKey 区分不同 widget（terminal/browser），lines 追加语义（Terminal）。
 */
export function onWidget(
  sessionId: string,
  handler: (widgetKey: string, lines: string[]) => void,
): () => void {
  return events.on(sessionId, (msg) => {
    if (msg.type === 'extension:widget') {
      const payload = msg.payload as { sessionId: string; widgetKey: string; lines: string[] }
      handler(payload.widgetKey, payload.lines)
    }
  })
}

/** 订阅 extension:status（session 通道） */
export function onStatus(
  sessionId: string,
  handler: (statusKey: string, text: string) => void,
): () => void {
  return events.on(sessionId, (msg) => {
    if (msg.type === 'extension:status') {
      const payload = msg.payload as { sessionId: string; statusKey: string; text: string }
      handler(payload.statusKey, payload.text)
    }
  })
}
```

- [ ] **步骤 2：提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit
git add src-electron/renderer/src/api/domains/extension.ts
git commit -m "feat(api): add onWidget/onStatus subscription (session channel) (W17-4)"
```

### 任务 17-5：Panel.vue 接入 GitZone + SideDrawer

**文件：** 修改 `src-electron/renderer/src/components/panel/Panel.vue`

- [ ] **步骤 1：composer-band 加 GitZone + SideDrawer 容器**

```vue
<!-- composer-band 加 GitZone（zone ⑤ 恢复） -->
<div class="composer-band flex flex-shrink-0 flex-col gap-1.5">
  <RetryIndicator v-if="sessionId" :retry="chat.getRetryState(sessionId)" />
  <QueuePending v-if="sessionId" :queue="chat.getQueueState(sessionId)" />
  <ProgressZone phase="running" />
  <Composer v-if="sessionId" :session-id="sessionId" />
  <!-- ⑤ git-zone（W17 恢复，draft-companion-zones §2 四态） -->
  <GitZone v-if="sessionId && gitStatus" :session-id="sessionId" :status="gitStatus" @open-drawer="openDrawer" @status-update="onGitStatusUpdate" />
</div>

<!-- SideDrawer（W17，git-zone Diff 按钮触发） -->
<SideDrawer :open="drawerOpen" :session-id="sessionId ?? ''" @close="drawerOpen = false" />
```

- [ ] **步骤 2：script 加 git status 管理 + drawer 状态**

```ts
import GitZone from './GitZone.vue'
import SideDrawer from '../workspace/SideDrawer.vue'
import * as gitApi from '@/api/git'
import type { GitStatusResult } from '@xyz-agent/shared'

const gitStatus = ref<GitStatusResult | null>(null)
const drawerOpen = ref(false)

// 进入 session / agent_end / 操作后刷新 git status（C14 非轮询）
watch(() => props.sessionId, async (sid) => {
  if (sid) {
    try { gitStatus.value = await gitApi.status(sid) } catch { gitStatus.value = null }
  } else {
    gitStatus.value = null
  }
}, { immediate: true })

function openDrawer(_tab: string) {
  drawerOpen.value = true
}
function onGitStatusUpdate(r: GitStatusResult) {
  gitStatus.value = r
}
```

- [ ] **步骤 3：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run
git add src-electron/renderer/src/components/panel/Panel.vue
git commit -m "feat(panel): wire GitZone + SideDrawer into Panel (W17-5)"
```

### W17 Review 要点
- [ ] git domain（status/stage/unstage/commit）+ mock 同构
- [ ] GitZone 四态（clean/staged/diff/conflict）+ 暂存/取消暂存/提交（弹 message 输入框）/Diff 按钮
- [ ] SideDrawer 容器（开/关 + tab 切换），git-zone Diff 按钮触发打开
- [ ] extension onWidget/onStatus 走 session 通道
- [ ] SideDrawerTab 消费 widget lines（terminal append 语义）
- [ ] Panel.vue 恢复 zone ⑤ GitZone

---

## W18 · session.list server-push + FileView 聚合

**目的：** session.list 加全局订阅（runtime 增删实时刷新，不重载历史）+ FileView 从 mock fixture 切到 file_changes 跨回合并集。

**文件（4）：** useSidebar.ts + mock/index.ts + FileView.vue + FileTreeRow.vue

### 任务 18-1：session.list server-push 订阅

**文件：** 修改 `src-electron/renderer/src/composables/features/useSidebar.ts:217-228`

- [ ] **步骤 1：useSidebar 加 session.list onGlobalType 订阅**

在 loadSessions（L217）后加订阅函数：
```ts
import * as events from '@/api/events'

/**
 * 订阅 session.list server-push（W18）。
 * runtime broadcastSessionList 时刷新 Sidebar 列表（增删实时同步）。
 * 注：不重载全量历史（G-018）——只更新 groups/list 结构，历史按需 hydrate。
 */
export function subscribeSessionList(sessionStore: ReturnType<typeof useSessionStore>): () => void {
  return events.onGlobalType('session.list', (msg) => {
    sessionStore.setGroups(msg.payload.groups)
  })
}
```

在 useSidebar 的初始化（onMounted 或 setup）调 subscribeSessionList，onUnmounted 取消。

- [ ] **步骤 2：mock 补 session.list server-push 模拟**

mock/index.ts 在 session.create/remove 后加广播模拟：
```ts
// session.create 末尾（L142 后）加：
broadcastSessionListMock()
// session.remove 末尾（L166 后）加：
broadcastSessionListMock()
```
加 helper：
```ts
function broadcastSessionListMock(): void {
  // 模拟 runtime broadcastSessionList（server-push）
  const groups = /* 重新按 cwd 分组 fixtureSessions */
  events.dispatchGlobal({ type: 'session.list', id: nextId('push'), payload: { groups } })
}
```

注意：mock 的 list() 已有分组逻辑（L125-136），提取复用。

- [ ] **步骤 3：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run
git add src-electron/renderer/src/composables/features/useSidebar.ts src-electron/renderer/src/api/mock/index.ts
git commit -m "feat(sidebar): subscribe session.list server-push (W18-1)"
```

### 任务 18-2：FileView 切 file_changes 聚合

**文件：** 修改 `src-electron/renderer/src/components/sidebar/FileView.vue` + `FileTreeRow.vue`

- [ ] **步骤 1：FileView 数据源从 fixture 改 chat store 聚合**

FileView.vue 当前 `import { fixtureFileChanges } from '@/api/mock/data'`（Sidebar.vue:143 直读）。
改为聚合 chat store 里 active session 所有 assistant 的 fileChanges（跨回合并集，C6）：

```ts
import { useChatStore } from '@/stores/chat'
import { computed } from 'vue'
import type { FileChange } from '@xyz-agent/shared'

const chat = useChatStore()
const props = defineProps<{ sessionId: string }>()

// 跨回合并集（C6）：聚合 active session 所有 assistant message 的 fileChanges
const aggregatedChanges = computed<FileChange[]>(() => {
  const messages = chat.getMessages(props.sessionId) ?? []
  const map = new Map<string, FileChange>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.fileChanges) continue
    for (const fc of msg.fileChanges) {
      // 后回合覆盖前回合同文件（最新状态优先）
      map.set(fc.filePath, fc)
    }
  }
  return Array.from(map.values())
})

// buildTree 用 aggregatedChanges 而非 fixtureFileChanges
const tree = computed(() => buildTree(aggregatedChanges.value))
```

- [ ] **步骤 2：FileTreeRow 加 U 标注 + 行数显示**

FileTreeRow.vue 加 unmerged badge + addLines/delLines：
```vue
<!-- status badge 加 U（冲突红） -->
<span class="rounded-sm px-1 py-0.5 font-mono text-[10px] font-semibold" :class="badgeClass">
  {{ statusLabel }}
</span>
<!-- 行数（W18，draft-file-view :170） -->
<span v-if="change.addLines || change.delLines" class="flex items-center gap-1 text-[10px] tabular-nums">
  <span v-if="change.addLines" class="text-success">+{{ change.addLines }}</span>
  <span v-if="change.delLines" class="text-danger">-{{ change.delLines }}</span>
</span>
```
badgeClass/statusLabel 加 unmerged 分支（红边框）。

- [ ] **步骤 3：树内过滤框**

FileView.vue 加过滤 input（draft-file-view §3 实时过滤）：
```vue
<input v-model="filterText" placeholder="过滤文件…" class="mb-1.5 w-full rounded-sm border border-border px-2 py-1 text-[12px]" />
```
tree computed 加过滤：
```ts
const filtered = computed(() => {
  if (!filterText.value.trim()) return aggregatedChanges.value
  const q = filterText.value.toLowerCase()
  return aggregatedChanges.value.filter((fc) => fc.filePath.toLowerCase().includes(q))
})
```

- [ ] **步骤 4：验证 + 提交**

```bash
cd src-electron/renderer && npx vue-tsc --noEmit && npx vitest run
git add src-electron/renderer/src/components/sidebar/FileView.vue src-electron/renderer/src/components/sidebar/FileTreeRow.vue
git commit -m "feat(fileview): switch to file_changes aggregation + U badge + filter (W18-2)"
```

### W18 Review 要点
- [ ] session.list onGlobalType 订阅，runtime 增删实时刷新 Sidebar
- [ ] 不重载全量历史（G-018），只更新 groups/list 结构
- [ ] mock create/remove 后广播 session.list server-push
- [ ] FileView 数据源从 fixture 改 chat store 聚合（跨回合并集）
- [ ] FileTreeRow 含 U（unmerged 冲突红）badge + 行数 +N/-N
- [ ] FileView 有树内过滤框（实时）

---

## 全局验收（全部 Wave 完成后）

- [ ] mock 模式发消息看到 thinking + tool_call + ChangeSetCard 实时流式
- [ ] message.tool_call_pending 有 store case + ToolCallStatus 含 pending
- [ ] Composer 上方有 retry 指示位 + queue pending 气泡（steer 后可见）
- [ ] ExtensionPage 三 tab 安装 + 候选选择 + 卸载可用
- [ ] /compact 触发压缩，compacting→compacted 状态正确
- [ ] git-zone 四态展示（干净/已暂存/有 diff/冲突）+ 暂存/提交（弹 message 输入框）/Diff 按钮
- [ ] 后端 git.status/stage/unstage/commit 可用（spawn git，execFileSync 安全）
- [ ] SideDrawer 由 git-zone Diff 按钮触发，含 Terminal/Browser tab
- [ ] extension:widget/extension:status 前端订阅渲染（session 通道）
- [ ] session.list server-push 实时刷新 Sidebar
- [ ] FileView 显示 file_changes 聚合（跨回合并集）+ U 标注 + 行数 + 过滤
- [ ] ExtensionInfo 含 tools；FileChangeStatus 含 unmerged（vue-tsc 0 错）
- [ ] `npx vue-tsc --noEmit` 0 错 + `npx vitest run` 全绿（每 wave 基线）
