---
wave: W07
phase: P2
cases: simple×3
deps: [W06]
est: 5min
va_ref: VA-03 #1-4
---

> 结果: ✅ PASS (2026-06-20, minimax-m3)

# W07 · P2 Sidebar Overview 入口（分层）

> 3 个简单 case：Overview 入口按钮位置 / 计数 / 激活态。DOM + 视觉核对。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/sidebar/spec.md` | §视图切换（Overview 入口分层警告） |
| `$ROOT/docs/designs/v3-demo/sidebar/draft-five-states.html` | 对照稿（Overview 按钮位置） |
| `$ROOT/docs/architecture/adr/0022-overview-entry-coverage.md` | **入口覆盖裁决** |
| `$ROOT/src-electron/renderer/src/components/sidebar/Sidebar.vue` | 待验：Overview 入口按钮 |

## 前置

- **W06 PASS**（容器分层就绪）。

## Cases

### Case 1（simple）· Overview 入口在 tab 之上独立层

**检查方法**：DevTools Elements 找 Overview 入口按钮，看其在 sidebar DOM 中的位置。

**期望**（sidebar/spec §视图切换 + ADR-0022）：
- Overview 入口按钮在 sidebar 分层中位于 **segmented tab 之上**（独立层），**不混排进 tab**。
- 分层顺序：Brand → nav(新建/搜索) → **Overview 入口按钮** → segmented tab → 子视图 → 用户区。

**PASS**：Overview 按钮 DOM 祖先层级在 tab 之上，非 tab 的子项。

### Case 2（simple）· Overview 按钮 session 计数角标

**检查方法**：DevTools 看 Overview 按钮内/旁是否有计数元素。

**期望**（draft-five-states + spec）：按钮带角标显示当前 session 数（与实际 session 列表数一致）。

**PASS**：角标存在且数值 = 实际 session 数。

### Case 3（simple）· Overview 按钮激活态（转 accent）

**检查方法**：点 Overview 按钮（若 v1 已实现进入；若未实现则只验激活态视觉）。

**期望**（spec §视图切换）：激活时按钮转 accent 态（accent 色背景/边框）；**sidebar 整体持久不变**（不被 Overview 覆盖，ADR-0022）。

**PASS**：激活态 accent + sidebar 持久。**注**：若 v1 Overview 进入功能未实现，按钮点击无反应 = FAIL（入口显示但无反应违反 hide 规则，spec §8.5）；应 hide 入口或实现进入。

## 执行步骤

1. `cd $ROOT && VITE_MOCK=true npm run dev`（需 session 数据显计数）。
2. DevTools 定位 Overview 按钮 DOM 层级（Case 1）。
3. 看角标数值（Case 2）。
4. 点按钮看激活态 + sidebar 是否持久（Case 3）。

## FAIL 判定

- Overview 混进 tab（Case 1）= FAIL（spec 明确警告分层）。
- 入口显示但点击无反应（Case 3，若未实现）= FAIL（违反 hide 规则）。
- PASS 后可与 W08/W09 并行。
