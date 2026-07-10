# 0018: 视觉方向收敛到 zcode-demo 冷蓝暗色

**状态:** Accepted　**日期:** 2026-06-18　**决策者:** 产品负责人

## 决策

以 `docs/page-design/zcode-demo/`（冷蓝 `#4f8ef7`、暗色画布、Inter）作为产品**唯一视觉标准 (single source of truth)**，默认主题基调为**暗色优先，亮色为备选**。

> **注**：原始画布色值为 `#0d0d0f`，2026-07-09 提亮校准为 `#1a1b1f`（对标 VS Code Dark+，减轻长时间用眼疲劳，详见 `design-tokens.md` 暗色章节）。本 ADR 的视觉方向裁决（冷蓝暗色优先）不变。

完整 token 见 `docs/design-tokens.md`（本 ADR 的规范附件，唯一可引用的色值/字体/圆角源）。

## 背景

重构前共存四套互相冲突的视觉系统：

| 代号 | 来源 | 方向 | 处置 |
|------|------|------|------|
| A · Warm Workbench | `DESIGN.md` + `PRODUCT.md` 品牌 | 暖奶油 + 赤陶 + serif + 亮色 | **归档** |
| B · 终端/IDE | ~~`docs/design-system.md`~~（已删除） | 纯黑 + 绿 `#22c55e` + 1px 圆角 | **归档** |
| C · zcode-demo | `docs/page-design/zcode-demo/` | 纯黑 + 蓝 `#4f8ef7` + Inter + 暗色 | **✅ 升级为真身** |
| D · 真实代码漂移 | `src-electron/.../style.css` + `tailwind.config.ts` | 暖底 + 青蓝 accent(195°) + serif + 1px | **改到对齐 C** |

`PRODUCT.md` 原定的「温润赤陶 Warm Workbench」品牌方向**被本决策推翻**，需同步重写。

## 理由

1. **用户决策**：产品负责人明确选择 C，接受推翻 Warm 定位的代价。
2. **目标用户对齐**：AI-Coding-Agent 的核心用户是开发者；冷蓝暗色更贴近 Cursor / Windsurf / VS Code 的开发者工具直觉。
3. **暗色优先的内部一致性**：C 本身就是纯暗色，"暗色优先"与 C 无冲突；而 A 的亮色优先与决策矛盾。
4. **布局资产保留**：C 探索出的 layered-float 画布、三栏聊天、进程 mini-chip、右抽屉 diff/浏览器/终端 是产品核心交互创新，随 C 一并保留。

## 代价与风险

- **品牌一致性**：推翻 `PRODUCT.md` 已固化的 Warm 人格，需重写品牌章节，否则文档自相矛盾。
- **C 的 token 残缺**：zcode-demo 原始仅 9 个 CSS 变量，缺 warning/danger/info、间距、阴影、动效、亮色变体。已在 `docs/design-tokens.md` 补全，但补全项未经视觉校准，需在高保真阶段验证。
- **D 的状态色资产**：真实代码 `style.css` 已有完整的 success/warning/danger + light 体系，比 C 完整——收敛时**继承 D 的状态色结构**，仅替换色相，不全盘推翻。

## 归档处置

- **A (`DESIGN.md`)**：文件顶部加 `> ⚠️ DEPRECATED by ADR-0018 (2026-06-18). 真身见 docs/design-tokens.md`，保留作历史参考，从所有"当前规范"链接撤下。
- **B (`docs/design-system.md`，已删除)**：原 Warm & Soft 方案，ADR-0018 推翻后文件已清理。
- **`PRODUCT.md`**：品牌章节（Warm & Soft 人格、赤陶、anti-references 中"不是冷色开发者工具"）需重写为冷蓝暗色开发者工具人格——**单独任务，不在此 ADR 范围**。

## D 的漂移修复清单（精确到行）

目标：`src-electron/renderer/src/style.css` + `tailwind.config.ts` 全部对齐到 `docs/design-tokens.md`。

`style.css` :root（L11-30）：
- L11-15 `--bg/--surface/--fg/--muted/--border`：暖奶油 → 冷蓝暗色底（见 tokens.md 暗色块）
- L16-17 `--accent(195°)/--accent-light`：青蓝 → `#4f8ef7` 蓝系
- L25 `--font-display`：serif (Tiempos/Newsreader) → Inter（display 与 body 同族，tech-utility 取向）
- L28 `--radius: 1px` → `3px/8px/12px` 三档
- **新增**：整块 `.dark { ... }` token（当前缺失，`darkMode:'class'` 是空头支票）

`tailwind.config.ts`：
- L8 `colors`：对齐冷蓝暗色板
- L37 `fontFamily`：display/body → Inter，mono → JetBrains Mono
- L42 `borderRadius`：→ 3/8/12px

## 后续步骤

1. 落地 tokens.md 到 `style.css :root` + `tailwind.config.ts`（按上清单）
2. 重写 `PRODUCT.md` 品牌章节（Warm → 冷蓝开发者工具人格）
3. 补交互层规范（组件状态机、空/错/载态、动效时序、响应式断点）——当前最大空白
4. 从 zcode-demo 提炼 Vue SFC 组件库，补全 8 个状态
