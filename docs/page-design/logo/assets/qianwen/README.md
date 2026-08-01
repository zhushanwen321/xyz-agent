# qianwen — 千问 AI 生成的双鱼太极 logo

> 2026-08-01 决策: 千问 AI 生成的双鱼太极图作为 xyz-agent logo 的**唯一参考图**，双鱼版作为最终方案。
>
> v2 阴鱼版（仅保留阴鱼 + 白鱼眼水滴）已尝试但回退——用户最终选择保留完整双鱼结构。

## 文件清单

| 文件 | 用途 |
|------|------|
| `source.png` | 千问 AI 生成原图 (857x1224)，设计唯一参考 |
| `source.png.src.txt` | 几何分析数据 (PIL 提取) |
| `logo.svg` | **最终 logo** (矢量, 竖向 0.7:1)，双鱼太极，6 条 potrace path |
| `logo.svg.src.txt` | logo.svg 设计说明 |
| `logo.png` | **logo.svg 渲染的位图版本** (857x1224)，用于 Markdown/竖向场景 |
| `logo.png.src.txt` | PNG 渲染方法 (headless Chrome + http server) |
| `logo-square.svg` | **正方形版 logo** (矢量, 1:1)，用外层 g 缩放+居中，几何与 v1 一致 |
| `logo-square.svg.src.txt` | 正方形版设计说明 (含视觉重心微调细节) |
| `logo-square.png` | **正方形版 PNG** (1200x1200)，用于 App icon / favicon / 头像 |
| `logo-square.png.src.txt` | 正方形版 PNG 渲染方法 |
| `logo-autotrace-raw.svg` | potrace 原始输出，**仅作几何参考底稿**，不要直接用 |
| `logo-autotrace-raw.svg.src.txt` | autotrace 输出说明 |
| `preview.html` | 浏览器对比验证页面（白底/深色底两种） |

## 设计过程回溯

- v1 双鱼版（`logo.svg`）— 完整保留
- v2 阴鱼版（`logo-v2.svg`）— 用户试过，但"看起来负空间感太弱/白鱼眼形状不对"等迭代 3 次后回退

## 使用方法

### 直接使用 logo.svg
```html
<img src="logo.svg" width="64" height="91" alt="xyz-agent">
```

### 改成项目主题色
- 黑色色块：搜索 `fill="#000000"`，改为项目主色（如 v3 冷蓝 `#3b82f6`）
- 鱼眼/描边同理
- viewBox 是 `0 0 857 1224`，缩放时保持 0.7:1 比例

## 设计取舍

| 决策 | 原因 |
|------|------|
| 保留 potrace 的 6 条 path 几何 | 手工重画会丢失"千问图风格"且几何不准 |
| 不做水墨笔触 | 用户要求"线条感"优先，水墨飞白在 SVG 里只能用渐变近似 |
| 比例保持 857x1224 (竖向) | 与源图比例一致 |
| 中央 S 曲线来自 potrace path | 几何自然，不是手工画的标准太极 S |
| **保留双鱼而非单阴鱼** | 用户 2026-08-01 终决策: 双鱼结构比负空间更平衡 |
