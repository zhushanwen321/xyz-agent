---
wave: W18
phase: P6
cases: simple×3
deps: [W17]
est: 6min
va_ref: VA-06 #8-14
---

> 结果: ✅ PASS (2026-06-20)

# W18 · P6 Overview 卡片网格 + inset ring + 空态

> 3 个简单 case：网格响应式 + 卡片信息结构/inset ring + 空态。视觉 + DOM 核对。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/overview/spec.md` | §布局（网格响应式）+ §卡片信息 |
| `$ROOT/docs/designs/v3-demo/overview/draft-overview.html` | **主对照稿 B**（卡片网格 + 信息结构） |
| `$ROOT/docs/designs/design-system.md` | §2 Card-Active（inset ring，禁左竖条） |
| `$ROOT/src-electron/renderer/src/components/overview/SessionCard.vue` | 待验：卡片信息 + 激活 |

## 前置

- **W17 PASS**（可进入 Overview）。

## Cases

### Case 1（simple）· 网格响应式 + 间距

**检查方法**：进 Overview，调整窗口宽度，DevTools 量卡片网格。

**期望**（draft-overview + overview/spec §布局）：
- 列数随视口：宽屏 4 / 笔记本 3 / 窄屏 2 / 移动 1。
- 卡片最小宽度 ~280px。
- 卡片间距 16px（`--space-4`），**无分隔线**靠间距区分。

**PASS**：列数随宽度变化 + 最小宽 ~280px + 间距 16px 无分隔线。

### Case 2（simple）· 卡片信息结构 + inset ring 激活

**检查方法**：DevTools 看卡片 DOM 结构 + 激活态样式。

**期望**（draft-overview + spec §卡片信息 + design-system §2）：
- 信息结构：状态点 + 标题 + 分支 pill + 摘要 + 指标 + 时间。
- 激活态：**Card-Active（inset accent ring）**，**禁用左竖条**（AI slop 反模式）。

**PASS**：信息元素齐全 + 激活用 inset box-shadow（非 border-left 竖条）。

### Case 3（simple）· 空状态 session=0

**检查方法**：删空 mock session（或切空 fixture），进 Overview。

**期望**（spec §边缘状态）：图标 + 「新建一个会话开始」文案 + Primary 新建入口。

**PASS**：空态有引导 + 新建入口。

## 执行步骤

1. `cd $ROOT && VITE_MOCK=true npm run dev`，进 Overview。
2. 调窗口宽度看列数 + 量间距（Case 1）。
3. DevTools 看卡片结构 + 激活态 inset ring（Case 2，确认非左竖条）。
4. 删空 session 验空态（Case 3）。

## FAIL 判定

- 网格不响应式 / 间距有分隔线（Case 1）= FAIL。
- 卡片用左竖条激活（Case 2）= FAIL（design-system §2 禁止）。
- 空态无引导（Case 3）= FAIL。
- PASS 后 P6 Overview 完成。W19/W20 可并行。
