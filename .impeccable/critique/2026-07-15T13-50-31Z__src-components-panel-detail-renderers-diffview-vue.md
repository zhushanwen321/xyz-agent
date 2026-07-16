---
target: DiffView.vue (右侧抽屉文件 diff)
total_score: 21
p0_count: 0
p1_count: 1
p2_count: 1
timestamp: 2026-07-15T13-50-31Z
slug: src-components-panel-detail-renderers-diffview-vue
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | diff 解析/高亮有降级，但视觉反馈太弱等于"没反馈" |
| 2 | Match System / Real World | 3 | +/- 符号语义清晰 |
| 3 | User Control and Freedom | 3 | diff/preview 切换可用 |
| 4 | Consistency and Standards | 2 | 与 GitHub/VSCode 行业惯例偏差大（颜色不可辨） |
| 5 | Error Prevention | 3 | 长 diff 有退化保护 |
| 6 | Recognition Rather Than Recall | 2 | 颜色信息因低对比度近乎不可识别 |
| 7 | Flexibility and Efficiency | 3 | 有 toggle |
| 8 | Aesthetic and Minimalist Design | 2 | 过度克制导致功能不可见，矫枉过正 |
| 9 | Error Recovery | n/a | |
| 10 | Help and Documentation | n/a | |
| **Total** | | **21/32** | **Acceptable** |

## Anti-Patterns Verdict

非 AI slop 问题。核心问题是**过度克制**：v3 冷蓝暗色设计系统强调 Restrained，但 diff 着色是信息密度场景，Restrained 在这里是错的——用户需要快速定位变更，颜色是功能性必需，不是装饰。

## Priority Issues

### [P1] diff 行/字符级背景透明度过低，暗色主题下几乎不可辨
- **Why**: bg-success/12 + bg-danger/12 叠加在 #313239 上 WCAG 对比度 1.11-1.22:1，低于人眼 JND（约 1.4:1）
- **Fix**: 改用预混合实色（GitHub 风格），暗/亮主题各定一套 CSS 变量
- **Suggested command**: /impeccable colorize

### [P2] 字符级 diff 与行级 diff 层次区分不足
- **Why**: /12 vs /30 的双层在两者都不可辨时形同虚设
- **Fix**: 行背景用中饱和实色，字符级用高饱和更亮实色，明确两层亮度差
- **Suggested command**: /impeccable bolder

## Minor Observations
- del 符号用 U+2212（数学减号）而非普通连字符，对齐美观但复制粘贴可能困扰
- 空 diff 态图标 GitCompare opacity-40 太淡
