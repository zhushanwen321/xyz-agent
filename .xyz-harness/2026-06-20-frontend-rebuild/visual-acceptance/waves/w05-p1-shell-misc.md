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
