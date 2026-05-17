# E2E 测试计划 — Agent Subagent 使用

## 1. 测试环境

| 项目 | 配置 |
|------|------|
| 应用 | xyz-agent (Electron dev mode `npm run dev`) |
| Sidecar | 自动启动，连接 pi RPC |
| pi | 需要配置有效的 API key，subagent extension 已加载 |
| 浏览器 | Electron Chromium (dev tools 可用) |
| Agent 数据 | `~/.pi/agent/agents/` 下至少有 1 个 flat `.md` 文件 |

**前置检查**（对应 Plan T0）：
```bash
# 1. subagent extension 存在
ls ~/.pi/extensions/subagent/index.ts

# 2. agent 文件存在
ls ~/.pi/agent/agents/*.md | head -3

# 3. xyz-agent 导入的 agent 列表中有 enabled agent
cat src-electron/.xyz-agent/agents.json | python3 -c "import json,sys; agents=json.load(sys.stdin); enabled=[a for a in agents if a.get('enabled')]; print(f'{len(enabled)} enabled agents')" 
```

## 2. 测试组 & 依赖关系

```
G1: 基础设施验证
 └→ G2: SlashMenu Agent 命令
   └→ G3: 手动触发 Subagent
     └→ G4: SubagentRenderer 渲染
       └→ G5: LLM 自动调用
         └→ G6: 边界与错误
```

| 组 | 依赖 | 说明 |
|----|------|------|
| G1 | 无 | 验证 pi + subagent extension 就绪 |
| G2 | G1 | SlashMenu 展示 agent 列表 |
| G3 | G2 | 用户手动触发 agent 执行 |
| G4 | G3 | 聊天流中 subagent 卡片渲染 |
| G5 | G4 | LLM 自动调用 subagent |
| G6 | G5 | 错误、边界、空状态 |

## 3. 测试用例

### G1: 基础设施验证

| ID | 用例 | 操作步骤 | 验证方式 |
|----|------|---------|---------|
| TC-1-01 | subagent extension 加载 | 启动 xyz-agent → 创建新 session → 发送任意消息 | **L1-WS**: sidecar 日志中无 extension 加载错误；pi 进程启动成功 |
| TC-1-02 | agent 文件可被 pi 发现 | 启动 pi → 检查 tool list | **L1-WS**: pi 启动日志中 subagent tool 注册成功（或通过 RPC 验证可用 tool 包含 subagent） |
| TC-1-03 | xyz-agent agent 列表加载 | 启动 xyz-agent → 打开 Settings → Agent 页面 | **L2-DOM**: Agent 列表展示至少 1 个 agent，且有 enabled 状态 |

### G2: SlashMenu Agent 命令

| ID | 用例 | 操作步骤 | 验证方式 |
|----|------|---------|---------|
| TC-2-01 | SlashMenu 展示 agent 命令 | 在聊天框输入 `/` → 查看 SlashMenu | **L2-DOM**: 列表中出现 `agent:xxx` 格式的条目；source 标签显示 "agent"（蓝色）；与 "skill"（accent 色）和 "command"（灰色）视觉区分 |
| TC-2-02 | 仅展示 enabled agent | Settings 中 disable 一个 agent → 新 session → 输入 `/` | **L2-DOM**: SlashMenu 中不出现被 disable 的 agent |
| TC-2-03 | 选择 agent 预填输入框 | 在 SlashMenu 选择一个 agent 条目 | **L2-DOM**: 输入框文本变为 `/agent:xxx `（带尾部空格，等待用户输入 task） |
| TC-2-04 | 无 enabled agent 时不展示 | disable 所有 agent → 新 session → 输入 `/` | **L2-DOM**: SlashMenu 只显示 builtin 命令（clear/compact/help），无 agent 分组，不报错 |

### G3: 手动触发 Subagent

> **T3 编码前置要求**：sidecar `message.send` handler 中必须添加 `console.log('[sidecar] subagent prompt:', agentPrompt)` 日志，TC-3-02 依赖此日志。

| ID | 用例 | 操作步骤 | 验证方式 |
|----|------|---------|---------|
| TC-3-01 | 手动触发 — 前端到 sidecar 链路 | (1) 打开 DevTools Console（渲染进程）；(2) 选择 agent → 输入 task 文本 → 点击发送；(3) 检查 Console 中 ChatInput emit 的 payload；(4) 检查 DevTools Network → WS → Messages tab，过滤关键字 `subagent` | **L2-Console**: ChatInput handleSend 输出的 payload 包含 `subagent: { agent: "xxx", task: "yyy" }`。**L1-WS**: WS `message.send` 消息 payload 包含 `subagent` 字段。两步验证确保 ChatInput → PaneSessionView → useChat → WS 全链路不丢失 |
| TC-3-02 | sidecar 构造 XML 指令 | TC-3-01 触发后检查 sidecar 终端日志 | **L1-WS**: sidecar 日志 `[sidecar] subagent prompt:` 行包含 `<tool_call tool="subagent">` XML 标记 |
| TC-3-03 | pi 执行 subagent tool | TC-3-01 触发后等待 pi 响应 | **L1-WS**: WS 收到 `message.tool_call_start` 事件（toolName = "subagent"）；随后收到 `message.tool_call_end` 事件（output 非空） |
| TC-3-04 | 普通 text 发送不受影响 | 不选 agent，直接输入文本发送 | **L1-WS**: WS 消息 payload 不含 `subagent` 字段；pi 正常响应文本 |

### G4: SubagentRenderer 渲染

| ID | 用例 | 操作步骤 | 验证方式 |
|----|------|---------|---------|
| TC-4-01 | running 状态渲染 | TC-3-01 触发后观察聊天流 | **L2-DOM**: 出现 ToolCallCard（header 显示 "subagent" + spinner + 耗时计数）；body 展开（agent name + task 描述） |
| TC-4-02 | completed 状态渲染 | 等待 agent 执行完成 | **L2-DOM**: ToolCallCard header spinner 变为 ✓；body 显示 agent 输出文本（在 `<pre>` 块中） |
| TC-4-03 | agent name 显示 | TC-4-01/02 过程中检查 | **L2-DOM**: body 中 "Agent: xxx" 显示正确的 agent 名称（与 SlashMenu 选择的一致） |
| TC-4-04 | error 状态渲染 | 触发一个不存在的 agent 名称 | **L2-DOM**: ToolCallCard header 显示 ✗ + 红色边框；body 显示错误信息 |
| TC-4-05 | LLM 自动调用也用 SubagentRenderer | G5 中 LLM 自动调用 subagent 时 | **L2-DOM**: tool call card 同样使用 SubagentRenderer（body 显示 agent name + task） |

### G5: LLM 自动调用

| ID | 用例 | 操作步骤 | 验证方式 |
|----|------|---------|---------|
| TC-5-01 | LLM 自动判断委派 | 发送消息："请分析 src-electron/sidecar/src/server.ts 的代码质量" 或类似需要委派的请求 | **L1-WS**: pi 自行调用 subagent tool（`message.tool_call_start` toolName = "subagent"）|
| TC-5-02 | 自动调用结果渲染 | TC-5-01 触发后等待完成 | **L2-DOM**: 聊天流中出现 SubagentRenderer 卡片 + LLM 后续回复 |

### G6: 边界与错误

| ID | 用例 | 操作步骤 | 验证方式 |
|----|------|---------|---------|
| TC-6-01 | agent 不存在 | 手动构造发送不存在的 agent name | **L2-DOM**: SubagentRenderer error 状态显示 "Unknown agent" 或类似错误信息 |
| TC-6-02 | task 为空发送 | 选择 agent → 不输入 task → 直接发送 | **L1-WS**: sidecar 日志显示构造了 `subagent` 指令（task 为空字符串）。**L2-DOM**: SubagentRenderer 显示 agent 执行结果或 error 状态（取决于 pi subagent tool 对空 task 的处理）。无论成功或报错，前端不崩溃、不卡死 |
| TC-6-03 | task 含特殊字符 | 输入 task 包含 `<>&"` 字符 | **L1-WS**: sidecar 日志中 XML 指令中特殊字符被正确转义/去除；pi 不因 XML 格式错误崩溃 |
| TC-6-04 | 长输出截断 | 触发一个输出很长的 agent | **L2-DOM**: SubagentRenderer output 区域有 max-height + 滚动条，不撑破布局 |
| TC-6-05 | 并发 session 隔离 | 创建两个 session → 各自手动触发不同 agent → 等待完成 | **L1-WS**: 两个 session 的 tool_call_start/tool_call_end 各自携带正确的 sessionId。**L2-DOM**: 各 session 聊天流的 SubagentRenderer 显示各自正确的 agent name 和输出 |
| TC-6-06 | WS 断连时 subagent 状态 | agent 执行中断开 sidecar WS | **NOTE**: 当前未实现断连恢复，记录为已知限制。**L2-DOM**: 前端不崩溃，SubagentRenderer 停留在 running 状态或显示连接断开提示 |

## 4. 验证层级策略

| 层级 | 本项目适配 | 工具 |
|------|-----------|------|
| L1-WS | WebSocket 消息 payload 检查 | Chrome DevTools → Network → WS tab / sidecar console 日志 |
| L2-DOM | UI 元素存在、文本内容、状态 | Chrome DevTools → Elements / 手动目视 |
| L3-Visual | 截图对比（可选） | 手动截图，非自动化 |
| L4-FS | 文件系统检查（agent 文件存在） | `ls`/`cat` 命令 |

> 本项目是 Electron 桌面应用，无 HTTP API 和数据库。L1 用 WS 消息检查替代 API 检查，L4 用文件系统检查替代 DB 检查。L3（视觉对比）为可选项，不阻塞验收。

## 5. 通过/回退判定

| 结果 | 处理 |
|------|------|
| 全部 PASS | 通过，进入编码阶段 |
| G1 有 FAIL | 需修复基础设施（环境配置问题），重跑 G1 |
| G2-G4 有 FAIL | 需回退编码修复前端代码，重跑失败组 |
| G5 有 FAIL | 检查 pi subagent extension 是否正常工作 |
| G6 有 FAIL | 非阻塞，记录 issue 后续修复 |
