# Handoff · flows · flow-2-code-review（验收型 · 已完成 · 老叶子补录）

## 1. 路径
- 目录：`v3-demo/flow-2-code-review/`
- 文件：`draft-cases.html`（✅ 已完成）
- 层级：L3 Flow · 代码变更审查时序
- 上游 spec：`flow-2-code-review/spec.md`（flow 范围）
- 备注：本叶早于 handoff 体系建立，现补验收记录

## 2. 产物现状
- standalone，内联 CSS，冷蓝 token
- **S1–S6 屏幕序列**：代码变更审查完整时序（从触发到完成）
- **变更集卡状态机 5 态**：pending / running / review / approved / rejected
- **消息操作菜单**：critique P0 短板补齐
- **边缘状态 7 例**：错误 / 超时 / 冲突等异常路径

## 3. 已做的事（回顾）
- [x] S1–S6 屏幕序列
- [x] 变更集卡 5 态状态机
- [x] 消息操作菜单
- [x] 边缘状态 7 例

## 4. 关联文档
- `flow-2-code-review/spec.md`
- `adr/0019-core-user-flows.md`（flow 范围决策）

## 5. 关联 HTML
- `panel/draft-message-stream.html`（变更集卡嵌入消息流）
- `panel/draft-detail-pane.html`（变更详情展示）

## 6. 验收 P0
- [x] S1–S6 时序完整
- [x] 变更集卡 5 态覆盖
- [x] 边缘状态 7 例

## 7. suggested skills
- 无（已完成）
