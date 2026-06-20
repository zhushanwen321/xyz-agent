---
title: 前端 v3 重建 · 视觉验收（Visual Acceptance）总索引
date: 2026-06-20
phase: all
---

# 视觉验收总索引

> 配套 harness：`$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/`
> 本目录把 `e2e-test-plan.md` 的 **L4 视觉验收**拆成 **8 个按 phase 编号的 VA 文件**。每个文件自包含——AI 读单个文件即可定位所有相关 spec / plan / draft / 代码并开始对照。

## 项目根绝对路径

**$ROOT** = `/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

下文所有路径前缀均为 $ROOT。每个 VA 文件顶部也重复此声明，不依赖本 index。

## VA 文件清单（执行顺序 = phase 顺序）

> **执行单元**：subagent 派单用 [`waves/`](waves/README.md)（20 个 wave，每个 ≤3 简单或 1 复杂 case）。下表 VA-0N 是 **phase 聚合参考**（人看全貌，含完整对照表）。wave 文件引用 VA-0N 的检查项编号，但**自包含**路径与期望值，subagent 读单个 wave 即可执行。

| # | 文件 | Phase | Wave | 对照 design 单元 | 优先级 |
|---|------|-------|------|-----------------|--------|
| 01 | [va-01-p0-tokens.md](va-01-p0-tokens.md) | P0 | 1 | design-tokens + ADR-0018/0021 | ★★★ |
| 02 | [va-02-p1-shell.md](va-02-p1-shell.md) | P1 | 2 | shell/（2 draft）| ★★★ |
| 03 | [va-03-p2-sidebar.md](va-03-p2-sidebar.md) | P2 | 3 | sidebar/（4 draft）| ★★★ |
| 04 | [va-04-p3-workspace-panel.md](va-04-p3-workspace-panel.md) | P3 | 3 | workspace/ + panel/spec | ★★ |
| 05 | [va-05-p4-panel-content.md](va-05-p4-panel-content.md) | P4 | 4 | panel/（4 draft）| ★★★ |
| 06 | [va-06-p6-overview.md](va-06-p6-overview.md) | P6 | 5 | overview/（2 draft）| ★ |
| 07 | [va-07-p6-settings.md](va-07-p6-settings.md) | P6 | 5 | settings/（6 draft）| ★ |
| 08 | [va-08-p6-overlays.md](va-08-p6-overlays.md) | P6 | 5 | overlays/（1 draft）| ★ |

**执行规则**：每个 phase（= Wave）完成后立即跑对应 VA 文件，PASS 才进下一 Wave（见 plan.md Wave Schedule）。VA-01 是所有 UI 的前置。

## 全局必读文件清单（汇总，每个 VA 文件引用此清单）

### Harness 文档（spec / plan 体系）

| 文件 | 用途 |
|------|------|
| `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/spec.md` | 需求规格（范围 / 路线 / 决策 D1-D7 / §9 DEFERRED 清单 27 项） |
| `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan.md` | 实施计划（Task T0-T6 + Wave + Execution Group FG0-FG6） |
| `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan-frontend.md` | 前端细节（File Structure + Interface Contracts 完整签名表） |
| `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/e2e-test-plan.md` | 测试总策略（L1-L4 分层，本目录细化 L4） |
| `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/use-cases.md` | UC-1 / UC-2 / UC-3 业务用例 |

### 全局基础件（tokens / system / 产品 / 术语 / 架构 / 规范）

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/design-tokens.md` | **原子值 SSOT**（色 / 字 / 距 / 影 / 动效）—— 所有 VA 的色值 / 半径基准 |
| `$ROOT/docs/designs/design-system.md` | 组件原语层（tokens 之上如何组合：Card / Card-Active / inset ring 等） |
| `$ROOT/PRODUCT.md` | 产品定位 + 品牌人格（冷蓝暗色主张来源） |
| `$ROOT/docs/architecture/context.md` | 领域术语表（Session / Panel / Overview / Side Drawer 等 v3 UI 结构术语） |
| `$ROOT/docs/architecture/design.md` | 全局架构（Renderer R1-R5 五层 + 三条依赖铁律） |
| `$ROOT/CLAUDE.md` | 项目编码规范（#10 radius / #11 traffic light 安全区 / 前端规范 / 测试规范） |

### ADR（按 phase 相关性选读）

| ADR | 主题 | 主要用于 |
|-----|------|---------|
| `$ROOT/docs/architecture/adr/0018-visual-direction.md` | 视觉方向（冷蓝暗色） | 所有 VA |
| `$ROOT/docs/architecture/adr/0019-core-user-flows.md` | 核心用户流 | VA-05（P4） |
| `$ROOT/docs/architecture/adr/0020-resource-loading-strategy.md` | 资源加载（skill / agent 来源 badge） | VA-07（settings） |
| `$ROOT/docs/architecture/adr/0021-default-theme-direction.md` | 默认主题 = 暗色 | VA-01（P0） |
| `$ROOT/docs/architecture/adr/0022-overview-entry-coverage.md` | Overview 入口覆盖 | VA-06（overview） |

### v3-demo 设计稿根

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/README.md` | v3-demo 目录说明 + 术语映射 + 已知问题 |
| `$ROOT/docs/designs/v3-demo/ui-skeleton.md` | L0-L4 总纲（部分术语待批量替换，以各 spec.md 为准） |

## 共用执行规则

### 1. 启动方式

```bash
cd $ROOT
npm run dev                    # 普通启动（P0 / P1 结构验收）
VITE_MOCK=true npm run dev     # mock 模式（P2+ 主流程验收，见 spec D2）
```

### 2. 对照方法

- **draft 用浏览器打开**：例 `open $ROOT/docs/designs/v3-demo/shell/draft-overlay-states.html`（每个 VA 文件顶部已列出该 phase 要打开的具体 draft 绝对路径）
- **dev 应用**：`npm run dev` 起的 Electron 窗口
- **并排比对**：draft 浏览器窗口 + Electron 窗口同屏，逐项勾选
- **DevTools 验证**：Electron 窗口开 DevTools，查 computed style（颜色 / 尺寸 / 间距）

### 3. 检查项标记

| 标记 | 含义 | 处理 |
|------|------|------|
| ✅ | v1 必验 | 必须通过，FAIL 则停在该 phase |
| 🔇 | DEFERRED 不验（spec §9） | 不算失败；额外查「入口是否已 hide」（见下） |

### 4. DEFERRED 入口 hide 规则（spec §8.5 Round 3）

DEFERRED 功能若在 v1 已渲染组件中有触发入口（如 sidebar 搜索 / 重命名、panel split、⌘K / ⌘,），v1 统一 **hide 隐藏**（不显示入口），不保留 disabled 占位。

- **例外**：核心功能入口（新建 session ⌘N / Overview 进入）v1 保留。
- **验收判定**：🔇 项若「入口已显示但点了无反应」= **FAIL**（违反 hide 规则）；若「入口不显示」或「功能完全未渲染」= PASS。

### 5. FAIL 判定与处理

- 任一 ✅ 项不通过 = 该 VA 文件 FAIL → **停在该 phase**，修复后重跑，不进下一 Wave。
- 颜色 / 尺寸偏差：以 `design-tokens.md` 为 SSOT（draft HTML 间色值差异如 composer 的 `#34d399` 不作基准，见 spec G-008）。
- tsc / lint 不绿 = FAIL（spec §6.5），不论视觉。

### 6. 术语源

规范术语源 = `$ROOT/docs/architecture/context.md`（v3 UI 结构术语章节）。**注**：各 design spec.md 引用的 `docs/designs/v3-demo/architecture-and-terminology.html` 在归位时未迁移、**当前缺失**（v3-demo 根目录仅 `skeleton-chain.html`）——统一以 `context.md` 为准。废弃词映射见 `$ROOT/docs/designs/v3-demo/README.md`。

## Wave 执行索引（subagent 派单入口）

**调度总表**：[`waves/README.md`](waves/README.md)（20 wave + 依赖图 + case 类型 + 并行批次 + subagent 派单协议）。

| Wave | 文件 | Phase | Cases | 依赖 |
|------|------|-------|-------|------|
| W01 | [w01-p0-tokens-color](waves/w01-p0-tokens-color.md) | P0 | simple×3 | — |
| W02 | [w02-p0-tokens-infra](waves/w02-p0-tokens-infra.md) | P0 | simple×3 | — |
| W03 | [w03-p1-shell-topology](waves/w03-p1-shell-topology.md) | P1 | complex×1 | W02 |
| W04 | [w04-p1-shell-traffic-light](waves/w04-p1-shell-traffic-light.md) | P1 | complex×1 | W02 |
| W05 | [w05-p1-shell-misc](waves/w05-p1-shell-misc.md) | P1 | simple×3 | W03 |
| W06 | [w06-p2-sidebar-container](waves/w06-p2-sidebar-container.md) | P2 | complex×1 | W05 |
| W07 | [w07-p2-sidebar-overview-entry](waves/w07-p2-sidebar-overview-entry.md) | P2 | simple×3 | W06 |
| W08 | [w08-p2-sidebar-session-item](waves/w08-p2-sidebar-session-item.md) | P2 | complex×1 | W06 |
| W09 | [w09-p2-sidebar-collapse](waves/w09-p2-sidebar-collapse.md) | P2 | complex×1 | W06 |
| W10 | [w10-p3-workspace-dual-panel](waves/w10-p3-workspace-dual-panel.md) | P3 | complex×1 | W09 |
| W11 | [w11-p3-panel-skeleton](waves/w11-p3-panel-skeleton.md) | P3 | simple×3 | W10 |
| W12 | [w12-p4-message-stream-blocks](waves/w12-p4-message-stream-blocks.md) | P4 | complex×1 | W11 |
| W13 | [w13-p4-message-stream-turn](waves/w13-p4-message-stream-turn.md) | P4 | complex×1 | W12 |
| W14 | [w14-p4-composer-states](waves/w14-p4-composer-states.md) | P4 | complex×1 | W11 |
| W15 | [w15-p4-companion-zones](waves/w15-p4-companion-zones.md) | P4 | simple×3 | W11 |
| W16 | [w16-p4-uc2-flow](waves/w16-p4-uc2-flow.md) | P4 | complex×1 | W12-15 |
| W17 | [w17-p6-overview-entry-exit](waves/w17-p6-overview-entry-exit.md) | P6 | complex×1 | W16 |
| W18 | [w18-p6-overview-grid](waves/w18-p6-overview-grid.md) | P6 | simple×3 | W17 |
| W19 | [w19-p6-settings-hide](waves/w19-p6-settings-hide.md) | P6 | simple×2 | W16 |
| W20 | [w20-p6-overlays-hide](waves/w20-p6-overlays-hide.md) | P6 | simple×2 | W16 |

**并行批次**：W01+W02 / W03+W04 / W07+W08+W09 / W12+W14+W15 / W19+W20。

## phase → VA → Wave 映射（与 plan.md 对齐）

```
Wave1: VA-01(P0) ──┬→ VA-02(P1) ──┬→ VA-03(P2) ──┐
                                   └→ VA-04(P3) ──┴→ VA-05(P4) ─→ VA-06/07/08(P6)
```
