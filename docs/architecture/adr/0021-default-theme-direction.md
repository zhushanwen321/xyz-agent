# 0021: 默认主题方向

**Status**: Accepted — 已裁决（选项 B，暗色冷蓝为真默认）
**Date**: 2026-06-20
> **裁决**：暗色冷蓝为真默认，真身代码跟随 ADR-0018
> **关联**：ADR-0018（视觉方向）、`design-tokens.md`、`design-system.md §10`、`settings/handoff-system.md §2/§11a`

## 背景

项目存在两套相互矛盾的「默认主题方向」主张，分别来自设计层与真实代码层：

| 主张方 | 默认 | 依据 |
|---|---|---|
| **设计层** | 暗色冷蓝优先（`--bg #0d0d0f`，accent `#4f8ef7`） | `design-tokens.md`（标题「冷蓝暗色 SSOT」）、`design-system.md §10`（「暗色为主，亮色为辅」）、`PRODUCT.md`、ADR-0018 |
| **真实代码层** | 亮色 neutral（`theme=light`，`themePreset=neutral`） | `settings/handoff-system.md §2`：`settingsStore` 初值 `theme='light'` / `themePreset='neutral'`，来自 `~/Code/xyz-agent-workspace/main` 现有实现 |

settings draft 用 `cold-blue` preset 演示来视觉弥合，但**真身代码默认仍是亮色 neutral**，未跟随设计方向。

## 附带冲突：impl 变量未登记

`settings/handoff-system.md §13` 记录：impl 用了 `--section-bg` / `--divider` / `--accent-light` 三个变量，`design-tokens.md` 未定义。这是 token SSOT 的次生裂缝，与本主题方向问题同源（设计 token 体系与 impl 未完全对齐）。

## 选项

### 选项 A · 设计跟随代码（亮色 neutral 为真默认）

- 真身代码不动，`design-tokens.md` / `design-system.md` 改口：亮色 neutral 为默认，暗色冷蓝降为「备选/高保真打磨对象」。
- draft 已用 cold-blue 演示 → 需重新评估是否改回 neutral 演示。
- **代价**：推翻 ADR-0018 的视觉方向主张；冷蓝暗色探索成果降级。
- **适合**：产品实际面向亮色场景、暗色非核心体验。

### 选项 B · 代码跟随设计（暗色冷蓝为真默认）

- 真身 `settingsStore` 初值改 `theme='dark'` / `themePreset='cold-blue'`；`SystemPane.vue` `palettes[]` 新增 `cold-blue`。
- `design-tokens.md` 补登 `--section-bg` / `--divider` / `--accent-light`（或反向：impl 改用 tokens 已有名）。
- **代价**：改真身代码 + 测试亮暗双态；现有亮色用户首次升级会看到主题切换。
- **适合**：产品定位就是开发者工具暗色体验（与 ADR-0018 一致）。

### 选项 C · 维持现状 + 显式登记（draft 演示态 ≠ 真身默认）

- 不改代码也不改设计主张，正式承认「draft 演示用 cold-blue、真身默认 neutral」是**有意分离**（draft 展示设计目标，真身保守默认）。
- **代价**：长期维持两套口径，新接手者需读本 ADR 才能理解。
- **适合**：暗色方向仍在探索、暂不想动真身。

## 裁决（2026-06-20）

### Q1 → 选项 B · 暗色冷蓝为真默认

产品真实默认 = **暗色冷蓝**（`--bg #0d0d0f` / accent `#4f8ef7`）。真身代码跟随设计主张（ADR-0018）。

落地变更（真身 `~/Code/xyz-agent-workspace/main`，非本设计仓）：
- `shared/src/settings.ts`：`settingsStore` 初值 `theme: 'light'` → `'dark'`，`themePreset: 'neutral'` → `'cold-blue'`
- `settings/SystemPane.vue`：`palettes[]` 新增 `cold-blue` preset（品牌主色）
- 校验亮暗双态切换回归（现有亮色用户首次升级会看到主题切换，属预期）

### Q2 → 选项② · impl 迁移到 SSOT 已有名（附带裁决）

基于 Q1「代码跟随设计」方向，token 命名也由 impl 迁移到 `design-tokens.md` SSOT，**不把 impl 自造名补进 tokens**（避免同语义双名污染源头）。三个自造名均有干净语义对应：

| impl 现名 | → SSOT 名 | 语义 |
|---|---|---|
| `--section-bg` | `--surface` | 区块/面板背景 |
| `--divider` | `--border` | 分隔线 |
| `--accent-light` | `--accent-soft` | 主色背景填充 |

落地：真身 CSS 变量全局重命名（替换 + 移除自造名）。draft 已用 SSOT 名，无需改。

> 若不认可此附带裁决，可回退到选项①（补进 tokens），但会引入「同一语义两个 token 名」的长期维护成本。

### Q3 → draft 与真身默认统一

裁决 B 后，draft 演示态（cold-blue）与真身默认**将一致**（真身完成迁移后）。迁移期间 handoff `§2`/`§12` 仍如实记录真身当前为 light/neutral，并登记「待跟随 ADR-0021-B」待办。

## 落地状态

- **设计层**：✅ `design-tokens.md` / `design-system.md §10` / `PRODUCT.md` / ADR-0018 本就主张暗色冷蓝，无需改。
- **真身代码**：⏳ 待迁移（见 Q1/Q2 变更清单），已在 `settings/handoff-system.md §11b` 登记。
- **draft**：✅ 已用 cold-blue 演示 + SSOT token 名，与本裁决一致。
- **收口登记**：`design-tokens.md`「已知裂缝」、`v3-demo/README.md`「已知问题」同步标为已裁决。
