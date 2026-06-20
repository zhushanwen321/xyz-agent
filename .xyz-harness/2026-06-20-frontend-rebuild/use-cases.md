---
verdict: pass
title: 前端 v3 重建 - 业务用例
date: 2026-06-20
status: draft
spec_ref: spec.md §7 / §8.5
---

# 业务用例（v1 In-Scope）

> 仅覆盖 spec §8.5 v1 范围：主聊天流 + session 切换/创建 + 基础空态 + Overview 进入/基本退出 + auto-scroll 基础版。DEFERRED 项（见 spec §9）不单独立 UC，仅在 Alternative Paths 一句话提及。

## UC-1: 用户启动应用看到 v3 Shell

**Actor**: 开发者用户
**Preconditions**: `npm run dev` 已启动；P0 token/shadcn 装机完成。
**Main Flow**:
1. Electron 窗口创建，App.vue 挂载
2. shell 渲染：aside-region（透明）+ main-panel（浮起）
3. 非全屏时应用 traffic light 安全区 padding
4. useConnection 触发 ws-client 4 态机；mock 模式 200ms 进 connected（D7）
5. sidebar 渲染容器四态骨架 + 默认空态引导（G2-004）

**Alternative/Exception Paths**:
- 全屏两态切换微交互 → deferred（spec §9 P1 行）
- ws 断线重连 → 现有 ws-client 指数退避（非 v1 新增，复用）

**Postconditions**: 冷蓝暗色画布呈现，视觉对齐 `shell/draft-overlay-states.html`。
**Module Boundaries**:
- components: `shell/`、`sidebar/`（容器根）
- composables: `useConnection.ts`
- stores: `navigation`（初始 view）
- lib: `ws-client.ts`、`ipc.ts`

**AC 映射**: spec §6 整体验收「`npm run dev` 启动冷蓝画布」+ P1 phase 验收。

## UC-2: 用户用 mock 数据完成一次对话

**Actor**: 开发者用户
**Preconditions**: `VITE_MOCK=true npm run dev`；存在 mock session 或已新建。
**Main Flow**:
1. 用户在 composer 输入消息（S1 空 → S2 聚焦）
2. 回车提交，composer 进 S5 发送中
3. `features/useChat` 调 `api.chat.send(sessionId, text)`
4. mock 返回预制 Promise，emit 流式 assistant 块事件
5. message-stream 渲染 user 块 + assistant text 块 + 流式光标
6. 回合折叠 pill 出现，auto-scroll 滚到底（基础版）
7. 流结束 composer 回 S1；用户可点 S6 停止（mock 即时结束）

**Alternative/Exception Paths**:
- Tool 审批 / steer·followup（S7-S9）/ S3 命令浮层 / S4 附件 / abort 后状态流转与重发 → 全部 deferred（spec §9 G-018/019/G2-002/G-025）
- mock 不模拟失败（D7），失败 UI 联调阶段用真 stream_error 验

**Postconditions**: 消息流含完整回合，视觉对齐 `panel/draft-*.html`。
**Module Boundaries**:
- components: `panel/composer/`、`panel/message-stream/`
- composables: `features/useChat.ts`
- stores: `chat`（按 sessionId 分区）、`session`（5 态派生 D6）
- api: `domains/chat.ts` + `api/mock/`

**AC 映射**: spec §6「`VITE_MOCK=true` 主流程跑通」+ P4 phase 验收。

## UC-3: 用户在 sidebar 切换会话 / 进入 Overview

**Actor**: 开发者用户
**Preconditions**: sidebar 已渲染，存在 ≥1 mock session。
**Main Flow**:
1. 用户在 segmented tab 切换 sessions ↔ files（files v1 仅骨架，G2-003 deferred）
2. 点会话项 → `features/useSession` 调 `api.session.switch(id)`，navigation push `{view:'chat', sessionId:id}`
3. chat store 路由到对应分区，message-stream 切内容
4. 用户点 Overview 入口按钮 → navigation push `{view:'overview'}`
5. Overview 卡片网格覆盖 main 区，sidebar 持久（ADR-0022）
6. 点卡片或 Esc → navigation back，返回 chat view（基本退出）

**Alternative/Exception Paths**:
- 新建 session：`⌘N` 入口 v1 保留，走 `api.session.create()` 后 push 栈
- session rename / 删除确认 / ⌘K 搜索 / ⌘, settings / ⌘⇧O 高级退出 → 全部 deferred（spec §9 G2-005/G-013/G-022/G-021/G-020）

**Postconditions**: 当前激活 session 切换，或进入/退出 Overview。
**Module Boundaries**:
- components: `sidebar/`（会话项/tab/Overview 按钮）、`overview/`
- composables: `features/useSession.ts`、`features/useNavigation.ts`
- stores: `navigation`（历史栈 D1）、`session`、`chat`
- api: `domains/session.ts`

**AC 映射**: spec §6 P2/P6 phase 验收 + spec §7 UC-3 预期。
