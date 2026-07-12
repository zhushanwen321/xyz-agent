# 08 · real 轨手工测试（给 ai-agent 照着执行）

> 本文不是自动化脚本，而是**结构化测试流程文档**。每个用例包含：前置条件 → 操作步骤 → 每步期望结果 → 验证点。
> ai-agent（或人）照着步骤执行，每步对照期望结果判断 pass/fail。
>
> 为什么不用自动化脚本？real 轨依赖真实 runtime + pi + provider 配置 + 可能调 LLM，环境敏感、CI 不稳定。
> 手工执行更灵活——可以观察中间状态、调试问题、跳过环境不可用的步骤。

## 0. real 轨测试策略

### 0.1 自动化 vs 手工的分工

| 层 | 保留方式 | 理由 |
|---|---|---|
| `e2e/fixtures/launch-app-real.ts` + `waitForRuntime` | **保留代码不删** | 基础设施，未来扩展 real 用例时复用 |
| `e2e/workspace-real.spec.ts` T4.6 | **保留，标注"需前置 runtime"** | 跨进程持久化——不依赖 LLM 但依赖真实 runtime/文件系统，且手工难以模拟（需两个 app 实例 + WS 直连 + 文件落盘对比） |
| 其他 real 场景（RT-01~RT-08） | **走本文档手工执行** | 依赖 LLM/pi 真实执行，结果不可预测，自动化断言无法稳定 |
| real spec 扩展 | **不主动扩展**，有明确需求时再加 | 每加一个 real 用例都要维护环境依赖，ROI 低 |

### 0.2 判断标准：什么场景值得 real 自动化？

一个 real 场景值得写自动化脚本，需同时满足：

1. **不依赖 LLM**——结果可预测（如 session.create 的 record 是同步收尾，不调 LLM）
2. **依赖真实 runtime/文件系统**——mock 轨覆盖不了
3. **手工难以模拟**——如跨进程持久化需要两个 app 实例

三条都满足才写自动化。否则走本文档手工执行。

### 0.3 T4.6 运行方式

```bash
# 1. 先启动真实 runtime（pnpm dev 会自动启动 runtime 子进程）
npm run dev &
# 等 ~/.xyz-agent-dev/runtime.port 文件出现

# 2. 分批构建 real renderer bundle（与 mock bundle 输出冲突，不能同时构建）
#    real bundle 不传 VITE_MOCK
pnpm --filter @xyz-agent/frontend run build  # 不带 VITE_MOCK
pnpm --filter @xyz-agent/electron run build:main
pnpm --filter @xyz-agent/electron run build:preload

# 3. 跑 real E2E
npx playwright test e2e/workspace-real.spec.ts

# 4. 跑完后重建 mock bundle（恢复日常 E2E 环境）
VITE_E2E=true VITE_MOCK=true pnpm --filter @xyz-agent/frontend run build
```

> **注意**：real E2E 和 mock E2E 不能同时跑——两者的 renderer bundle 输出到同一目录（`renderer/dist`），构建期 define 冲突。必须分批构建。

## 1. 前置条件

### 1.1 环境准备

```bash
# 1. 确认 pi 二进制存在
ls apps/electron/resources/pi/pi-darwin-arm64  # macOS arm64

# 2. 确认 dev 数据目录有 provider 配置
ls ~/.xyz-agent-dev/pi/agent/models.json
ls ~/.xyz-agent-dev/pi/agent/settings.json

# 3. 确认 1420 端口没被占用（Vite dev server）
lsof -i :1420 -P | grep node  # 应无输出

# 4. 安装本地 extension（可选，测 GUI 组件渲染需要）
XYZ_EXTENSION_PATHS="\
<path-to>/pi-ask-user:\
<path-to>/pi-goal:\
<path-to>/pi-subagent-workflow:\
<path-to>/pi-todo" \
npm run dev
```

### 1.2 启动 dev app

```bash
npm run dev
# 等待 Electron 窗口出现 + sidebar 渲染完成
# 确认 runtime 日志无错误：tail -f ~/.xyz-agent-dev/logs/runtime-*.log
```

### 1.3 验证 app 健康

| 检查项 | 期望 | 不通过时的排查 |
|---|---|---|
| 窗口出现 | Electron 窗口显示，sidebar 可见 | runtime 启动失败 → 查日志 |
| 会话列表 | 侧栏显示已有 session（或空态） | WS 连接失败 → 查 runtime 端口 |
| 新建任务 | 点「新建任务」→ Landing 态渲染 | renderer 加载失败 → 查 console |
| composer 可输入 | 输入框可聚焦、可输入 | — |

## 2. 核心用例

### RT-01: 新建 session → 发消息 → 收到真实流式回复

**验证目标**：runtime → pi → LLM 全链路打通

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 点「新建任务」→ 选一个目录（或用已有目录） | Landing 态 → composer 可见 |
| 2 | 输入「你好，简单回复一句话」+ Enter | 消息发出，侧栏 session 显示蓝色转菊花 |
| 3 | 等待 3-30 秒 | assistant 回复开始流式出现（逐字） |
| 4 | 流式完成 | 转菊花变绿色圆点，回复内容完整 |
| 5 | 回复内容 | 是对「你好」的合理回复（非错误信息） |

**失败排查**：
- 转菊花一直蓝色不回复 → pi 没连上 LLM provider → 查 `~/.xyz-agent-dev/pi/agent/models.json` 配置
- 回复报错 → 查 runtime 日志 `tail -f ~/.xyz-agent-dev/logs/runtime-*.log`
- session 卡死 → pi 子进程异常 → 查 `~/.xyz-agent-dev/logs/pi-*.jsonl`

### RT-02: tool call 真实执行（read/bash）

**验证目标**：pi 工具调用 → runtime 事件翻译 → 前端 Block.vue 渲染

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 在 session 中输入「读一下 package.json 的内容」+ Enter | 消息发出，转菊花 |
| 2 | 等待 | 消息流出现 tool 块（read 工具，收起态） |
| 3 | 点击 tool 块 header 展开 | 显示 toolName(read) + 参数 + 输出 |
| 4 | 输出内容 | 含 `package.json` 的真实文件内容（非 mock 的「…文件内容…」） |
| 5 | assistant 回复 | 基于 package.json 内容的合理回复 |

**验证点**：tool 块的输出是**真实文件内容**（mock 轨是「…文件内容（mock）…」，real 轨是实际文件内容）。

### RT-03: extension GUI 组件渲染（需安装 extension）

**验证目标**：extension 推送 `__gui__` → 前端 GuiComponentRenderer 渲染真实组件

**前置**：用 `XYZ_EXTENSION_PATHS` 启动 dev，安装了 pi-todo / pi-goal / pi-subagent-workflow

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 让 AI 使用 todo 工具（如「用 todo 记录 3 个任务」） | tool 块出现 |
| 2 | 展开 tool 块 | 渲染 `list-tree`（非 JSON 文本） |
| 3 | list-tree 内容 | 含 3 个 todo 项，状态图标正确（pending=dot / in_progress=circle / completed=check） |
| 4 | 让 AI 使用 goal 工具（如「设定一个目标」） | tool 块出现 |
| 5 | 展开 goal tool 块 | 渲染 `card` 嵌套 `stats-line`（非 JSON 文本） |

**验证点**：tool 块展开后是**结构化 UI 组件**（卡片/进度条/树），不是 `{"variant":"elevated","body":[...]}` 这样的 JSON 文本。如果是 JSON 文本说明 GuiComponentRenderer 路由失败或 extension 没推 `__gui__`。

### RT-04: SideDrawer widget 渲染（需安装 extension）

**验证目标**：extension 推送 `extension:widgetGui` → SideDrawer 渲染

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 让 AI 执行一个会推 widget 的操作（如 subagent workflow） | — |
| 2 | 点 PanelHeader 右侧的 drawer-toggle 按钮（PanelRight 图标） | SideDrawer 打开 |
| 3 | terminal tab | 如果 extension 推了 terminal widget，显示结构化组件或纯文本 |
| 4 | 切到 browser tab | 如果 extension 推了 browser widget，显示结构化组件 |
| 5 | 切到 git tab | 显示 git 状态（如果是 git 仓库） |

**验证点**：SideDrawer 的 widget 是**实时推送**的（extension 执行时出现），不是持久化的（session 重开后清空）。

### RT-05: session 隔离（多 session 并行）

**验证目标**：两个 session 独立运行，互不干扰

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 创建 session A，发送一条长消息（如「写一个 100 行的 Python 脚本」） | A 开始流式 |
| 2 | A 流式中，点「新建任务」创建 session B | B 的 Landing 态正常渲染（不被 A 的流式误伤） |
| 3 | B 中输入消息 + Enter | B 也开始流式 |
| 4 | 切回 A | A 的流式仍在进行（未被 B 打断） |
| 5 | 等两个都完成 | 各自的回复内容独立、正确 |

### RT-06: abort 真实中断 pi

**验证目标**：点停止按钮 → pi 子进程真实中断

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 发送一条需要长时间执行的消息（如「分析整个项目的架构」） | 流式开始 |
| 2 | 流式中点停止按钮 | 按钮消失，session 状态变回 idle |
| 3 | pi 子进程 | 不再占 CPU（`top -pid <pi_pid>` 确认） |
| 4 | 再发一条消息 | 正常回复（session 没卡死） |

### RT-07: 错误处理（provider 不可用）

**验证目标**：LLM 报错时 UI 正确处理

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 临时改 `~/.xyz-agent-dev/pi/agent/models.json` 为无效 API key | — |
| 2 | 发消息 | 消息流出现错误提示（不是 UI 卡死） |
| 3 | session 状态 | 转菊花消失，回到 idle 态 |
| 4 | 恢复 API key 后再发消息 | 正常回复 |
| 5 | 检查 runtime 日志 | 有错误日志记录（不是静默失败） |

### RT-08: session 重开后历史完整

**验证目标**：关掉 session 重开，对话历史完整呈现

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 在 session A 中完成一轮对话（含 thinking + tool + text） | 消息流完整 |
| 2 | 切到 session B，再切回 A | A 的历史完整（不丢失） |
| 3 | 重启 app | — |
| 4 | 打开 session A | 历史完整加载（thinking + tool + text + fileChanges） |
| 5 | tool 块展开 | tool 输出内容仍在（持久化在 session JSONL 里） |

## 3. 已知盲区（mock 轨测不到的）

以下场景**只能通过 real 轨验证**，mock 轨的盲区：

| 盲区 | 对应用例 | 说明 |
|---|---|---|
| runtime ↔ pi RPC 协议真实字段 | RT-01/02 | mock 是简化版，字段可能漂移 |
| pi 工具调用真实执行 | RT-02 | mock 的 tool output 是固定文本 |
| extension `__gui__` 真实推送 | RT-03/04 | mock 的 `__gui__` 是构造的固定数据 |
| WS 连接生命周期 | RT-05/06 | mock 不走 WS |
| 错误处理真实触发 | RT-07 | mock 不模拟 provider 报错 |
| session JSONL 持久化 | RT-08 | mock 不写文件 |
| pi 子进程 CPU/内存行为 | RT-06 | mock 不起 pi 进程 |

## 4. 执行记录模板

每次执行 real 轨测试时，复制以下模板记录结果：

```markdown
## real 轨测试执行记录

- 日期：YYYY-MM-DD
- 执行者：ai-agent / 人工
- 环境：dev / prod，pi 版本 x.x.x

| 用例 | 结果 | 备注 |
|---|---|---|
| RT-01 | ✅/❌ | |
| RT-02 | ✅/❌ | |
| RT-03 | ✅/❌ | 跳过原因：未安装 extension |
| RT-04 | ✅/❌ | |
| RT-05 | ✅/❌ | |
| RT-06 | ✅/❌ | |
| RT-07 | ✅/❌ | |
| RT-08 | ✅/❌ | |

失败用例详情：
（记录失败步骤、错误信息、截图路径）
```
