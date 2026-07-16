# Subagent/Workflow 面板 — 手工 E2E 测试计划

> 本文档是**执行计划**，供 AI agent（或人类 QA）照着逐步操作。不是 Playwright spec 脚本，而是通过 browser-automation skill 的 CDP 连接到 dev app，执行真实 Playwright 操作并断言。
>
> 配套正式文档：[09-subagent-workflow-panel.md](09-subagent-workflow-panel.md)

## 1. 测试策略

### 为什么用 real-track CDP 而非 mock E2E

mock 层的 `session.getSubagents` 固定返回空数组（`api/mock/index.ts:259-263`），无法验证 subagent 列表渲染。本功能核心是读真实 session JSONL → 提取 subagent 记录 → 渲染卡片 → 切换对话流，必须连真实 runtime。

### 测试通道

```
pnpm dev (real runtime)
  → Electron 启动时带 --remote-debugging-port=9222
  → browser-automation pw.js 连接 http://localhost:9222
  → Playwright 操作 renderer DOM
```

### 环境约定

| 项 | 值 |
|---|---|
| CDP 端口 | `9222`（`apps/electron/package.json:17` dev:electron 硬编码） |
| 数据目录 | `~/.xyz-agent-dev/`（dev 模式默认） |
| Vite 端口 | `1420`（strictPort） |
| 连接方式 | `connectOverCDP`（连接已有进程，不新开 Electron） |

### 前置条件

1. `pnpm dev` 已启动，Electron 首窗渲染完成（CDP 9222 可连）
2. dev 数据目录中存在含 subagent 调用的 session：
   - session `019f574d`（cwd `/Users/zhushanwen/Code/chat_project`）：1 个后台 subagent `bg-273756-1-...`（status=done, agent=general-purpose）
   - session `019f5672`（同 cwd）：1 个后台 subagent `bg-703a48-1-...`（status=running）

## 2. 测试用例清单

### 核心用例（必须全部通过）

| ID | 名称 | 核心能力 | 优先级 |
|----|------|---------|--------|
| TC-1 | SegmentedTab 4 tab 渲染 | 侧边栏出现 会话/文件/Agents/Flows 四个 tab 按钮 | P0 |
| TC-2 | Agents tab 加载 subagent 列表 | 切到 Agents tab 后 WS RPC → runtime 读取 session JSONL → 卡片渲染 | P0 |
| TC-3 | Subagent 卡片内容正确 | 卡片含 agent 名称、status 指示、task 描述 | P0 |
| TC-4 | 点击 subagent → 对话流切换 | 点击卡片 → Panel sessionId 切换到虚拟 session → 渲染对话流 + 返回按钮 | P0 |
| TC-5 | 返回主 session | 点击返回按钮 → Panel 恢复原 session | P0 |
| TC-6 | Workflow tab 空状态 | 切到 Flows tab → 显示空态占位 | P1 |
| TC-7 | Subagent tab 空状态 | 选中无 subagent 的 session → Agents tab 显示空态 | P1 |

### 边界用例（验证鲁棒性）

| ID | 名称 | 核心能力 | 优先级 |
|----|------|---------|--------|
| TC-8 | 多 session 切换后 subagent 列表刷新 | 切 session → Agents tab 列表跟随更新 | P1 |
| TC-9 | subagent badge 点显示 | subagentCount > 0 时 tab 上出现蓝点 | P2 |

## 3. 逐步执行指南（给执行 agent 的指令）

### 通用前置（每个用例开头）

```bash
# 确认 CDP 端口可连
EP="http://localhost:9222"
PW="node ~/.pi/agent/skills/browser-automation/scripts/pw.js"
lsof -i :9222 2>/dev/null  # 端口被占用 = dev app 在跑
$PW $EP list-pages          # 列出 Electron 窗口页
$PW $EP select-page 0       # 选中第一个窗口
```

### TC-1: SegmentedTab 4 tab 渲染

**操作**：
1. 截图侧边栏区域
2. 查找 4 个 tab 按钮（按 title 属性定位：会话/文件/Agents/Flows）

**断言**：
- 存在 title="会话" 的按钮
- 存在 title="文件" 的按钮
- 存在 title="Agents" 的按钮
- 存在 title="Flows" 的按钮

**命令**：
```bash
$PW $EP snapshot
# 或用 evaluate 检查
$PW $EP evaluate "document.querySelectorAll('button[title]').length"
$PW $EP evaluate "Array.from(document.querySelectorAll('button[title]')).map(b => b.title).join(', ')"
```

### TC-2: Agents tab 加载 subagent 列表

**操作**：
1. 点 sessions tab（`button[title="会话"]`）
2. 在 session 列表中找到 cwd=`chat_project` 的 session，点击激活
3. 点 Agents tab（`button[title="Agents"]`）
4. 等 `data-testid="subagent-card"` 出现

**断言**：
- `[data-testid="subagent-card"]` 存在且至少 1 个
- `[data-testid="subagent-list"]` 容器存在

**命令**：
```bash
$PW $EP click 'button[title="会话"]'
$PW $EP wait 'text=chat_project' 10000
$PW $EP click 'text=chat_project'
$PW $EP wait 'button[title="Agents"]' 5000
$PW $EP click 'button[title="Agents"]'
$PW $EP wait '[data-testid="subagent-card"]' 10000
$PW $EP evaluate "document.querySelectorAll('[data-testid=\"subagent-card\"]').length"
```

### TC-3: Subagent 卡片内容正确

**操作**（在 TC-2 基础上）：
1. 读取第一个 `subagent-card` 的文本内容
2. 检查是否包含 agent 名称、task 描述

**断言**：
- 卡片文本含 `general-purpose`（agent 名称）
- 卡片文本含 subagentId 前缀（`bg-273756`）
- 无 `subagent-card-spinner`（done 状态不显示 spinner）
- 存在状态点（`bg-success` 类 → 绿色圆点）

**命令**：
```bash
$PW $EP text '[data-testid="subagent-card"]'
$PW $EP evaluate "document.querySelector('[data-testid=\"subagent-card\"]').textContent"
$PW $EP evaluate "document.querySelector('[data-testid=\"subagent-card-spinner\"]')?.outerHTML ?? 'no spinner (expected for done)'"
$PW $EP evaluate "document.querySelector('[data-testid=\"subagent-card\"] .bg-success')?.outerHTML ?? 'no green dot'"
```

### TC-4: 点击 subagent → 对话流切换

**操作**（在 TC-3 基础上）：
1. 点击第一个 `[data-testid="subagent-card"]`
2. 等 `[data-testid="subagent-back-btn"]` 出现
3. 检查 panel 区域是否渲染了对话消息

**断言**：
- `[data-testid="subagent-back-btn"]` 存在且可见
- Panel 区域有消息内容渲染（不再是空态/loading）
- PanelHeader 显示 subagent label（含 agent 名称）

**命令**：
```bash
$PW $EP click '[data-testid="subagent-card"]'
$PW $EP wait '[data-testid="subagent-back-btn"]' 10000
$PW $EP screenshot -o tc4-subagent-view.png
$PW $EP text '[data-testid="subagent-back-btn"]'
```

### TC-5: 返回主 session

**操作**（在 TC-4 基础上）：
1. 点击 `[data-testid="subagent-back-btn"]`
2. 等返回按钮消失
3. 验证 panel 恢复主 session

**断言**：
- `[data-testid="subagent-back-btn"]` 不再存在（或 count=0）
- Panel 恢复正常 header（有 session 面包屑或 spinner）

**命令**：
```bash
$PW $EP click '[data-testid="subagent-back-btn"]'
$PW $EP wait '[data-testid="subagent-back-btn"]' hidden 5000
$PW $EP screenshot -o tc5-back-to-main.png
```

### TC-6: Workflow tab 空状态

**操作**：
1. 点击 Flows tab（`button[title="Flows"]`）
2. 等 `[data-testid="workflow-list-empty"]` 出现

**断言**：
- `[data-testid="workflow-list-empty"]` 存在
- 文本含「暂无工作流」和「发起 workflow 后在此查看进度」

**命令**：
```bash
$PW $EP click 'button[title="Flows"]'
$PW $EP wait '[data-testid="workflow-list-empty"]' 5000
$PW $EP text '[data-testid="workflow-list-empty"]'
```

### TC-7: Subagent tab 空状态

**操作**：
1. 点 sessions tab
2. 选一个没有 subagent 调用的 session（如选 cwd 非 chat_project 的 session，或新建空 session）
3. 切 Agents tab

**断言**：
- `[data-testid="subagent-list-empty"]` 存在
- 文本含「暂无后台任务」

**命令**：
```bash
$PW $EP click 'button[title="会话"]'
# 选一个其他 cwd 的 session（如 xyz-agent 开发目录）
$PW $EP click 'button[title="Agents"]'
$PW $EP wait '[data-testid="subagent-list-empty"]' 5000
$PW $EP text '[data-testid="subagent-list-empty"]'
```

## 4. 执行结果记录（2026-07-13 real-track CDP 实测）

环境：`pnpm dev`（real runtime），CDP 9222，dev 数据目录 `~/.xyz-agent-dev/`。
测试 session：`019f574d`（cwd `/Users/zhushanwen/Code/chat_project`），1 个后台 subagent `bg-273756-1-...`（status=done, agent=general-purpose）。

| 用例 ID | 结果 | 关键断言 |
|---------|------|---------|
| TC-1 | **PASS** | 4 个 tab 按钮全部渲染（title=会话/文件/Agents/Flows） |
| TC-2 | **PASS** | 切 Agents tab → `subagent-card` 渲染 1 张卡片（WS RPC → runtime JSONL 提取成功） |
| TC-3 | **PASS** | agent=general-purpose，subagentId 前缀=bg-273756-1-，状态点=bg-success（绿），无 spinner（done 正确），task 描述完整 |
| TC-4 | **PASS** | 点卡片 → `subagent-back-btn` 可见，Panel 切换到对话流（含 assistant 回复「扫描结果 根目录文件...」），label=`general-purpose · bg-273756-1-` |
| TC-5 | **PASS** | 点返回 → back-btn 消失（count=0），composer 恢复可见（主 session 还原） |
| TC-6 | **PASS** | Flows tab → `workflow-list-empty` 渲染，文本「暂无工作流」「发起 workflow 后在此查看进度」 |
| TC-7 | **PASS** | 选无 subagent 的 session → Agents tab 显示 `subagent-list-empty`「暂无后台任务」 |
| TC-8 | **PASS** | chat_project→其他 session（0 卡片空态）→切回 chat_project（1 卡片恢复），列表跟随 session.activeId 刷新 |
| TC-9 | **PASS** | subagentCount=1 > 0 时 Agents tab 显示 badge（6px bg-accent 圆点） |

截图：`/tmp/tc0-initial.png`（首屏 Overview）、`/tmp/tc4-subagent-view.png`（subagent 对话流）、`/tmp/tc5-back-to-main.png`（返回主 session）。

## 5. 失败排查

| 现象 | 可能原因 | 排查命令 |
|------|---------|---------|
| CDP 连不上 | dev 没启动 / 端口被占 | `lsof -i :9222` |
| session 列表空 | runtime 没起 / 数据目录不对 | 检查 `~/.xyz-agent-dev/runtime.port` |
| Agents tab 空 | session 无 subagent 调用 / extractor 没提取到 | 看 runtime 日志 `~/.xyz-agent-dev/logs/` |
| 卡片不出现 | WS RPC 失败 / mock 模式 | 确认非 `VITE_MOCK=true` 启动 |
| 点击卡片无反应 | panel store 没切 / virtualId 注入失败 | devtools console 查报错 |
