# 02 · 废弃 drawer 旧 widget/status 适配

> 主文档：`README.md`（§3.3，W2 的详细设计）
> 解决主问题 P2（双通道重复消费）+ 用户明确要求「drawer 对 todo/goal 的适配废弃删除」

## §1 问题定义

**现状**：`extension:widget` / `extension:widgetGui` / `extension:status` 三路 WS 帧被**两个通道并行消费**：

```
通道 A（旧，drawer 适配，本次废弃）
  PanelContainer.vue: onMessage('extension:widget'/'extension:widgetGui'/'extension:status')
    → createDrawerBuffers（core/domain/drawer/widget-buffers.ts）
    → DrawerPanel widget 区（activeGuiComponent → activeLines → 空态）+ status footer

通道 B（新，ExtensionHost，保留）
  useExtensionHostBridge 双订阅（同三路帧）
    → MessageBusBridge 归一 → ViewHostStore / StatusBarController → ViewHost / StatusBar
```

**根本问题**：同一份数据两份状态源。旧通道的 UX 缺陷（widgetKey 不匹配 terminal/browser 时塞入 unknownWidget、被 terminalLines 遮蔽、status 只在 drawer 底部小字 footer）是"todo/goal 没有内容展示"的次根因——内容其实在，但在看不见的地方。

**目标**：删除旧通道全部代码，drawer 只保留五个固定 tab（terminal/browser/git/doc/detail）；extension 的 widget/status 内容由新体系（plugins tab ViewHost + A4 底栏 StatusBar）单一承载。

## §2 删除范围核查（先确认再删）

### 2.1 删除清单

| 文件 | 内容 | 消费方 |
|---|---|---|
| `packages/core/src/domain/drawer/widget-buffers.ts` | createDrawerBuffers / mapWidgetKeyToTab / unknownWidget / statusMap / guiWidgetsByTab / WIDGET_MAX_LINES / MAX_STATUS_KEYS | PanelContainer.vue 唯一 |
| `packages/core/src/domain/drawer/__tests__/widget-buffers.test.ts` | 随删 | — |
| `packages/ui/src/features/drawer/DrawerPanel.vue` | widget 区三分支（drawer-widget-gui/lines/empty）+ status footer + activeGuiComponent/activeLines/statusEntries props | PanelContainer.vue 传参 |
| `packages/ui/src/features/drawer/__tests__/DrawerPanel.test.ts` | 断言 widget 区的用例改为断言无 widget 区 | — |
| `packages/renderer/src/components/workspace/PanelContainer.vue` | 三路 onMessage 订阅 + buffers 实例化 + 传 DrawerPanel 的 widget props | — |
| `packages/renderer/src/__tests__/panel/panel-container-drawer-mode.test.ts` | widget 相关用例 | — |
| `packages/core/src/domain/drawer/types.ts` | `SideDrawerTab` 死成员 `'tasks'`（已无渲染，先删） | 类型 |
| i18n `panel.ts` tasksHint 死 key | 无消费方 | — |

### 2.2 保留确认（删除不动）

| 项 | 为什么保留 | 证据 |
|---|---|---|
| DrawerPanel 五固定 tab（terminal/browser/git/doc/detail） | 各自有独立内容组件（TerminalView/GitPanel/CommandDocPanel/DetailPane/BrowserPane），不依赖 widget 数据 | `PanelContainer.vue:94-100` |
| `core/domain/drawer/` 其余模块（control/coordination/terminal-write-queue/types） | drawer 开关/tab 状态/终端写队列是固定功能 | `useSideDrawer.ts` 消费 |
| subagent-stream 通道 | event-adapter 对 `subagent-stream-<id>` 前缀**短路**（不走 widget 通道，发独立 subagent-stream 事件），与本次删除无交集 | `event-adapter.ts:296-302` |
| runtime event-adapter 的 widget 解析 | 新通道（ViewHostStore）依赖同一解析，不动 | — |

### 2.3 活跃 widget 推送方核查（删前探针，全部经代码核实）

删除前必须摸清所有 `setWidget` 推送方的 widgetKey 分布，确认删除后去向。**已核实清单**（grep extensions/ 源码）：

| 推送方 | widgetKey | 状态 | 删除后去向 |
|---|---|---|---|
| `extensions/goal/src/projection/widget.ts:228-248` updateWidget（10 处调用点） | `'goal'` | **活跃**（非终态推 renderWidgetLines 文本行） | ViewHostStore['goal'] → W1 的「目标」view 承接 ✅ |
| `extensions/todo/src/index.ts:45-47` refreshDisplay | `'todo'` | **活跃**（todos 非空时推 renderWidgetLines；__gui__ 是 tool result 附加，widget 通道同时在推） | ViewHostStore['todo'] → W1 的「任务」view 承接 ✅ |
| `extensions/plan/src/widget.ts:13` | `'plan-mode'` | 活跃 | ViewHostStore['plan-mode']，**无 view 声明承接 → 过渡期不可见**（登记待办，见 D3） |
| `extensions/scheduler/src/index.ts:133` | `'scheduler'` | 活跃 | ViewHostStore['scheduler']，**无 view 声明承接 → 过渡期不可见**（登记待办，见 D3） |
| subagent-stream 前缀 | `subagent-stream-<recordId>` | 活跃但短路 | event-adapter 发独立 subagent-stream 事件，不走 widget 通道，不受影响 |

- [ ] dev 运行 30 分钟，收集 runtime 日志中 `extension:widget` 帧的 widgetKey 分布（runtime `logs/pi-*.jsonl` tee 已有），与上表交叉验证无遗漏

**D3 决策（plan-mode/scheduler 去向）**：删除 drawer 通道后，plan/scheduler 的 widget 推送进 ViewHostStore 但 plugins tab 无对应 view 声明 → **过渡期不可见**。接受此代价并登记待办：未来 plan/scheduler 按新规范在 builtin contributions 声明 view（与 tasks 同路径）。理由：这两个 widget 目前位于 drawer unknownWidget 槽位（被 terminalLines 遮蔽、几乎不可见），实际展示价值已接近零；过渡期不可见不构成功能回退。**不做**在本次设计中为它们补 view 声明（超出 tasks 范围，且 plan/scheduler 的展示形态需另行设计）。## §3 方案

### 3.1 方案对比

| 方案 | 说明 | 长期 | 成本 | 风险 |
|---|---|---|---|---|
| **A（推荐）全删** | §2.1 清单全删，drawer 零 widget 概念 | ★★★★★ 单一状态源（ViewHostStore/StatusBarController），与 V6 目标态一致 | 低（纯删除，无新逻辑） | 低（2.3 探针先过） |
| B 只删 todo/goal 分支 | 保留 widget 通道但过滤 widgetKey | ★★ 双通道仍在，mapWidgetKeyToTab 特判更多 | 低 | 中（状态源仍分裂，todo/goal 之外的其他 widget 继续藏在 drawer） |
| C 保留但降级 | drawer 只显示"widget 存在"提示跳转 plugins tab | ★★★ 引导用户但保留死代码 | 低 | 低（多一层无谓代码） |

**推荐 A**。被否方案：B 制造更复杂的特判（违背"删特殊路径"方向），C 是过渡态无终态价值。

### 3.2 删除后的行为变化

| 场景 | 删除前 | 删除后 |
|---|---|---|
| agent 建 todo 列表，打开 drawer | terminal tab 显示 widget 内容（若 terminalLines 空）或看不到（被遮蔽）；底部 status footer 显示 📋 N | drawer 五个 tab 全为固定功能；todo 内容在侧栏 plugins tab「任务」+ 底栏 StatusBar |
| pi extension 推 status | drawer footer 小字 | A4 底栏 StatusBar（priority 排序，可见性更好） |
| pi extension 推 widgetGui 结构化组件 | drawer widget 区渲染 | plugins tab ViewHost（viewId 路由） |
| plan-mode / scheduler widget 推送 | drawer terminal tab 的 unknownWidget 槽位（被遮蔽，几乎不可见） | 进 ViewHostStore 无承接 → 不可见（D3 决策：接受 + 登记待办） |
| browser tab 无 URL | 回退到内置 widget 区（有 widget 数据时） | 直接空态（widget fallback 删除；`panel-container-drawer-mode.test.ts` 对应用例改写为断言空态） |

### 3.3 运行时断言（附探针）

| 断言 | 探针 |
|---|---|
| 删除后无代码引用 | `grep -rn "createDrawerBuffers\|unknownWidget\|mapWidgetKeyToTab\|drawer-widget-gui\|drawer-status-footer" packages/` 零业务命中（测试断言除外） |
| drawer 固定 tab 无损 | 既有 DrawerPanel.test.ts 的 tab 渲染用例保留，widget 断言替换为"无 widget 区 DOM" |
| extension widget 数据仍进新通道 | ViewHostStore 集成测试（s2 已交付）继续绿——删除只影响旧通道消费，不影响 MessageBusBridge 归一 |

## §4 验收（对应主文档场景 C）

### 场景 C：drawer 无 widget 内容

1. 完成主文档场景 A（todo 列表存在）+ 场景 B（goal 存在）
2. 打开 drawer，逐 tab 检查
3. **通过**：
   - terminal：PTY 可交互（输入命令有输出）
   - browser：可导航（或空态）
   - git：git 状态面板正常（非 git 仓库显示空态）
   - doc/detail：正常
   - 全程无 drawer-widget-gui / drawer-widget-lines / drawer-status-footer / drawer-unknown-badge DOM
4. 切回对话流：todo/goal 内容在对话流卡片、侧栏 plugins tab、底栏 StatusBar 三处仍正常（无内容真空）

### 回归护栏

- `cd packages/core && npx vitest run`（drawer 域其余测试绿）
- `cd packages/ui && npx vitest run`（DrawerPanel 测试适配后绿）
- `cd packages/renderer && npx vitest run`（panel-container 相关测试适配后绿）
- `grep` 探针零命中

## §5 下一层拆分（wave 级）

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | 2.3 探针（widgetKey 分布核查），记录结论 | 探针报告 |
| 2 | 删 core 侧（widget-buffers.ts + 测试 + types 'tasks' 死成员） | core 测试绿 |
| 3 | 删 ui 侧（DrawerPanel widget 区/status footer + props + 测试适配） | ui 测试绿 |
| 4 | 删 renderer 侧（PanelContainer 订阅 + 传参 + 测试适配）+ i18n 死 key | renderer 测试绿 + 场景 C 手工 |

**依赖**：本 wave 依赖 W1（01 子文档）先落地——先有 plugins tab 展示位，再删 drawer 旧通道，保证任意时刻 todo/goal 内容可见（无真空期）。若 W1 未完成而先删，用户会在过渡期完全看不到 todo/goal 内容。

**文件改动地图**：
- `packages/core/src/domain/drawer/widget-buffers.ts`（删）
- `packages/core/src/domain/drawer/types.ts`（-tasks 死成员）
- `packages/ui/src/features/drawer/DrawerPanel.vue`（-widget 区 -status footer -3 props）
- `packages/renderer/src/components/workspace/PanelContainer.vue`（-3 订阅 -buffers -传参）
- 对应测试文件 4 个
