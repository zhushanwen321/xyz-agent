# Tracing Round 2

> **结论：NOT CONVERGED** —— 7 个新 gap（6 D 类 scope 边界未定 + 1 F/K 类 mock fixture 丰富度未定）。均为 v1 in-scope 路径上的未定义项，不在 §9 DEFERRED 清单内。

## 追踪范围

- **追踪对象**：spec.md（verdict: pass，含 D1-D7 决策 + §9 DEFERRED 清单 G-004..G-035 + §8.5 v1 scope 裁决）
- **追踪的视角**：5 视角全部完整追踪（无降级）
  - P1 User Journey（完整）
  - P2 Data Lifecycle（完整，实体 = 前端 store 状态 Session/Message/Panel/Nav/Connection）
  - P3 API Contract（完整，契约 = api/ 层 + shared/protocol.ts WS 协议）
  - P4 State Machine（完整，5 个状态机：Connection / Composer S1-S9 / SessionStatus 5 态 / Panel 单双 / Navigation views）
  - P5 Failure Path（完整追踪，但 mock-first + D7「v1 永远成功」使多数失败路径天然 N/A，已逐项确认落入 DEFERRED 或 mock 豁免）
- **追踪的 v1 范围**（§8.5）：主聊天流（UC-1/UC-2）+ session 切换/创建（UC-3 基本部分）+ 基础空态 + Overview 进入
- **DEFERRED 豁免**：§9 清单内项（G-013/015/016/018/019/020/021/022/023/024/025/027/029/031/032/033/034/035 + G-004/008 设计稿不一致）不计为新 gap

## 隔离声明

本追踪未读 `tracing-round-1.md`（保持隔离上下文，从零重跑）。所有 gap 判定基于 spec.md 现状文本 + 源码事实独立得出。

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G2-001 | D | P1 / P4 | OP-U04 / SM5 | **Overview v1 退出路径未定义**：§8.5 纳入「Overview 进入」，但 G-020 把 overview/spec.md 定义的全部退出（点卡片载入 / Esc / ⌘⇧O）都 DEFERRED。`overview/spec.md` 只定义入口（按钮 + ⌘⇧O），未定义「再次点击入口按钮 toggle off」。v1 用户进入 Overview 后如何回到 chat？需明确最小退出机制（如按钮 toggle off），否则是单向陷阱。 |
| G2-002 | D | P4 / P1 | SM2 / OP-U02 | **Composer S3（命令浮层 @/#//）和 S4（附件）v1 scope 未定**：UC-2 主路径只列 S1→S2→S5→S6→S1；§9 DEFERRED 只覆盖 S7-S9（G-019）。S3/S4 是 draft 定义的「输入器自身态」（非 S7-S9 待发组），但既不在 UC-2 主路径也不在 DEFERRED。v1 是否实现 slash 命令浮层 + 附件？renderer 现有断链 `useSlashCommands.test.ts` 暗示曾规划，需裁决 in/defer。 |
| G2-003 | D | P1 / P2 | OP-U03 / E01 | **File View（文件视图）内容 v1 scope 未定**：UC-3 描述含「segmented tab 切换会话列表 ↔ 文件视图」，§8.5 限定「UC-3 基本部分」。sidebar spec 定义 File View 计数 = 当前 active session 改动文件数。v1 是否渲染文件列表内容，还是只做 tab 切换机制 + 空内容？mock 是否产出 file-change 数据？ |
| G2-004 | K/D | P1 / P2 | OP-U02-B5 / E02 | **「基础空态」语义未收敛**：§8.5 说「基础空态」但未界定。sidebar 状态 D（sessions=0）明确；但 (a) session 存在无消息时 message-stream 的空态、(b) File View 无改动文件时的空态 是否在 v1 scope？「基础」覆盖到哪一层未定。 |
| G2-005 | D | P1 / P2 | OP-U03-B4 / E01 | **Session 重命名 scope 未定**：sidebar spec 定义 hover 显「重命名 / 删除」两按钮；删除确认流 DEFERRED（G-013）；但 spec.md 全文未提 rename，既不在「切换/创建」scope 也不在 DEFERRED。v1 hover 按钮是否显示/可用？显示但不可用 = 死 UI；不显示 = 与设计稿 hover 态不符。 |
| G2-006 | F/K | P2 / P1 | E02 / OP-U02 | **mock fixture 块丰富度未定**：UC-2 验收含「回合折叠」（折叠 pill 显「N reasoning · M tool」）+ panel spec「7 块」（thinking/toolCall/text/contentBlocks/usage）。D7 只规定「返回类型全字段镜像 shared」，未规定 fixture 数据是否含 thinking/toolCall/usage/Summary 块。若 mock 只流式 text，则 7-块渲染（thinking 块、toolCall 块）+ 回合折叠 pill 计数无法在 v1 验收。需定 mock 预制消息的块构成。 |
| G2-007 | D | P1 | OP-U02-B3 | **message-stream 自动滚动行为未定**：流式 text_delta 持续到达时，视图是否自动滚动到底部显示最新内容？主聊天流可用性依赖此（否则流式内容需手动滚），但 spec.md + panel spec + draft-message-stream 均未提。 |

## 降级视角记录

无。5 视角全部适用并完整追踪：

- P2 Data Lifecycle：虽非后端 CRUD，但前端 store 状态（Session/Message/Panel/Nav）有完整 create/read/update/delete 生命周期，适用。
- P3 API Contract：api/ 层（R4）+ WS 协议（shared/protocol.ts 已验证类型齐全）是 renderer 重建的核心契约，适用。
- P5 Failure Path：mock-first + D7「v1 永远成功」使多数失败路径天然 N/A，但 4 态连接机、pending 超时、断连收尾等仍在追踪范围，适用（追踪后确认主要落入 DEFERRED 或 mock 豁免，无新 gap）。

## 5 视角追踪摘要

### P1 User Journey（完整）

| OP | 路径 | 结果 |
|----|------|------|
| OP-U01 启动看 Shell（UC-1） | main.ts → useConnection.init → connect(mock 200ms / real) → App.vue 渲 shell（aside 透明 + main 浮起 + traffic light 安全区 + app-nav-controls） | 主路径清晰 [VERIFIED ws-client.ts/mock-ws.ts]；连接态 UI 消费未提（mock-first 豁免，不计 gap） |
| OP-U02 mock 对话（UC-2） | 新建 session → S1→S2→S5→S6→S1 + message-stream 流式 + 回合折叠 | 主路径态定义 [VERIFIED composer draft]；**S3/S4 scope 未定（G2-002）**、**空态未定（G2-004）**、**mock 块丰富度未定（G2-006）**、**auto-scroll 未定（G2-007）** |
| OP-U03 session 切换/创建（UC-3 基本部分） | segmented tab 切换 / ⌘N 新建 / 点 session 项切换 | 主路径清晰；**File View 内容 scope 未定（G2-003）**、**rename scope 未定（G2-005）** |
| OP-U04 进入 Overview | 点 Overview 入口按钮 → main 区被覆盖、sidebar 持久 | 入口清晰 [VERIFIED sidebar/overview spec]；**退出路径全部 DEFERRED 导致 v1 无退出（G2-001）** |

### P2 Data Lifecycle（完整）

| 实体 | 生命周期 | 结果 |
|------|---------|------|
| Session（store） | create(list/create)/read(list)/update(rename?,status 派生 D6)/delete(G-013 DEFERRED) | 字段必填性 + 镜像类型 [VERIFIED session.ts + D7]；rename/delete scope 见 G2-005 |
| Message（store） | create(send+stream)/read(history) | 7 块结构 [VERIFIED message.ts]；mock fixture 块构成见 G2-006 |
| Panel/PanelTree | v1 恒单 Panel（G-023 DEFERRED split） | [VERIFIED panel.ts]；v1 退化为 trivial store，无 gap |
| Navigation | entries[]+pointer+splice+MAX=50+overview 第三 view | [VERIFIED main navigation.ts + D1]，无 gap |

### P3 API Contract（完整）

api/ 层契约继承 shared/protocol.ts（已核对 ClientMessageType/ServerMessageType/错误契约三通道完整）+ phase-1-api-client.md（pending/events/domains/mock 最小集）。v1 mock-first，mock 实现同接口 [VERIFIED]。command 超时/断连善后/重连收尾链路（G4/G5/G6）在 phase-1-api-client.md 已定。**无新 gap**——契约层事实充分，剩余均为 scope 决策（归 P1/P4）。

### P4 State Machine（完整）

| SM | 状态 | 结果 |
|----|------|------|
| Connection（4 态） | disconnected→connecting→connected→reconnecting | [VERIFIED ws-client.ts + D2 保留]；mock 走 200ms 直连，无 gap |
| Composer（S1-S9） | v1 主路径 S1/S2/S5/S6 | **S3/S4 scope 未定（G2-002）**；S7-S9 DEFERRED（G-019/029）已记录 |
| SessionStatus（5 态派生 D6） | running/waiting/done/stopped/error | [VERIFIED D6 派生逻辑]；mock 不触发 waiting（tool 审批 DEFERRED）属可接受，无 gap |
| Panel（单/双） | v1 恒单 | [VERIFIED]，无 gap |
| Navigation views | chat/overview/settings | **Overview 进入有/退出无（G2-001）** |

### P5 Failure Path（完整）

| 源操作 | 最可能失败 | 处理 | 结果 |
|--------|-----------|------|------|
| session.create / message.send / switch | mock 永不失败（D7） | 真失败走 error envelope（protocol.ts 三通道已定） | 联调阶段验，DEFERRED（G-029），无新 gap |
| connection 断开 | 4 态机 + 指数退避重连 [VERIFIED] | mock 不触发；真 runtime 重连收尾链路（G5）在 phase-1-api-client 已定 | mock-first 豁免 UI，无新 gap |
| pending 超时 | 30s reject ApiTimeoutError | [VERIFIED phase-1-api-client task2] | mock 即时 resolve，无 gap |
| 重复触发 | double-send 被 S5 状态机防；double-create 产 2 session（可接受） | [VERIFIED] | 无 gap |

## 判定

**NOT CONVERGED**。7 个新 gap（G2-001..G2-007），全部为 v1 in-scope 路径上的未定义项，不在 §9 DEFERRED 清单内：

- 4 个 D 类为 scope 边界未划定（Overview 退出 / S3·S4 / File View 内容 / rename）—— 这些是「既未纳入 v1 主路径也未记入 DEFERRED」的灰色项，违反 §9「不丢失」原则。
- 1 个 K/D 类为「基础空态」语义未收敛。
- 1 个 F/K 类为 mock fixture 块丰富度，直接影响 UC-2「回合折叠 + 7 块」验收是否可在 v1 成立。
- 1 个 D 类（auto-scroll）为主聊天流可用性依赖项，优先级最低。

spec 的事实陈述（架构 R1-R5、协议类型、设计稿引用、token SSOT、D1-D7 决策）经源码核对均准确，无 F 类事实错误。剩余收敛阻塞全在 scope 边界与 mock 验收契约的明确化。
