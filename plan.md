# Composer Slash 命令触发补全 实现计划

## 业务目标

补全 composer 输入区敲 `/` 触发命令浮层的能力——当前唯一断点：输入区敲 `/` 不弹浮层，只有点 `+` 菜单→「命令」一条路径。数据流（runtime `session.commands` → CommandPopover 订阅）已全通，无需改 runtime。

**成功标准（可衡量）**：在任一激活 session 内，输入区敲 `/` → 浮层弹出列出 `/commit /review /fix /compact`；继续输入过滤；Enter 或 Tab 选中 → 浮层消失、composer 内出现紫色 slash chip 占最左；chip 后继续输入文字可正常发送；`/compact` chip 发送触发 compact。附带：输入区高 2 行（≈60px）、输入区与工具栏间 4px 间隔。

**约束**：runtime 全链路不改；`/compact` 路由（`Composer.vue` `text.trim()==='/compact'` 检测）不改；mock（`MOCK_COMMANDS` 已覆盖 extension/skill/builtin 三 source）不改。

**不做**：`@`/`#` 符号触发（本次只做 `/`，@/# 仍只走 `+` 菜单）；landing 态无 session 时的命令（`fetchAndBroadcastCommands` 仅 session 激活时推一次，landing 态无命令是预期）。

## 技术改动点

- **修改** `src-electron/renderer/src/components/panel/ComposerInput.vue`
  - `onInput` 内加 `/` 触发检测：当 **DOM 内无 `.slash-chip`/`.mention-chip`**（必须 DOM 查询，不能用 getText——chip 本体文本 `/commit` 会被 TreeWalker 读入误判）**且 `getText().startsWith('/')`** 时，emit `'slash-trigger': { query: getText().slice(1) }`；否则 emit `'slash-trigger': null`。
  - 新增 emit 类型 `'slash-trigger': [payload: { query: string } | null]`。
  - 新增并 `defineExpose` 方法 `clearSlashQueryText()`：清空输入区全部文本 + 光标回开头（选中命令后，Composer 调它清掉 `/query` 过滤文本，再调 `insertSlashChip` 插 chip）。
  - `onKeydown` 内对 Tab 不再透传：浮层打开时由 CommandPopover 的 handleKeydown 拦截转选中（依赖现有 window capture listener，preventDefault 在 capture 阶段生效，不移焦）。
  - 高度微调：`min-h-[40px]` → `min-h-[60px]`（沿用本文件既有 `[40px]` 任意值范式，一致性优先）。
- **修改** `src-electron/renderer/src/components/panel/Composer.vue`
  - 监听 ComposerInput `@slash-trigger`：payload 非 null → `slashTriggerActive=true; cmdType='slash'; cmdOpen=true; slashQuery=payload.query`；payload 为 null **且 `slashTriggerActive`** → `cmdOpen=false; slashTriggerActive=false`。
  - 新增 `slashTriggerActive` ref 与 `slashQuery` ref；`slashQuery` 作为 prop 透传给 CommandPopover `:query="slashQuery"`。
  - **[修正 handoff 遗漏]** `+` 菜单路径（`onAddSelect`）打开浮层时 `slashTriggerActive=false`，避免用户随后敲键触发 `slash-trigger:null` 误关 `+` 菜单浮层；`onCmdSelect`/关闭时复位 `slashTriggerActive=false`。
  - `onCmdSelect` slash 分支：先 `clearSlashQueryText()` 再 `insertSlashChip(name)`（去掉过滤文本再插 chip）。
  - 工具栏 `composer-bar` 加 `mt-1`（4px，Tailwind 标准 scale）。
- **修改** `src-electron/renderer/src/components/panel/CommandPopover.vue`
  - 新增 prop `query?: string`（默认 ''）。
  - `items` computed：`type==='slash'` 时按 `query` 过滤（`name.toLowerCase().includes(query.toLowerCase())`）。
  - 扩展 `handleKeydown`：新增 `Tab` 分支（与 `Enter` 同处理：preventDefault + 选中 activeIndex + return true）。
  - 扩展现有 `watch([open, type])` → `watch([open, type, query])`：query 变化时 `activeIndex` 重置 0。
- **修改** `docs/page-design/v3/panel/draft-composer-states.html`
  - 同步 `/` 触发规则到定稿：`/` 在输入流最左且左侧无内容时触发，右侧作 query，Enter/Tab 确认（定位 §2d/§1 现有「敲对应符号触发」描述并补精确规则）。
  - §1 记录 4px gap 决策（偏离原「无分隔」，用户拍板）。
- **创建** `src-electron/renderer/src/__tests__/panel/composer-slash-trigger.test.ts` — 触发检测 + query 过滤单测。

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1 | ComposerInput.vue、Composer.vue、CommandPopover.vue、draft-composer-states.html、composer-slash-trigger.test.ts | - | - | slash 触发是一个垂直切片（三组件经 event/prop 契合，同一 implementer TDD 串行）；单 Wave，不拆并行（subagent 启动开销 > 改动量） |
| W2 | 验收 Wave | W1 | - | `npm run lint` + 全量单测 + 覆盖率 ≥60% + 手动 E1–E5 全绿 |

三组件改动经 event/prop 契约耦合（ComposerInput emit → Composer 路由 → CommandPopover prop），改不同文件但有调用依赖 → 必须串行同一 implementer，不并行。设计稿与代码无调用依赖，折叠进 W1 的 commit 序列（分文件提交）。

## 单测用例清单（AC 级）

测试框架：vitest + @vue/test-utils + happy-dom（见 `renderer/vitest.config.ts` 与 `__tests__/panel/context-chips-bar.test.ts` 范式）。Composer.vue 的 mount 参照 `__tests__/new-task/landing.test.ts`（stub 重子组件 + 真 pinia + mock composable/api）。

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | ComposerInput.vue:onInput 触发检测 | mount ComposerInput；设 `el.textContent='/'`；trigger `input` 事件 | emitted `slash-trigger` 末次 = `{ query: '' }` | 正常 |
| U2 | ComposerInput.vue:onInput 触发检测 | 设 `el.textContent='/commit'`；trigger `input` | emitted `slash-trigger` 末次 = `{ query: 'commit' }` | 正常 |
| U3 | ComposerInput.vue:onInput 边界（chip 存在不重触发） | 设 `el.innerHTML='<span class="slash-chip">/commit</span>'`；trigger `input` | emitted `slash-trigger` 末次 = `null` | 边界 |
| U4 | ComposerInput.vue:onInput 异常（非开头） | 设 `el.textContent='foo/'`；trigger `input` | emitted `slash-trigger` 末次 = `null` | 异常 |
| U5 | ComposerInput.vue:onInput 边界（清空关闭） | 先 `/commit` 触发后，设 `el.textContent=''`；trigger `input` | emitted `slash-trigger` 末次 = `null` | 边界 |
| U6 | CommandPopover.vue:items 过滤 | mount（type='slash', open=true, sessionId='s1'）；dispatch `session.commands` 推 4 条；设 `query='co'` | 渲染列表仅含 `/commit`（1 项） | 正常 |
| U7 | CommandPopover.vue:items 过滤 | 同上，`query=''` | 渲染全部 4 项 | 边界 |
| U8 | CommandPopover.vue:items 过滤 | 同上，`query='zzz'` | `items.length===0`，PopoverContent（`v-if items.length>0`）不渲染 | 边界 |
| U9 | Composer.vue:slash-trigger wiring | mount Composer（stub 子组件：ComposerInput/CommandPopover/AddMenuPopover；mock useChat/useNewTaskFlow/stores/@/api，参照 landing.test.ts）；ComposerInput stub `emit('slash-trigger', {query:'co'})` | CommandPopover stub 收到 `open=true`、`type='slash'`、`query='co'` | 正常 |
| U10 | Composer.vue:`+`菜单不回归（修正 handoff 遗漏） | 同上 mount；AddMenuPopover stub `emit('select','slash')` 打开浮层 → 再 ComposerInput stub `emit('slash-trigger', null)` | CommandPopover stub 仍 `open=true`（`slashTriggerActive=false`，null 不误关 `+` 菜单浮层） | 边界 |

说明：U1–U5 对 ComposerInput 检测逻辑断言 emitted 事件，不依赖 Selection/Range（仅 textContent + TreeWalker + querySelector，happy-dom 支持）。U6–U8 对 CommandPopover 经 events 通道推 `session.commands` 后设 query prop 断言过滤。U9–U10 对 Composer.vue wiring 与 `+` 菜单不回归修正做组件级锁定（stub 子组件 + mock 依赖，参照 landing.test.ts 范式）。

## E2E 用例清单

**E2E 框架探测**：项目无 `playwright.config.*` / `cypress.config.*`（已确认）。**降级为 browser-automation（连 Electron CDP 9222）或手动**。建议后续安装 Playwright 以获得可回归 E2E（本次不做）。

前置：`npm run dev:mock`（= `VITE_MOCK=true XYZ_MOCK=1`，mock 已覆盖 `/commit /review /fix /compact`）；切到任一 session 等命令推送。

| 用例ID | 场景 | 步骤 | 预期 | 执行方式 |
|--------|------|------|------|---------|
| E1 | `/` 触发主流程（happy） | 输入区敲 `/` → 敲 `co` → 按 Enter | 浮层弹列出 4 条→过滤到 `/commit`→浮层消失，composer 出现紫色 `/commit` chip 占最左；chip 后输入文字→发送成功 | 手动 / browser-automation |
| E2 | Tab 选中 | 输入区敲 `/f` → 按 Tab | 选中 `/fix`（浮层消失、出现 chip） | 手动 |
| E3 | `+` 菜单不回归（异常） | `+` 菜单→「命令」打开浮层 → 输入区敲普通文字 `x` | 浮层不被误关（`slashTriggerActive=false` 生效）；行为同改前 | 手动 |
| E4 | chip 删除回归（边界） | 已有 slash chip → backspace | 整体删 chip（`handleBackspaceOnChip` 不破） | 手动 |
| E5 | `/compact` 操作型（状态转换） | 选 `/compact` chip → 发送 | 触发 `compact()`（`text.trim()==='/compact'` 命中） | 手动 |
| E6 | 视觉微调 | 目视 | 输入区高约 2 行（≈60px），与工具栏间 4px 呼吸 | 手动 |

## 覆盖率 gate

- gate 命令：`cd src-electron/renderer && npx vitest run --coverage`（项目 vitest.config 未配 thresholds，用命令行 `--coverage`；如需硬阈值加 `--coverage.thresholds.lines=60`）
- 阈值：增量代码（本次新增/修改的 3 个组件 + 测试）覆盖率 ≥ 60%
- gate 位置：W2 验收 Wave 独立执行（isVerification=true）

## 实现步骤

1. [W1] 写 `composer-slash-trigger.test.ts`（U1–U10 全部失败）→ 跑一次确认红
2. [W1] 改 `CommandPopover.vue`：加 `query` prop + items 过滤 + Tab 分支 + watch 扩展 → U6–U8 绿
3. [W1] 改 `ComposerInput.vue`：onInput 触发检测 + `slash-trigger` emit + `clearSlashQueryText()` 暴露 + Tab 透传保留 + `min-h-[60px]` → U1–U5 绿
4. [W1] 改 `Composer.vue`：监听 `slash-trigger` + `slashTriggerActive`/`slashQuery` + `+` 菜单不回归 + `onCmdSelect` slash 先 clear 再 insert + `composer-bar mt-1` + `:query` prop 透传 → U9–U10 绿
5. [W1] 同步 `draft-composer-states.html`（触发规则 + 4px gap 决策）
6. [W1] 分文件 commit（ComposerInput / Composer / CommandPopover / 设计稿 各一，或合理合并）
7. [W2] 验收：`npm run lint`（根）+ `npx vitest run --coverage`（renderer，≥60%）+ 手动 E1–E6 全绿 → 完成

## 风险与注意

- **contenteditable Tab 移焦**：依赖 CommandPopover 的 window capture listener（`onWindowKeydown`）在 capture 阶段 preventDefault，确保 cmdOpen 时 Tab 不移焦；cmdOpen 时 handleKeydown 返回 false，Tab 正常透传。
- **IME**：`/` 是 ASCII，中文输入法下经 composition；ComposerInput 已有 `composing`/`isComposing` 守卫（line ~82），安全。
- **getText 对 chip 的过滤**：现有 `getText()` TreeWalker 跳过 `.chip-x`（× 按钮），不跳 chip 本体 → chip 文本 `/commit` 会被读入。因此「无 chip 时才触发」必须 DOM 查询（`el.querySelector('.slash-chip, .mention-chip')`），U3 即验证此点。
- **`+` 菜单回归**（handoff 遗漏，本 plan 修正）：`slash-trigger:null` 仅在 `slashTriggerActive` 时关浮层，`+` 菜单打开的浮层不受影响（E3 验证）。
