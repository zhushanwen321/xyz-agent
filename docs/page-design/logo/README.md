# xyz-agent LOGO 探索

> **状态（2026-08-01）**：探索期，**未收敛**。蝴蝶 / 太极双线并行，仅做不同版本参考。
> 详见 `assets/README.md` 的硬性筛选标准。

## 概念稿时间线

| 版本 | 风格主线 | 路径 | 备注 |
|------|---------|------|------|
| v1 | 太极初探 | `concepts.html` `concepts-glm-v1.html` `concepts-kimi-v1.html` `concepts-minimax-v1.html` | 多模型第一轮 |
| v2 | 蝴蝶 + 太极双线 | `concepts-v2.html` `concepts-kimi-v2.html` | 双线探索 |
| v3 | 蝶即两仪 | `concepts-v3.html` `concepts-kimi-v3.html` | 蝴蝶方向第一稿 |
| v4 | 太极中线强化 | `concepts-v4.html` `concepts-kimi-v4.html` | 太极中线 / 蝶翼对比 |
| v5 | 蚀仪三式（太极+鱼） | `concepts-v5.html` `concepts-kimi-v5.html` | 蚀仪·添鳍 / 负空间·醒 / 负空间·梦 |
| **v6** | **太极鱼·简约克制（4 方向对比）** | **`concepts-v6.html`** `concepts-kimi-v6.html` | **基于参考图（水墨双鱼）再设计：克制+现代，4 候选 A1-A4 + 决策矩阵**；kimi 侧：鱼眼归正 + 墨戏复刻三式 |
| **v7** | **单鱼复刻（半仪之鱼）** | **`concepts-kimi-v7.html`** | **抛开双鱼构图，先把一条鱼画对：参考图黑鱼高度复刻（俯首+白瞳/背弧/腹 S/飞白尾带/利鳍），三式 G1-G3** |

## v6 概览（最新）

基于参考图（水墨双鱼环绕，飘逸湿润笔触）的再设计——收敛参考图的水墨飞溅，保留双鱼互绕的"飘逸流畅"势，落到 v3 冷蓝暗色系统的几何骨架。

**4 个候选方向**（详见 `concepts-v6.html`）：

| 编号 | 名称 | 特征 | 适合 |
|------|------|------|------|
| **A1** | 蚀仪·添鳍 | 主体几何 + 单色鳍 | 通用首选，几何感最强 |
| **A2** | 负空间·醒 | 纯线稿无填色 | 网页头图 / 品牌周边（大尺寸） |
| **A3** | 蚀仪·添彩 | A1 + 冷蓝尾鳍 | **推荐主推**——品牌色钩子最强 |
| **A4** | 流水·弧 | A1 + 外圈水弧 | 飘逸感最强，最接近参考图 |

**推荐**：A3「蚀仪·添彩」—— 简洁/现代/克制 + 唯一能在 favicon 单色场景保留辨识度的彩色版，且已自带单色变体（印刷/水印安全）。

**备选**：A4「流水·弧」—— 若你更看重参考图的飘逸流畅本身。

## 工作流

```
concepts-N.html          ← 视觉稿（HTML 内嵌 SVG）
  ↓
用户反馈 / 决策矩阵对比
  ↓
精修定稿 → 导出 SVG/PNG 多尺寸
  ↓
与 v3 设计 tokens 对齐 → 落库到 packages/shared/src/logo/
```

## 后续（待用户决策后）

- 选 1 个方向进入精修：贝塞尔参数定稿 + 多尺寸导出
- 颜色与 `docs/page-design/design-tokens.md` 对齐检查（accent 比例、contrast）
- 落地到 electron app icon（apps/electron/build/）+ README badge + 文档站
- 风格统一检查：4 个候选都要做 app icon / favicon / 印刷 / 品牌蓝 四场景对比

---

相关：
- [[logo-design-exploration-phase]] — 探索期记忆
- [[logo-assets-directory]] — 参考素材库结构
- `docs/page-design/design-tokens.md` — v3 冷蓝暗色 SSOT
- `docs/page-design/design-system.md` — 设计系统原语