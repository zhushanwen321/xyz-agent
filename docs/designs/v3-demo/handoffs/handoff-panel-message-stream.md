# Handoff · panel · draft-message-stream（验收型 · 已完成）

## 1. 路径
- 目录：`v3-demo/panel/`
- 文件：`draft-message-stream.html`（✅ 已完成 · 唯一载体）
- 层级：L2 Module · Panel message-stream zone
- 上游 spec：`panel/spec.md`（5 zone + 回合折叠机制 + steer/followup）
- 备注：原 `message-types` 规则稿已并入本文 §4 附录，message-stream 是唯一载体（替代旧名）

## 2. 产物现状
- standalone，内联 CSS，冷蓝 token
- **交互原型（§1）**：用户消息靠右气泡，助手消息与背景融合；点「已工作 X分 + 思考/工具计数」按钮向下展开执行流程
- **边界态画廊（§2）**：工具失败挂 tool 块整块红框、streaming 无背景下划线展开等
- **未决落点（§3）**：①–⑥ 全 resolved（summary 恒存在、steer/followup 时机归 runtime，由产品契约在本稿关闭）
- **规则附录（§4）**：7 类块 + 折叠规则（原 message-types 稿合并于此）

## 3. 已做的事（回顾）
- [x] 交互原型（回合折叠 + 「已工作」计数按钮）
- [x] 边界态画廊（工具失败红框、streaming 态）
- [x] 未决落点全裁决（summary 恒存在契约关闭）
- [x] message-types 规则稿合并入 §4，消除双载体

## 4. 关联文档
- `panel/spec.md`（回合折叠规则、message-stream zone 细则）
- `architecture-and-terminology.html`（术语锚点）

## 5. 关联 HTML
- `panel/draft-composer-states.html`（steer/followup 待提交气泡）
- `panel/draft-companion-zones.html`（progress-zone 显示工具执行进度）

## 6. 验收 P0
- [x] 回合折叠交互（点「已工作」展开完整执行流程）
- [x] 7 类块规则（§4 附录为唯一定义）
- [x] 未决项全 resolved（无 deferred）

## 7. suggested skills
- 无（已完成；summary 契约已在 §3 由产品契约关闭，不再押后 PRODUCT）
