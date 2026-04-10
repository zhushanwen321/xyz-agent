# Superpowers 目录结构规范

设计规格（spec）和实施计划（plan）文档的组织规范。

## 目录结构

```
.claude/.superpowers/
├── yyyy-MM-dd-{short-title}/    # 主任务目录
│   ├── spec.md                              # 设计规格
│   ├── plan.md                              # 实施计划
│   └── {subtask-name}/                      # 子任务目录（可选）
│       └── spec.md                          # 子任务规格
```

## 命名规范

- **任务目录**：`yyyy-MM-dd-{short-title}`
  - 优先级：P0 > P1 > P2
  - 示例：`2026-04-09-toolrouter`
- **设计文档**：始终命名为 `spec.md`，放在任务目录内
- **计划文档**：始终命名为 `plan.md`，放在任务目录内

## 禁止的结构

- ❌ `docs/superpowers/` — 错误根目录
- ❌ `.claude/.superpowers/specs/` — 禁止集中存放 spec
- ❌ `.claude/.superpowers/plans/` — 禁止集中存放 plan

## 原因

spec 和 plan 是特定任务的配套文档，应该与该任务放在同一目录下，便于：
1. 上下文关联 — spec 和 plan 自然关联
2. 按时间组织 — 目录按日期排序，反映开发历史
3. 独立管理 — 每个任务有自己的 spec/plan，易于归档
