# 03 · D1 slash 双轨收编（CommandRegistry 实例化 + CommandPopover 归一）

> 主文档：`README.md`（§3.3，W3 的详细设计）
> 解决主问题 P3（slash 双轨未收编）

## §1 问题定义

**现状**（双轨）：
- **轨道 1（真源）**：pi extension 注册 slash 命令 → `session.commands` WS 通道（D8 带 sessionId）→ `CommandPopover.vue` 订阅写 `commandStore` → 渲染。执行：选中的命令发给 pi 子进程（`/goal` → pi-goal extension）。
- **轨道 2（声明，未生效）**：plugin `contributes.slashCommands`（builtin tasks 已声明 goal/todo）→ ContributionRegistry 解析 → **CommandRegistry 未实例化**（零消费）。

**根本问题**：声明式贡献（schema v2 的 slashCommands）与运行时命令清单（session.commands）两套来源，CommandPopover 只消费后者。builtin tasks 已声明的 goal/todo 在 CommandPopover 中**不生效**（其显示目前依赖 pi 的 session.commands 通道）；未来 external plugin 声明的 slash 命令完全不生效。

**目标**：
1. CommandRegistry 实例化并成为 slash 命令的统一消费源（合并 plugin 声明 + pi 真源）
2. builtin tasks 的 slashCommands 声明（goal/todo）进入 CommandPopover（存在性交叉校验 + description 元数据）
3. 执行路径不变（仍发 pi），无功能回归

> **审查修正（MUST_FIX 5）**：plugin 声明的元数据能力现状有限——schema v2 的 `slashCommands` 仅 `{name, description}`（`plugin-sdk/types.ts:204`），**无 icon/category/keybinding 字段**。icon 现状已由 `iconKeyForCommand(c.name, c.source)` 推断（`stores/command.ts:147`）。故收编目标**降级**为：合并去重 + 存在性交叉校验 + description 级元数据；schema 扩展（slashCommands 加 icon/category/keybinding）列为 `@proposed` future 工作，本次不做。

## §2 现状细节（代码事实）

- `core/src/extension-host/command-registry.ts`：命令注册表已就绪（CommandRecord/CommandExecutor/registerFromContribution/registerCommand），**slash 型归一/查询未实现**——`registerFromContribution` 对 slashCommand 型直接 ignore（:52-53），**无任何 slash 查询方法**（本次补）；renderer 壳零实例化（`grep "new CommandRegistry"` 仅测试）
- **构造依赖**：CommandRegistry 构造需要 `deps.activationManager`（:23-25），但壳 `useExtensionHostBridge.ts` 未实例化 ActivationManager（仅 bridge/viewHostStore/statusBarController/contributions/overlayLifecycle/notificationController）——**本次需一并实例化**（builtin 免审批路径）
- `builtin-contributions.ts:27-36`：tasks 声明 `slashCommands: [{name:'goal'}, {name:'todo'}]`（name 不含前导 /，对齐 schema v2；仅 name+description）
- `CommandPopover.vue:151-186`：panel 态 = compact + commandStore（pi 真源）；landing 态 = commandStore + skills 合并
- 执行链路：`CommandPopover` emit select → composer 插入 `/goal` chip → 发送给 pi（`composer-slash-trigger.test.ts` 断言归一化补 / 前缀）

## §3 方案

### 3.1 方案对比

| 方案 | 说明 | 长期 | 成本 | 风险 |
|---|---|---|---|---|
| **A（推荐）CommandRegistry 为消费源** | 壳实例化 CommandRegistry（registerBuiltin + loadExternal 已就绪），CommandPopover 改从 registry 取数（merged：registry 声明 ∪ commandStore pi 真源） | ★★★★★ D1 归一终态（命令面板/快捷键/slash/菜单同一张表），plugin 元数据生效 | 中 | 中（改 CommandPopover 数据源需保 session.commands 行为） |
| B CommandRegistry 只注册不消费 | 实例化 + builtin 注册，CommandPopover 不动 | ★★ 声明落地一半，双轨仍在 | 低 | 低（无行为变化，但也无收编） |
| C 反向：session.commands 写入 registry | pi 清单作为唯一源，plugin 声明仅在校验 | ★★★ 单一表但 plugin 元数据无处注入 | 中 | 中 |

**推荐 A**。被否方案：B 是半途，C 让 plugin 声明沦为摆设（与 schema v2 设计意图相反——contributes.slashCommands 是要驱动 CommandPopover 的）。

### 3.2 合并规则（关键决策）

**D3-1：消费优先级与合并规则**——同名命令（如 'goal'）：
1. plugin 声明（registry）提供**存在性声明 + description 元数据**（schema 无 icon/category/keybinding，icon 维持现状的 `iconKeyForCommand` 推断）
2. session.commands（pi 真源）提供**存在性与执行**：命令是否可用、发送给 pi 的名称
3. 合并 = 存在性取并集（任一来源有即显示），元数据取 plugin 声明（description），执行永远走 pi

**D3-2：builtin tasks 的 slash 执行**：/goal /todo 的执行仍由 pi-goal/pi-todo extension 承担（声明与执行分离，s5 clarify Q3 已裁决）。**存在性交叉校验（已裁决）**：`/goal` 的实际可用性依赖 pi 侧已装 pi-goal extension——CommandPopover 对 merged 结果做交叉校验，pi 未装时不显示（避免死命令）；验收场景 D 步骤 4 据此写死。

**D3-3：CommandRegistry 实例化位置**：`useExtensionHostBridge.ts`（与 ViewHostStore/StatusBarController 并列），`registerBuiltin()` + `loadExternal([])`（external 透传通道 s3 完成后接真实 descriptors）。**前置：壳同时实例化 ActivationManager**（构造依赖）。CommandExecutor 适配 = 调 runtime 的 `plugin.executeCommand` RPC（通道名已核实：`plugin-message-handler.ts:50`；语义是 command contribution 执行，与 slash 执行（走 composer→pi）不同——CommandExecutor 仅服务非 slash 命令的 execute 场景）。

**D3-4：CommandPopover 改造**：
- 数据源：`registry` 的 merged 结果（registry 声明 ∪ commandStore pi 真源，交叉校验）
- **landing 态同样吃 merged 源**（统一数据源，避免两套逻辑）：skills 合并逻辑保留（registry 源之后追加 skill 项，去重规则同现状）
- 不改变：执行 emit 链、__ 前缀过滤、/ 前缀归一化
- 保留：session.commands 订阅写 commandStore（pi 真源存在性信息）

### 3.3 运行时断言（附探针）

| 断言 | 探针 |
|---|---|
| registry 实例化 + builtin 注册 | 单测：new CommandRegistry + registerBuiltin → 查询含 goal/todo |
| CommandPopover 消费 merged 源 | 组件测试：mock registry（含 goal 声明）+ mock commandStore（含 goal）→ items 去重且 description 来自 registry |
| 执行路径不变 | 既有 `composer-slash-trigger.test.ts` 全绿（/ 前缀归一化、chip 插入、pi 发送） |
| pi 未装 extension 时命令隐藏 | 组件测试：registry 有 goal、commandStore 无 goal → items 不含 goal（交叉校验） |

## §4 验收（对应主文档场景 D）

### 场景 D：slash 收编

1. dev 启动，composer 输入 `/`
2. **通过**：/goal /todo 出现在列表（builtin 声明 + pi 存在性交叉校验）；icon 沿用现状推断（`iconKeyForCommand`）
3. 选中 /goal 发送 → pi 正常执行（对话流出现 goal card）
4. 停用 pi-goal extension（模拟）→ /goal 从列表消失（交叉校验生效）
5. `/compact` 等 pi 原生命令不受影响
6. landing 态（无 session）输入 `/`：skills 命令 + /goal /todo 正常合并显示

### 回归护栏

- `cd packages/core && npx vitest run`（command-registry 测试 + 新增 merged 测试）
- `cd packages/renderer && npx vitest run`（composer-slash-trigger / command-popover 既有测试全绿 = 执行链无回归）
- 手工：landing 态 slash（skills 合并）不回归

## §5 下一层拆分（wave 级）

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | 壳实例化 ActivationManager + CommandRegistry（registerBuiltin）+ CommandExecutor 适配（plugin.executeCommand RPC） | core/registry 单测 |
| 2 | core 补 slash 归一/查询 + merged 交叉校验纯函数（headless 可测） | core 单测 |
| 3 | CommandPopover 数据源切换（panel + landing 两态）+ description 元数据渲染 | renderer 组件测试 |
| 4 | 手工场景 D + 回归护栏 | 场景 D |

**文件改动地图**：
- `packages/renderer/src/composables/shell/useExtensionHostBridge.ts`（+ActivationManager +CommandRegistry 实例化 + executor 适配）
- `packages/core/src/extension-host/command-registry.ts`（+slash 归一/查询 + merged/交叉校验纯函数，如 `resolveSlashCommands(piCommands)`）
- `packages/renderer/src/components/panel/CommandPopover.vue`（数据源切换，panel + landing 两态）
- 测试：core command-registry.test.ts + renderer command-popover.test.ts
