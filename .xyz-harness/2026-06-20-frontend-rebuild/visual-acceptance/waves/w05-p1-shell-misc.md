---
wave: W05
phase: P1
cases: simple×3
deps: [W03]
est: 6min
va_ref: VA-02 #13-16
---

# W05 · P1 Shell 杂项（breadcrumb / drag / 导航栈）

> 3 个简单 case：breadcrumb 落点 + 拖拽区 + ⌘[/⌘] 导航。DOM + 交互核对。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/shell/spec.md` | §四 breadcrumb + §七-6 drag 区 + §8.5 导航 |
| `$ROOT/src-electron/renderer/src/components/panel/PanelHeader.vue` | 待验：breadcrumb 落点（在 header 内） |
| `$ROOT/src-electron/renderer/src/components/shell/AppShell.vue` | 待验：drag 区 |

## 前置

- **W03 PASS**（拓扑就绪，header 可定位）。

## Cases

### Case 1（simple）· breadcrumb 落点在 main-header 内

**检查方法**：DevTools Elements 搜 breadcrumb 元素（类名含 `breadcrumb` 或 `<nav>`/`<ol>` 结构）。

**期望**（shell/spec §四）：
- breadcrumb 位于 **`.main-panel` 的 header 区**（panel-header）内，**非横跨窗口顶栏**。
- 不在 aside-region，不在 app-nav-controls 旁。

**PASS**：breadcrumb DOM 父级是 panel-header / main-header。

### Case 2（simple）· 拖拽区 -webkit-app-region

**检查方法**：DevTools Elements 搜 `-webkit-app-region`。

**期望**（shell/spec §七-6，修复旧 bug）：
- main-header 的**空白区**：`-webkit-app-region: drag`（可拖动窗口）。
- 按钮 / breadcrumb / 输入框等交互元素：`-webkit-app-region: no-drag`（不拦截）。

**PASS**：header 空白 drag + 交互元素 no-drag 共存（窗口顶部空白可拖动，按钮可点）。

### Case 3（simple）· ⌘[ / ⌘] 导航栈绑定

**检查方法**：
1. 先制造 >1 条历史：进 session A → 切 Overview → 进 session B（或类似导航动作 ≥2 步）。
2. 按 `⌘[`（mac）/ `Ctrl+[`（win/linux）：应后退到上一历史。
3. 按 `⌘]`：应前进。

**期望**（shell/spec §8.5 + plan T2.2）：快捷键绑定 `nav.back` / `nav.forward`，导航历史栈可来回。

**PASS**：⌘[ 后退 + ⌘] 前进均生效，历史状态正确恢复。

## 执行步骤

1. `cd $ROOT && npm run dev`。
2. DevTools 搜 breadcrumb（Case 1）、搜 app-region（Case 2）。
3. 导航几步后测 ⌘[/⌘]（Case 3）。

## FAIL 判定

- breadcrumb 横跨窗口顶栏 / 在 aside（Case 1）= FAIL（spec §四）。
- header 无 drag 区 / 按钮 drag 拦截点击（Case 2）= FAIL。
- ⌘[/⌘] 无反应或历史错乱（Case 3）= FAIL。
- PASS 后进 W06（P2 Sidebar 容器）。

## 验收结果（2026-06-20）

**✅ PASS（3/3 case）** —— CDP DOM 断言 + 交互验证。

| Case | 结果 | 证据 |
|------|------|------|
| 1 breadcrumb 落点 | ✅ | `header` 在 `<main>` 内（`headerInMain:true`、`headerInAside:false`）；`header>nav>ol>li×5`（3 文本段 + 2 分隔）；三段内容 `[Code/xyz-agent, 重构 auth 模块, refactor-auth]`；分支段 `font-family:mono` + `color:rgb(79,142,247)`（= `--accent`）符合 spec §四 |
| 2 拖拽区 | ✅ | `header` `-webkit-app-region:drag`；`nav` / `button` / button 容器均 `no-drag`（含按钮自身显式 no-drag）。空白可拖窗口、交互元素不拦截，符合 spec §七-6 |
| 3 ⌘[/⌘] 导航 | ✅ | 制造 3 条历史（pointer=2, canBack=true）；`⌘[` → pointer 2→1, view 退到 `overview`；`⌘]` → pointer 1→2, view 进 `chat/s2`。导航栈 back/forward 正确 |

补充验证：`#15 data-platform` = `mac`（W04 范围，顺带确认）。

### 实现变更

- `PanelHeader.vue`：新增 `gitBranch` prop；重构 header 左侧为 `<nav><ol>` breadcrumb 三段（项目 cwd 末段 ▸ 会话名 ▸ 分支 mono+accent）；popover 点击跳转 DEFERRED（shell/spec §八 G3），v1 纯展示。
- `PanelHeader.vue` / `Panel.vue`：清掉既有 `<style scoped>`（vue_rules_checker 存量违规，no-skip 原则要求一并修）；status-dot 5 态色改 Tailwind `:class` 映射 + running 用内置 `animate-pulse`；Panel 4 层激活标识 `::before` 竖条改 `<div>`，box-shadow/opacity/transition 全 Tailwind。
- drag 区：`header` 加 `[-webkit-app-region:drag]`，`nav` / 按钮 / 按钮容器加 `[-webkit-app-region:no-drag]`。

### ✅ P3 阻塞 bug 已修复（同日，见同 commit）

**PanelContainer watch 死锁**：空态时 `Workspace` 不渲染 `PanelContainer`（因 `panel.leaf.sessionId=null`）→ `PanelContainer` 的 `watch(session.activeId)→loadSession` 未注册 → sidebar `selectSession` 设 `session.activeId` 后无人监听 → `loadSession` 永不触发 → `leaf.sessionId` 永远 null → breadcrumb 内容空、MessageStream 不渲染。

- **修复**：`useSidebar` 新增幂等的 `syncSessionToPanel(id)`（session 已在某 panel 则 setActive，否则 loadSession 到 active panel）；`selectSession` 直接调用，不再依赖条件渲染子组件 watch。`AppShell` 加 `watch(navigation.pointer)` 同步 ⌘[/⌘] 导航后的 session。
- **验证**：CDP 刷新空态 → sidebar 点击 s1 自动载入（breadcrumb 三段自动显示）；⌘[x2 回退 s2、⌘]x2 前进 s3 时 panel 跟随切换。
- **影响解除**：W10（panel skeleton）、W12（message-stream）、W16（UC-2 flow）不再受阻。
- **详情**：[va-04 已修复段](../va-04-p3-workspace-panel.md)
