# page-design · 页面设计

xyz-agent 前端设计的权威目录。v3 冷蓝暗色设计系统（ADR-0018）的 SSOT 与设计稿集中于此。

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

1. **tokens 是唯一值源**：`src-electron/renderer/src/style.css` 的 CSS 变量必须全部能在 `design-tokens.md` 找到（pre-commit hook `check_css_token_ssot.py` 强制校验）
2. **draft 必须有 spec**：一个设计单元 = 一个文件夹（spec.md + n 个 draft）。只有 draft 没 spec = 缺口
3. **术语唯一来源**：`v3/architecture-and-terminology.html §1`，新稿禁止用废弃词
4. **ADR 归架构目录**：设计决策记录放 `docs/architecture/adr/`，不放本目录

## 相关文档

- [ADR-0018 视觉方向](../architecture/adr/0018-visual-direction.md) — v3 冷蓝暗色确立
- [领域术语表](../architecture/context.md) — v3 UI 结构术语
- [编码规范 §设计](../standards.md) — 前端设计规则
