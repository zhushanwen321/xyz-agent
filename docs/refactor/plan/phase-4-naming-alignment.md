# 阶段 4 · 命名对齐（引用既有计划）

> 上游：[migration-plan.md](../migration-plan.md) · 关联决策：D7 · 既有计划：[terminology-alignment-plan.md](../terminology-alignment-plan.md)

## 目标

执行既有 `terminology-alignment-plan.md` 的 R1–R5 命名债清理，消除认知债务。

## 前置依赖

阶段 2（`SidecarServer → RuntimeServer` 在阶段 2 已做）。

## 改动清单（R1–R5）

| # | 旧名 | 新名 | 范围 |
|---|------|------|------|
| R1 | sidecar（目录/变量） | runtime | 已大部分完成，扫残留 |
| R2 | Pane | Panel | 组件名、类型名、store |
| R3 | SystemChatMessage | SystemNotification | 类型 + 使用处 |
| R4 | Drawer | SideInspector | 组件 + 引用 |
| R5 | Overview | PanelGrid | 组件 + 引用 |

详见 `terminology-alignment-plan.md` 的逐项执行步骤。

## 改动原则（design.md D7）

- 「挪名」须同时「正注释」，否则只换皮不治本。
- 用 `git mv` 改文件名（保留历史）；IDE 重命名改符号引用。
- 全仓搜索旧名，确保无残留（含注释、文档）。

## 验证标准

- [ ] `npm run lint` 通过。
- [ ] `npm run build` 通过。
- [ ] 全局搜索旧名无残留：`rg "Pane|SystemChatMessage|Drawer|Overview|SidecarServer" src-electron/ --type ts --type vue`（注意排除合法用法，如 CSS pane 属性）。
- [ ] 手测涉及组件功能正常。

## 回滚

`git revert <commit>`。命名变更是纯重命名，无逻辑风险。

## 备注

R1（sidecar→runtime）的 `SidecarServer → RuntimeServer` 在阶段 2 已完成。本阶段聚焦 R2–R5（前端命名）。可与阶段 5 并行。
