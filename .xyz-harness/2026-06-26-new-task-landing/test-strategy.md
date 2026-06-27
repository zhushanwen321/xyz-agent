---
verdict: pass
upstream: execution-plan.md, code-architecture.md
downstream: coding
---

# 测试策略 — 新建任务

> 本策略回答「**怎么测**」，[execution-plan.md](execution-plan.md) 测试验收清单（39 用例）回答「**测什么**」，二者正交。DoD = 清单全 PASS，不设覆盖率百分比门槛。

## 1. 测试分层总览

| 层 | 职责 | 框架 | 环境 | mock 对象 | 文件落位 | 运行 |
|----|------|------|------|----------|---------|------|
| **单元** | 纯函数 / composable 状态机 / runtime service 单方法 | vitest | renderer: happy-dom；runtime/main: node | api 域 / IGitExecutor port | renderer `src/__tests__/`；runtime `test/` | 见 §8 |
| **集成** | composables+store+组件跨层链路（mount 组件树，mock 最外层 API/IPC） | vitest + @vue/test-utils | happy-dom | `@/api`、`window.electronAPI` | renderer `src/__tests__/integration/` | 见 §8 |
| **E2E 替代** | v1 不引入 Playwright（OS 原生 dialog 无法 CI 驱动）。用「端到端集成测试」+ 手工验收清单替代 | — | — | — | — | 见 §4 |

## 2. 单元测试规范

### 2.1 前端（renderer）— vi.hoisted + vi.mock('@/api')

范式来自 [`useChat.test.ts`](../../src-electron/renderer/src/__tests__/useChat.test.ts)：① `vi.hoisted` 在模块加载前捕获回调 handler；② `vi.mock('@/api')` 整体替换 api 域；③ `beforeEach` 重建 pinia + `clearAllMocks`；④ 每测用唯一 sid 避免模块级 Map 串扰。useNewTaskFlow 同构：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionSummary } from '@xyz-agent/shared'

const apiMock = vi.hoisted(() => ({
  create: vi.fn((cwd?: string) =>
    Promise.resolve({ id: 's1', cwd, status: 'idle' } as SessionSummary)),
}))
vi.mock('@/api', () => ({ session: { create: apiMock.create }, git: {} }))

import { useNewTaskFlow } from '@/composables/features/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'

beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

describe('useNewTaskFlow.startFlow', () => {
  it('T1.1 常态：resolveDefaultCwd 返回 cwd → create(cwd) → state=landing', async () => {
    useSessionStore().sessions = [{ id: 'old', cwd: '/repo', lastActiveAt: 1 }] as any
    const flow = useNewTaskFlow()
    await flow.startFlow()
    expect(apiMock.create).toHaveBeenCalledWith('/repo', undefined)
    expect(flow.state.value).toBe('landing')
  })

  it('T1.2 首次启动：sessions 空 → 不 create，currentSessionId=null', async () => {
    useSessionStore().sessions = []
    const flow = useNewTaskFlow()
    await flow.startFlow()
    expect(apiMock.create).not.toHaveBeenCalled()
    expect(flow.currentSessionId.value).toBeNull()
    expect(flow.state.value).toBe('landing')
  })

  it('T1.3 E1 双击并发：in-flight 标记只 create 一次', async () => {
    useSessionStore().sessions = [{ id: 'x', cwd: '/repo', lastActiveAt: 1 }] as any
    const flow = useNewTaskFlow()
    await Promise.all([flow.startFlow(), flow.startFlow()])
    expect(apiMock.create).toHaveBeenCalledTimes(1)
  })

  it('T8.6 非法转换：idle 下 openBranchModal → 抛错回 idle', () => {
    const flow = useNewTaskFlow()
    expect(() => flow.openBranchModal()).toThrow()
    expect(flow.state.value).toBe('idle')
  })
})
```

### 2.2 runtime — mock IGitExecutor port（构造注入）

GitService 经 `{ sessionService, executor }` 构造注入，executor 是 seam，mock 它不起真实 git 进程：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GitService, GitError } from '../src/services/git-service'
import { GitExecutorError } from '../src/services/ports/git-executor'
import type { IGitExecutor, GitExecutorResult } from '../src/services/ports/git-executor'

const executor: { exec: ReturnType<typeof vi.fn> } = { exec: vi.fn() }
const sessionService = { getSummary: vi.fn(() => ({ cwd: '/repo' })) } as any

function svc(): GitService {
  return new GitService({ sessionService, executor: executor as unknown as IGitExecutor })
}

beforeEach(() => vi.clearAllMocks())

describe('GitService.createBranch (#7)', () => {
  it('T6.1 成功：checkout -b exit 0 → resolve', async () => {
    executor.exec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as GitExecutorResult)
    await expect(svc().createBranch('s1', 'feat/x')).resolves.toBeUndefined()
    expect(executor.exec).toHaveBeenCalledWith('/repo', 'checkout', ['-b', 'feat/x'])
  })

  it('T6.3 E10 已存在：exit 128 → throw GitError', async () => {
    executor.exec.mockResolvedValueOnce({ stdout: '', stderr: 'already exists', exitCode: 128 } as GitExecutorResult)
    await expect(svc().createBranch('s1', 'feat/x')).rejects.toBeInstanceOf(GitError)
  })

  it('T6.4 E11 超时：exec throw GitExecutorError(timeout) → reject', async () => {
    executor.exec.mockRejectedValueOnce(new GitExecutorError('timeout', 'timed out'))
    await expect(svc().createBranch('s1', 'feat/x')).rejects.toThrow()
  })

  it('T6.8 NFR runtime 分支名二次校验：非法名在 exec 前被拒', async () => {
    await expect(svc().createBranch('s1', 'bad name')).rejects.toThrow()
    expect(executor.exec).not.toHaveBeenCalled()
  })
})
```

### 2.3 main — 纯函数

main 侧本功能仅 `dialog.showOpenDialog`（IPC handler）+ 路径校验，无独立业务逻辑。纯校验函数（如路径规范化）走 node 环境单测，断言输入输出，无 mock。

## 3. 集成测试规范

**什么算集成**：composables + store + 组件 跨层串联，mount 真实组件树，只 mock **最外层边界**（`@/api` 域 + `window.electronAPI` IPC），验证跨层数据流。mock 边界划在最外层 = 内部所有转换（状态机、computed、chip 回灌）都用真实代码跑。

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Panel from '@/components/panel/Panel.vue' // mount 组件树入口
import { useSessionStore } from '@/stores/session'
import { flushPromises } from '@vue/test-utils'

const apiMock = vi.hoisted(() => ({
  create: vi.fn((cwd?: string) =>
    Promise.resolve({ id: 's1', cwd, status: 'idle' })),
}))
vi.mock('@/api', () => ({ session: { create: apiMock.create }, git: {} }))

beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

describe('Wave 1 集成：⌘N → create(cwd) → landing 渲染', () => {
  it('T1.1+T1.6 触发点→composable→api→store→Landing 全链路', async () => {
    setActivePinia(createPinia())
    const session = useSessionStore()
    session.sessions = [{ id: 'old', cwd: '/repo', lastActiveAt: 1 }] as any
    const wrapper = mount(Panel)
    // 模拟 ⌘N 触发（按实际触发点接线，如键盘事件或调用 useNewTaskFlow().startFlow）
    window.dispatchEvent(new KeyboardEvent('keydown', { metaKey: true, key: 'n' }))
    await flushPromises()
    expect(apiMock.create).toHaveBeenCalledWith('/repo', undefined)
    expect(wrapper.text()).toContain('landing 空态文案') // 按 spec §6 实际文案
  })
})
```

> 集成测试断言落在**用户可见结果**（渲染文案 / chip 回灌），而非内部函数调用，保证重构内部时测试不脆。

## 4. 用户态 E2E 替代方案

**v1 不引入 Playwright/Spectron**：① OS 原生 dialog（`dialog.showOpenDialog` → NSOpenPanel）无法在 CI 驱动，真实 Electron 窗口 + OS 窗口交互超出自动化边界；② Ponytail，不为单一不可测点引入新依赖栈。

**替代**：端到端集成测试（§3，覆盖可驱动链路）+ 手工验收清单（覆盖 OS dialog 真实交互）。

**v1 手工验收必跑项**（真实走查 5 步流程，每次提测前人肉过一遍）：
1. ⌘N → landing 空态渲染（问候语 + composer + directory chip 空）— T1.1/T1.6
2. 点 directory chip → popover 列出 recent workspace → 选一项 → chip 回灌 — T3.1
3. 点「打开文件夹」→ OS dialog 弹出 → 选目录 → chip 回灌新 cwd（**真实 dialog，此处必须手工**）— T3.3
4. 点 branch chip → popover 列分支 → 选 dirty 分支 → 二次确认条 → 确认切走留工作区 — T4.2
5. 点「创建并检出新分支」→ modal 输入名 → 创建成功 chip 回灌 — T6.1

## 5. mock 策略矩阵

| 被测对象 | mock 什么 | 怎么 mock |
|---------|----------|----------|
| 前端 composable（useNewTaskFlow） | `@/api`（session/git 域） | `vi.mock('@/api', () => ({...}))`，handler 用 `vi.hoisted` 捕获 |
| 前端组件（单测） | useNewTaskFlow 返回值 | `vi.mock('@/composables/features/useNewTaskFlow')` 返回固定 state |
| 前端组件（集成） | 仅 `@/api` + IPC | `vi.mock('@/api')` + `window.electronAPI` stub，composable 用真实 |
| pick-directory IPC | `window.electronAPI.pickDirectory` | `vi.stubGlobal` 或 `Object.defineProperty(window, 'electronAPI', {...})` |
| runtime GitService | `IGitExecutor` port | **构造注入** mock executor（GitService 经 opts 接收） |
| runtime GitMessageHandler | GitService | 构造注入 mock service，验证路由 case + ack 消息 |
| git execSync 阻塞（T4.8） | IGitExecutor.exec + 定时器 | `vi.useFakeTimers()` 让 getStatus 返回可控 pending Promise |

## 6. TDD 流程约束

**每个 Wave 每个功能 Task 都走红绿循环**，纠正 execution-plan.md 仅 Wave 1 提 TDD 的缺口。5 步模板：

1. 写**失败测试**（按 test-matrix 用例 ID 取断言）
2. 跑测试 → **红**（确认测试本身有效，而非假绿）
3. 写**最小实现**让测试过
4. 跑测试 → **绿**
5. `commit`（一个 Task = 红→绿 = 一个 commit）

**先写测试的用例**（强制）：纯函数（`resolveDefaultCwd`/`recentWorkspaces`，T 无关 AC-4.x）、port 契约（`IGitExecutor` 调用参数/错误分类，T6.1/T6.3/T6.4/T6.8）、状态机转换守卫（T8.1-T8.6/T7.1）——这些是逻辑核心，测试即规格。

**可后写测试**：纯 UI 渲染（Landing 文案、popover 布局），实现后补渲染断言（T1.6/T1.7/T3.2）。

## 7. 特殊难点

**git execSync 阻塞测试（T4.8）**：getStatus 经 port 同步 exec，期间 JS 冻结，Esc 事件排队。用 `vi.useFakeTimers()` + mock executor 让 `gitApi.status` 返回 pending Promise，阻塞期 `dispatchEvent(Esc)`，`runAllTimers` 放行后断言状态机按队列转移、不丢事件：

```typescript
it('T4.8 getStatus 阻塞期间 Esc 排队，放行后状态机正确转移', async () => {
  vi.useFakeTimers()
  let resolveStatus!: () => void
  executor.exec.mockReturnValueOnce(new Promise(r => { resolveStatus = () => r({ exitCode: 0, stdout: '', stderr: '' }) }))
  const flow = useNewTaskFlow(); const session = useSessionStore()
  session.sessions = [{ id: 's', cwd: '/repo', lastActiveAt: 1 }] as any
  const p = flow.startFlow(); await flushPromises()
  flow.openBranchPopover() // state→branch-popover，触发 getStatus pending
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) // 阻塞期排队
  resolveStatus(); await p; await flushPromises()
  expect(flow.state.value).toBe('landing') // Esc 后关 popover 回 landing，事件未丢
  vi.useRealTimers()
})
```

**OS 原生 dialog 不可测（T3.3/T3.4）**：前端只测 `pickDirectory()` 返回 `{canceled:false, path}` / `{canceled:true}` 两个分支（mock `window.electronAPI`），真实 dialog 留手工验收（§4）。

**状态机非法转换（T8.6/T7.1）**：测非法转换**抛错** + state 回 idle，并验证 Vue 错误边界兜底不崩组件（mount 组件后触发非法调用，断言 wrapper 仍存活）。

## 8. 运行命令

```bash
# 前端（renderer）单测 + 集成
cd src-electron/renderer && npx vitest run
cd src-electron/renderer && npx vitest run src/__tests__/useNewTaskFlow.test.ts   # 单文件

# runtime（含 GitService/Handler）
cd src-electron/runtime && npx vitest run
cd src-electron/runtime && npx vitest run test/git-service.test.ts                # 单文件

# main（纯函数/路径校验）
cd src-electron/main && npx vitest run
```

## 9. 与 execution-plan.md 验收清单的关系

- **正交分工**：验收清单（39 用例 ID）= 测什么（断言点）；本策略 = 怎么测（分层归属 + mock + 运行）。一个用例 ID（如 T1.1）落进哪一层由本策略决定，断言内容不变。
- **Wave 4 验收 Wave 跑的是「分层测试全量」**：即 §8 三套 `npx vitest run` 全跑 + §4 手工验收 5 步过，而非单一套件。全 PASS 才算清单闭合（Wave 4 职责）。
- **条件性用例**：T4.7（getStatus 缓存命中）v1 不加缓存时标 `[DEVIATED]④NFR 允许`（沿用 execution-plan D-6），本策略不为其加测试。

## 10. 事后复盘：本次测试失效教训 [HISTORICAL — 2026-06-27]

**失效现象**：Wave 1-4 完成，77 单测 + 24 集成全绿、vue-tsc/tsc EXIT 0、verdict pass。用户手动打开发现 **Landing 态根本没有 composer 输入区**——功能不可用，阻塞级 bug，全部测试零覆盖。

**根因链**：
1. **视角单一**：只做构建者（白盒）视角（验状态机转换、API 契约）。使用者（黑盒：能输入吗、能发送吗）+ 观察者（形态：composer 在 DOM 吗）= 0 测试。
2. **文档与执行不一致**：本文 §3 写了正确范式（`mount(Panel)` + `wrapper.text()` 断言），但执行测试的 subagent 写集成用例时没 mount 任何组件，只调 composable 方法断言 `state.value`。
3. **旅程降级**：§4 E2E 替代手工验收写了完整旅程（chip 空态 → 选目录 → 打字发送），但落到自动化测试里「打字发送」零覆盖，用例被无声降级。
4. **DoD 漏关**：DoD 只数用例编号 + 测试全绿，没有「验证用户真的能用」这道关。
5. **§6「可后写测试：纯 UI 渲染」成为漏洞**：把渲染断言标记为「可后写」，结果要么没写要么弱写（断 testid 而非 DOM 可见元素）。

**本次 bug 作反面案例**：spec 写了 composer（§3 结构元素），测试没验证它在 DOM 里，于是 composer 缺失的 bug 穿透 77+24 全绿 + typecheck + verdict 三道关。

**已固化到项目级规范**：上述根因提炼为 4 条硬约束 + 首屏冒烟模板，见 [CLAUDE.md 测试规范 §5-§8 + 首屏冒烟模板](../../CLAUDE.md)。约束要点：① 每条用例至少一个用户可见断言；② 必须 mount 文档指定入口；③ 旅程步骤不可降级；④ DoD 渲染 gate（spec 结构条目 = 渲染断言清单）。后续 feature 的 test-strategy.md 必须把这 4 条作为集成/E2E 章节的硬性约束。
