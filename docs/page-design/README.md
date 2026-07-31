# page-design · 页面设计

xyz-agent 前端设计的权威目录。v3 冷蓝暗色设计系统（ADR-0018）的 SSOT 与设计稿集中于此。

> **当前状态（2026-07）**：**v6 是当前进行中的全面重设计**，落在视觉语言层（架构/色相/字体保留）。ADR-0018 的 v3 冷蓝暗色为色彩基底，v6 范式已演进（五原则：层级代替边框 / 圆角升档 / 正文提亮 / 内容收窄 / 彩色降噪）。**v6 SSOT = [`v6-design.md`](./v6-design.md)**。下方 v3 内容作为历史参考保留，不删；新设计以 v6 为准。

## 目录结构

```
page-design/
├── README.md           本文件（索引 + 归属判定）
├── design-tokens.md    原子 SSOT（色/字/距/影/动效）— 所有值的唯一来源
├── design-system.md    组件原语层（Card/Input/Button 等如何用 tokens）
├── zcode-ui-spec.md    ZCode 风格 Chat UI/UX 规格（v3 视觉方向的布局规则）
├── v3/                 ★正式设计区（L0-L4 递归骨架，22 个 draft 全落地）
├── zcode-demo/         v3 视觉方向的原型来源（React demo，参考用）
└── archive/            pre-v3 历史探索稿（不再维护，仅追溯）
```

## 三层关系

```
design-tokens.md   ← 原子：存在哪些值
design-system.md   ← 原语：值如何拼成可复用部件
v3/<模块>/spec.md  ← 模块：原语如何组合成一个功能单元
v3/<模块>/draft-*  ← 验证：模块的可视化原型（HTML）
```

所有前端实现必须从本目录派生，禁止各处自造变体。

## v6 文档索引（当前进行中）

> v6 = 2026-07 全面重设计，视觉语言层。SSOT 为 [`v6-design.md`](./v6-design.md)。下列文件按用途分组。

**设计与规范**

| 文件 | 用途 |
|------|------|
| [`v6-design.md`](./v6-design.md) | **v6 视觉与架构设计规范（SSOT）** — 已确认决策、五原则、视觉/结构决策 |
| [`v6-summary.md`](./v6-summary.md) | v6 设计稿总览（索引与摘要，临时查阅文档） |
| [`v6-spec-tokens.html`](./v6-spec-tokens.html) | v6 token 集 + 标注规范 |

**视觉稿（v6-spec-*.html 系列）**

| 文件 | 用途 |
|------|------|
| [`v6-spec-shell.html`](./v6-spec-shell.html) | shell 三栏骨架视觉稿 |
| [`v6-spec-sidebar.html`](./v6-spec-sidebar.html) | sidebar（侧边会话列表）视觉稿 |
| [`v6-spec-drawer.html`](./v6-spec-drawer.html) | drawer（抽屉）视觉稿 |
| [`v6-spec-overlays.html`](./v6-spec-overlays.html) | overlays（浮层/popover/dialog）视觉稿 |
| [`v6-spec-container.html`](./v6-spec-container.html) | 对话流容器视觉稿 |
| [`v6-spec-content.html`](./v6-spec-content.html) | 对话流内容（消息块）视觉稿 |
| [`v6-spec-input.html`](./v6-spec-input.html) | 输入区（Composer）视觉稿 |
| [`v6-spec-blocks.html`](./v6-spec-blocks.html) | 消息块族（toolcall/file/diff 等）视觉稿 |
| [`v6-spec-plugin-rendering.html`](./v6-spec-plugin-rendering.html) | plugin 渲染区视觉稿 |
| [`v6-spec-settings.html`](./v6-spec-settings.html) | settings（全屏覆盖）总视觉稿 |
| [`v6-spec-settings-shell.html`](./v6-spec-settings-shell.html) | settings shell 视觉稿 |
| [`v6-spec-settings-provider.html`](./v6-spec-settings-provider.html) | settings — provider 视觉稿 |
| [`v6-spec-settings-extension.html`](./v6-spec-settings-extension.html) | settings — extension 视觉稿 |
| [`v6-spec-settings-resources.html`](./v6-spec-settings-resources.html) | settings — resources 视觉稿 |
| [`v6-spec-settings-system-prompt.html`](./v6-spec-settings-system-prompt.html) | settings — system prompt 视觉稿 |

**共享基建与验证**

| 文件 | 用途 |
|------|------|
| `v6-spec-base.css` | 对话流共享 CSS（L2.1 规划中，抽取以根治四文件复制漂移） — *规划中，尚未创建* |
| [`v6-demo.html`](./v6-demo.html) | 综合交互 demo（验收 SSOT） |
| [`v6-drawer-tabs-demo.html`](./v6-drawer-tabs-demo.html) | drawer tabs 交互原型 |
| [`v6-plugin-max-demo.html`](./v6-plugin-max-demo.html) | plugin 最大化交互原型 |

**审查与修复计划**

| 文件 | 用途 |
|------|------|
| [`v6-review-2026-07-31.md`](./v6-review-2026-07-31.md) | 五路审查报告（349 条断言） |
| [`v6-fix-plan.md`](./v6-fix-plan.md) | **全量修复计划（rev3，62 任务）** — 当前执行计划 |
| [`v6-review-action-plan.md`](./v6-review-action-plan.md) | 旧版 plan（已被 v6-fix-plan 取代，保留追溯） |

## SSOT 链（v3 → v6 演进）

```
design-tokens.md        ← v3 原子层（色/字/距/影/动效值的唯一来源）
        ↑ 派生
v6-design.md            ← v6 范式 SSOT（五原则 + 视觉/结构决策，演进 v3）
        ↑ 派生
v6-spec-*.html          ← v6 视觉稿（各视图标注规范）
        ↑ 验证
v6-demo.html            ← v6 综合交互 demo（验收 SSOT）
```

- **v3 原子层（design-tokens.md）仍是值的唯一来源**：CSS 变量仍须全部能在 design-tokens.md 找到
- **v6-design.md 是范式 SSOT**：v6 范式与决策以此为准；v3/ 下 spec 为旧范式（已被 v6 追认或修订）
- **v6-spec-*.html 是视觉稿**：从 v6-design 派生，承载标注规范
- 实施时序：阶段 0（测试基建）→ A（架构重构）→ B（renderer 局部重构）→ C（v6 视觉层）

## 目录分区归属

| 目录 | 性质 |
|------|------|
| `archive/` | **pre-v3 历史探索稿**（不再维护，仅追溯） |
| `v3/` | **v3 正式设计区**（L0-L4 递归骨架，已被 v6 追认/修订，保留作历史参考） |
| `v6-*.md` / `v6-*.html` | **v6 当前进行中**（SSOT = v6-design.md） |
| `zcode-demo/` | v3 视觉方向的原型来源（React demo，参考用） |

## 文档归属判定

| 问题 | 去向 |
|------|------|
| 色值/字体/圆角/阴影/动效的值定义？ | `design-tokens.md` |
| 组件原语（Card 族、Input、Button）的形态/状态？ | `design-system.md` |
| 一个 UI 模块（shell/sidebar/panel 等）的完整规范？ | `v3/<模块>/spec.md` |
| 模块规范的可视化验证稿？ | `v3/<模块>/draft-*.html` |
| 跨模块的用户流程（如 code-review 流）？ | `v3/flow-*/` |
| v3 之前的旧设计探索？ | `archive/`（不再维护） |

## 关键约束

1. **tokens 是唯一值源**：`packages/renderer/src/style.css` 的 CSS 变量必须全部能在 `design-tokens.md` 找到（pre-commit hook `check_css_token_ssot.py` 强制校验）
2. **draft 必须有 spec**：一个设计单元 = 一个文件夹（spec.md + n 个 draft）。只有 draft 没 spec = 缺口
3. **术语唯一来源**：`v3/architecture-and-terminology.html §1`，新稿禁止用废弃词
4. **ADR 归架构目录**：设计决策记录放 `docs/architecture/adr/`，不放本目录

## 相关文档

- [ADR-0018 视觉方向](../architecture/adr/0018-visual-direction.md) — v3 冷蓝暗色确立
- [领域术语表](../architecture/context.md) — v3 UI 结构术语
- [编码规范 §设计](../standards.md) — 前端设计规则
