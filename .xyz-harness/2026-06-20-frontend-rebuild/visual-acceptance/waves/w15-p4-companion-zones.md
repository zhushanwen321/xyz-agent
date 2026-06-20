---
wave: W15
phase: P4
cases: simple×3
deps: [W11]
est: 5min
va_ref: VA-05 C1-C6
---

# W15 · P4 Companion Zones（progress + git 位置 / 状态骨架）

> 3 个简单 case：progress-zone / git-zone 位置 + 各自状态骨架。DOM + 视觉核对。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/panel/spec.md` | §5 zone（progress / git 位置） |
| `$ROOT/docs/designs/v3-demo/panel/draft-companion-zones.html` | **主对照稿**（progress 三态 + git 四态） |
| `$ROOT/docs/designs/v3-demo/workspace/spec.md` | §git-zone（38px 单行常驻） |
| `$ROOT/src-electron/renderer/src/components/panel/ProgressZone.vue` | 待验：位置 + 骨架 |
| `$ROOT/src-electron/renderer/src/components/panel/GitZone.vue` | 待验：位置 + 骨架 |

## 前置

- **W11 PASS**（zone 容器就位）。

## Cases

### Case 1（simple）· progress-zone 在 composer 上方

**检查方法**：DevTools 看 Panel 内 DOM，progress-zone 相对 composer 的位置。

**期望**（panel/spec §5 zone）：progress-zone（zone ③）在 composer（zone ④）**上方**。

**PASS**：progress-zone DOM 顺序在 composer 之前。

### Case 2（simple）· git-zone 在 composer 下方 + 单行 38px

**检查方法**：DevTools 看 git-zone 位置 + 高度。

**期望**（panel/spec §5 zone + workspace/spec §git-zone）：
- git-zone（zone ⑤）在 composer（zone ④）**下方**。
- 单行 `height:38px` 常驻（始终渲染，非条件隐藏）。

**PASS**：位置在下 + 高度 38px + 常驻。

### Case 3（simple）· 状态骨架（progress 三态 / git 四态）

**检查方法**：参考 draft-companion-zones，核对 zone 是否支持状态切换骨架。

**期望**（draft-companion-zones，v1 边界 spec §8.5 P4）：
- progress-zone：待办 / 进行 / 完成 / 阻塞（四态，v1 若主路径用到则验，否则骨架可渲染）。
- git-zone：干净 / 已暂存 / 有 diff / 冲突（四态，同上）。
- git-zone 干净态显「工作区干净」+ Diff 按钮。

**PASS**：zone 容器存在 + 可承载状态切换骨架（内容深度可 defer）。**注**：若 v1 主路径未用到 progress/git 详细内容，只要 zone 容器在位 + 不崩溃即 PASS（状态内容 DEFERRED，spec §8.5 P4）。

## 执行步骤

1. `cd $ROOT && VITE_MOCK=true npm run dev`。
2. DevTools 看 zone 顺序（Case 1/2）+ 量 git-zone 高度（Case 2）。
3. 对照 draft 看 zone 状态骨架（Case 3，宽松判定）。

## FAIL 判定

- progress/git 位置颠倒（Case 1/2）= FAIL。
- git-zone 非 38px 或非常驻（Case 2）= FAIL。
- zone 容器缺失 / 崩溃（Case 3）= FAIL。
- PASS 后进 W16（UC-2 集成）。
