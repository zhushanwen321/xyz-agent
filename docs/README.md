# docs 目录

xyz-agent 的文档统一存放于 `docs/`。按内容性质分目录，全项目共享。

## 目录结构

```
docs/
├── README.md              ← 本文件，目录索引
├── architecture.md        ← 系统架构总览（Electron 主进程 / Runtime / 渲染进程三层）
├── standards.md           ← 前端编码规范（Vue 3 + xyz-ui + Tailwind）
├── troubleshooting.md     ← 问题排查指南
├── design-evolution.md    ← UI 设计演变史（Warm&Soft → v3 → v6 → 太极纯灰）
│
├── adr/                   ← 架构决策记录（统一编号 + README 索引 + 旧→新编号映射）
├── architecture/          ← 架构设计文档（design/context/terminology/subsystems/plan/history）
├── extensions/            ← pi 扩展系统（开发指南/约定/术语/ADR/注册表）
├── page-design/           ← 前端设计 SSOT + 视觉规格 + 能力 spec
├── testing/               ← 测试手册（按功能分篇的操作步骤）
└── feature-map/           ← 功能规划全景（阶段性快照）
```

## 文档归属判定

| 问题 | 去向 |
|------|------|
| 全项目通用的架构/规范/排错？ | 根级 `*.md` |
| 不可逆的架构/技术决策？ | `adr/`（ADR，带日期 + 状态 + 背景 + 裁决） |
| 架构设计、分层、术语？ | `architecture/` |
| 前端视觉/组件/页面设计？ | `page-design/` |
| UI 设计演变历史？ | `design-evolution.md`（单篇汇总） |
| pi 扩展开发？ | `extensions/` |
| 某次重构的 spec/plan/test/retrospect？ | `.xyz-harness/<date>-<slug>/`（**不进 docs**） |
| 一次性审查日志、已完成的修复记录？ | 完成后删除（git 可追溯） |

## 关键文档入口

- [architecture.md](./architecture.md) — 系统架构总览
- [standards.md](./standards.md) — 前端编码规范
- [troubleshooting.md](./troubleshooting.md) — 问题排查指南
- [design-evolution.md](./design-evolution.md) — UI 设计演变史
- [adr/README.md](./adr/README.md) — ADR 索引（含旧→新编号映射）
- [page-design/README.md](./page-design/README.md) — 前端设计 SSOT 索引
- [architecture/README.md](./architecture/README.md) — 架构文档目录规范
- [extensions/local-dev-guide.md](./extensions/local-dev-guide.md) — pi extension 本地开发调试
- [extensions/gui-protocol-guide.md](./extensions/gui-protocol-guide.md) — extension GUI 协议接入

## 禁止放入 docs/

- xyz-harness 工作流产出物（spec / plan / test / retrospect）→ `.xyz-harness/<date>-<slug>/`
- 一次性审查日志、已完成的修复记录 → 完成后删除（git 可追溯）
- UI demo / HTML 设计稿 → `page-design/`（禁止散落项目根或 `demos/`、`impeccable/` 目录）
- 竞品/技术调研资料 → 移到 `~/Documents/xyz-agent-archive/`（不进 git）
