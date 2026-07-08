---
verdict: pass
backfed_from: []
---

# 对话流状态撕裂修复

## 1. 业务目标

### 目标树
- **G1: UI 状态与实体状态永久一致** — 成功标准：任意时刻，"停止按钮可见" ⟺ "存在 status=streaming 的 message 或 status=running 的 toolCall"，不存在两者矛盾的态
  - G1.1: 消除所有"只翻 flag 不收口实体"的旁路
  - G1.2: 异常路径（超时/断连/崩溃/abort）与正常路径走同一收口逻辑
- **G2: 长任务期间 UI 持续准确** — 成功标准：agent 运行 >5min（glm-5.2 等慢模型）时 UI 不撕裂
- **G3: agent 忙时用户可追加上下文（B 策略）** — 成功标准：生成中用户发送消息自动转 steer，不被静默丢弃或误报错误

### 达成路线
| 目标 | 路线/策略 | 对应用例 |
|------|---------|---------|
| G1 | isStreaming 从命令式 flag 重构为从 message 实体派生的 computed；统一收口出口 finalizeSession | UC-1, UC-3, UC-4 |
| G2 | 超时改为收口实体（非翻 flag）；阈值适配慢模型 | UC-3 |
| G3 | Composer 发送按钮按 isActive 路由 send/steer；already processing 走独立 send.rejected 通道 | UC-2 |

## 2. 业务用例

### UC-1: 正常对话流（baseline，行为等价）
- **Actor**: 用户
- **前置条件**: session idle
- **主流程**: 用户输入 → 发送 → assistant 流式回复（text/tool）→ 完成 → 回 idle
- **后置状态**: message 实体 status=complete，toolCall status=completed，UI 停止按钮消失
- **关联目标**: G1（基线，不退化）
- **AC**: AC-1.1 [正常] 单轮对话完成后 isGenerating=false 且 message.status=complete

### UC-2: agent 忙时追加上下文 / 停止重来（B 策略）
- **Actor**: 用户
- **前置条件**: agent 生成中（isActive=true）
- **主流程（追加-键盘）**: 用户输入 → ⏎ → 自动路由为 steer → 消息入 steering 队列 → 当前回合后投递
- **主流程（追加-鼠标）**: 用户输入 → 点击发送位（busy 时渲染为 steer 入口）→ 转 steer（F4 搭便车新交互）
- **替代流程（停止重来）**: 用户点停止 → abort → 回 idle → 重新发送
- **异常流程**: steer 失败 → 回滚 pending + toast，不动 isGenerating
- **后置状态**: steer 成功后 pending→complete（queue_update 驱动）；isGenerating 全程不变
- **关联目标**: G3
- **AC**:
  - AC-2.1 [正常] 生成中键盘 ⏎ → 走 steer 路径（不触发 prompt RPC）
  - AC-2.2 [正常] 生成中鼠标点发送位 → 转 steer（F4，与键盘对齐）
  - AC-2.3 [正常] 生成中点停止 → abort → isGenerating 变 false + 实体收口
  - AC-2.4 [异常] steer 失败 → isGenerating 不变 + pending 回滚 + toast

### UC-3: 长任务持续生成（>5min）
- **Actor**: agent（glm-5.2 等慢模型）
- **前置条件**: agent 正在生成单个长 message
- **主流程**: 流式 delta 持续到达 → UI 持续显示活跃态（停止按钮可见 + 气泡 streaming）
- **异常流程**: 超时兜底触发 → 收口实体（非仅翻 flag）→ UI 准确反映"已结束"
- **关联目标**: G2
- **AC**:
  - AC-3.1 [正常] 长任务期间 isGenerating 持续 true，停止按钮持续可见
  - AC-3.2 [边界] 超时触发 → 实体收口为 error/end_not_received → isGenerating 派生 false

### UC-4: 异常路径统一收口
- **Actor**: 系统（runtime 崩溃 / WS 断连 / 超时 / abort）
- **前置条件**: agent 生成中
- **主流程**: 异常事件 → finalizeSession → 所有 streaming message→终态 + running toolCall→收口 + pendingSend 清理
- **后置状态**: isGenerating 派生 false（因实体已终态），无残留 streaming/running
- **关联目标**: G1
- **AC**:
  - AC-4.1 [异常] runtime 重启 → useConnection 调 finalizeSession → 所有 streaming 实体收口 → isGenerating=false
  - AC-4.2 [异常] 超时 → finalizeSession('timeout') → 实体收口
  - AC-4.3 [异常] abort → 前端乐观清 pendingSend + runtime 广播 `message.complete` (stopReason=aborted) 兑底收口实体
  - AC-4.4 [异常] message.stream_error（pi 发 error 不发 agent_end）→ effects handler 调 finalizeSession('stream_error')
  - AC-4.5 [异常] message.error（pi 真流错误）→ effects handler 调 finalizeSession('error')

### UC-5: 编辑重发（editAndResend，行为等价基线）
- **Actor**: 用户
- **前置条件**: session idle，存在历史 user 消息
- **主流程**: 编辑最后一条 user 消息 → truncate（含该消息及后续）→ appendUser 新文本 → send
- **后置状态**: 与 UC-1 send 等价（pendingSend 空窗 + message_start 接管）
- **关联目标**: G1（行为等价，不退化）
- **AC**: AC-5.1 [正常] editAndResend 的 pendingSend 生命周期与 send 对称

### UC-6: landing 态首发（submitFirstMessage）
- **Actor**: 用户
- **前置条件**: 新 session（无 sessionId）
- **主流程**: 输入 → create session → send（create 后有 sessionId，pendingSend.add）
- **关联目标**: G1
- **AC**: AC-6.1 [正常] landing 首发的空窗期由 pendingSend 覆盖（create 后 add）

## 3. 数据流转

### 数据流
```
pi 子进程（agent 循环）
  → runtime event-interpreter（翻译 pi 事件为 WS 帧）
  → WS message.* / send.rejected
  → renderer useChat.ensureStreamSubscription
  → chat.applyMessageEvent（effects 注册表）
  → messages[] 实体状态变更（唯一真值源）
  → isGenerating computed 派生（自动）
  → Composer/Panel/Block 响应式渲染
```

### 数据清单
| 数据 | 来源 | 处理 | 消费者 |
|------|------|------|--------|
| messages[] | pi 事件经 effects | 实体状态机转换 | isGenerating computed + UI 渲染 |
| isGenerating | messages 派生 | computed | Composer 停止按钮 / Panel 守卫 |
| pendingSend | useChat.send/editAndResend（send 空窗，接管 dispatchingSessionId） | Set 增删（add 在 send 前，delete 在 message_start 正常/finalizeSession 异常） | isActive（预期态补充） |

## 4. 功能清单

| 编号 | 功能 | 对应用例 | 关联目标 |
|------|------|---------|---------|
| F1 | isStreaming → computed isGenerating(sid) 派生重构（per-session，防跨 session 误伤） | UC-1,3,4,7,8 | G1 |
| F2 | finalizeSession 统一收口出口（取代 resetActive，useConnection 调用方迁移） | UC-4,8 | G1 |
| F3 | send.rejected 独立通道（already processing） | UC-2,6 | G3 |
| F4 | Composer B 策略鼠标发送路由（busy 时发送位转 steer，搭便车新交互） | UC-2 | G3 |
| F5 | 超时兜底改为收口实体 + 可配置阈值 + message.error/stream_error handler 迁移 | UC-3,8 | G1,G2 |

## 5. UI/UX 场景

### 交互流（Composer 发送按钮）
- **idle（isActive=false）**: 显示发送按钮，点击 → send
- **busy（isActive=true）**: 显示停止按钮（始终）+ 发送仍可点 → 自动转 steer（追加上下文）
- **停止重来**: 点停止 → abort → 回 idle → 正常发送

## 6. 系统间功能关联

| 关联系统 | 依赖方向 | 交互方式 | 契约稳定性 |
|---------|---------|---------|-----------|
| pi 子进程 | runtime → pi（RPC） | prompt/steer/followUp/abort | 稳定（不改 pi） |
| runtime ↔ renderer | WS | message.* + 新增 send.rejected | 本 topic 扩展 |

## 7. 约束

- **不改 pi 协议**：pi 子进程行为不动，只动 runtime 翻译层和 renderer
- **行为等价**：refactor 模式，现有正常路径行为保持（行为契约见架构 §12）
- **测试框架 vitest**：禁止 node:test（项目规范）
- **超时可配置**：`XYZ_STREAMING_TIMEOUT_MS` env，默认 24h（D-003）。语义：24h = 用户接受「pi 静默卡死时靠手动点停止」，timer 机制保留但实质不触发；runtime 重启/WS 断连事件是主要卡死检测手段
- **超时行为变更（BC）**：原 5min 硬编码 → 可配置 24h，且超时从“翻 flag”改为“收口实体”（system-arch BC-3）

## 8. 不做

- 不改 pi 的 turn_end/agent_end 事件语义（event-interpreter 的“complete 由 agent_end 独占”设计保留）
- 不做多 panel 并发流式（G-023 仍 DEFERRED）
- 不改 session 隔离机制（规则 #7 不动）
- 不加新 UI 组件（复用现有 Composer/Block/Toast/QueueBubble）
  - **例外**：F4 鼠标发送位 busy 时转 steer 是 B 策略配套的搭便车新交互（模板三态微调，非新组件）

## 决策记录

核心决策已在 mid-plan 阶段经 ask_user / agent-opinionated 拍板，见 `decisions.md`：
- D-001: B 策略（忙时显式分流）— ask_user
- D-002: L1+L2+L3 一次到位 — ask_user
- D-003: 超时可配置默认 24h — ask_user
- D-004: steer UX 复用 QueueBubble — ask_user
- D-005~D-007: 派生实现/send.rejected/timer 变更 — agent-opinionated（定稿暴露）

## 待确认

- BC-5 abort 复活 steer：已知风险，本 topic 不修（依赖 pi RPC 扩展 clear_queue），mid-detail-plan NFR 标注
