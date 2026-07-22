# fast-fork · E2E 测试计划（可执行）

> 目标：把 fast-fork 从「21 个 vitest 隔离测试全绿」推进到「真正验证端到端用户体验」。
> 本计划写到 mount/createMock/click/assert 级别——下一个 subagent 直接照着写代码 + 跑测试。
>
> 设计依据：
> - `TEST-STRATEGY.md`（分层 + mock 策略 + 三视角规则）
> - `docs/testing/00-test-strategy-overview.md`（双轨制 + Playwright harness）
> - `docs/page-design/v3/fast-fork/spec.md`（FR/AC SSOT）
> - 4 份现有 fast-fork vitest（`fork-entry-behavior` / `composer-fork-mode` / `fork-keymap` / `fork-group`）

---

## 1. 测试基建调研结果

### 1.1 测试框架盘点

| 框架 | 用途 | 入口 | 现状 |
|------|------|------|------|
| **vitest**（renderer） | 单元 + 集成（mount 组件树） | `packages/renderer/vitest.config.ts`（happy-dom + `@vue/test-utils`） | 21 个 fast-fork 用例全绿（隔离测试，mock 依赖） |
| **vitest**（runtime） | runtime 单元 | `packages/runtime/vitest.config.ts` | `session-fork-fields.test.ts` 等 |
| **Playwright**（`@playwright/test` ^1.61.1） | Electron E2E | `playwright.config.ts` + `e2e/fixtures/launch-app.ts` | 7 个 mock 轨 spec（43 用例，41 绿/2 flaky） |
| **node 验证脚本**（`tools/verify-*.cjs`） | runtime/pi 真实协议验证（独立 node 进程） | `verify-merge-rpc-mode.cjs`（spawn pi `--mode rpc`） | merge 功能已用此范式 |

**关键结论**：项目**已有 Playwright**，但 mock 轨 E2E 走构建产物 + mock WS，**测不到 fast-fork 的 runtime 层（session-fork.ts 截断 + JSONL header + 磁盘扫描血缘）**。real 轨 Playwright（`launch-app-real.ts`）依赖完整 runtime + pi + provider 配置，环境敏感、CI 不稳定（`docs/testing/08-real-track-manual.md §0.2` 明确：只有「不依赖 LLM + 依赖真实 runtime + 手工难模拟」三条全满足才值得写自动化）。

### 1.2 现有「集成测试」范式（层 1 的模板）

项目现有两种集成测试范式，fast-fork 层 1 复用它们：

**范式 A：mount 顶层组件，最小 mock（参考 `App-w8.test.ts`）**
```typescript
// mount App.vue，mock 掉 useConnection/useSidebar，stub 掉 AppShell/ToastContainer 重组件
// 验证 watch connectionState → 调 onConnected 的调用契约
vi.mock('@/composables/useConnection', () => ({ useConnection: () => ({ state: connectionState, ... }) }))
import { mount } from '@vue/test-utils'
wrapper = mount(App)
```

**范式 B：mount 功能入口组件，mock useChat/api + stub 子组件（参考 `fork-entry-behavior.test.ts` / `composer-fork-mode.test.ts`）**
```typescript
// mount Turn.vue（不 mock useSidebar，测真实 forkSession 行为）+ stub Block/ChangeSetCard/MarkdownRenderer
// 或 mount Composer.vue + ComposerInputMock（defineExpose + emit input/keydown）+ stub CommandPopover 等
function mountComposer(props) {
  return mount(Composer, { props, global: { stubs: otherStubs } })
}
```

**范式 C：源码断言 + mount 验证（参考 `fork-keymap.test.ts`）**
- 当被测对象是模块级配置数据（如 Sidebar keymap），用 `fs.readFileSync` 断言源码含某条目；同时 mount + `window.dispatchEvent(KeyboardEvent)` 验证派发链路。

### 1.3 runtime 验证脚本范式（层 2 的模板）

参考 `tools/verify-merge-rpc-mode.cjs`：
- **结构**：`locatePiBinary()` → `mkdtempSync` 建临时目录 → `spawn(piBin, args, {stdio:['pipe','pipe','pipe']})` → stdin 写 JSON 命令、stdout 逐行 parse JSON 响应 → stderr 收集 extension 内部标记 → 期望输出逐行 `console.log('[TAG] Rx: ... PASS/FAIL')` → 末尾汇总 `CORE PASS/FAIL` + exit code。
- **调用方式**：`node tools/verify-merge-rpc-mode.cjs`（支持 `PROVIDER` / `MODEL` / `PI_BIN` 环境变量）。
- **fast-fork 适配**：fast-fork 的截断逻辑在 xyz-agent runtime（`session-fork.ts`），不在 pi。所以层 2 脚本**不能只 spawn pi**——必须连 xyz-agent runtime 的 WS server（BASE_PORT=3310 起），发 `session.fork` RPC。详见 §3。

### 1.4 关键 data-testid / 方法清单（从源码核实）

| 元素 | data-testid / 方法 | 文件 |
|------|-------------------|------|
| fork 后台按钮 | `[data-testid="fork-background-btn"]` | Turn.vue:204 |
| fork 提问按钮 | `[data-testid="fork-ask-btn"]` | Turn.vue:214 |
| composer 容器 | `[data-testid="composer-box"]`（fork 模式加 `fork-mode` class） | Composer.vue:25 |
| composer 模式 chip | `[data-testid="composer-mode-chip"]` | Composer.vue:30 |
| ForkNotice 反馈行 | `.fork-notice` + `[data-testid="fork-notice-view"]` | ForkNotice.vue:17,29,37 |
| ForkGroup 折叠头 | `[data-testid="fork-group-header"]` | ForkGroup.vue:23 |
| ForkGroup 分支项 | `[data-testid="fork-group-branch"]`（fresh 时含 `fresh` class） | ForkGroup.vue:43 |
| ForkGroup fresh 锚 | `[data-testid="fork-group-branch-fresh"]` | ForkGroup.vue:80 |
| ForkGroup 未读角标 | `[data-testid="fork-group-branch-unread"]` | ForkGroup.vue:61 |
| ForkGroup 停止按钮 | `[data-testid="fork-group-stop"]` → `[data-testid="fork-group-stop-confirm"]` | ForkGroup.vue:96,107 |
| Composer fork API | `vm.enterForkMode(s,i)` / `vm.exitForkMode()` / `vm.forkMode.value`（defineExpose） | Composer.vue:409-410 |
| fork 编排 | `useSidebar().forkSession / forkSessionAsk / forkFromLastAssistant / enterForkModeFromLastAssistant` | useForkActions.ts:156 |

---

## 2. 层 1 · renderer 集成测试（vitest mount，最小 mock）

> 新文件：`packages/renderer/src/__tests__/panel/fast-fork-e2e-journeys.test.ts`
> 运行：`cd packages/renderer && npx vitest run src/__tests__/panel/fast-fork-e2e-journeys.test.ts`
>
> 与现有 4 个隔离测试的差异：现有测试每个只 mount 单组件 + mock 编排层（`vi.mock('@/composables/features/useSidebar')`）。层 1 的 E2E 旅程**真实链通多组件**——mount Turn + Composer + SessionList 三者，让 fork 按钮 → useForkModeChannel → Composer enterForkMode → forkSessionAsk → sessionStore.appendSession → SessionList 渲染 ForkGroup 这条链路真实跑通。只 mock 最底层：api domain（`session.fork`/`chat.send` RPC）+ useChat（流式依赖）。
>
> 三视角规则（TEST-STRATEGY §3）：每条用例至少 1 个**用户可见 DOM 断言**（`.exists()`/`.text()`/`.classes()`），纯 `toHaveBeenCalled` 不计 DoD。

### 共用 mock / 夹具（所有层 1 用例复用）

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, ref, h, nextTick } from 'vue'
import type { Message, MessageTurn, SessionSummary } from '@xyz-agent/shared'
import { textToSegments } from '@xyz-agent/shared'

// ── mock 最底层 api domain（层 1 只 mock RPC 返回，不 mock 编排）──
const sessionApiMock = {
  fork: vi.fn(),            // 每个用例 mockResolvedValue 一个新 SessionSummary
  remove: vi.fn().mockResolvedValue(undefined),
  switchSession: vi.fn().mockResolvedValue(undefined),
  getCommands: vi.fn().mockResolvedValue({ commands: [] }),
  getContext: vi.fn().mockResolvedValue({}),
}
const chatApiMock = { send: vi.fn(() => Promise.resolve()), abort: vi.fn(() => Promise.resolve()) }
vi.mock('@/api', () => ({
  session: sessionApiMock,
  chat: chatApiMock,
  model: { switchModel: vi.fn() },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
}))

// ── mock useChat（流式依赖，fork 不走它但 setup 调）──
vi.mock('@/composables/features/useChat', () => ({
  useChat: () => ({
    editAndResend: vi.fn(), disposeSession: vi.fn(), setHistoryTruncated: vi.fn(),
  }),
}))
vi.mock('@/composables/features/useSideDrawer', () => ({ useSideDrawer: () => ({ open: vi.fn() }) }))
vi.mock('@/composables/features/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, setPendingModel: vi.fn() }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/stores/settings', () => ({ useSettingsStore: () => ({ defaultModel: '' }) }))

// ── ComposerInput mock（同 composer-fork-mode.test.ts 范式，支持 emit input/keydown + defineExpose）──
const lastInputText = ref('')
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  props: { placeholder: { type: String, default: '' }, disabled: { type: Boolean, default: false } },
  emits: { input: (v: string) => { lastInputText.value = v; return true }, keydown: null, 'slash-trigger': null, 'file-trigger': null },
  setup(_, { expose }) {
    expose({ clear: vi.fn(), setText: vi.fn(), insertSlashChip: vi.fn(),
      getSegments: () => textToSegments(lastInputText.value), getText: () => lastInputText.value, moveCaretVertical: () => 'edge' })
    return () => h('div', { 'data-testid': 'composer-input' })
  },
})

// ── 消息夹具 ──
function makeAssistant(over: Partial<Message> = {}): Message {
  return { id: over.id ?? 'a1', role: 'assistant', content: over.content ?? 'AI 回复',
    status: over.status ?? 'complete', timestamp: over.timestamp ?? Date.now(),
    piEntryId: over.piEntryId ?? 'pi-entry-a1', ...over } as Message
}
function makeTurn(assistants: Message[]): MessageTurn {
  return { index: 1, user: { id: 'u1', role: 'user', content: [{ type: 'text', text: '问' }],
    status: 'complete', timestamp: Date.now() }, assistants, isWorking: false, hasFoldable: false }
}

beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); lastInputText.value = '' })
```

---

### E2E-L1-1 · fork-ask 完整旅程（最高优先级 · 高频路径）

**验证目标**：spec §5 Fork-to-Ask 高频路径全链路——hover assistant → fork 提问按钮 → composer 进 fork 模式 → 输入 → 发送 → forkSessionAsk 被调 + 反馈行 + 退出 fork 模式 + 侧栏新增分支。

**前置条件（mount 什么）**：
- mount **Turn.vue**（真实 useSidebar，不 mock 编排层——这是与 `composer-fork-mode.test.ts` 的关键区别）。
- props：`{ turn: makeTurn([makeAssistant({ id: 'a1', piEntryId: 'pi-a1' })]), sessionId: 's-src' }`。
- 先 `useChatStore().hydrate('s-src', [makeAssistant(...)])` 让 forkSession 能找到消息。
- stub：`Block`/`ChangeSetCard`/`MarkdownRenderer`（避免渲染依赖树）。
- mock `sessionApi.fork` 返回 `{ id: 's-forked', label: 'fork', cwd: '/tmp', parentSession: '/tmp/src.jsonl', forkEntryId: 'pi-a1' }`。

**步骤 + 断言**：

| # | 操作 | 断言（用户可见 DOM + api 调用） |
|---|------|------------------------------|
| 1 | mount Turn | `[data-testid="fork-ask-btn"]` 存在（spec §1「streaming/pending 均可 fork」门控已放开） |
| 2 | `wrapper.find('[data-testid="fork-ask-btn"]').trigger('click')` | 触发 `onForkAsk(assistant)` → 经 `useForkModeChannel.triggerEnterForkMode` 发 signal。**注意**：Turn 本身不含 Composer，此步只验证 signal 发出。完整 composer 联动见变体（下方） |
| 3 | （composer 联动变体）mount Composer + 手动调 `vm.enterForkMode('s-src','a1')` 模拟 signal 到达 | `[data-testid="composer-box"]` classes 含 `fork-mode`；`[data-testid="composer-mode-chip"]` 存在；ComposerInput placeholder prop 含 fork/提问 语义 |
| 4 | `wrapper.findComponent(ComposerInputMock).vm.$emit('input', '追问那条')` | `lastInputText.value === '追问那条'` |
| 5 | `$emit('keydown', new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true,cancelable:true}))` （⌘Enter） | await flushPromises 后：`chatApiMock.send` **未被调**（主线不参与）；`sessionApiMock.fork` 被调 1 次（srcSessionId='s-src'）；`chatApiMock.send` 被调 1 次且第 1 参 = 's-forked'（新 session，非主线） |
| 6 | （反馈行）— 此用例 mount 的是 Composer，ForkNotice 经 `pushForkNoticeAsk` 注入 store。mount 一个独立 ForkNotice 或断言 store | 见下方「反馈行断言」 |
| 7 | composer 自动退出 fork 模式 | `vm.forkMode.value === false`；`[data-testid="composer-box"]` classes **不含** `fork-mode` |

**反馈行断言**（独立子用例，mount ForkNotice.vue）：
```typescript
// forkSessionAsk 成功后 pushForkNoticeAsk(srcSessionId, newId, preview) 写入 effect store。
// mount ForkNotice 并断言：
const wrapper = mount(ForkNotice, { props: { preview: '追问那条', sessionDeleted: false }, global: { plugins: [pinia] } })
expect(wrapper.find('.fork-notice').exists()).toBe(true)                    // 反馈行非 banner
expect(wrapper.text()).toContain('追问那条')                                  // 提问预览
expect(wrapper.find('[data-testid="fork-notice-view"]').attributes('disabled')).toBeFalsy()  // 查看可点
```

**侧栏新增分支断言**（独立子用例，mount SessionList）：
```typescript
// forkSessionAsk 成功 → sessionStore.appendSession(created)。
// mount SessionList，groups 含源 session + 新 fork session（parentSession 指向源）：
const groups = [{ cwd: '/tmp', sessions: [srcSession, forkedBranch] }]
const sl = mount(SessionList, { props: { groups, activeId: 's-src', statusOf: () => 'done' } })
expect(sl.findComponent({ name: 'ForkGroup' }).exists()).toBe(true)          // 渲染分支小列表
expect(sl.find('[data-testid="fork-group-branch"]').text()).toContain('追问那条')  // 标题为提问预览
```

**已知限制**：
- happy-dom 不模拟真实 hover（CSS `:hover`）。fork 按钮用 `opacity-0 group-hover/ai:opacity-100`，但 `data-testid` 始终在 DOM——直接 `find` 即可，不需真 hover。
- Turn 和 Composer 是两个独立组件，无法在单个 mount 里同时验证「点 Turn 的 fork 按钮 → Composer 进 fork 模式」的跨组件 signal（signal 经 `useForkModeChannel` 模块级事件总线）。**变体方案**：mount Turn 触发 click → 断言 channel listener 被调；另 mount Composer 注册 listener → 手动调 enterForkMode。跨组件真实联动留给层 2 / Playwright。

---

### E2E-L1-2 · 纯后台 fork 旅程（⌘G / fork 后台按钮）

**验证目标**：spec §5 纯后台 fork 低频路径——点 fork 后台按钮 → 不 split、不跳转 → 反馈行 + 侧栏 fresh 高亮。

**前置条件**：同 E2E-L1-1 的 Turn mount（真实 useSidebar）+ `hydrate('s-src', [...])` + mock `sessionApi.fork`。

**步骤 + 断言**：

| # | 操作 | 断言 |
|---|------|------|
| 1 | mount Turn，记下 `usePanelStore().split` spy + `useSessionStore().activeId` before | — |
| 2 | `wrapper.find('[data-testid="fork-background-btn"]').trigger('click')` → await flushPromises | `sessionApiMock.fork` 被调 1 次（`includeFrom:true`）；`panelStore.split` **未被调**（spec 反模式：不 split）；`sessionStore.activeId` 未变（不跳转） |
| 3 | 反馈行：runtime 广播 `session.forkNotice` → 前端 ForkNotice（kind=undefined, branchName=label）。mount ForkNotice `{ branchName: '主分支 · 分支 1' }` | `.fork-notice` 存在；文案含「已 fork 到后台」语义（i18n key `panel.forkNotice.forkedPrefix`）；查看链接文案为「查看」（非「查看分支」，P4 区分） |
| 4 | 侧栏 fresh 高亮：mount ForkGroup `{ branches:[branch], freshIds:[branch.id] }` | `[data-testid="fork-group-branch"]` classes 含 `fresh`；`[data-testid="fork-group-branch-fresh"]` 存在 |
| 5 | `vi.advanceTimersByTime(3200)`（FRESH_FADE_MS） | `[data-testid="fork-group-branch"]` classes **不含** `fresh`（淡出） |

**已知限制**：反馈行的 runtime 广播在隔离测试中需手动注入（mock WS 推 `session.forkNotice` 事件）——此用例直接 mount ForkNotice 验证渲染契约，广播链路的端到端验证留层 2。

---

### E2E-L1-3 · ⌘G / ⌘⇧G 快捷键旅程

**验证目标**：spec §8.4 Sidebar keymap 注册 `g`（⌘G → forkFromLastAssistant）+ `g`+shift（⌘⇧G → enterForkModeFromLastAssistant），含 composer focus 守卫。

**前置条件**：mount **Sidebar.vue**（范式 C：stub 重子组件 + mock useSidebar 暴露 fork 方法 spy）。参考现有 `fork-keymap.test.ts`（已绿），层 1 在其基础上补**端到端断言**：⌘G 触发后 forkFromLastAssistant 内部真实调 forkSession（而非只验证 mock 被调）。

**步骤 + 断言**：

| # | 操作 | 断言 |
|---|------|------|
| 1 | mount Sidebar（stub SessionList/FileView/SearchModal 等）+ 真实 useForkActions（focusedSessionId 指向有 assistant 的 session） | — |
| 2 | `window.dispatchEvent(new KeyboardEvent('keydown',{key:'g',metaKey:true,shiftKey:false,bubbles:true,cancelable:true}))` | `sessionApiMock.fork` 被调（⌘G → forkFromLastAssistant → forkSession）；fork 的 fromMessageId = 末条 assistant id |
| 3 | `window.dispatchEvent(new KeyboardEvent('keydown',{key:'g',metaKey:true,shiftKey:true,...}))` | 经 `useForkModeChannel.triggerEnterForkMode` 发 signal（断言：mount Composer 注册 listener 后 `vm.forkMode.value===true`） |
| 4 | composer focus 守卫：插入 `[data-testid="composer-box"]` + `tabindex=0` + `.focus()`，再 dispatch ⌘G | `sessionApiMock.fork` **未被调**（focus 守卫拦截，spec §8.4） |

**已知限制**：现有 `fork-keymap.test.ts` 已用 mock useSidebar 验证了 U15/U16（mock 被调 + 源码断言）。层 1 增量价值在于「真实链通 forkSession」——但这需 mount 完整 Sidebar + 真实 stores，成本高。**建议**：若现有 `fork-keymap.test.ts` 已覆盖 ⌘G→forkFromLastAssistant 调用契约，层 1 只补「⌘G 后 sessionApi.fork 真实被调」一条真实链路用例即可，避免重复。

---

### E2E-L1-4 · Esc 退出 + 切 session 退出

**验证目标**：spec §8.4 composer fork 模式 Esc 退出 + 切 session 自动 exitForkMode。

**前置条件**：mount Composer（同 E2E-L1-1 的 Composer mount + ComposerInputMock）。

**步骤 + 断言**：

| # | 操作 | 断言 |
|---|------|------|
| 1 | `vm.enterForkMode('s1','m1')` | `vm.forkMode.value===true`；`composer-box` 含 `fork-mode` class；`composer-mode-chip` 存在（用户可见三重视觉） |
| 2 | `$emit('input','打了一半')` | `lastInputText.value==='打了一半'` |
| 3 | `$emit('keydown', new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))` | `vm.forkMode.value===false`；`composer-box` **不含** `fork-mode`；`composer-mode-chip` 不存在；输入清空（`lastInputText.value===''`，spec §4「清空输入」） |
| 4 | （切 session 子用例）重新 enterForkMode → `wrapper.setProps({ sessionId: 's2' })` | `vm.forkMode.value===false`（切 session 自动退出，spec §8.4） |

**已知限制**：现有 `composer-fork-mode.test.ts` U14 已覆盖此旅程（已绿）。**层 1 增量价值低**——除非要验证 Esc 清空输入的额外断言，否则可标注「已由 U14 覆盖，层 1 不重复」。

---

### E2E-L1-5 · 后台分支停止（两段式确认 → abort）

**验证目标**：spec §8.5 ForkGroup 分支项 hover 出停止 action → 两段式确认 → emit stop → 调 abort。

**前置条件**：mount **ForkGroup.vue**，`branches: [makeSession({id:'b-running',status:'active'})]`。

**步骤 + 断言**：

| # | 操作 | 断言 |
|---|------|------|
| 1 | mount ForkGroup（running 分支） | `[data-testid="fork-group-stop"]` 存在（仅 running 显示） |
| 2 | `wrapper.find('[data-testid="fork-group-stop"]').trigger('click')` | `wrapper.emitted('stop')` 为 falsy（首次不 emit，进确认态）；`[data-testid="fork-group-stop-confirm"]` 存在 |
| 3 | `wrapper.find('[data-testid="fork-group-stop-confirm"]').trigger('click')` | `wrapper.emitted('stop')` truthy；`emitted('stop')[0]===['b-running']` |
| 4 | （上层联动）SessionList 监听 `@stop` → 调 `chat.abort(sessionId)`。mount SessionList + 触发 ForkGroup 的 stop emit | `chatApiMock.abort` 被调，参 = 'b-running' |

**已知限制**：现有 `fork-group.test.ts` U19 已覆盖两段式确认（已绿）。层 1 增量：补「SessionList @stop → chat.abort」上层联动（U19 只测 ForkGroup emit，未测 SessionList 消费）。

---

### E2E-L1-6 · 血缘可见（ForkGroup 渲染 + SessionItem 血缘）

**验证目标**：spec §8.5 当前 session 有子分支时渲染 ForkGroup；分支 session 自身显示「fork 自父名」。

**前置条件**：mount **SessionList.vue**（groups 含父 + 子分支）+ mount **SessionItem.vue**（分支 session）。

**步骤 + 断言**：

| # | 操作 | 断言 |
|---|------|------|
| 1 | mount SessionList，groups=[{cwd, sessions:[parent, branch(parentSession=parent.sessionFile)]}]，activeId=parent | `findComponent({name:'ForkGroup'})` 存在；`[data-testid="fork-group-branch"]` 文本含 branch.label |
| 2 | mount SessionList，groups=[{cwd, sessions:[plainSession]}]（无分支） | `findComponent({name:'ForkGroup'})` **不存在**（spec §4「无分支不渲染空容器」） |
| 3 | mount SessionItem，session=branch（parentSession + parentLabel） | `wrapper.text()` 含「fork 自」；含父名（spec §8.5 血缘元信息） |
| 4 | mount SessionItem，session=plain（无 parentSession） | `wrapper.text()` 不含「fork 自」 |

**已知限制**：现有 `fork-group.test.ts` U17/U18 已覆盖（已绿）。层 1 增量价值低。**建议标注「已覆盖」**。

---

### 层 1 汇总：新增 vs 已覆盖

| 用例 | 现有覆盖 | 层 1 增量 | 优先级 |
|------|---------|-----------|--------|
| E2E-L1-1 fork-ask 完整旅程 | 部分隔离（composer-fork-mode U13 只测 Composer 单组件） | **真实链通 Turn→channel→Composer→forkSessionAsk→SessionList** | **P0** |
| E2E-L1-2 纯后台 fork | fork-entry-behavior U8（真实 forkSession 不 split） | 反馈行 + fresh 高亮端到端 | P1 |
| E2E-L1-3 ⌘G/⌘⇧G | fork-keymap U15/U16（已绿） | 真实链通 forkSession | P2（可选） |
| E2E-L1-4 Esc 退出 | composer-fork-mode U14（已绿） | 输入清空断言 | P3（可省） |
| E2E-L1-5 停止分支 | fork-group U19（两段式） | SessionList @stop→abort 联动 | P1 |
| E2E-L1-6 血缘可见 | fork-group U17/U18（已绿） | — | 已覆盖 |

**结论**：层 1 真正需要新写的核心用例是 **E2E-L1-1**（fork-ask 跨组件链路）。其余要么已覆盖，要么补小增量联动断言。

---

## 3. 层 2 · runtime 验证脚本（真实 runtime + pi）

> 新文件：`tools/verify-fork-e2e.cjs`
> 运行：`node tools/verify-fork-e2e.cjs`（需前置：runtime 在 3310 端口运行，见 §4）
>
> **为什么不用纯 pi `--mode rpc`**：fast-fork 的截断逻辑（`session-fork.ts` 的 `createForkedSessionFile`）在 xyz-agent runtime 层，不在 pi。纯 pi 脚本验证不到 JSONL header 写 `parentSession`/`forkEntryId`、磁盘扫描回传血缘这些 runtime 行为。**正确做法**：连 xyz-agent runtime 的 WS server，发 `session.fork` RPC，验证 runtime 层的真实行为。

### 3.1 脚本设计（参照 verify-merge-rpc-mode.cjs 结构）

```javascript
#!/usr/bin/env node
/**
 * verify-fork-e2e.cjs — fast-fork runtime 层 E2E 验证。
 *
 * 验证目标（spec §8.1 基础层 + §12 验收 checklist）：
 *   F1. session.fork RPC 返回的 SessionSummary 含 parentSession + forkEntryId
 *   F2. fork 出的 session JSONL header 含 parentSession + forkEntryId（读磁盘文件验证）
 *   F3. 磁盘扫描（config.sessions RPC）回传的 fork session Summary 含 parentSession
 *   F4. forkNotice 广播（subscribe WS push，验证收到 session.forkNotice 事件）
 *
 * 前置：xyz-agent runtime 运行中（pnpm dev 或独立 runtime 进程），WS 监听 3310。
 *       数据目录需有 provider 配置（~/.xyz-agent-dev/pi/agent/models.json）。
 *       但本脚本不调 LLM——只 fork（createForkedSessionFile 不调 LLM），符合
 *       docs/testing/08-real-track-manual.md §0.2「不依赖 LLM」自动化判定标准。
 *
 * 用法：
 *   node tools/verify-fork-e2e.cjs                 # 连默认 3310 端口
 *   node tools/verify-fork-e2e.cjs --port 3320     # 指定端口
 *   node tools/verify-fork-e2e.cjs --print         # 只打印将发送的 RPC，不实际连
 */
'use strict'
const { WebSocket } = require('ws')        // runtime 依赖 ws，root node_modules 有
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const TAG = '[FORK-E2E]'
let port = 3310, printOnly = false
for (const a of process.argv.slice(2)) {
  if (a === '--print') printOnly = true
  if (a.startsWith('--port=')) port = Number(a.slice(7))
}
```

### 3.2 RPC 编排（核心验证步骤）

脚本启动后顺序执行：

| 步骤 | RPC / 操作 | 期望输出 | 验证点 |
|------|-----------|---------|--------|
| **S0 连接** | `new WebSocket('ws://127.0.0.1:<port>')` | open 事件 | runtime 可达 |
| **S1 ping** | 发 `{type:'ping',id:'r1'}` | 收 `{type:'pong',id:'r1'}` | WS 通道通 |
| **S2 创建源 session** | 发 `{type:'session.create',id:'r2',payload:{cwd:tmpDir,label:'fork-src'}}` | 收 `session.created`，记下 `srcSessionId` + `srcSessionFile` | 源 session 就绪 |
| **S3 写入一条 assistant 消息** | **[需手工] 见 §5**——真实 assistant 消息需 LLM 生成或手工写 JSONL。**替代方案**：脚本用 `message.send` 发一条 user 消息触发 pi（需 LLM）；或直接手工预置一个含 message entry 的源 JSONL 再 fork。**推荐**：脚本前置用 node 直接在 `<dataDir>/pi/sessions/` 写一个含 `{type:'session'}` header + `{type:'message',id:'msg-1',parentId:<header>}` 的 JSONL，记下 `msg-1` 作 forkEntryId | — | fork 点就绪 |
| **S4 发 fork RPC** | 发 `{type:'session.fork',id:'r3',payload:{srcSessionId, fromPiEntryId:'msg-1', includeFrom:true, label:'fork-branch'}}` | 收 `session.created`，session = `{id, parentSession, forkEntryId:'msg-1', ...}` | **F1**：`session.parentSession` 有值（源 sessionFile 或源 sessionId fallback）；`session.forkEntryId==='msg-1'` |
| **S5 读 fork JSONL header** | `fs.readFileSync(forkSessionFile)`，parseJsonl 取首行 `{type:'session'}` | header.parentSession 有值；header.forkEntryId==='msg-1' | **F2**：磁盘 JSONL header 含两字段 |
| **S6 磁盘扫描** | 发 `{type:'config.sessions',id:'r4'}` | 收 `config.sessions`，groups 里找到 fork session | **F3**：扫描回传的 fork session Summary.parentSession 有值（验证磁盘扫描链路 `parseSessionHeader`/`scannedToSummary` 回传血缘，spec §8.1 HISTORICAL） |
| **S7 forkNotice 广播** | S4 发 fork 后，WS 收到的 push 里应有 `{type:'session.forkNotice',payload:{srcSessionId,newSessionId,branchName}}` | push 事件存在 | **F4**：广播链路通（session-message-handler.ts:62） |

### 3.3 关键实现细节

**消息收发器**（参照 verify-merge-rpc-mode.cjs 的 pending Map 模式）：
```javascript
let rpcId = 0
const pending = new Map()       // id → resolve
const pushes = []               // 收集所有非 reply 的 push 事件
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  else pushes.push(msg)         // 广播事件
})
function rpc(type, payload) {
  const id = 'r' + (++rpcId)
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ type, id, payload }))
  })
}
```

**S3 预置源 JSONL（绕过 LLM）**——关键技巧：
```javascript
// pi sessions 目录：<dataDir>/pi/sessions/
// 但 session.create 创建的 session 文件路径由 runtime 管理，脚本难以直接写。
// 推荐方案：S2 用 session.create 建源 session → S3 用 session.getFullHistory 读出真实 entryId
//   （但空 session 无 message entry）。
// 最稳妥：S3 用 message.send 发一条触发 pi（需 provider 配置），等 message_end，
//   再 session.getFullHistory 取末条 assistant 的 piEntryId 作 fork 点。
// 若要完全无 LLM：改用 runtime 的 session.restore 加载一个预置 JSONL 文件（若 runtime 支持）。
```
> ⚠️ S3 是本脚本最大的环境依赖点。详见 §5「无法自动化部分」。

**退出码**：全部 PASS → `exit 0`；任一 FAIL → `exit 1`（供 CI / 手工判断）。

---

## 4. 执行顺序 + 依赖

```
┌─────────────────────────────────────────────────────────────┐
│ 阶段 0：环境前置（人工，一次性）                              │
│  - 确认 pi 二进制：apps/electron/resources/pi/pi-darwin-arm64 │
│  - 确认 provider 配置：~/.xyz-agent-dev/pi/agent/models.json  │
│  - pnpm install（root）                                       │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 阶段 1：层 1 renderer 集成测试（无外部依赖，最先跑）          │
│  cd packages/renderer && npx vitest run                      │
│    src/__tests__/panel/fast-fork-e2e-journeys.test.ts        │
│  依赖：无（happy-dom + vitest，mock api domain）              │
│  覆盖：E2E-L1-1 ~ L1-6                                        │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 阶段 2：runtime 单元（已存在，回归）                          │
│  cd packages/runtime && npx vitest run                       │
│    src/__tests__/session-fork-fields.test.ts                 │
│  依赖：无（纯函数 + tmpdir）                                   │
│  覆盖：U1-U6 fork 字段透传（createForkedSessionFile 单元）    │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 阶段 3：层 2 runtime 验证脚本（需 runtime 运行）              │
│  3a. 启动 runtime：pnpm dev &（等 ~/.xyz-agent-dev/runtime.port）│
│      或独立：XYZ_AGENT_DATA_DIR=~/.xyz-agent-dev node …runtime │
│  3b. node tools/verify-fork-e2e.cjs                          │
│  依赖：runtime WS server（3310）+ provider 配置（S3 需 LLM 或  │
│        预置 JSONL）                                           │
│  覆盖：F1-F4 runtime 层 fork 真实行为                         │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 阶段 4：[需手工] dev app 冒烟（非 MOCK 轨）                   │
│  pnpm dev → 手工走 spec §12 验收 checklist                    │
│  依赖：完整 runtime + pi + provider + LLM                     │
│  覆盖：streaming 中 fork、视觉三重强化、fresh 动效等           │
└─────────────────────────────────────────────────────────────┘
```

**为什么层 2 在层 1 之后**：层 1 是纯 renderer（快、无外部依赖），先跑能快速发现组件链路问题。层 2 需 runtime 环境，慢且环境敏感，放后面。但**逻辑上层 2 验证的 fork RPC 契约（F1: 返回 parentSession）是层 1 mock 的依据**——如果层 2 发现 runtime 不回传 parentSession，层 1 的 mock 数据就是错的。所以写代码时：先确认层 2 的 F1 契约（可读 runtime 源码 `session-service.ts:715` 确认 toSummary 回传），再写层 1 mock。

---

## 5. 无法自动化的部分（标注 [需手工]）

| 项 | 原因 | 手工验证方式 |
|----|------|-------------|
| **streaming 中 fork 的 JSONL 读取竞态**（spec §10.5） | 需源 session 正在流式（LLM 生成中）时 fork，验证 fork 出的 session 是否静默丢失末尾 entry。竞态时序难自动化触发 | dev app 中发一条长回复，流式中按 ⌘G，检查 fork session 末条是否完整 |
| **composer fork 模式视觉三重强化**（accent 边 + 3px ring glow + 5% 底） | happy-dom 不渲染 CSS；vitest 只能断言 class 名 `fork-mode`，无法验证视觉效果（glow/混底） | dev app 点 fork 提问按钮，肉眼确认三重视觉 |
| **fresh 高亮 3.2s 淡出动效** | `@keyframes fresh-fade` 动画 happy-dom 不跑；vitest 用 fake timer 只能断言 class 移除，不能验证渐变过渡 | dev app fork 后观察侧栏分支项高亮渐变 |
| **真实 LLM streaming 中 fork** | 需 provider 配置 + 真实 LLM 调用，结果不可预测，CI 不稳定（`08-real-track-manual §0.2`） | dev app 走 RT-01 类流程 |
| **层 2 S3：无 LLM 预置 fork 点** | `session.create` 建空 session 无 message entry；`message.send` 需 LLM 才生成 assistant entry | 方案 a：脚本用 `message.send` 发 user + 等 LLM reply（需 provider）；方案 b：手工预置 JSONL 到 sessions 目录（需知 runtime 文件命名规则）；方案 c：调 runtime 内部 restore API 加载预置文件（若存在） |
| **fork-notice transient 不持久化**（spec §8.3） | 需 fork → 关 session → 重开，验证反馈行不重新出现。涉及完整 app 生命周期 | dev app fork 后关 session 重开，确认无历史 fork-notice |
| **多 fork-notice 并存路由**（spec §4 后台分支完成追加通知） | 需多个后台分支 + 各自状态变化（done/error），状态变化经 WS 广播到对应反馈行。多分支状态时序难自动化 | dev app 开 3 个后台分支，等各自完成，观察反馈行追加 |
| **fork 失败反馈行 danger 色**（spec §4） | 需制造 JSONL 读取错误 / RPC 失败。难稳定触发 | 临时改坏源 JSONL 文件后 fork，观察 danger 反馈行 |
| **ForkGroup 折叠/展开交互** | happy-dom 不模拟真实点击折叠动画；折叠态 `v-show` 可测但视觉过渡不可测 | dev app 点 fork-group-header 观察折叠 |
| **跨窗口 WS 广播 forkNotice** | 需两个 app 实例连同一 runtime，一个 fork 另一个收到广播。多进程编排复杂 | 开两个 dev app 窗口，一个 fork 观察另一个 |

---

## 6. 给下一个 subagent 的执行 checklist

写代码时按此顺序：

- [ ] **先读契约**：`packages/runtime/src/services/session/session-service.ts:715`（toSummary 回传 parentSession/forkEntryId）+ `session-message-handler.ts:50`（fork RPC reply session.created）——确认层 1 mock 数据 shape。
- [ ] **写层 1**：新建 `packages/renderer/src/__tests__/panel/fast-fork-e2e-journeys.test.ts`，实现 E2E-L1-1（P0）。复用 `fork-entry-behavior.test.ts` 的 makeAssistant/makeTurn/mountTurn 夹具 + `composer-fork-mode.test.ts` 的 ComposerInputMock。核心新增：mount Turn 点 fork-ask → 验证 channel signal → mount Composer enterForkMode → 发送 → 断言 `sessionApiMock.fork` + `chatApiMock.send`（新 sessionId）。
- [ ] **补层 1 小增量**：E2E-L1-2 反馈行+fresh、E2E-L1-5 SessionList@stop→abort 联动。E2E-L1-3/4/6 标注「已由现有测试覆盖，不重复」。
- [ ] **跑层 1**：`cd packages/renderer && npx vitest run src/__tests__/panel/fast-fork-e2e-journeys.test.ts`，全绿。
- [ ] **写层 2**：新建 `tools/verify-fork-e2e.cjs`，参照 verify-merge-rpc-mode.cjs 结构 + §3.2 RPC 编排。S3 优先尝试 `message.send` + 等 message_end 方案（需 provider）。
- [ ] **跑层 2**：先 `pnpm dev &` 等 runtime.port，再 `node tools/verify-fork-e2e.cjs`。若 S3 环境不具备，脚本应优雅 skip S4-S7 并打印 `[FORK-E2E] SKIP: no provider / no source message entry`。
- [ ] **手工冒烟**：`pnpm dev`，按 spec §12 验收 checklist 逐项过（重点：streaming fork、视觉三重、fresh 动效、transient 不持久化）。

---

## 附：风险与回退

- **层 1 跨组件 signal 难题**：Turn 点 fork-ask → Composer enterForkMode 经 `useForkModeChannel` 模块级事件总线。单测里 Turn 和 Composer 是两个 mount 实例，signal 可能跨不到。**回退**：若跨组件验证成本过高，退化为「Turn 断言 channel.trigger 被调」+「Composer 断言收到 channel signal 后 enterForkMode」两条独立用例（即接近现有隔离测试），但明确标注「跨组件真实联动留层 2/Playwright」。
- **层 2 S3 卡住**：若无法稳定预置 fork 点，层 2 降级为只验证 F1（fork RPC 返回字段）——用 `message.send` 发一条简单 user 消息（即便 pi 回错或空），fork 点 fallback 到「最后一条 message entry」（session-service.ts:325），仍能验证 fork RPC 链路。F2/F3/F4 视环境决定是否跑。
- **Playwright real E2E 不写**：遵循 `08-real-track-manual §0.2`——fast-fork 的 real 场景多数依赖 LLM（streaming fork、分支完成通知），不满足「不依赖 LLM」自动化判定。走本文档 §5 手工清单，不扩展 `e2e/*-real.spec.ts`。
