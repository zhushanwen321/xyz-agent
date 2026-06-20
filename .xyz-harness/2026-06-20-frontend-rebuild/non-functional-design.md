---
verdict: pass
title: 前端 v3 重建 - 非功能设计
date: 2026-06-20
status: draft
spec_ref: spec.md §3 / §5 / §6
---

# 非功能设计

> 纯前端重建 + mock 驱动。多维度不适用，如实标注原因，不硬凑。

## 1. 稳定性（适用）

**改动范围**：renderer 全新建（R1-R5 五层），runtime 不动；ws-client/ipc 基础设施复用。
**风险与对策**：
- mock→真 api 切换契约漂移 → mock 严格镜像 shared 类型（全字段，D7）缓解
- store 间隔离防回归 → spec §3 铁律「stores 禁止互相 import」+ lint 检查兜底（§6 `rg "from.*stores/" stores/` 必须为空）

## 2. 数据一致性（部分适用）

**不适用**：无 DB、无多端同步、无并发写入。
**适用（前端层面）**：
- navigation 历史栈一致性：分支截断（splice pointer+1）+ `MAX_ENTRIES=50` 上限防孤儿条目（D1）
- store 状态派生一致性：SessionStatus 5 态由前端从 message/tool 状态派生（D6），单一数据源放在 `stores/session.ts` computed，避免多组件各自推导漂移

## 3. 性能（适用）

- **message-stream 流式渲染**：高频 assistant 块事件，需块级 memo 或窗口化避免整流重渲染（plan 阶段细化）
- **长会话列表**：sidebar 会话项可能上百，v1 数据量小可暂缓虚拟滚动，留 TODO
- **auto-scroll 基础版**：新消息滚到底（`scrollTop = scrollHeight`），注意不与用户手动滚动冲突；高级暂停/跳底提示 deferred（G2-007）

## 4. 业务安全（不适用）

纯前端 mock，无 AI 行为指令注入面、无权限决策、无 tool 真实执行。Tool 审批 UI 本身 deferred（G-018）。联调阶段引入真 runtime 时再评估。

## 5. 数据安全（大部分不适用）

**不适用**：无敏感数据存储（mock 全内存，reload 重置 D7）、无网络出口（mock 本地）。
**保留不动（已有）**：Electron `contextIsolation: true` + preload 白名单仅暴露 4 个 runtime-port 方法（spec §1 现状），本次重建不扩展 preload 攻击面。
