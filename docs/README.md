# docs 目录

xyz-agent 的文档统一存放于 `docs/`。按内容性质分目录，全项目共享。

## 目录结构

| 目录 | 内容 | 性质 |
|------|------|------|
| 根级 `*.md` | 全项目通读文档（架构总览、编码规范、排错） | 活文档，持续维护 |
| `agent/` | Agent 提示词工程参考（prompt/slash 命令/tool description 编写指南） | 长期参考 |
| `architecture/` | 架构设计、决策记录（ADR）、迁移记录 | 活文档 + 永久 ADR |
| `page-design/` | 前端设计 SSOT 与设计稿（v3 冷蓝暗色） | 活文档 |
| `feature-map/` | 功能规划全景（按日期版本） | 阶段性快照 |
| `project/` | 项目功能清单（已完成/规划中/最高优先级） | 活文档 |
| `research/` | 技术调研、竞品借鉴 | 长期参考 |
| `templates/` | 设计参考素材、竞品 UI 分析 | 长期参考 |
| `extensions/` | 扩展系统分析 | 长期参考 |

## 文档归属判定

| 问题 | 去向 |
|------|------|
| 全项目通用的架构/规范/排错？ | 根级 `*.md` |
| 架构设计、分层、不可逆决策？ | `architecture/`（决策进 `architecture/adr/`） |
| 前端视觉/组件/页面设计？ | `page-design/` |
| 某次重构的 spec/plan/test/retrospect？ | `.xyz-harness/<date>-<slug>/`（**不进 docs**） |
| 外部/竞品/技术调研？ | `research/<topic>/` |
| 一次性审查日志、已完成的修复记录？ | 完成后删除（git 可追溯） |

## 关键文档入口

- [architecture.md](./architecture.md) — 系统架构总览（Electron 主进程 / Runtime / 渲染进程三层）
- [standards.md](./standards.md) — 前端编码规范（Vue 3 + xyz-ui + Tailwind）
- [troubleshooting.md](./troubleshooting.md) — 问题排查指南
- [page-design/README.md](./page-design/README.md) — 前端设计 SSOT 索引
- [architecture/README.md](./architecture/README.md) — 架构文档目录规范
- [extensions/local-dev-guide.md](./extensions/local-dev-guide.md) — pi extension 本地开发调试指南
- [extensions/gui-protocol-guide.md](./extensions/gui-protocol-guide.md) — extension GUI 协议接入

## 禁止放入 docs/

- xyz-harness 工作流产出物（spec / plan / test / retrospect）→ `.xyz-harness/<date>-<slug>/`
- 一次性审查日志、已完成的修复记录 → 完成后删除（git 可追溯）
- UI demo / HTML 设计稿 → `page-design/`（禁止散落项目根或 `demos/`、`impeccable/` 目录）
