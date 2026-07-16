# ADR 0033: Subagent 只支持 cancel，不支持 pause/resume

**Status**: Accepted
**Date**: 2026-07-15

## Context

左侧边栏 subagent 列表（SubagentList.vue）此前只能查看历史，无法主动控制 running subagent。产品愿景强调「在不离开当前工作上下文的情况下，掌控所有并行任务」，缺少 cancel 能力是缺口。

调研 pi-subagent-workflow 扩展（`feat-ask-user-gui` 分支）后发现：

- **subagent 有 cancel 能力**：扩展注册了 `/subagents cancel <id>` slash command（RPC 模式可用），底层实现 `SubagentService.cancelBackground()` → `record.controller.abort()` → `child.kill("SIGTERM")`，真正终止子进程。
- **subagent 无 pause/resume 能力**：subagent 是 single-shot 子进程（`child_process.spawn` 启动 `pi --mode json`），架构上没有可暂停的 worker 线程。这与 workflow 不同——workflow 用 `worker_threads`，可以 terminate + 重建实现 pause/resume。

## Decision

为 subagent 新增 **cancel** 控制（对齐 workflow abort 的交互模式：inline 两段式确认）。**不实现 pause/resume**。

## Alternatives Considered

**将 subagent 改为长驻 RPC 进程以支持 pause/resume**
- 扩展 `session-runner.ts:405` 注释已提到长期方案：「切到 pi --mode rpc」
- 成本：较大的架构改动（子进程生命周期管理 → 长驻进程 + 状态机）
- 收益：subagent 可暂停/恢复
- 否决理由：当前 cancel 已满足「掌控并行任务」的核心需求，pause/resume 的 ROI 不足以支撑架构重写

## Consequences

- **正面**：cancel 能力补齐，与 workflow 的 abort 形成交互对称（都是破坏性操作 + 两段式确认）
- **负面**：subagent 没有 pause/resume，用户无法临时暂停一个 subagent。若未来需求强烈，需扩展层架构升级
- **一致性**：UI 上 subagent 卡片只有 cancel 按钮（running 态），workflow 卡片有 pause/resume + abort——差异反映底层能力差异，不做假对称
