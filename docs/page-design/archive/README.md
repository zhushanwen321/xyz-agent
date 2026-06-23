# archive · pre-v3 历史设计稿

本目录存放 v3 重构（ADR-0018，2026-06）**之前**的 UI 探索稿。v3 冷蓝暗色方向确立后，这些稿已被 [`../v3/`](../v3/) 正式设计区全面取代。

## 性质

- **不再维护**：仅作历史追溯用途，保留设计演进脉络
- **不作为实现依据**：当前前端实现以 [`../v3/`](../v3/) spec + draft 为准
- **命名混乱是历史遗留**：`views_*.html` / `demo-*.html` / `0X-*.html` 多种命名风格并存，反映不同探索阶段，不强制统一

## 内容概览

| 类别 | 示例 | 时期 |
|------|------|------|
| 整页原型 | `index.html`（v4 暖色）、`views_app-shell.html` | 2026-05 初版 |
| 视图探索 | `views_chat.html`、`views_sidebar.html`、`views_settings-*.html` | 2026-05 |
| 风格对比 | `demo-tone-comparison.html`、`demo-warm-soft-redesign.html` | 2026-05 Warm & Soft 时期 |
| chat 区精修 | `0X-*.html`（impeccable critique 产出）、`chat-area-design-decisions.md` | 2026-06 初 |
| settings 探索 | `settings-final.html`、`settings-variant-*.html` | 2026-05 |

## 设计系统沿革

| 阶段 | 文档 | 状态 |
|------|------|------|
| Warm & Soft（已推翻） | ~~`docs/design-system.md`~~（已删除）、~~`docs_DESIGN-SYSTEM.md`~~（已删除） | ADR-0018 废弃 |
| v3 冷蓝暗色（当前） | [`../design-tokens.md`](../design-tokens.md) + [`../design-system.md`](../design-system.md) | 生效 SSOT |

详细决策见 [ADR-0018](../../architecture/adr/0018-visual-direction.md)。
