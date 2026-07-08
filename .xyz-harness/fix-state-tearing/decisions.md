---
topic: fix-state-tearing
created_at: 2026-07-08
---

# 决策账本 — fix-state-tearing

> append-only 账本。每条 D 类决策经 ask_user 拍板或 agent opinionated 自决后即时 append。
> 字段定义见 `loop-skeleton.md` Step 1.2 schema。

## 决策账本（append-only，一行一条决策）

> 表头与字段顺序固定。`superseded_by` 空列留空；有值时原行 `status` 必须同步改 `revisited`。

| id | decision | rationale | classification | confirmed_by | stage | source | status | superseded_by |
|----|----------|-----------|----------------|--------------|-------|--------|--------|---------------|
| D-001 | agent 忙时发送采用 B 策略（显式分流：steer 追加上下文 / 停止重来） | xyz-agent 已有 steer/followUp 基建 + QueueBubble 展示；A 太死板（长任务无法补充上下文），C 静默排队易困惑 | D-不可逆 | ask_user | mid-plan | [from: fix-state-tearing §1] | confirmed | |
| D-002 | L1+L2+L3 一次到位（派生模型 + send.rejected + 统一收口全做） | 撕裂根因是命令式 flag 模型，只做 L1 止血未来其他路径（超时/断连）仍复发；L3 删 timer 补丁是派生模型的必然结果 | D-不可逆 | ask_user | mid-plan | [from: fix-state-tearing §2] | confirmed | |
| D-003 | 流式超时阈值可配置（env），默认 24 小时 | 用户决策：让 agent 跑完不误杀。派生模型下超时语义变为防 agent 真卡死（非防 flag 永挂），24h = 实质禁用超时兜底，仅极端情况触发 | D-不可逆 | ask_user | mid-plan | [from: fix-state-tearing §10 D-3] | confirmed | |
| D-004 | steer UX 复用现有 QueueBubble + S6 呼吸 ring + pending 气泡，不加额外 toast | QueueBubble 已实现（Composer 上方双队列分栏，只读展示），反馈已完备；加 toast 是噪音 | D-可逆 | ask_user | mid-plan | [from: fix-state-tearing §10 D-5] | confirmed | |
| D-005 | isGenerating 用 computed scan 实现（非增量 Set 维护） | 简单性优先；典型会话 <1000 条 message，scan 微秒级；消除手动维护一致性的复杂度 | D-可逆 | agent-opinionated | mid-plan | [from: fix-state-tearing §10 D-1] | confirmed | |
| D-006 | 新增 send.rejected WS 类型（不复用 message.error） | message.error 副作用（进对话流 + 翻流式态）与操作拒绝语义正交，复用必污染（本次 bug 根因） | D-不可逆 | agent-opinionated | mid-plan | [from: fix-state-tearing §10 D-2] | confirmed | |
| D-007 | streamingTimer 假收口行为变更为收口实体（finalizeSession） | 当前行为（只翻 flag 不收口）本身就是 bug；refactor 保持的是正确行为等价，非保持 bug | D-不可逆 | agent-opinionated | mid-plan | [from: fix-state-tearing §10 D-4] | confirmed | |
| D-008 | abort 终态保持 complete（不映射 error） | 现行 message-dispatcher 广播 message.complete{stopReason:aborted} → effects 产出 complete；refactor 保持现行行为，abort→error 的语义改进属独立 ticket（非本 topic scope）。arch reviewer SF-1 发现 §5 与 BC-2 矛盾，此决策消除矛盾 | D-不可逆 | agent-opinionated | mid-plan | [from: fix-state-tearing §5] | confirmed | |
| D-009 | send.rejected 触发机制为 runtime 预检（sendPrompt 入口检查 isGenerating，忙则广播 send.rejected 不调 pi.prompt） | 比靠 pi 错误字符串匹配更可靠，不依赖 pi 协议细节。arch reviewer SF-3 发现边界契约空洞，此决策填充 | D-不可逆 | agent-opinionated | mid-plan | [from: fix-state-tearing §8] | confirmed | |
| D-010 | finalizeSession sealed 不变式：收口后该 session 后续 streaming 事件（text_delta/thinking_delta/tool_call_*）幂等丢弃 | 派生模型引入 finalizeSession 后，晚到事件可污染终态实体（handler 不检查 status）。arch reviewer SF-2 发现此缺口 | D-不可逆 | agent-opinionated | mid-plan | [from: fix-state-tearing §4] | confirmed | |
| D-011 | toolCall 诚实态不变式：running toolCall 收口时一律 → end_not_received（除 error/stream_error→error），不直接 completed；迟到 tool_call_end 覆盖到 completed | 异常猎手 F3 发现 code-arch §2 表（normal→completed）与 NFR M8（诚实态）+ 现行代码矛盾。统一为诚实态默认，避免 tool_call_end 丢失时虚假成功 | D-不可逆 | agent-opinionated | mid-detail-plan | [from: anomaly F3] | confirmed | |
| D-012 | useConnection 多 session 收口：加 finalizeAllStreaming(reason) helper，遍历所有 streaming session 调 finalizeSession | 异常猎手 F1 发现只清 active session 会漏后台 streaming session，违背 G1。新模型无全局 flag，必须逐个收口实体 | D-不可逆 | agent-opinionated | mid-detail-plan | [from: anomaly F1] | confirmed | |
| D-013 | message.error/stream_error handler 保留 errorText 数据流：finalizeSession 加 errorText? 参数 | 异常猎手 F2 发现骨架丢 payload，错误文本丢失 + 无前置流场景错误消息不进对话流（违反规则 #3） | D-不可逆 | agent-opinionated | mid-detail-plan | [from: anomaly F2] | confirmed | |
| D-014 | send.rejected 只由 runtime 预检触发；catch 路径一律 message.error（不分类） | 异常猎手 F6 + NFR SV-4 决断：D-009 禁字符串匹配 + 无可靠结构化判据区分 pi 拒绝。catch 分类不可靠，message.error 是安全降级 | D-不可逆 | agent-opinionated | mid-detail-plan | [from: anomaly F6] | confirmed | |
| D-015 | pendingSend 空窗期（ack→message_start）保留 30s timer 兜底（dispatchingTimer 语义迁移到 pendingSendTimer） | 异常猎手 F4 发现删 dispatchingTimer 后，pi 静默卡死在 ack 后会导致 isActive 恒 true 无限期（24h streamingTimer 不覆盖此阶段）。相对当前 30s auto-recovery 是回归 | D-不可逆 | agent-opinionated | mid-detail-plan | [from: anomaly F4] | confirmed | |
| D-016 | XYZ_STREAMING_TIMEOUT_MS env 经 IPC 从主进程读（非 renderer import.meta.env） | 异常猎手 F5 发现 Vite renderer 不暴露 XYZ_ 前缀（无 envPrefix/define 配置），import.meta.env.XYZ_* 永远 undefined。ENV_WHITELIST 是主进程机制不适用 renderer | D-不可逆 | agent-opinionated | mid-detail-plan | [from: anomaly F5] | confirmed | |
| D-017 | useConnection WS state watch（瞬态断连）不触发 finalizeSession，只 rejectAll pending；仅 onRuntimeFailed/onRuntimeRestarting 触发收口 | 异常猎手 F7 发现瞬态断连（ws-client 自动重连）不应收口（pi 仍活，流可恢复），否则网络抖动会错误收口为 error | D-不可逆 | agent-opinionated | mid-detail-plan | [from: anomaly F7] | confirmed | |
