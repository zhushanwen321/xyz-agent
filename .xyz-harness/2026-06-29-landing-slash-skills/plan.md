# Plan: 新建任务 Landing 页 slash 命令浮层可用

## 1. 业务目标

**一句话目标**：新建任务 Landing 页（无 session 态）输入 `/` 时，slash 命令选择浮层能弹出并展示可用 skill 命令，选中后插入 chip，提交创建 session 后该 skill 在 pi 子进程真正生效。

**可衡量成功标准**：
1. Landing 态（sessionId=null）输入 `/`，浮层弹出且含 ≥1 条命令项（来自已扫描的 skills）
2. 浮层命令项的 name 带 `/` 前缀（如 `/code-review`），与 session 态格式（`/compact`）一致
3. 选中命令 → 插入 slash chip → 提交（submitFirstMessage create session）后，pi `get_commands` 返回的命令集覆盖该 skill（"后端真生效"由现有 session 创建链路保证，非本次新增）
4. session 态（有 sessionId）行为零回归——仍用 commandStore（pi 真实命令），不被 skills 数据污染

**约束 / 不做**：
- Landing 态**不含** builtin 命令（`/compact` 等）——无 session 时这些命令无意义，进 session 后自动切回 session 源补上
- icon **统一用 star**（与现有 skill source 的 `iconKeyForSource('skill')='star'` 一致），不按 skill 来源（pi/claude/agents）区分
- **不改 commandStore**——它是 session-scoped（按 sid 分区，数据来自 `session.commands` 广播）。全局 skills 塞进去会破坏分区语义且引入"全局命令何时刷新"问题。Landing 命令是临时视图，放组件 computed 更干净
- **不改 runtime / protocol / settingsStore**——config.skills 订阅链路已完整（`sendInitialState` → `config.onSkills` → `settingsStore.skills`），直接消费

**已知取舍（用户已确认接受）**：
config.skills 来自 `ConfigService.loadSkills`（读文件系统 SKILL.md），与 pi `get_commands`（pi 子进程实际加载）存在偏差窗口——SKILL.md 被扫描到但 pi 加载时 frontmatter 不合规被丢弃 → 浮层显示但提交后失效。此偏差由 create session 后 `fetchAndBroadcastCommands` 刷新 commandStore 自然修正（切回 session 源时失效 skill 消失）。偏差窗口小（扫描目录集与 pi 加载目录集同源：discovery.json + 强制目录）。

---

## 2. 技术改动点

### 改动 1（修改）：`src-electron/renderer/src/components/panel/CommandPopover.vue`

**职责**：`slashCommands` computed 增加 landing 态 fallback 数据源。

**现状**（第 113-114 行）：
```typescript
const slashCommands = computed(() => (props.sessionId ? commandStore.getCommands(props.sessionId) : []))
```
landing 态 `props.sessionId` 为 undefined → 返回空数组 → `items.length===0` → `PopoverContent`（第 24 行 `v-if="open && items.length > 0"`）不渲染 → 浮层不弹。

**改后**：双源切换——session 态用 commandStore（现有，含 builtin/extension），landing 态用 settingsStore.skills（config.skills 全局扫描结果），归一化为 SessionCommand 结构（补 `/` 前缀、icon='star'）。

**复用判断**：
- `settingsStore`（`@/stores/settings`）：**复用**。已有 `skills: Ref<SkillInfo[]>`，AppShell init 后常驻订阅。组件读 store 是允许方向（Composer.vue 已读 `settingsStore.defaultModel`，同构）
- `SessionCommand` 结构（`{ id, name, kind, icon, description? }`）：**复用**。landing 映射项须符合此结构，下游 `items` computed（第 139-169 行）和 `onSelect`（第 177-179 行）零改动
- `SLASH_ICON_COMPONENTS.star`（`@/composables/slashIcons`）：**复用**。icon='star' 能正确渲染（slashIcons.ts:26 `star: markRaw(Star)`，已实测）

**为何不新建 store/composable**：改动是"组件 computed 多读一个已有 store + 一处归一化映射"，7 行逻辑。抽 store/composable 是过度设计（YAGNI）。

### 改动 2（新建）：`src-electron/renderer/src/__tests__/panel/command-popover-landing.test.ts`

**职责**：覆盖 landing 态双源切换（正常/边界/回归），断言 DOM（三视角之观察者 + 使用者）。

**测试框架**：vitest（从 vitest 导入 describe/it/expect，禁止 node:test；CLAUDE.md 测试规范 [HISTORICAL]）。运行：`cd src-electron/renderer && npx vitest run <file>`。

---

## 3. Wave 拆分与依赖

改动范围极小（1 文件 1 computed + 1 测试文件），单功能 Wave + 验收 Wave。

| Wave | 内容 | 文件 | blocked_by | 并行组 |
|------|------|------|-----------|--------|
| W1 | CommandPopover landing 双源 + 测试 | CommandPopover.vue, command-popover-landing.test.ts | — | — |
| W2（验收） | 全量回归（新测 + 现有 slash/command-store 测试） | — | W1 | — |

W1 内测试与实现同 Wave（TDD：先写测试看到失败，再改 computed 转绿）。

---

## 4. 单测用例清单

**fixture（已读进上下文，对照真实数据推算预期）**：
- `fixtureSkills`（settings-data.ts:66-74）：7 条，name 不带 `/`：code-review / diagnose / impeccable / fallow / tavily-web-search / batch-tracer / pi-goal
- `command-store.test.ts` RAW：4 条，name 带 `/`：/commit(extension) / /review(extension) / /fix(skill) / /compact(builtin)

**同源盲区反向自检**（query 过滤边界）：
- query='co'：'/code-review'.includes('co')=true；其余 6 条均不含 'co'（diagnose/impeccable/fallow/tavily-web-search/batch-tracer/pi-goal，逐条验证无 'co' 子串）→ 仅 1 项 ✓
- query='e'：会匹配 code-review/diagnose/impeccable/batch-tracer（含 'e'）→ 不用此值做精确计数断言

| ID | 类型 | 输入 | 预期 |
|----|------|------|------|
| L1 | 正常 | mount CommandPopover `{open:true, type:'slash', sessionId:undefined}`；settingsStore.skills=fixtureSkills(7)；query='' | body 内命令按钮数=7；首个按钮文本含 `/code-review` |
| L2 | 正常 | 同 L1，query='co' | 按钮数=1；文本含 `/code-review` |
| L3 | 边界 | 同 L1，query='zzz' | 按钮数=0；`document.body.querySelector('[data-radix-popper-content-wrapper]')` 为 null（PopoverContent 不渲染） |
| L4 | 边界 | settingsStore.skills=[]；query='' | 按钮数=0 |
| L5 | 回归 | sessionId='s1'；commandStore.applyCommands('s1', RAW)(4条)；settingsStore.skills=fixtureSkills(7)；query='' | 按钮数=4（来自 commandStore，非 7 条 skills）；含 `/compact`（builtin，skills 里没有） |
| L6 | 正常 | 同 L1 | 每个按钮内 `svg` 存在（star 图标渲染，icon='star'） |
| L7 | 异常→正常 | 同 L1，trigger 第一个按钮 click | emitted('select')[0][0] = `{type:'slash', name:'/code-review', icon:'star', description:'审查代码变更'}` |

**mount 策略**：`mount(CommandPopover, { attachTo: document.body, props })`，pinia 测试模式（beforeEach `setActivePinia(createPinia())`），通过 `useSettingsStore().skills = fixtureSkills` 注入（store 创建后直接赋值 ref）。`bodyItemButtons()` 复用现有测试的 DOM 选择器模式（`document.body.querySelectorAll('button')` 过滤含 `/` 文本）。

**覆盖维度**：正常(L1/L2/L6/L7) / 边界(L3/L4) / 回归(L5) / 异常路径(L7 select)。

### 现有测试适配评估（步骤 4 必做）

| 现有测试 | 是否受影响 | 处理 |
|---------|-----------|------|
| `composer-slash-trigger.test.ts` U6-U8 | 否 | sessionId='s1' 走 session 源，不读 skills。新增 `useSettingsStore()` 调用需 pinia——该测试 beforeEach 已 `setActivePinia(createPinia())`，settingsStore 可创建（skills 初始 []），不影响 session 源断言。**无需改** |
| `composer-slash-trigger.test.ts` U9-U10 | 否 | 测 Composer wiring，CommandPopover 是 stub，不触发改动逻辑。**无需改** |
| `command-store.test.ts` | 否 | commandStore 未改。**无需改** |

---

## 5. E2E / 集成用例清单

**测试栈探测（已做）**：
- 项目无 Playwright/Cypress（glob 无 e2e 目录 / playwright.config）
- 前端测试统一 vitest + @vue/test-utils（CLAUDE.md 测试规范 [HISTORICAL]）
- "用户可见"断言通过 mount 组件 + DOM 断言实现（CLAUDE.md 三视角：构建者/使用者/观察者）

**集成用例**：
- Landing 态 wiring（用户输入 `/` → 浮层弹出含 skills）**不需新增集成测试**。理由：wiring 机制（ComposerInput → Composer.onSlashTrigger → CommandPopover open）在现有 `composer-slash-trigger.test.ts` U9 已覆盖（session 态）。landing 态 wiring 无新代码——sessionId 仅是透传值不同（null vs 's1'），不涉及新的 wiring 逻辑。L1-L7 单测已直接覆盖 CommandPopover landing 行为（含 DOM 断言，满足观察者视角）

**手动验证（可选，发布前）**：
1. `npm run dev` → 点「新建任务」进 Landing
2. composer 输入 `/` → 确认浮层弹出，含 skill 命令（如 /code-review），icon 为 star
3. 输入 `/co` → 确认过滤到 /code-review
4. 选中 → 确认插入 slash chip（紫底，含 star 图标 + `/code-review` 文本）
5. 选目录 + 提交 → 进 session 后输入 `/` 确认该 skill 仍在（后端生效验证）

---

## 6. 覆盖率 gate

**命令**：
```bash
cd src-electron/renderer && npx vitest run src/__tests__/panel/command-popover-landing.test.ts --coverage
```

**增量算法**：关注 `CommandPopover.vue` 的 `slashCommands` computed 两个分支：
- session 分支（`props.sessionId` truthy）：L5 覆盖
- landing 分支（`props.sessionId` falsy）：L1-L4/L6/L7 覆盖

**阈值**：项目 `src-electron/renderer/vitest.config.ts` 未配置 coverage thresholds（实测无 coverage/thresholds 相关字段），即 vitest 默认不强制覆盖率。`src-electron/renderer/coverage/` 目录是历史 `--coverage` 运行产物，非 CI gate。本次改动两个 computed 分支均有用例覆盖（session 分支 L5、landing 分支 L1-L4/L6/L7），满足分支覆盖。

---

## 实现步骤

1. **改 `CommandPopover.vue`**：
   - `<script setup>` import 区新增 `import { useSettingsStore } from '@/stores/settings'`
   - `const commandStore = useCommandStore()` 后新增 `const settingsStore = useSettingsStore()`
   - 替换 `slashCommands` computed（第 113-114 行）为双源版本：session 态返回 `commandStore.getCommands(props.sessionId)`；landing 态（无 sessionId）返回 `settingsStore.skills.map(s => ({ id: s.name, name: '/' + s.name, kind: 'skill', icon: 'star', description: s.description }))`
   - 加注释说明双源切换语义 + 为何 landing 不含 builtin + 归一化 `/` 前缀原因（与 runtime get_commands name 格式对齐，chip label 与 draft 检测如 `/compact` 都依赖 `/` 前缀）

2. **写测试 `command-popover-landing.test.ts`**：按 L1-L7 用例清单，TDD（先写看到 landing 态空/失败 → 改完转绿）。复用 `composer-slash-trigger.test.ts` 的 `bodyItemButtons()` DOM 选择器模式 + `events.dispatchSession` 推命令模式（L5 用）

3. **回归**：`cd src-electron/renderer && npx vitest run src/__tests__/panel/command-popover-landing.test.ts src/__tests__/panel/composer-slash-trigger.test.ts src/__tests__/command-store.test.ts`，全绿

4. **lint**：`npm run lint`（新增 import + computed 改动需过 taste-lint / vue_rules_checker）
