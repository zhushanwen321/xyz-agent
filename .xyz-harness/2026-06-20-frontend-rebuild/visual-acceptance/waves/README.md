---
title: Wave 调度总表（subagent 执行单元索引）
date: 2026-06-20
total_waves: 20
---

# Wave 调度总表

> 把 8 个 phase 级 VA 文件（`../va-0N-*.md`，每个 13-22 检查项）拆成 **20 个 wave 执行单元**。每个 wave = 一个 subagent 可独立派单的任务，容量约束：**≤3 个简单 case，或 1 个复杂 case**。
> VA-0N 保留作 phase 聚合参考（人看全貌）；wave 文件是 subagent 的执行契约（自包含、聚焦）。

## 项目根

**$ROOT** = `/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

所有 wave 文件路径：`$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/visual-acceptance/waves/` 下，命名格式 `wNN-{phase}-{slug}.md`（NN = 01-20 全局执行序号）。完整清单见下方 §20 个 Wave 总表。

## case 类型定义（派单负荷判定）

| 类型 | 特征 | 典型 | subagent 负荷 |
|------|------|------|--------------|
| **simple** | 单一断言，二元判定（是/否）。DevTools 一次 computed style / 一个文件存在 / 一个命令 / 一个入口显隐 | 色值核对、radius 量取、tsc/lint、hide 入口检查 | 轻，可批量 ≤3 |
| **complex** | 多步骤交互 / 多组件联动 / 时序验证 / 全链路数据流。需综合判定 | 拓扑视觉层次、双 Panel 主从、回合折叠、UC-2 端到端 | 重，每 wave 仅 1 |

## 20 个 Wave 总表（执行序）

| Wave | 文件 | Phase | Cases | 依赖 Wave | 预估 min | 对照 VA |
|------|------|-------|-------|-----------|---------|---------|
| W01 | w01-p0-tokens-color.md | P0 | simple×3 | — | 5 | VA-01 #1-5 |
| W02 | w02-p0-tokens-infra.md | P0 | simple×3 | — | 8 | VA-01 #6-13 |
| W03 | w03-p1-shell-topology.md | P1 | complex×1 | W02 | 10 | VA-02 #1-6 |
| W04 | w04-p1-shell-traffic-light.md | P1 | complex×1 | W02 | 10 | VA-02 #4,7-11 |
| W05 | w05-p1-shell-misc.md | P1 | simple×3 | W03 | 6 | VA-02 #13-16 |
| W06 | w06-p2-sidebar-container.md | P2 | complex×1 | W05 | 12 | VA-03 #5-8,18-19 |
| W07 | w07-p2-sidebar-overview-entry.md | P2 | simple×3 | W06 | 5 | VA-03 #1-4 |
| W08 | w08-p2-sidebar-session-item.md | P2 | complex×1 | W06 | 10 | VA-03 #9-11 |
| W09 | w09-p2-sidebar-collapse.md | P2 | complex×1 | W06 | 10 | VA-03 #14-17,20-22 |
| W10 | w10-p3-workspace-dual-panel.md | P3 | complex×1 | W09 | 12 | VA-04 #1-7,13-14 |
| W11 | w11-p3-panel-skeleton.md | P3 | simple×3 | W10 | 6 | VA-04 #8-12 |
| W12 | w12-p4-message-stream-blocks.md | P4 | complex×1 | W11 | 12 | VA-05 A1-A2,A6-A8 |
| W13 | w13-p4-message-stream-turn.md | P4 | complex×1 | W12 | 10 | VA-05 A3-A5,A9 |
| W14 | w14-p4-composer-states.md | P4 | complex×1 | W11 | 12 | VA-05 B1-B6,B10 |
| W15 | w15-p4-companion-zones.md | P4 | simple×3 | W11 | 5 | VA-05 C1-C6 |
| W16 | w16-p4-uc2-flow.md | P4 | complex×1 | W12-W15 | 15 | VA-05 D3-D4 + 集成 |
| W17 | w17-p6-overview-entry-exit.md | P6 | complex×1 | W16 | 10 | VA-06 #1-7 |
| W18 | w18-p6-overview-grid.md | P6 | simple×3 | W17 | 6 | VA-06 #8-14 |
| W19 | w19-p6-settings-hide.md | P6 | simple×2 | W16 | 4 | VA-07 #1-3(+4-8若建) |
| W20 | w20-p6-overlays-hide.md | P6 | simple×2 | W16 | 4 | VA-08 #1-2(+4-7若建) |

## 依赖图（可并行批次）

```
Wave 1 (P0 基础):     W01 ──┬── W02
                             │
Wave 2 (P1 Shell):          ├── W03 ── W05
                             ├── W04 (与 W03 并行,均依赖 W02)
Wave 3 (P2 Sidebar):        └── W06 ──┬── W07
                                        ├── W08
                                        └── W09 ── W10
Wave 4 (P3 WS+Panel):                            W10 ── W11
Wave 5 (P4 Content):                                       W11 ──┬── W12 ── W13
                                                                ├── W14
                                                                ├── W15
                                                                └──(W12-15)── W16
Wave 6 (P6):                                                            W16 ──┬── W17 ── W18
                                                                               ├── W19
                                                                               └── W20
```

**并行机会**：W01/W02、W03/W04、W07/W08/W09、W12/W14/W15、W19/W20 可同批派单（同 phase 内无相互依赖）。

## subagent 派单协议

### 派单前（主 agent 职责）

1. **查依赖**：确认前置 wave 已 PASS（见依赖图）。未 PASS 则不派。
2. **传 wave 文件绝对路径**给 subagent，并指示：「读该 wave 文件，按 §执行步骤逐项验收，回报每个 case 的 PASS/FAIL + 证据」。
3. **启动环境**：主 agent 起好 `npm run dev`（或 `VITE_MOCK=true npm run dev`），告诉 subagent Electron 窗口已就绪 / 或让 subagent 自行启动（wave 文件含启动命令）。

### subagent 执行契约

每个 subagent 收到 **1 个 wave 文件**，必须：

1. 读 wave 文件顶部 `$ROOT` 声明 + §本 wave 专属文件（绝对路径）+ §前置。
2. 打开 §执行步骤列出的 draft（浏览器）+ Electron 窗口。
3. 逐 case 验收：执行检查方法 → 记录实测值 → 对照期望 → 标 ✅ PASS / ❌ FAIL。
4. 🔇 项按 hide 规则判定（入口显示但无反应 = FAIL；未渲染 = PASS）。
5. 回报结构化结果：
   ```
   Wave WNN: [PASS|FAIL]
   - Case 1: PASS（实测: ..., 期望: ...）
   - Case 2: FAIL（实测: ..., 期望: ..., 证据: DevTools截图/命令输出）
   - 🔇 Case N: PASS（入口未渲染）
   阻塞: [无 / 描述]
   ```

### FAIL 处理

- 任一 case FAIL → 该 wave FAIL → **主 agent 停止派后续依赖 wave**，先修复。
- subagent 报 FAIL 时必须附证据（computed style 值 / 命令输出 / DOM 片段），不可只说"不匹配"。

## 全局共用规则（所有 wave 遵守）

详见 [`../va-00-index.md`](../va-00-index.md) §共用执行规则。要点：

- **SSOT**：色值 / radius / 间距 / 时长以 `design-tokens.md` 为准，draft HTML 间差异忽略（spec G-008）。
- **启动**：结构验收 `npm run dev`；主流程验收 `VITE_MOCK=true npm run dev`（spec D2）。
- **标记**：✅ v1 必验；🔇 DEFERRED 不验（额外查入口 hide）。
- **hide 规则**：DEFERRED 功能入口已显示但无反应 = FAIL（spec §8.5 Round 3）。
- **术语源**：`$ROOT/docs/architecture/context.md`（v3-demo 的 architecture-and-terminology.html 缺失，见 va-00 备注）。

## 全局必读文件（wave 文件按需引用，不重复列全量）

见 [`../va-00-index.md`](../va-00-index.md) §全局必读文件清单（harness / 基础件 / ADR / v3-demo 根）。每个 wave 文件只列**本 wave 专属**的 draft / spec / 代码路径。

## 完成判定

全部 20 wave PASS → 跑 spec §6 整体验收 5 项（见 [`../va-08-p6-overlays.md`](../va-08-p6-overlays.md) 末尾）→ 前端 v3 重建视觉验收闭环。
