---
verdict: pass
complexity: L1
---

# 前端 v3 重建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从零重建 xyz-agent renderer，照着已完成的 v3-demo 设计稿落地 UI，mock 优先驱动，联调推迟。

**Architecture:** Renderer 五层（R1 components / R2 composables / R3 stores / R4 api / R5 lib），三条依赖铁律（features 唯一跨 api+stores、stores 不互 import、lib 无业务）。状态驱动导航历史栈（无 vue-router）。

**Tech Stack:** Electron + Vue3 + TypeScript + Pinia + Tailwind + shadcn-vue + vitest

**Complexity:** L1（纯前端，无后端 endpoint 开发，runtime 已就绪，mock 内存数据流）

## Sub-documents
- 前端设计细节（File Structure + Interface Contracts 完整签名表）：`plan-frontend.md`
- 业务用例：`use-cases.md`
- 非功能设计：`non-functional-design.md`
- E2E 测试计划：`e2e-test-plan.md`
- 测试用例模板：`test_cases_template.json`

## Task List

| # | Task | Phase | Depends on | Group |
|---|------|-------|-----------|-------|
| T0.1 | 清理断链 symlink + style.css token 落地 | P0 | — | FG0 |
| T0.2 | tailwind.config 对齐 token（radius/colors/Inter） | P0 | T0.1 | FG0 |
| T0.3 | shadcn-vue 装机（components.json + 基础 ui） | P0 | T0.2 | FG0 |
| T1.1 | api/ 五层骨架（index/transport/pending/events） | P5 | — | FG1 |
| T1.2 | api/domains/session + chat（签名） | P5 | T1.1 | FG1 |
| T1.3 | api/mock 最小 fixture + mockConnect（200ms） | P5 | T1.2 | FG1 |
| T1.4 | stores/navigation + session（含 D6 派生） | P5 | T1.2 | FG1 |
| T2.1 | App.vue → AppShell 容器（aside+main 布局） | P1 | T0.3 | FG2 |
| T2.2 | traffic light 安全区 + MainPanel view 路由 + ⌘[/⌘] keydown 绑定 nav.back/forward | P1 | T2.1 | FG2 |
| T3.1 | Sidebar 容器四态 + SegmentedTab | P2 | T2.2, T1.4 | FG3 |
| T3.2 | SessionList + SessionItem（状态点 D6） | P2 | T3.1 | FG3 |
| T3.3 | 折叠态 + Overview 入口 + ⌘N 新建 | P2 | T3.2 | FG3 |
| T3.4 | stores/sidebar + features/useSidebar | P2 | T3.3 | FG3 |
| T4.1 | Workspace 容器 + PanelContainer（split 状态机） | P3 | T2.2 | FG4 |
| T4.2 | Panel 容器 + 5 zone 空壳 | P3 | T4.1 | FG4 |
| T4.3 | stores/panel（PanelTree + activePanelId） | P3 | T4.1 | FG4 |
| T5.1 | MessageStream（7 块 + 回合折叠 + auto-scroll） | P4 | T4.2, T1.3 | FG5 |
| T5.2 | Composer（S1/S2/S5/S6 主路径） | P4 | T5.1 | FG5 |
| T5.3 | stores/chat + features/useChat + effects/useChatScroll | P4 | T5.2 | FG5 |
| T5.4 | mock fixture 深化（user/assistant/tool_call/summary/error） | P5 | T1.3 | FG5 |
| T6.1 | Overview 卡片网格骨架 + 进入/基本退出（Esc+点卡片） | P6 | T5.3 | FG6 |
| T6.2 | Settings/Search 骨架（hide 入口） | P6 | T6.1 | FG6 |

## Execution Groups

### FG0: P0 基础对齐
**Description:** 视觉基础（token + shadcn 装机）+ 清理。是所有 UI Task 的前置。
**Tasks:** T0.1, T0.2, T0.3
**Files:** ~5（3 modify/create + 2 delete）
**Subagent:** general-purpose ×2（frontend-dev 骨架→美化 + reviewer）
**注入上下文:** design-tokens.md、ADR-0018、CLAUDE.md #10（已改 radius）、P0 token 归一约定（spec §4）
**读取:** `docs/designs/design-tokens.md`、`src-electron/renderer/src/style.css`、`tailwind.config.ts`
**Dependencies:** 无

### FG1: P5 API Client 骨架 + stores 基础
**Description:** 数据基础。P1+ 的 store/composable 都依赖它。与 FG0 并行。
**Tasks:** T1.1, T1.2, T1.3, T1.4
**Files:** ~9（全 create）
**执行顺序（C 方案）：** 步骤 A 骨架（types + api 五层 + stores 全 throw，tsc 绿）→ 步骤 B 填实现。详见 plan-frontend.md §1.5
**Subagent:** general-purpose ×2（骨架 + 实现）
**注入上下文:** phase-1-api-client.md、spec D2/D7（mock 契约）、D6（status 派生）、shared/ 协议类型、main worktree mock/data.ts 结构（参考非搬迁）
**读取:** `src-electron/shared/src/{protocol,session,message,panel}.ts`、`src-electron/renderer/src/lib/{ws-client,ipc}.ts`、`src-electron/renderer/src/mock/mock-ws.ts`、`main/src-electron/renderer/src/mock/data.ts`、`main/.../stores/navigation.ts`
**Dependencies:** 无（与 FG0 并行）

### FG2: P1 L0 Shell
**Description:** 应用骨架布局。
**Tasks:** T2.1, T2.2
**Files:** ~4（3 create + 1 modify App.vue）
**Subagent:** general-purpose ×2（frontend-dev + reviewer）
**注入上下文:** shell/spec.md、draft-overlay-states.html、traffic light 安全区（CLAUDE.md #11）
**读取:** `docs/designs/v3-demo/shell/{spec.md,draft-overlay-states.html}`
**Dependencies:** FG0（token）

### FG3: P2 L1 Sidebar
**Tasks:** T3.1-T3.4 | **Files:** ~6 | **Subagent:** general-purpose ×2
**注入上下文:** sidebar/spec.md + 3 draft、D6 status 派生、DEFERRED 入口 hide 规则、UC-3
**Dependencies:** FG2（shell 槽）+ FG1（session api + nav store）

### FG4: P3 Workspace + Panel 骨架
**Tasks:** T4.1-T4.3 | **Files:** ~8 | **Subagent:** general-purpose ×2
**注入上下文:** workspace/spec.md + draft-dual-panel.html、panel/spec.md 5 zone、split 单 session DEFERRED（G-023）
**Dependencies:** FG2

### FG5: P4 Panel 深化 + mock fixture
**Tasks:** T5.1-T5.4 | **Files:** ~8 | **Subagent:** general-purpose ×2
**注入上下文:** panel/ 4 draft（message-stream + composer）、flow-2/draft-cases.html、composer 9 态只做 S1/S2/S5/S6、auto-scroll 基础版、mock fixture 块丰富度（G2-006）
**Dependencies:** FG4（panel 骨架）+ FG1（api streaming）

### FG6: P6 Overview/Settings/Search 骨架
**Tasks:** T6.1-T6.2 | **Files:** ~4 | **Subagent:** general-purpose ×2
**注入上下文:** overview/spec.md + draft、ADR-0022（进入/基本退出）、settings/overlays draft（骨架，hide 入口）
**Dependencies:** FG5 + FG3（sidebar Overview 按钮）

## Dependency Graph & Wave Schedule

```
Wave1: FG0 ──┬──→ FG2 ──┬──→ FG3 ──┐
       FG1 ──┘          └──→ FG4 ──┴──→ FG5 ──→ FG6
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | FG0, FG1 | 基础（token/api），无依赖，并行 |
| Wave 2 | FG2 | Shell，依赖 FG0 |
| Wave 3 | FG3, FG4 | Sidebar + Workspace/Panel 骨架，依赖 FG2 + FG1 |
| Wave 4 | FG5 | Panel 深化 + mock，依赖 FG4 + FG1 |
| Wave 5 | FG6 | Overview/Settings 骨架，依赖 FG5 + FG3 |

**并行约束:** 同 Wave ≤3 subagent 并行；同文件不并发；前端 Group 需对应 api 就绪。

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| §6.1 npm run dev 冷蓝画布 | — | token→style.css | T0.1/T0.2 |
| §6.2 VITE_MOCK 主流程 | chat.send + session.create | useChat→api.chat→mock | T1.3/T5.3 |
| §6.3 ws-client 封装（仅 useConnection+transport） | transport.send/on | ws-client→transport | T1.1 |
| §6.4 stores 无互相 import | (架构约束) | — | T1.4/T3.4/T4.3/T5.3 |
| §6.5 lint + vue-tsc 通过 | — | — | 全部 Task 收尾 |
| UC-1 Shell | — | AppShell 渲染 | T2.1/T2.2 |
| UC-2 mock 对话 | chat.send/streamSubscribe | Composer→useChat→store.chat→api | T5.1/T5.2/T5.3 |
| UC-3 sidebar 切换 | session.switch + nav.push | SessionItem→useSidebar→store | T3.1-T3.4 |
| §8.5 ⌘[/⌘] 后退/前进 | nav.back/nav.forward | keydown→nav | T2.2 |
| §8.5 基础空态 | session.active(ComputedRef null) | store.session.activeId=null | T1.4/T3.2 |
| §8.5 Overview 进入/退出 | nav.push(view:'overview') | Overview 按钮→nav | T6.1 |
| §8.5 auto-scroll 基础 | useChatScroll.scrollToBottom | stream→store→scroll | T5.3 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| §6 整体验收 5 项 | adopted | FG0-FG6 |
| UC-1/UC-2/UC-3 | adopted | T2.x/T5.x/T3.x |
| D1 导航历史栈（MAX_ENTRIES=50） | adopted | T1.4 |
| D2 mock 优先 | adopted | T1.3/T5.4 |
| D3 shadcn-vue 增量装 | adopted | T0.3 |
| D4 术语（Overview/SideDrawer） | adopted | T6.1 |
| D5 radius 3/8/12px | adopted | T0.2 |
| D6 SessionStatus 前端派生 | adopted | T1.4 |
| D7 工程默认包 | adopted | T1.1-T1.3 |
| §9 DEFERRED 27 项 | postponed | — (见 spec §9，联调/后续补) |
| [AMBIGUOUS] Summary 契约 | postponed | — (plan/PRODUCT 定) |

## ADR 评估

扫描 plan 新决策：D1-D7 在 spec 阶段已记录，ADR-0018-0022 已归位。本 plan 无新决策满足"难以逆转+无上下文惊讶+真实权衡"三条件（分组/Wave 是执行编排非架构决策；D1-D7 已有 ADR 或属实现细节）。**产出为空**。
