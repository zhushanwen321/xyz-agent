# page-design · 页面设计

太极（xyz-agent）前端设计的权威目录。设计系统的 SSOT 与设计稿集中于此。

> **当前状态（2026-08）**：视觉层已从 v3 冷蓝演进到 **v6 太极纯灰**（accent `#c8c8cd`，三级明度 stage/bg/surface）。v6 SSOT = [`v6-design.md`](./v6-design.md)。v6 Vue 交互 demo 在 `../../.tmp/v6/`（独立可运行项目，不放在文档目录）。下方 archive/v3/ 的视觉稿是 v6 之前的中间态，保留追溯；**但 archive/v3/ 下的能力 spec（fast-*/flow-*/research 等）仍是活跃的功能设计 SSOT，非死稿**。

## 目录结构

```
page-design/
├── README.md                          本文件（索引 + 归属判定）
├── design-tokens.md                   原子 SSOT（色/字/距/影/动效）— 所有值的唯一来源
├── design-system.md                   组件原语层（Card/Input/Button 等如何用 tokens）
├── zcode-ui-spec.md                   ZCode 风格 Chat UI/UX 规格（布局规则）
├── 2026-08-02-taiji-v3-color-decision.md  太极 V3 纯灰配色决策记录
├── markdown-filepath-redesign/        Markdown 文件路径识别重构设计（已落地）
├── logo/                              品牌 logo 素材与设计稿
│   ├── assets/qianwen/                当前唯一活跃素材库（千问双鱼）
│   └── archive/pre-2026-08-qianwen/   已淘汰素材（butterfly/taiji/taiji-fish + concepts）
├── archive/                           历史设计稿归档（见下方详细说明）
├── v6-design.md                       v6 视觉与架构设计规范（范式 SSOT）
├── v6-summary.md                      v6 设计稿总览（索引与摘要）
├── v6-spec-tokens.html                v6 token 集 + 标注规范
├── v6-spec-*.html                     v6 各视图视觉稿（14 个文件）
├── v6-spec-base.css                   对话流共享 CSS
├── v6-demo.html                       综合交互 demo（验收 SSOT）
├── v6-drawer-tabs-demo.html           drawer tabs 交互原型
├── v6-plugin-max-demo.html            plugin 最大化交互原型
├── 2026-08-02-taiji-v3-color-decision.md   V3 配色决策
├── visual-modernization-2026-07.md    v6 视觉输入/基线提案（历史，SSOT 以 v6-design.md 为准）
├── v6-review-2026-07-31.md            v6 第一轮审查报告（历史）
├── v6-review-round2-2026-07-31.md     v6 第二轮复审报告（历史）
├── v6-fix-plan.md                     v6 全量修复计划（历史，已执行完毕）
└── v6-review-action-plan.md           v6 旧版修复计划（历史，已被 fix-plan 取代）
```

> v6 Vue 交互 demo 在 `../../.tmp/v6/`（独立 Vue 3 + Vite 项目，有自己的 package.json / node_modules）。

## 三层关系

```
design-tokens.md   ← 原子：存在哪些值
design-system.md   ← 原语：值如何拼成可复用部件
v6-design.md       ← 范式：五原则 + 视觉/结构决策
v6-spec-*.html     ← 视觉稿：各视图标注规范
```

所有前端实现必须从本目录派生，禁止各处自造变体。

## archive/ 目录说明

archive/ 是历史设计稿归档区，分两大块：

### archive/v3/ — v3 设计稿全集（混合：死稿 + 活 spec）

| 子目录 | 性质 | 说明 |
|--------|------|------|
| `shell/` `sidebar/` `panel/` `settings/` `overlays/` `workspace/` `overview/` `new-task/` `ask-user/` | **视觉稿（已被 v6 取代）** | spec.md + draft-*.html，v6-design.md 已超越 |
| `fast-fork/` `fast-handoff/` `fast-merge/` | **能力 spec（活跃）** | 跨区联动功能的设计 SSOT，v6 无对应物 |
| `flow-2-code-review/` `flow-3-subagent/` | **能力 spec（活跃）** | 产品主路径时序设计 |
| `coding-plan-quota/` | **能力 spec（活跃）** | provider 额度查询设计（packages/ 代码注释引用） |
| `research/` | **实现调研（活跃）** | pi steer/followUp 机制调研 |
| `subagent-panel/` | **实现调研（活跃）** | agent-call-streaming + workflow-spec |
| `handoffs/` | **交接文档** | 19 份叶子 handoff，能力 spec 复活时的接手入口 |

### archive/zcode-demo/ — v3 视觉原型来源（React demo，已被 v6 吸收）

### archive/ 根目录 — pre-v3 探索稿（Warm & Soft 时期，已废弃）

`frontend-redesign-log.md` 是视觉方向演进的编年史，其余 `views_*.html` / `demo-*-comparison.html` 可安全忽略。

## SSOT 链（v3 → v6 演进）

```
design-tokens.md        ← 原子层（色/字/距/影/动效值的唯一来源）
        ↑ 派生
v6-design.md            ← v6 范式 SSOT（五原则 + 视觉/结构决策）
        ↑ 派生
v6-spec-*.html          ← v6 视觉稿（各视图标注规范）
        ↑ 验证
v6-demo.html            ← v6 综合交互 demo（验收 SSOT）
```

- **design-tokens.md 是值的唯一来源**：CSS 变量必须全部能在此找到
- **v6-design.md 是范式 SSOT**：v6 范式与决策以此为准
- archive/v3/ 的视觉 spec 为旧范式（已被 v6 追认或修订），但能力 spec 仍活跃

## 文档归属判定

| 问题 | 去向 |
|------|------|
| 色值/字体/圆角/阴影/动效的值定义？ | `design-tokens.md` |
| 组件原语（Card 族、Input、Button）的形态/状态？ | `design-system.md` |
| v6 视觉稿（某视图的标注规范）？ | `v6-spec-*.html` |
| 跨模块的用户流程（如 code-review 流）？ | `archive/v3/flow-*/spec.md`（活跃能力 spec） |
| Fork/Handoff/Merge 联动能力？ | `archive/v3/fast-*/spec.md`（活跃能力 spec） |
| pre-v3 旧设计探索？ | `archive/`（不再维护） |
| Logo 素材？ | `logo/assets/qianwen/`（活跃）/ `logo/archive/`（已淘汰） |

## 关键约束

1. **tokens 是唯一值源**：`packages/renderer/src/style.css` 的 CSS 变量必须全部能在 `design-tokens.md` 找到（pre-commit hook `check_css_token_ssot.py` 强制校验）
2. **术语唯一来源**：`archive/v3/architecture-and-terminology.html §1`，新稿禁止用废弃词
3. **ADR 归架构目录**：设计决策记录放 `docs/adr/`，不放本目录

## 相关文档

- [ADR-0019 视觉方向](../adr/0019-visual-direction.md) — v3 冷蓝暗色确立
- [太极 V3 配色决策](./2026-08-02-taiji-v3-color-decision.md) — 纯灰配色方向定案
- [领域术语表](../architecture/context.md) — UI 结构术语
- [编码规范 §设计](../standards.md) — 前端设计规则
