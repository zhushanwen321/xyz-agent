---
name: block-wrong-superpowers-path
enabled: true
event: file
action: block
conditions:
  any_of:
    - field: file_path
      operator: regex_match
      pattern: docs/superpowers/
    - field: file_path
      operator: regex_match
      pattern: \.claude/\.superpowers/(specs|plans)/
  - field: new_text
    operator: regex_match
    pattern: .+
---

**禁止创建或编辑以下位置的文件：**

1. `docs/superpowers/` — 错误目录
2. `.claude/.superpowers/specs/` — 错误结构
3. `.claude/.superpowers/plans/` — 错误结构

**正确的目录结构：**

```
.claude/.superpowers/
└── yyyy-MM-dd-short-title/          # 任务目录（按日期+标题命名）
    ├── spec.md                      # 设计规格文档
    ├── plan.md                      # 实施计划文档
    └── subtask-xxx/                 # 子任务目录（可选）
        └── spec.md                  # 子任务规格
```

**命名规范：**
- 任务目录：`yyyy-MM-dd-P{priority}-{short-title}` 或 `yyyy-MM-dd-{short-title}`
- 设计文档：始终命名为 `spec.md`（放在任务目录内）
- 计划文档：始终命名为 `plan.md`（放在任务目录内）

请将文件移动到正确的位置。
