# Tracing Round 4 — CONVERGED

## 追踪范围

- spec 版本：最终版（verdict: pass，含 §8.5 P1-P6 交付边界 + §9 DEFERRED 清单 + D1-D7 决策 + Round 2/3 修正）
- 追踪视角：**全部 5 视角完整重跑**（无降级）
- 隔离原则：从零审视，未读 round-1/2/3 报告，仅以 spec + 源码为依据
- v1 范围（§8.5）：主聊天流 + session 切换/创建 + 基础空态 + Overview 进入/基本退出 + auto-scroll 基础版 + ⌘N/⌘[/⌘]

## 源码事实核验（F 类）

| 事实 | 核验结果 |
|------|---------|
| ws-client 4 态机 + 15s 心跳 + 指数退避 + HMR + mock 分支 | ✅ `lib/ws-client.ts` 全部不变量落地 |
| mock-ws 仅 ping→pong，无业务数据 | ✅ 53 行最小骨架确认 |
| ipc.ts 仅 4 个 runtime-port 方法 | ✅ 确认（G-035 按需补齐） |
| composables 2 个断链 symlink | ✅ `useChat.test.ts`/`useSlashCommands.test.ts` → 不存在的 `__tests__/`（P0 清理） |
| `SessionStatus` shared 仅 `'active'\|'idle'` | ✅ D6 前端派生 5 态合理 |
| protocol **无 `panel.*` 消息** | ✅ 确认 → panel 布局是前端本地状态（spec §3 R3 panel/tree store 自洽） |
| design-tokens.md 用 `--bg` 非 `--bg-base` | ✅ 证实 G-004 SSOT 判定 |
| main navigation.ts 仅 chat/settings | ✅ 证实 D1 "扩展加 overview 第三 view" 是真实 delta |

## 5 视角追踪

### P1: User Journey

#### UC-2 主聊天流（mock）
- Main Path：开应用 → 见 shell+sidebar 空态 → ⌘N/点入口 new session → composer S1→S2→S5→S6→S1 → 消息流渲染 [VERIFIED: spec UC-2 + D7 mock 永远成功]
- B1 发送中再次按 Enter：S5/S6 期间 send 按钮变 stop，物理上无法重复 send [DERIVABLE: composer 状态机]
- B2 abort（S6）：UC-2 明确 S6→S1 基本流转；G-025 DEFERRED 的是中断回合折叠+重发细节 [§9]
- B3 ⌘N 重复：每次创建新 session（非幂等，by design）[DERIVABLE]
- B4 ⌘[/⌘] 边界：navigation.ts `canGoBack/canGoForward` 守卫 [DERIVABLE: 引用实现]
- B5 Overview 空态退出：卡片点击 N/A，Esc 仍生效 [DERIVABLE: 基本退出]
- B6 流式中切 session：chat store 按 sessionId 分区（CLAUDE.md #7 三层隔离），A 流式继续更新 A 分区，切到 B 显示 B 分区 [DERIVABLE: 架构铁律]

强制检查项：成功下一步 ✅ / 中途放弃（Esc、S6）✅ / 重复操作 ✅ / 权限不足 N/A（单用户桌面）/ 操作超时 ✅（mock 永远成功 D7）

**无新 gap。**

### P2: Data Lifecycle

v1 实体：Session / Message / PanelTree（前端本地）/ NavEntry / mock fixture

- Session Create：mock `session.create` → 全字段 SessionSummary（D7 严格镜像 shared）。初始 status='active' [DERIVABLE]
- Session Read：`session.list`（sidebar 列表）+ `session.switch`+`session.history`（切会话载入）[DERIVABLE: P5 实现]
- Session Update：rename DEFERRED（G2-005）；compact 不在 v1 主路径（触发入口 S3 slash DEFERRED G2-002）[§9]
- Session Delete：DEFERRED（G-013）[§9]
- Message：streaming→complete；error 态 mock 不造（D7），真 stream_error 联调验 [DERIVABLE]
- PanelTree：无 `panel.*` 协议 → 前端本地 store；ratio 持久化 DEFERRED（G-031）[DERIVABLE]

强制检查项：唯一性（mock 生成 ID，D7 不模拟往返）✅ / 外键完整性（sessionId 路由）✅ / 数据量增长（mock 小 fixture，真持久化 DEFERRED G-015）✅ / 必填字段（D7 全字段）✅ / 删除级联（delete DEFERRED）✅

**无新 gap。**

### P3: API Contract

v1 "API" = R4 `api/` 门面 + mock 实现。契约细节 spec 显式引用 `phase-1-api-client.md`（§4 P5 + §8）。

- session.create/list/switch/history、message.send/abort：v1 in-scope [§8.5]
- `session.switch` 返回契约：protocol 无 `session.switched` 消息 → switch 是 fire-and-forget + 前端乐观更新 + 单独 `session.history` 拉取。属 P5 实现细节，spec 已引用 phase-1-api-client.md [DERIVABLE]
- mock 流式事件序：message_start → text_delta* → thinking/tool_call（按 contentBlocks 序）→ complete。P5 实现 [DERIVABLE]
- 错误码：mock 永远成功（D7）；真 error envelope（D10/P0-B）联调阶段 [DERIVABLE]
- 幂等：create 非幂等（by design）；send 在 S5/S6 被状态机阻断 [DERIVABLE]

强制检查项：错误码 ✅（D7+D10）/ 幂等 ✅ / 边界值（空消息 S1 阻断 send）✅ / 分页（session.list v1 小 fixture，真分页联调）✅ / 返回上限（mock 可控）✅

**无新 gap。** API 响应形状属 plan/P5 细节，spec 显式引用文档移交。

### P4: State Machine

v1 状态机：连接 4 态 / Composer S1·S2·S5·S6 / Navigation(chat+overview) / Panel 主从 / SessionStatus 派生 5 态

- Composer S5↔S6 区分（发送瞬间 vs 流式+stop 按钮）：panel/spec.md 定义，spec §4 P4 显式引用 [DERIVABLE]
- Navigation session switch = push 新 chat entry（D1 栈条目={view,sessionId}）；MAX_ENTRIES=50 上限丢最早 [DERIVABLE: 引用 navigation.ts]
- Overview 进入/退出：push overview entry → Esc/卡片点击回 chat [VERIFIED: §8.5]
- SessionStatus 5 态派生（D6）：`isStreaming`→running 等，computed 实现 [DERIVABLE]
- 连接 4 态：mock 模式 connecting(200ms)→connected，不触达 reconnecting（D7）[VERIFIED]
- 僵尸状态：无（reconnecting 可达；mock 跳过）

强制检查项：停留时限（连接 15s 心跳；composer mock 无超时）✅ / 可见性（单用户 N/A）✅ / 非法转换（S5/S6 守卫、nav 边界）✅ / 回滚（abort 基本版 in-scope，细节 DEFERRED）✅ / 僵尸状态 ✅

**无新 gap。**

### P5: Failure Path

v1 mock-first，D7 "mock 永远成功"，绝大多数失败路径在 mock 模式 N/A。

- WS 断连（真模式）：ws-client 重连不变量 [VERIFIED]；v1 mock 不触达
- mock 连接失败：不可能（setTimeout 必触发）[DERIVABLE]
- runtime 未启：useConnection fallback 端口 + 重连；v1 mock N/A [VERIVIED]
- 用户 abort：S6→message.abort→mock 停；基本 S6→S1 in-scope（UC-2），细节 DEFERRED（G-025）[§9]
- 空态：sidebar 空引导 + message-stream 欢迎语（G2-004 定义）[DERIVABLE]
- HMR/reload 中途：mock 全内存重置（D7 + G-015 DEFERRED 持久化）[DERIVABLE]
- WS 非法 JSON：ws-client catch + console.error（no-silent-catch 注释）[VERIFIED]

强制检查项：网络断开（mock N/A，真重连）✅ / 上游超时（mock N/A）✅ / 写入失败（mock N/A）✅ / 并发冲突（单用户 N/A）✅ / 部分成功（mock 原子）✅ / 重复触发（S5/S6 守卫）✅

**无新 gap。**

## 考虑过但判为「可推导，非 gap」的边缘项

| 边缘项 | 判定 | 依据 |
|--------|------|------|
| 快捷键注册位置（main 菜单 vs renderer keydown） | 可推导 | 驱动前端 nav 状态 → renderer 监听；main 菜单改动需 ipc（G-035 按需补）。v1 dev 验收隐含 renderer 侧 |
| 主题初始应用机制（data-theme/class） | 可推导 | design-tokens.md `:root`+`[data-theme]` 结构 + ADR-0021 暗色默认 |
| 窗口拖拽区（-webkit-app-region） | 可推导 | shell/spec.md 引用（P1） |
| Overview 卡片点击数据载入（switch+history） | 可推导 | P5/P6 实现细节，session.switch 契约同上 |
| mock fixture 具体块构成 | 已定义 | G2-006 验收契约（user/assistant text/tool_call/summary/error 主要块） |
| Summary 契约落点（PRODUCT vs Panel） | 已标 AMBIGUOUS | spec 待办标记，plan 阶段确认（非遗漏） |
| `--bg-base` 笔误 | 已跟踪 | G-004 P0 收口 |

## 收敛判定

**CONVERGED。本轮 0 新 gap。**

理由：
1. 5 视角完整重跑，每个强制检查项逐一回答，所有分支要么被 §8.5 交付边界覆盖、要么 §9 DEFERRED、要么从 D1-D7 + 架构铁律（CLAUDE.md #7 三层隔离、R1-R5 分层）+ 引用文档（design-tokens/navigation.ts/panel·shell spec/phase-1-api-client）+ 已验证源码无歧义推导
2. spec 的 DEFERRED 清单（§9）+ P1-P6 交付边界（§8.5）+ D1-D7 决策形成自洽闭环：v1 做「骨架+主路径渲染」，每个 phase 验收基准明确（draft HTML），超出范围的交互统一 hide 策略（G3-002）
3. Stagnation 评估：Round 1（35 gap）→ Round 2（7 scope 边界）→ Round 3（3 一致性）→ Round 4（0）。gap 数单调不增且本轮无实质性新遗漏，符合「gap ≤ 上轮 + 无新实质遗漏 → CONVERGED」的倾向标准
4. 剩余 AMBIGUOUS（Summary 契约）和 G-004 笔误均已显式标记待 plan/P0 处理，非未发现遗漏
