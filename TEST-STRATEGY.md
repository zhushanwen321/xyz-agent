# 测试策略（TEST-STRATEGY）

> 测试体系 SSOT。CLAUDE.md「测试规范」章节是规则载体，本文件补充分层策略 + 回归基线 + mock 策略 + 运行手册。两者互补不冲突。
>
> **各功能具体测试步骤**（MOCK/非MOCK/Playwright 调用链 + 每步期望输入输出）见 [docs/testing/](docs/testing/) 测试手册：
> - [00-test-strategy-overview.md](docs/testing/00-test-strategy-overview.md) — 双轨制 + Playwright harness + 公共前置（入口篇，必读）
> - [01-new-task.md](docs/testing/01-new-task.md) — 新建任务（Landing + 选目录 + 首发提交）
> - [02-composer.md](docs/testing/02-composer.md) — Composer（输入框 + slash 命令浮层 + 三态）
> - [03-chat-flow.md](docs/testing/03-chat-flow.md) — 对话流（流式消息 + 工具调用 + 变更集）
> - [04-file-tree.md](docs/testing/04-file-tree.md) — 文件树（懒加载 + 过滤 + git 角标，11 E2E 用例已落地）
> - [05-side-drawer.md](docs/testing/05-side-drawer.md) — SideDrawer（文件预览 / diff / git tab）
> - [06-search-modal.md](docs/testing/06-search-modal.md) — 搜索浮层（⌘K 四类搜索 + recents + 跳转，7 E2E 用例已落地）

## 1. 测试框架 [HISTORICAL]

- **vitest，禁止 `node:test`**：runtime/renderer 子项目用 vitest。所有测试从 `vitest` 导入 describe/it/expect/vi/beforeEach，禁止从 `node:test` 导入。vitest 不识别 node:test 格式，会导致 "No test suite found"
- **不要用 `tsx --test`**：它能跑但不支持 vi mock（`vi.fn()`/`vi.useFakeTimers()`）和 vitest.config.ts。项目 CI/dev 流程都用 vitest
- **测试超时**：单测默认 5s。涉及 setTimeout/timer 的测试用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()`，禁止真实等待
- **subagent task prompt 必须写明测试框架**：「测试框架使用 vitest（从 vitest 导入 describe/it/expect/vi），运行命令 npx vitest run，禁止 node:test 和 tsx --test」

## 2. 测试分层

| 层 | 环境 | 目的 | 运行命令 |
|----|------|------|---------|
| 单元测试 | renderer（happy-dom）/ runtime | 纯逻辑、纯函数、单模块、状态机 | 见下 |
| 集成测试 | renderer（mount 组件树，`@vue/test-utils`） | 组件协作、store 联动、WS 事件流 | 见下 |
| E2E（mock 轨）| Playwright `_electron` + VITE_MOCK | 全链路用户旅程（renderer 渲染 + 交互逻辑），OS 原生 dialog 标 `[需手工]` | `npx playwright test` |
| **dev 冒烟**（闸门）| chromium + vite dev server | 模块加载健康（拦 node:path externalize 类 bug，mock 轨盲区）| `node scripts/dev-smoke.mjs`（待建） |

> **[HISTORICAL] E2E 从手动升级为 Playwright**：原「E2E 手动，无 playwright/cypress」（2026-06-28 sidebar-project-file-tree W0 引入 Playwright 覆盖）。mock 轨验证渲染/交互，但**验证不了模块加载期副作用**——`node:path` 类错误在 vite build 期被 externalize 成惰性代理，mock 模式不触发 getter，E2E 全绿却 dev 崩溃（2026-06-30 事故）。**必须配套 dev 冒烟闸门**。详见 `.xyz-harness/2026-06-30-e2e-retrospect/`。`[from: 2026-06-28-sidebar-project-file-tree §2/W8]`

### 运行命令（cwd 敏感）

> ⚠️ `@` alias 只在 `renderer/vitest.config.ts` 配置，**必须从 renderer 目录运行**。bash 工具 cwd 不跨调用持久，每条命令固定以 `cd packages/renderer &&` 开头。

```bash
# renderer 全量
cd packages/renderer && npx vitest run

# renderer 单文件
cd packages/renderer && npx vitest run src/__tests__/panel/composer-slash-trigger.test.ts

# runtime（有独立 vitest.config.ts）
cd packages/runtime && npx vitest run

# typecheck（vue-tsc 在 apps/electron/node_modules）
pnpm --filter @xyz-agent/frontend run typecheck
cd packages/runtime && npx tsc --noEmit
```

## 3. 三视角模型 + 渲染 gate DoD [HISTORICAL — 2026-06-27「新建任务」事故]

> **事故**：「新建任务」77 单测 + 24 集成全绿、tsc EXIT 0、verdict pass，用户手动打开却发现 Landing 态根本没有 composer 输入区——阻塞级 bug。根因：测试只做了构建者（白盒）视角，缺使用者/观察者两个视角。

| 视角 | 内涵 | 防护 |
|------|------|------|
| 构建者（白盒） | 状态机/API 契约/内部状态断言 | 已有 |
| **使用者（黑盒）** | 用户能否完成目标（DOM 可见断言） | **[MANDATORY] 补齐** |
| **观察者（形态）** | 渲染长什么样（首屏冒烟） | **[MANDATORY] 补齐** |

**四条 MANDATORY 规则**（详见 CLAUDE.md 测试规范#5-#8）：

1. 每条集成/E2E 用例至少一个用户可见断言（`wrapper.find().exists()`/`.text()`/`.html()`）。纯内部断言（`state.value`、`toHaveBeenCalled`）不计 DoD
2. 集成/E2E 必须mount test-strategy 指定的组件树入口（如 `Panel`），禁止悄悄换更小被测对象。入口无法 mount 时显式说明并降级入口
3. E2E 用户旅程步骤不可降级，每步必须有 DOM 断言。无法自动化的步标 `[需手工]` + 占位断言，**不得删除步骤**
4. **渲染 gate DoD**：mount 功能顶层容器，断言 spec 结构章节列出的每个「结构元素」对应 DOM 节点存在。**spec 结构条目 = 渲染断言清单**

**首屏冒烟模板**（每功能必含 1 条）：

```typescript
it('首屏渲染：Landing 态 DOM 含 composer 输入区 + chip 行', () => {
  const wrapper = mount(Panel, { props: { sessionId: null } })
  expect(wrapper.find('[data-testid="composer-input"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="chip-directory"]').exists()).toBe(true)
})
```

> 三视角缺一不可。任一缺失即重蹈「测试全绿但功能不可用」。

## 4. 回归基线用例（破坏即事故）

| 基线 | 描述 | 来源事故 | 守护测试 |
|------|------|---------|---------|
| **slash 命令契约** | 输入 `/` → 浮层弹出 → 选中 → chip 插入；session.commands 时序竞争修复 | `2026-06-28-lite-slash-command-fix`（broadcast 早于订阅丢失） | `src/__tests__/useSidebar-get-commands.test.ts`（U1-U3）+ `landing-precreate-session.test.ts`（U4/U5）+ `composer-slash-trigger.test.ts`（U1-U10） |
| **Session 隔离** | 三层隔离（store 分区/useChat 路由/PaneSessionView 过滤）+ 无 sessionId 消息丢弃 + sendError 带 sessionId | CLAUDE.md 规则#7 | 各 domain/store 单测 |
| **渲染 gate** | mount 顶层容器断言结构元素 DOM 存在（防「测试全绿功能不可用」） | 2026-06-27 事故 | 每功能首屏冒烟用例 |
| **错误状态重置** | 错误路径必须重置 isGenerating + streamingMessage（否则 UI 卡死） | CLAUDE.md 规则#3 | useChat 错误路径测试 |
| **emit 单 payload** | emit 不传多参数 | CLAUDE.md 规则#1 | - |
| **runtime broadcast 时序** | session 级 broadcast 早于 renderer 订阅会丢消息；切换/创建 session 后需立即消费的状态必须主动拉取（`session.getCommands` RPC） | `2026-06-28-lite-slash-command-fix` | U1-U3 + U4/U5（见上） |
| **搜索查询乱序守卫** | useSearch.query 内 loadSeq 自增序列号，await 后 `seq !== loadSeq` 丢弃旧响应；快速连续查询时旧响应晚到不得覆盖新结果（数据错乱=事故） | NFR S-8 `[from: 2026-06-30-search-modal §execution T1.12]` | `src/__tests__/composables/useSearch.test.ts` T1.12（BC-9 乱序 loadSeq 守卫）+ T3.10（file 分级匹配复用）|
| **搜索 slash 命令注入链路** | SearchModal 点击 slash 命令 → commandStore.pendingSlash 一次性通道 → Composer watch 消费 → insertSlashChip 注入 chip。watch 非 immediate（防残留误注入）+ sessionId 过滤（split 不串台）+ 先注入后清除（防读到 null）。commandKind 区分 slash/app（pi 命令名无 / 前缀，不可靠 title 猜测） | `2026-07-01-search-slash-injection`（injectSlash 回调断链 + commandKind 误判） `[from: 2026-07-01-search-slash-injection §plan]` | `src/__tests__/panel/composer-slash-injection.test.ts`（U12-U16,U18）+ `src/__tests__/composables/useSearchJump.test.ts`（U7-U11 commandKind 分发）+ `src/__tests__/stores/command-store.test.ts`（U1-U4 pendingSlash 通道）|
| **切模型后思考等级自动重置** | A 模型(high-max, level=xhigh) 切到 B 模型(on-off: off/high)，xhigh 不在 on-off 可用档 → 自动重置为 high。landing 态(localThinkingLevel=undefined) 切模型 → immediate watch 设最高可用档。on-off 模式 popover 显示「关」「开」而非「关」「高」。破坏=用户看到错误的思考等级/不可用档位被选中 | NFR S-9/S-10/S-11；`[from: 2026-07-02-thinking-level-and-model-select §execution]` | `src/__tests__/composables/use-thinking-level-sync.test.ts`（4 用例：A→B 重置/high 可用不重置/landing 设最高/all-levels 不重置）+ `src/__tests__/panel/thinking-levels.test.ts`（19 用例：resolveAvailableLevels key-based）|
| **store 必须走 @/api 门面（mock 数据流不断裂）** | 所有 renderer store 访问外部域必须 `import { xxx } from '@/api'`（门面），禁止直接 `import from '@/api/domains/xxx'`。绕门面→ mock 模式下走 real domain transport，而 mock-ws 只处理 ping→pong 不回业务 reply → Promise 永挂 → records 恒空。破坏=E2E mock 轨数据全空，UI 测试假绿（空态本就期望空）。对比：useSidebar 走门面所以 mock 生效 | `2026-07-03-recent-workspaces`（workspaceStore 绕门面致 mockApi.workspace 死代码）`[from: 2026-07-03-recent-workspaces §execution]` | `e2e/workspace.spec.ts` T4.1（records 非 0 断言）+ `workspace-store.test.ts` vi.mock('@/api') |
| **real E2E fixture（real runtime + pi spawn，create session 无 LLM 依赖）** | real 模式 E2E 不设 XYZ_MOCK（启动 runtime）+ real renderer bundle（VITE_MOCK=false build）。create session（session-lifecycle.create）的 record 是 create 同步收尾，**不调用 LLM**（LLM 调用在 sendPrompt）。real E2E 需预设 pi provider 配置（$dataDir/pi/agent/models.json + settings.json），dialog 走 WS 直连触发等效业务动作。mock/real E2E 分批 build（VITE_MOCK 构建期 define，bundle 输出冲突） | `2026-07-03-recent-workspaces`（T4.6 跨进程持久化 real E2E）`[from: 2026-07-03-recent-workspaces §execution T4.6]` | `e2e/workspace-real.spec.ts` + `e2e/fixtures/launch-app-real.ts` |

## 5. mock 策略

- **唯一合法入口：`api/mock/` 层**（镜像 `api/domains/` 接口签名，模拟 runtime WS 返回）。通过 `api/index.ts` 的 `VITE_MOCK` 切换。验证：`docs/standards.md §8.1`
- **禁止**：组件内联硬编码 mock（`const MOCK=[...]`）、panel/composables/lib 静态 fixture、组件直接 import `api/mock/`
- **测试 mock**：`vi.mock` api domain；复用 `api/mock/` 的 events/fixtures（如 `run-send-stream.ts` 模拟流式 ServerMessage 序列、`mock-ws.ts` 模拟 WS 生命周期）
- **例外**：UI 固定枚举常量（如 thinking-levels 6 级）、`__tests__/` 测试 mock 不算违规
- **外部系统对接验证脚本**：`tools/verify-*.cjs`（如 verify-pi-rpc.cjs），先验证字段名/格式再编码

### vi.mock 注意事项

- **factory 不能引用外部变量**（hoisted）：用 `vi.hoisted()` 或在 factory 内 inline + `import { session as sessionMock } from '@/api'`
- **mock 整个 api 模块时记得 mock 所有被测路径用到的方法**（漏 mock 会 undefined 崩溃）
- **happy-dom 对 contenteditable/Selection/Range 支持有限**：测 contenteditable 组件用 textContent + querySelector + dispatch input event，不要依赖真实光标操作

## 6. pre-commit hook

提交前自动跑（`.githooks/`）：
1. **前端 ESLint 检查**（含 taste 规则：no-magic-spacing / no-silent-catch 等）
2. **vue-tsc 类型检查**
3. **代码规范检查**

taste/no-silent-catch 处理：纯 console.warn 仍报（要求传播/重抛）。项目惯例用 `// eslint-disable-next-line taste/no-silent-catch -- <理由>`（参考 runtime `fetchAndBroadcastCommands`、useSidebar/useNewTaskFlow 的 getCommands catch）。**改 catch 前先 `grep -rn "no-silent-catch"` 看现有写法**。

## 7. 覆盖率

- 目标 ≥60%（增量核心逻辑应 100%）
- 全文件覆盖率可能偏低（含大量未测试的 pre-existing 代码），**以增量覆盖率为准**
- 运行：`cd packages/renderer && npx vitest run --coverage`

## 8. Extension Upgrade 回归基线 [from: extension-upgrade]

> 沉淀来源：extension-upgrade topic（2026-07-09 closeout）

### 关键时序约束

- **autoUpgradeOnStartup 必须在 `ensurePublicSession()` 之前执行**（`packages/runtime/src/index.ts`）：确保公共 session 及后续所有 session 加载到已升级的扩展版本。失败不阻塞启动（整体 try-catch + 每扩展独立 try-catch）。

### 错误码语义（不可混用）

| 场景 | code | 说明 |
|------|------|------|
| built-in 扩展调 upgrade | `not_user_installed` | 操作不被允许（非 user-installed） |
| 包不存在（不在 packages[]） | `not_installed` | settings.json 未注册 |
| npm install 后非有效 pi extension | `not_extension` | 安装成功但包结构无效，会触发 uninstallNpm 回滚 |
| npm install 网络失败 | `network` | extract/integrity 归类为 network |

### 回归基线用例

- `upgradeExtension` built-in → 拒绝（code=not_user_installed）
- `upgradeExtension` 不存在 → 拒绝（code=not_installed）
- `upgradeExtension` installNpm 后无效 → 回滚 + not_extension
- `uninstallExtension` → 必须调用 removeAutoUpgrade（与 removeDisabled 对称）
- `checkAndAutoUpgrade` → version='' 时 semver.valid=null 守卫，不调 semver.lt


## session-active-state-completion [from: session-active-state-completion]

E1-E4 三视角集成测试基线（`session-active-state.test.ts`）：
- 构建者：store.addPendingSend/setCompacting → isActive/isCompacting → deriveStatus 断言
- 使用者：mount SessionItem/Panel 断言 DOM（composer/landing testid）
- 观察者：dot class 含 animate-pulse-accent
