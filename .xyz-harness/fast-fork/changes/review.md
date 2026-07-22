# Code Review · fast-fork W1-W4

> 审查方法：reviewer subagent 只读审查 4 个 commit 的全部改动（git diff），按严重度 + 文件:行号 报告。
> 审查日期：2026-07-22

## 1. 审查范围

| Commit | Wave | 文件数 | 核心改动 |
|--------|------|--------|---------|
| 6e9b85ef | W1 基础层 | 8 源 + 2 测试 | SessionSummary 4 字段 + active/磁盘透传 + JSONL forkEntryId + handedOffTo append + parentSession fallback |
| 454fcb54 | W2 入口+行为 | 6 源 + 1 新 + 1 删 + 1 测试 | 门控放开 + 双按钮 + forkSessionAsk + 删 ForkConfirmModal + ForkNotice + protocol 广播 |
| 6c47745f | W3 composer | 4 源 + 2 新 + 2 测试 | useComposerForkMode + useForkModeChannel + ⌘G/⌘⇧G |
| cc40e3bd | W4 分支管理 | 3 源 + 2 新 + 1 测试 | ForkGroup + SessionList 接入 + SessionItem 血缘 + useForkBranchNotify |

## 2. 发现的问题

### Critical（集成接线缺失，功能不可用）

| ID | severity | ref | description |
|----|----------|-----|-------------|
| RV1 | must-fix | ForkNotice/session-message-handler | **反馈行 ForkNotice 从未渲染**。runtime 广播了 session.forkNotice（session-message-handler.ts:62-66），协议定义了（protocol.ts），组件建了（ForkNotice.vue），但 renderer **无任何一处订阅 session.forkNotice**。grep 确认只有注释提到。ForkNotice.vue 是孤儿组件 0 import。验收 checklist #4/#5/#13 全失败——用户 fork 后主面板无任何反馈。 |
| RV2 | must-fix | useForkBranchNotify | **useForkBranchNotify 从未实例化**。composable 定义了（useForkBranchNotify.ts:92），但 renderer **无任何一处调用 useForkBranchNotify()**。后台分支 done/error 状态追踪/通知/未读角标全不工作。验收 checklist #13/#14 失败。 |
| RV3 | must-fix | SessionList/Sidebar stopBranch | **Sidebar 未绑定 stopBranch 事件**。SessionList.vue:43,95 emit 了 stopBranch，但 Sidebar.vue 渲染 SessionList 时无 @stop-branch 绑定。ForkGroup 停止按钮 → SessionList emit → Sidebar 未接收 → 事件丢失。用户点"停止后台分支"无效。验收 checklist #22 失败。 |

### Major（逻辑错误/衔接遗漏）

| ID | severity | ref | description |
|----|----------|-----|-------------|
| RV4 | should-fix | Turn.vue onForkAsk | **onForkAsk 是空操作**。Turn.vue:510-516 `void forkSessionAsk` 仅引用未调用。W3 已实现 composer forkMode 通道（useForkModeChannel.triggerEnterForkMode），但 Turn.vue 的 fork 提问按钮没接上。高频路径（assistant 消息 fork 提问按钮）完全无反应，只剩 ⌘⇧G 全局快捷键可用。 |
| RV5 | should-fix | SessionList branchesOf | **parentSession 匹配 key 竞态**。branchesOf 用 `s.sessionFile || s.id` 匹配 `b.parentSession`，但 FR-20 fallback 在 fork 时判断（可能写 srcSessionId），渲染时源已落盘（parentKey 变文件路径），导致 b.parentSession === parentKey 永不命中，分支列表消失。应同时匹配 sessionFile 和 id 两种 key。 |

### Minor（不进 issue tracking）

| ID | description |
|----|-------------|
| RV6 | ForkGroup.vue 直接操作 DOM classList 绕过 Vue 响应式（fresh 淡出）。建议纯用响应式 ref 驱动。 |
| RV7 | SessionItem.vue parentLabel prop 从未传入，血缘显示原始文件路径/UUID 而非父 session 名。 |
| RV8 | 命名术语混乱：forkEntryId/piEntryId/fromMessageId/fromPiEntryId 同一概念 4+ 个名字。 |
| RV9 | ForkNotice viewBranch i18n key 定义未使用（死 key）。 |
| RV10 | useForkBranchNotify onScopeDispose 注释自相矛盾（说"预留"但实际已用）。 |

## 3. 各 wave 质量评价

- **W1 基础层**：高质量。FR-20 parentSession fallback 严谨（多级 fork 透传），active/磁盘两路径字段对齐，forkEntryId JSONL 写入，孤儿清理。无需返工。
- **W2 入口+行为**：半成品。门控/双按钮/forkSessionAsk 回滚/删 ForkConfirmModal 都到位，但**反馈行渲染接线缺失**（RV1）+ **onForkAsk 空操作**（RV4）。
- **W3 composer**：高质量。useComposerForkMode 状态机完整，shift 守卫正确，跨组件通道合理。问题仅在 Turn.vue 入口未接（RV4 属 W2→W3 衔接）。
- **W4 分支管理**：骨架为主。ForkGroup 组件完整，SessionList filter 合理。但 useForkBranchNotify 未实例化（RV2）+ stopBranch 无消费方（RV3）+ parentLabel 未注入（RV7）——三处接线全缺。

## 4. 审查结论

3 个 critical（集成接线缺失）+ 2 个 major（衔接遗漏 + 竞态）导致验收 checklist 至少 6 条失败。根因是各 wave 内部组件/composable 都写好了，但**跨 wave 的挂接没做**——测试因 mock 了订阅层而没发现这类集成 bug。

W1/W3 质量足够直接进 test。W2/W4 需补齐接线后才能进 test。建议 review_fix 集中修复 RV1-RV5（5 个 issue），minor 留后续优化。
