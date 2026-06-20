---
wave: W09
phase: P2
cases: complex×1
deps: [W06]
est: 10min
va_ref: VA-03 #14-17,20-22
---

# W09 · P2 折叠态 + 空态 + 新建 + hide 规则

> 1 个复杂 case：折叠态三路唤回 + 320ms + 空态 + ⌘N + DEFERRED 入口 hide。多交互路径 + 时序。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/sidebar/spec.md` | §收起态 + §8.5 |
| `$ROOT/docs/designs/v3-demo/sidebar/draft-collapsed-state.html` | **主对照稿**（三路唤回 + 320ms） |
| `$ROOT/src-electron/renderer/src/components/sidebar/Sidebar.vue` | 待验：折叠态 |
| `$ROOT/src-electron/renderer/src/stores/sidebar.ts` | 待验：collapsed 状态 |

## 前置

- **W06 PASS**。
- 启动：`cd $ROOT && VITE_MOCK=true npm run dev`。

## Case · 折叠态 + 唤回 + 新建 + hide（complex）

### 检查项

| # | 检查 | 对照 | 期望 | 标记 |
|---|------|------|------|------|
| a | 折叠态整体隐藏 | draft-collapsed-state + spec §收起态 | ⌘B 后 sidebar **完全隐藏**（非 56px 折叠条），Workspace 占满全宽 | ✅ |
| b | 唤回路径 1：Workspace 顶栏按钮 | draft-collapsed-state | 折叠后 Workspace 顶栏显「展开侧栏」按钮，点击唤回 | ✅ |
| c | 唤回路径 2：⌘B | draft-collapsed-state | ⌘B toggle（再按唤回） | ✅ |
| d | 唤回路径 3：左缘细条 hover | draft-collapsed-state | 折叠后左缘有细条，hover 唤回 | ✅ |
| e | 320ms 过渡 | draft-collapsed-state | 展开 / 收起过渡 320ms（=`--duration-slow`），与 shell app-nav-controls 同步 | ✅ |
| f | 空态新建引导 | spec §容器四态 D | session=0 时空态含「新建会话」入口 | ✅ |
| g | ⌘N 新建 session | spec §8.5 Round 3 | ⌘N 绑定 `newSession`（核心入口 v1 保留） | ✅ |
| h | active session 联动 | spec §视图切换 | 切 session 时 Session List 迁移高亮 | ✅ |
| i | 搜索 nav 项 hide | spec §9 G-022 + §8.5 | sidebar nav **无「搜索」项**（DEFERRED 入口 hide） | ✅(hide) |
| j | 右键菜单 | draft-session-item + spec | — | 🔇 |

### 检查方法

1. `cd $ROOT && VITE_MOCK=true npm run dev`。
2. 浏览器打开 draft-collapsed-state.html 并排。
3. 按 ⌘B 折叠：核 sidebar 完全消失（a，Workspace 占满）+ 320ms 过渡（e，DevTools 查 transition）。
4. 折叠后核三路唤回（b/c/d）：顶栏按钮 / ⌘B / 左缘 hover。
5. 删空 session 验空态（f）。
6. ⌘N 验新建（g）。
7. 切 session 验高亮迁移（h）。
8. 确认 nav 无搜索项（i）。

### 判定

**PASS**：a-i ✅ 项全符合。
**FAIL 触发**：
- (a) 折叠后留 56px 折叠条（非完全隐藏）= FAIL。
- (e) 非 320ms = FAIL。
- (i) 搜索 nav 项显示 = FAIL（违反 hide 规则，与 W20 一致）。
- 🔇 (j) 不验。

## 执行步骤

1. 启动 + draft 并排。
2. ⌘B 折叠/展开循环，核 a/e。
3. 三路唤回（b/c/d）。
4. 空态（f）+ ⌘N（g）+ 高亮（h）+ hide 检查（i）。

## FAIL 判定

- 见上方 FAIL 触发。
- PASS 后进 W10（P3 双 Panel）。
