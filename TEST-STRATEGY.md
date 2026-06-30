# 测试策略（TEST-STRATEGY）

> 测试体系 SSOT。CLAUDE.md「测试规范」章节是规则载体，本文件补充分层策略 + 回归基线 + mock 策略 + 运行手册。两者互补不冲突。

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

> ⚠️ `@` alias 只在 `renderer/vitest.config.ts` 配置，**必须从 renderer 目录运行**。bash 工具 cwd 不跨调用持久，每条命令固定以 `cd src-electron/renderer &&` 开头。

```bash
# renderer 全量
cd src-electron/renderer && npx vitest run

# renderer 单文件
cd src-electron/renderer && npx vitest run src/__tests__/panel/composer-slash-trigger.test.ts

# runtime（有独立 vitest.config.ts）
cd src-electron/runtime && npx vitest run

# typecheck（vue-tsc 在 src-electron/node_modules）
cd src-electron && npx vue-tsc --noEmit -p renderer/tsconfig.json
cd src-electron/runtime && npx tsc --noEmit
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
- 运行：`cd src-electron/renderer && npx vitest run --coverage`
