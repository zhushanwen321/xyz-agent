# 14 · 后台命令侧边栏视图 + Drawer 详情 测试流程

> 覆盖：plugin 区「后台命令」L2 视图（BackgroundTaskListView：三桶筛选 + 两行式 item + 行内两段式终止）与 drawer bashTask tab（BackgroundTaskDetailPanel：元信息 / 输出跟随 / 终止）。
>
> 设计：[background-task-sidebar-view.md](../design/background-task-sidebar-view.md)（§3.1 终态 / D4-D7 / D10）。先读 [00 总览](00-test-strategy-overview.md)。

## §1 功能概述

AI 把 bash 命令转后台执行后，任务落在 per-session registry.json。本功能提供用户可见可控面：

- **列表**（Sidebar plugins tab →「后台命令」L2 tab）：三桶筛选（运行中/已结束/全部 + 计数，默认运行中）、两行式 item（状态 icon + 命令 + 耗时 / pid · exit）、running 行行内两段式终止（✕ → ✓）、点击行开 drawer；
- **drawer 详情**（bashTask tab，第 8 tab）：命令全文（可复制）、元信息行（taskId · pid · 开始 · 时长 · exit · reason）、输出尾部（running 时 2s 跟随）、两段式终止按钮 + 回执分支 toast。

数据链路：runtime `BackgroundTaskService` 直读 registry（拉取 RPC + 变更广播），renderer `useBackgroundTasks` per-session 分区。测试框架（vitest 用例）见 `packages/renderer/src/__tests__/components/background-task-list-view.test.ts` 与 `background-task-detail-panel.test.ts`。

## §2 组件树

```
PluginViewContainer.vue（NATIVE_VIEWS 路由，viewId='background-tasks'）
└─ BackgroundTaskListView.vue
   ├─ div [data-testid="background-task-list"]            ← 视图容器
   ├─ [v-if 全量空态] div [data-testid="bg-task-empty"]
   ├─ [v-else]
   │   ├─ div [data-testid="bg-task-filterbar"]           ← 凹陷槽三桶
   │   │   └─ Button ×3 [data-testid="bg-task-filter-active|ended|all"]
   │   └─ ScrollArea
   │       ├─ [运行中空桶] div [data-testid="bg-task-bucket-empty"]
   │       │    └─ Button [data-testid="bg-task-view-all"]  「查看全部 (N)」
   │       ├─ [已结束空桶] div [data-testid="bg-task-bucket-empty-ended"]
   │       └─ [列表] div ×N [data-testid="bg-task-item"]    (@click → drawer)
   │           ├─ div [data-testid="bg-task-group-divider"]  「全部」桶 active/ended 段边界
   │           ├─ div [data-testid="bg-task-icon"]           7px 状态 icon（spinner/色点）
   │           ├─ div [data-testid="bg-task-meta"]           第二行 pid · exit
   │           │    └─ Button [data-testid="bg-task-kill"|"bg-task-kill-confirm"]
   │           │        （仅 running 行；确认态切换 testid）

DrawerPanel.vue（tab 栏 [data-testid="drawer-tab-bashTask"]，既有 drawer-tab-{key} 模板新值）
└─ PanelContainer.vue v-if 分支
   └─ BackgroundTaskDetailPanel.vue
      ├─ div [data-testid="bash-task-detail"]              ← 容器
      ├─ code [data-testid="bash-task-command"]            ← 命令全文
      ├─ Button [data-testid="bash-task-copy"]             ← 复制命令（copied 态换 icon）
      ├─ div [data-testid="bash-task-meta"]                ← 元信息行
      │    ├─ span [data-testid="bash-task-status-dot"]    ← 状态色点（bucket SSOT tone）
      │    ├─ span [data-testid="bash-task-meta-taskid"]
      │    ├─ span [data-testid="bash-task-meta-pid"]
      │    ├─ span [data-testid="bash-task-meta-started"]  「开始 HH:MM:SS」
      │    ├─ span [data-testid="bash-task-meta-duration"] running=已运行 / 终态=耗时
      │    ├─ span [data-testid="bash-task-meta-exit"]     exit {code|null→—}
      │    └─ span [data-testid="bash-task-meta-reason"]   reason 五态文案
      ├─ 输出区（三态互斥）
      │    ├─ div [data-testid="bash-task-output-unavailable"]  lost=true（文件已清理）
      │    ├─ pre [data-testid="bash-task-output"]              有内容（running 2s 跟随）
      │    └─ div [data-testid="bash-task-output-empty"]        loaded 且空
      └─ [v-if running] Button [data-testid="bash-task-kill"]   两段式（data-armed=确认态）
```

## §3 data-testid 清单

### 列表（BackgroundTaskListView.vue）

| testid | 文件:行 | 触发/可见条件 |
|--------|---------|--------------|
| `background-task-list` | BackgroundTaskListView.vue:17 | 视图挂载时恒显（容器） |
| `bg-task-empty` | BackgroundTaskListView.vue:21 | 全量空态（loaded 且 0 条；此时不渲染筛选条） |
| `bg-task-filterbar` | BackgroundTaskListView.vue:32 | 有任务时恒显（三桶筛选槽） |
| `bg-task-filter-active` / `bg-task-filter-ended` / `bg-task-filter-all` | BackgroundTaskListView.vue:37（动态 `bg-task-filter-${value}`） | 同 filterbar；`data-active` 标当前桶 |
| `bg-task-bucket-empty` | BackgroundTaskListView.vue:53 | 「运行中」桶空（含 bg-task-view-all） |
| `bg-task-view-all` | BackgroundTaskListView.vue:59 | 同上，点击跳「全部」桶 |
| `bg-task-bucket-empty-ended` | BackgroundTaskListView.vue:67 | 「已结束」桶空（仅文案） |
| `bg-task-item` | BackgroundTaskListView.vue:79 | 每条任务一个；@click 开 drawer bashTask tab |
| `bg-task-group-divider` | BackgroundTaskListView.vue:88 | 仅「全部」桶 active/ended 段边界处 |
| `bg-task-icon` | BackgroundTaskListView.vue:91 | 恒显；running 时内部为旋转环，其余为色点 |
| `bg-task-meta` | BackgroundTaskListView.vue:106 | 恒显（第二行 pid · exit） |
| `bg-task-kill` / `bg-task-kill-confirm` | BackgroundTaskListView.vue:117（确认态切换 testid） | 仅 running 行 hover 显现；首击变 confirm（常显红底），再击发 kill RPC |

### Drawer 详情（BackgroundTaskDetailPanel.vue）

| testid | 文件:行 | 触发/可见条件 |
|--------|---------|--------------|
| `drawer-tab-bashTask` | DrawerPanel.vue:41（既有 `drawer-tab-{key}` 模板） | drawer 打开时 tab 栏内 |
| `bash-task-detail` | BackgroundTaskDetailPanel.vue:23 | 选中任务后（未选中走 DrawerPanel 空态文案） |
| `bash-task-command` | BackgroundTaskDetailPanel.vue:29 | 恒显（命令全文） |
| `bash-task-copy` | BackgroundTaskDetailPanel.vue:36 | 恒显（title 随 copied 态换文案） |
| `bash-task-meta` | BackgroundTaskDetailPanel.vue:47 | 恒显（元信息行容器） |
| `bash-task-status-dot` | BackgroundTaskDetailPanel.vue:52 | 恒显；class 随 bucket SSOT tone |
| `bash-task-meta-taskid` | BackgroundTaskDetailPanel.vue:54 | 恒显 |
| `bash-task-meta-pid` | BackgroundTaskDetailPanel.vue:55 | 恒显 |
| `bash-task-meta-started` | BackgroundTaskDetailPanel.vue:56 | 恒显 |
| `bash-task-meta-duration` | BackgroundTaskDetailPanel.vue:59 | 恒显（文案随 running/终态切换） |
| `bash-task-meta-exit` | BackgroundTaskDetailPanel.vue:63 | 仅 exitCode 非 undefined |
| `bash-task-meta-reason` | BackgroundTaskDetailPanel.vue:65 | 仅终态（orphaned 或 exited+reason） |
| `bash-task-output` | BackgroundTaskDetailPanel.vue:78 | output 拉到且非空（running 时 2s 跟随） |
| `bash-task-output-unavailable` | BackgroundTaskDetailPanel.vue:73 | output 文件丢失/清理（lost） |
| `bash-task-output-empty` | BackgroundTaskDetailPanel.vue:83 | output loaded 但为空 |
| `bash-task-kill` | BackgroundTaskDetailPanel.vue:99 | 仅 running（killing/终态无按钮）；`data-armed="true"` = 确认态 |

### 测试注意

- running 计时用 fake timers（列表 1s tick / drawer 输出跟随 2s interval）；
- 杀进程是 mock RPC，不会真杀——行内终止断言两段式状态机（testid 切换）而非进程消失；
- i18n key 全表见 `packages/renderer/src/i18n/locales/{zh-CN,en-US}/{panel,sidebar}.ts`（`panel.sideDrawer.bashTask*` 21 个 + `sidebar.backgroundTaskList.*` 18 个）；文案断言用 override `t(key)` 注入而非依赖 locale 文件（组件测试既有形态）。

## §4 相关文档

- 设计文档：[background-task-sidebar-view.md](../design/background-task-sidebar-view.md)（终态 §3.1 / 筛选 D10 / kill 矩阵 D6 / 输出跟随 D7）
- SideDrawer 宿主：[05-side-drawer.md](05-side-drawer.md)（bashTask tab 为第 8 tab）
- 侧栏面板范式：[09-subagent-workflow-panel.md](09-subagent-workflow-panel.md)（Agents tab 同构先例）
- 组件测试：`packages/renderer/src/__tests__/components/background-task-list-view.test.ts`（12 用例）/ `background-task-detail-panel.test.ts`（13 用例）
