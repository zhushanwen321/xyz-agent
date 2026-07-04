# handoffs/ · 叶子交接文档索引

为各 draft 叶子提供一份 handoff，让接手者（人或 agent）不读全量上下文即可开工。每份 handoff 是**自包含**的：只读它 + 它点名的关联文件，就能做这一叶。

## 为什么独立成夹

- 不污染各单元的 `spec.md` + `draft-*.html` 结构（spec 是设计规范，handoff 是交接契约，两件事）
- 统一模板，格式一致，批量维护
- 孤儿/缺口立即可见（某叶缺 handoff = 还没交接清楚）

## 命名规范

- `handoff-<单元>-<状态>.md`，如 `handoff-panel-composer-states.md`
- 已完成叶子也做 handoff（验收型：产物 + 验收要点 + 回顾），不只是待做叶子

## 统一模板（每份 handoff 必须有的 7 段）

```
# Handoff · <单元> · <状态描述>

## 1. 路径
- 目录 / 文件名 / 层级 L?

## 2. 产物 HTML 规范
- standalone / 内联 CSS / token 来源 / 术语来源 / 该叶特有尺寸或约束

## 3. 要做的事情
- [ ] 具体 checklist（状态、空缺、联动）

## 4. 关联文档（md）
- 上游 spec / 术语 / 决策
- 同层兄弟叶子
- 下游依赖

## 5. 关联 HTML（draft）
- 参考稿 / 集成点（最终嵌入哪个 spec 的哪个 zone）

## 6. 验收
- P0 必过 checklist

## 7. Suggested skills
- 接手 agent 该加载的 skill
```

## 13 叶子索引

| # | handoff 文件 | 叶子 | 单元 | 状态 | 优先级 |
|---|---|---|---|---|---|
| 1 | `handoff-shell-skeleton.md` | draft-skeleton | shell | ✅ 完成 | — |
| 2 | `handoff-shell-overlay-states.md` | draft-overlay-states | shell | ✅ 完成 | — |
| 3 | `handoff-sidebar-five-states.md` | draft-five-states | sidebar | ✅ 完成 | — |
| 4 | `handoff-sidebar-collapsed-state.md` | draft-collapsed-state | sidebar | ✅ 完成（孤儿补录） | — |
| 5 | `handoff-sidebar-session-item.md` | draft-session-item | sidebar | ✅ 完成 | — |
| 6 | `handoff-sidebar-file-view.md` | draft-file-view | sidebar | ✅ 完成 | — |
| 7 | `handoff-workspace-dual-panel.md` | draft-dual-panel | workspace | ✅ 完成 | — |
| 8 | `handoff-panel-message-stream.md` | draft-message-stream | panel | ✅ 完成 | — |
| 9 | `handoff-panel-breadcrumb-popovers.md` | draft-breadcrumb-popovers | panel | ✅ 完成（孤儿补录） | — |
| 10 | `handoff-panel-composer-states.md` | draft-composer-states | panel | ✅ 完成 | — |
| 11 | `handoff-panel-companion-zones.md` | draft-companion-zones | panel | ✅ 完成 | — |
| 12 | `handoff-panel-detail-pane.md` | draft-detail-pane | panel | ✅ 完成 | — |
| 13 | `handoff-overlays-search-modal.md` | draft-search-modal | overlays | ✅ 完成 | — |
| 14 | `handoff-overview-view.md` | draft-overview | overview | ✅ 完成 | — |
| 15 | `handoff-flows-flow-2-code-review.md` | draft-cases | flow-2 | ✅ 完成（老叶子补录） | — |
| 16 | `handoff-flows-flow-3-subagent.md` | draft-cases | flow-3 | ✅ 完成 | — |

**完成度**：本目录 16 叶 handoff 全部 ✅（含计划外深化 `panel-breadcrumb-popovers`、`sidebar-collapsed-state`、`flows-flow-2-code-review`）。原 `handoff-settings-view.md`（空白占位 + 全屏覆盖形态）已删除——settings 单元已完整落地，5 份 per-menu handoff 见下方特例。

## 全局交接约束（所有 handoff 共享，不每份重复）

- **术语**：以 `../architecture-and-terminology.html` §1 为唯一来源。废弃词：左 aside / 会话列表视图 / session panel（歧义）/ 文件浏览区 / 搜索框 / main-panel / 双 panel（容器名）/ ChatView / Process Panel（v1 删）/ Mission Control（用 Overview）。
- **token**：色/字/距/影/动效值引自 `../../design-tokens.md`，组件原语形态引自 `../../design-system.md`。
- **HTML 规范**：每份 draft = standalone 单文件，内联 CSS，禁外链。冷蓝 token 已锁定（见各 spec）。
- **存放**：所有新文件放 `v3/` 下对应单元夹，禁止放项目根（上轮已纠正）。

## settings handoff 特例（★结构分歧 · 已登记）

settings 单元的 5 份 handoff（`handoff-{provider,skill,agent,extension,system}.md`）**保留在 `settings/` 目录内**，未归位到本 `handoffs/` 目录。理由：与同单元 spec/draft 强耦合（handoff 大量引用 `settings/spec.md` 的模式 A/B/C 与同目录 draft 的 zone），跨目录引用徒增维护成本。

- **现状已登记**，非待移动。若未来追求目录对称统一，移动需同步更新 `settings/spec.md §7` + 各 draft HTML 的引用（grep 确认当前外部零引用，移动成本可控）。
- **数字口径**：本目录 16 叶 + settings/ 内 5 份 = 全局共 21 份 handoff 覆盖 21 个 draft 叶子（1:1）。
- **押后项**：术语批量替换历史文件（ChatView / 会话列表等 8 处）/ 建 `settings/` 目录 → 待 settings spec 定稿后批量做，不在单叶 handoff 内。（Summary 契约已在 `panel/draft-message-stream.html` §3 由产品契约关闭，不再押后 PRODUCT。）
