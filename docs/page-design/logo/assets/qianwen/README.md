# qianwen — 千问 AI 生成的双鱼太极 logo

> 2026-08-01 决策: 取代之前的 butterfly/、taiji/、taiji-fish/ 三个目录（已移到 archive/pre-2026-08-qianwen/），作为 xyz-agent logo 设计的**唯一参考源**。

## 文件清单

| 文件 | 用途 |
|------|------|
| `source.png` | 千问 AI 生成原图 (857x1224)，设计唯一参考 |
| `source.png.src.txt` | 几何分析数据 (PIL 提取) |
| `logo.svg` | **v1 双鱼版** (矢量)，完整双鱼太极，6 条 potrace path + 显式鱼眼 |
| `logo.svg.src.txt` | logo.svg 设计说明 |
| `logo-v2.svg` | **v2 阴鱼版** (矢量)，只保留阴鱼，阳鱼作负空间，更克制 |
| `logo-v2.svg.src.txt` | logo-v2.svg 设计说明 + 与 v1 差异表 |
| `logo.png` | **logo.svg (v1) 渲染的位图版本** (857x1224)，用于 Markdown/头像/CI 截图等无 SVG 支持场景 |
| `logo.png.src.txt` | PNG 渲染方法 (headless Chrome + http server) |
| `logo-autotrace-raw.svg` | potrace 原始输出，**仅作几何参考底稿**，不要直接用 |
| `logo-autotrace-raw.svg.src.txt` | autotrace 输出说明 |
| `preview.html` | 浏览器对比验证页面（白底/深色底两种） |

## 使用方法

### 直接使用 logo.svg
```html
<img src="logo.svg" width="64" height="91" alt="xyz-agent">
```

### 改成项目主题色
- 黑色色块：搜索 `fill="#000000"`，改为项目主色（如 v3 冷蓝 `#3b82f6`）
- 白色色块：搜索 `fill="#ffffff"`，改为项目背景色或反色
- 鱼眼/描边同理

### 缩放
SVG 是矢量的，可以无损缩放到任何尺寸。但 200x285 默认比例与源图一致（竖向），改成正方形需要重新构图。

## 设计取舍

| 决策 | 原因 |
|------|------|
| 保留 potrace 的 6 条 path 几何 | 手工重画会丢失"千问图风格"且几何不准 |
| 显式分离黑鱼/白鱼/鱼眼 | 让改色和适配深色背景无需重画 |
| 不做水墨笔触 | 用户要求"线条感"优先，水墨飞白在 SVG 里只能用渐变近似 |
| 比例保持 200x285 (竖向) | 与源图比例一致，未来如需正方形需重新设计 |
| 中央 S 曲线来自 potrace path | 几何自然，不是手工画的标准太极 S |
