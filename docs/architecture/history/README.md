# 历史版本归档

本目录存放**被整体取代的旧架构版本**。文档在此仅供追溯，**不代表当前架构**。

当前架构以 [`../../design.md`](../design.md) 为准，入口 [`../../../architecture.md`](../../../architecture.md)。

## 归档规则

- 触发：`design.md` 或某个架构方案被新版**整体取代**时归档
- 命名：`<里程碑>-<YYYY-MM-DD>/`，用语义命名（如 `pre-electron-2026-05`），不用版本号
- ADR **不进本目录**：ADR 自带 supersede 机制，被取代时改状态字段即可

## 已归档

- [pre-electron-2026-05/](pre-electron-2026-05/migration-plan.md) — Tauri → Electron 迁移方案（迁移完成后归档）
