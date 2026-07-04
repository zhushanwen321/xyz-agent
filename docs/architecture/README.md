# 架构文档目录规范

本目录存放 xyz-agent 所有架构相关文档。入口是上一级的 [`../architecture.md`](../../architecture.md)，本 README 只说明**组织规则**。

## 目录结构

```
docs/architecture/
├── README.md            # 本文件（规范说明）
├── design.md            # 当前生效的完整架构设计
├── review-issues.md     # 架构评审问题记录（盲点 D1–D9）
├── migration-plan.md    # 重构迁移路线（索引）
├── terminology.md       # 术语对齐计划（R1–R3 生效 · R4/R5 已被 v3 推翻标注过时）
├── context.md           # 领域术语表（Session/Panel/Runtime 等）
├── plan/                # 迁移各阶段细节
├── changes/             # 阶段评审记录
├── adr/                 # 架构决策记录（0001-0017 系统/运行时 · 0018-0022 v3 视觉/交互 · 0023 statusline 封装）
├── subsystems/          # 子系统架构（如 plugin/）
├── research/            # 架构调研（非 UI 调研）
└── history/             # 历史版本归档（被 supersede 的旧架构）
```

> **v3 设计稿** 在 `docs/page-design/v3/`（L0-L4 递归骨架 spec + draft），基础件 `design-tokens.md` / `design-system.md` 在 `docs/page-design/` 根。v3 视觉/交互 ADR（0018-0022）已归位到本目录 `adr/`。

## 三条核心规则

### 1. 单一入口，不重复内容

`docs/architecture.md` 是「当前架构」唯一入口，**只放索引链接**。
- 改架构 → 改本目录内的具体文档（`design.md` 等）
- 入口的链接跟随更新，但**不在入口重复正文**

### 2. 版本归档触发条件

什么文档进 `history/`：

| 触发条件 | 动作 |
|---------|------|
| `design.md` 被新版**整体取代**（大重构/换方向） | 旧版 move 到 `history/<里程碑>-<YYYY-MM-DD>/design.md` |
| 某架构方案被新方案取代且不再参考 | move 到对应里程碑目录 |
| ADR 被新 ADR 取代 | **不进 history**——在原 ADR 写 `Status: Superseded by ADR-NNNN`，新 ADR 引用旧 ADR（supersede 机制内建） |

**里程碑命名**用语义而非版本号：`pre-electron-2026-05/`、`pre-refactor-2026-06/`。避免维护版本号带来的同步负担。

### 3. ADR 规范

- 文件名：`NNNN-kebab-case-title.md`（4 位序号 + 短横线标题）
- 必含字段：`# NNNN: 标题` + `## 状态`（已接受/已废弃/已被取代）+ `## 背景` + `## 决策` + `## 理由`
- 被取代时：原 ADR 状态改 `已被 ADR-NNNN 取代`，**不删除**——ADR 本身就是历史记录链
- 序号严格递增，不复用

## 什么算「架构相关」

| 属于本目录 | 不属于（留 docs/ 其他位置） |
|-----------|---------------------------|
| 系统分层 / 模块边界 / 依赖方向 | UI 设计稿（`docs/page-design/`） |
| 跨进程通信 / 数据流 | 设计规范（`docs/page-design/design-system.md`） |
| 架构决策（ADR） | 编码规范（`docs/standards.md`） |
| 子系统设计（plugin 等） | 功能规划（`docs/project/`、`docs/feature-map/`） |
| 架构调研（打包/路径安全/RPC 通道） | UI 调研（TUI→GUI 映射等，留 `docs/research/`） |
| 迁移 / 重构路线 | 竞品分析（`docs/templates/`） |

**判定标准**：描述「系统如何被组织和约束」→ 架构；描述「系统长什么样/怎么用」→ 其他。

## 与 CLAUDE.md 的关系

`CLAUDE.md`（项目根）是**编码规范 + 关键规则**，引用本目录的 ADR 作为决策依据（如 `docs/architecture/adr/0016-...`）。CLAUDE.md 不重复架构内容，只链接。
