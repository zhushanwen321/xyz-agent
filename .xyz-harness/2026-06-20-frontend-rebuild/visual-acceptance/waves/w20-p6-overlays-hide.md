---
wave: W20
phase: P6
cases: simple×2
deps: [W16]
est: 4min
va_ref: VA-08 #1-2(+4-7若建)
---
> 结果: ✅ PASS (2026-06-20)

# W20 · P6 Overlays (⌘K) hide 入口检查

> 2 个简单 case：v1 只 hide 入口（spec §9 G-022）。⌘K + sidebar 搜索 nav 均 hide。跨项目搜索永久 DEFERRED。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/overlays/spec.md` | §归属与边界（⌘K vs File View 内联搜索） |
| `$ROOT/docs/designs/v3-demo/overlays/draft-search-modal.html` | **主对照稿**（若浮层已建则对照） |
| `$ROOT/src-electron/renderer/src/components/overlays/SearchModal.vue` | 待验：**可能未建**（hide 策略） |

## 前置

- **W16 PASS**。

## Cases

### Case 1（simple）· ⌘K + sidebar 搜索 nav 全 hide

**检查方法**：
1. 按 `⌘K`（mac）/ `Ctrl+K`（win/linux）→ 确认无浮层弹出。
2. 查 sidebar nav → 确认**无「搜索」项**（与 W09 Case i 一致约束）。

**期望**（spec §9 G-022 + §8.5 hide 规则）：⌘K 不触发浮层 + sidebar 无搜索 nav 项。

**PASS**：两入口均 hide。**FAIL**：⌘K 触发浮层但功能不全（四类分组/键盘导航 DEFERRED）= 违反 hide 规则。

### Case 2（simple）· 若浮层已建：验 z-index 骨架

**检查方法**：若 SearchModal.vue 存在且 ⌘K 能打开它（开发调试用），对照 draft-search-modal 验骨架。

**期望**（draft-search-modal §实现要点 + design-system §2）：
- `z-index:1000`（高于 sidebar/workspace，低于系统 traffic-light）。
- 模糊背景 + 居中浮层（模态，非内联）。
- 选中态 inset ring，**禁用左色条**（AI slop 反模式）。
- `role="dialog"` + `aria-modal="true"`。

**判定**：
- 若 SearchModal.vue **完全未建**（hide 策略）→ Case 2 标 🔇(未建)，**只验 Case 1**，整体 PASS。
- 若已建骨架 → Case 2 必验，任一不符 = FAIL。
- 跨项目检索范围（spec §9 G-022 遗留③）= 永久 DEFERRED，不影响。

## 执行步骤

1. `cd $ROOT && npm run dev`。
2. 测 ⌘K + 查 sidebar nav（Case 1）。
3. `ls $ROOT/src-electron/renderer/src/components/overlays/SearchModal.vue` 判断是否已建。
4. 若已建 + 可打开：对照 draft-search-modal 验 Case 2（z-index / 居中 / inset ring / aria）。
5. 若未建：Case 2 🔇，仅 Case 1 判定。

## FAIL 判定

- ⌘K 触发不全功能浮层（Case 1）= FAIL（hide 规则）。
- sidebar 搜索 nav 项显示（Case 1）= FAIL（与 W09 重复约束）。
- 若已建：z-index ≤ workspace / 左色条（Case 2）= FAIL。
- 若未建 → Case 1 PASS 即整体 PASS。

## 全部 20 Wave 完成

PASS 后 → 跑 spec §6 整体验收 5 项（见 [`../va-08-p6-overlays.md`](../va-08-p6-overlays.md) 末尾）→ 前端 v3 重建视觉验收闭环。
