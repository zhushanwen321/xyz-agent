---
verdict: pass
title: 前端 v3 重建 E2E/集成测试计划
date: 2026-06-20
status: draft
spec: .xyz-harness/2026-06-20-frontend-rebuild/spec.md
---

# 前端 v3 重建 E2E/集成测试计划

> 配套 spec §6 验收点 + §7 UC + §4 P0-P6 路线。**mock 驱动**（`VITE_MOCK=true`），联调推迟。测试框架 **vitest**（CLAUDE.md 强制，禁 `node:test`）。

## 1. 分层测试策略

| 层 | 目标 | 工具 | 覆盖 |
|----|------|------|------|
| L1 纯逻辑 | stores computed / composables/logic / navigation 历史栈 | vitest 单测 | 状态派生、栈指针/splice/MAX_ENTRIES |
| L2 组件渲染 | components props/emit、shadcn 原子、容器态 | @vue/test-utils + vitest（happy-dom） | Shell/Sidebar/Panel 渲染、9 态 composer |
| L3 api/mock 契约 | api/transport 注入、domains 返回镜像 shared 全字段、mockConnect 4 态机不变量 | vitest | D7 mock 契约、D2 mock 优先 |
| L4 视觉验收 | draft HTML 像素对齐（P1-P6 每 phase） | **人工**为主，Playwright 可选（v1 不强制） | §4 每 phase 验收基准 |

> **L4 已细化**：拆成 8 个按 phase 编号的 VA 文件，见 [`visual-acceptance/`](visual-acceptance/va-00-index.md) 子目录。每个 VA 文件自包含（spec/plan/draft/代码绝对路径 + 对照表 + 执行步骤 + FAIL 规则），AI 读单个文件即可开始对照。下文 §2/§4 的 TS-2~TS-5 / TS-7 视觉部分以 VA 文件为准。

**严格 v1 边界**：只测 §8.5 v1 in-scope；§9 DEFERRED 项（tool 审批/steer/重命名确认/⌘K/settings 三模式/S3-S4/S7-S9/auto-scroll 高级/auto-scroll 暂停/⌘B 第3态等）**不测**（VA 文件中用 🔇 标记，并额外验「入口是否已 hide」）。

## 2. Test Scenarios（场景 → 验收映射）

| ID | 场景 | 覆盖 |
|----|------|------|
| TS-1 | P0 token/shadcn 装机 | §6 整体验收「冷蓝暗色画布」+ ADR-0018 |
| TS-2 | P1 Shell 渲染（aside 透明/main 浮起/traffic light 安全区） | UC-1 + §6 冷蓝画布 |
| TS-3 | P2 Sidebar 容器四态 + segmented tab + Overview 入口 + ⌘N | UC-3 + §8.5 P2 v1 边界 |
| TS-4 | P3 Workspace 双 Panel 主从 + 5 zone 空壳 | §8.5 P3 骨架 |
| TS-5 | P4 message-stream 7 块 + 回合折叠 + composer S1/S2/S5/S6 + auto-scroll 基础 | UC-2 主聊天路径 + §8.5 P4 v1（S3/S4/S7-S9 DEFERRED 不测） |
| TS-6 | P5 api/ 五层 + mock 镜像 shared 类型 + 4 态连接机 | D2 mock 优先 + D7 契约 + §6「ws-client 仅 useConnection+api/transport」 |
| TS-7 | 整体验收：VITE_MOCK 主流程 + 架构铁律 + lint/typecheck | §6 整体验收 5 项全部 |

## 3. Test Environment

- **框架**：vitest@^4.1.6（`renderer/vitest.config.ts`，env=happy-dom，alias `@` + `@xyz-agent/shared`）
- **组件测试**：@vue/test-utils@^2.4.10，`mount`/`shallowMount` + `props`/`emitted`
- **运行**：`npx vitest run <file>`（renderer 目录内），禁 `tsx --test` / `node:test`
- **mock 模式**：`VITE_MOCK=true`，mock-ws.ts 已实现 ping→pong + 200ms connecting→connected；session/chat fixture 随 P5 从零编写（参考 main worktree `mock/data.ts` 数据结构）
- **renderer 现状**：greenfield，0 components/stores/views；composables/ 下 2 个断链 symlink（P0 清理）；i18n 已 wire
- **timer 测试**：含 setTimeout 的（mockConnect 200ms、心跳、重连退避）用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()`，禁真实等待（5s 超时）
- **视觉验收**：每 phase 对应 `docs/designs/v3-demo/<域>/draft-*.html` 人工像素对照；Playwright v1 不强制

## 4. 每 phase 验收触发

P0-P6 每 phase 结束跑对应 TS + **对应 VA 文件**（[`visual-acceptance/va-0N-*.md`](visual-acceptance/va-00-index.md)）人工视觉对照，产出可运行增量后才进下一 phase。VA 文件与 phase 映射：

| Phase | VA 文件 | Wave |
|-------|--------|------|
| P0 | va-01-p0-tokens.md | 1 |
| P1 | va-02-p1-shell.md | 2 |
| P2 | va-03-p2-sidebar.md | 3 |
| P3 | va-04-p3-workspace-panel.md | 3 |
| P4 | va-05-p4-panel-content.md | 4 |
| P6 | va-06/07/08（overview/settings/overlays）| 5 |

TS-7（整体验收）在 P5 完成后首次全量跑，之后每 phase 回归。
