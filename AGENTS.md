# AGENTS — Agent 工作指引

> 完整编码规范与项目约定见 [`CLAUDE.md`](CLAUDE.md)（项目根）及 [`docs/standards.md`](docs/standards.md)。

## 技术栈
Electron + Vue 3 + TypeScript + Pinia + Tailwind CSS v3 + xyz-ui 组件库（v3 冷蓝暗色）。Runtime 是独立 Node.js WebSocket 服务（`src-electron/runtime/`），与前端通过 WS 通信。

## Agent 工作底线
1. 改文件前先读它的调用方与共用工具（CLAUDE.md「写之前先读」）
2. 前端禁原生 HTML 元素 / Emoji / 硬编码颜色 / 魔数间距 —— 用 xyz-ui 组件 + Tailwind 语义类
3. Runtime 是 pi 协议的唯一适配点，业务代码不直接处理 pi 格式
4. 所有 runtime → 前端消息必须带 sessionId（session 隔离）

## 设计文档区
- 页面设计 SSOT：`docs/page-design/`（v3 正式稿在 `v3/`，`design-tokens.md` + `design-system.md` 是原子层）
- Design workflow 产出：`.xyz-harness/{yyyy-MM-dd}-{主题}/`（各阶段 .md + .html）
- 统一语言：`CONTEXT.md`（本目录）+ `docs/architecture/context.md`（完整版）
