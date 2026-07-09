# Shell 设计 — zcode-demo 拓扑 + traffic light 兼容

> 决策来源：shell-traffic-light form（2026-06）原选 C · Overlay 横跨顶栏。
> **2026-06 修正**：横跨 overlay 与 zcode-demo「base 平铺 / sidebar 透明 / main 浮起」双语义冲突，回归 zcode-demo 纯拓扑，traffic light 靠 sidebar 顶部留白兼容。
> **2026-06-18 更新**（cross-platform-controls form）：① 增「应用导航按钮」（收起侧栏 / ← 后退 / → 前进），浮在 traffic light 右侧，三平台统一；② 全屏 hover 红黄绿改由 mac 系统提供，应用只画「非全屏 / 全屏」两态；③ 窗口控制走流派 A（各平台原生 + 应用按钮统一）；④ logo 定为 xyz-agent，新建/搜索标 ⌘N/⌘K。
> **2026-06-18 再更新**（win-controls-visual form）：流派 A 实测两个 bug——win/linux 左上应用按钮撞 logo（padding-top:12px 不足）、右上角窗口控制侵入 main 浮起区（breadcrumb 被迫 padding-right:120px 避让）。决策改走**方案 X**：win/linux 自绘彩色圆点放左侧完全模拟 mac（mimic_mac，hover 显 close/min/max 符号），三平台左上视觉完全统一；logo 下移到按钮排下方（logo_below，三平台 padding-top 统一 52px）。流派 A 弃用。
> **2026-06-28 更新**（折叠态 chrome 落位实施后）：① 红黄绿主进程改用 `titleBarStyle:'hidden'` + `trafficLightPosition:{x:16,y:26}` 精确控位（弃用 `hiddenInset`，因其强制水平内缩使 `trafficLightPosition.x` 失效）；② 三处 chrome（红黄绿 / 浮层按钮 / PanelHeader 内按钮）统一对齐到 header 中线 y=32px；③ 折叠态 chrome 迁入 P1 PanelHeader（`pl-[88px]` 让位），与非折叠浮层位置一致（按钮起 x=100）；④ rail-restore 左缘细条移除，唤回靠 ⌘B + header chrome 按钮。下文 §二/§三/§五/§七 坐标已据此更新。

## 决策演进（为何从 Overlay C 改成 zcode-demo 拓扑）

| 阶段 | 方案 | 问题 |
|------|------|------|
| 初版 | Overlay C 横跨顶栏（36px 透明层 + breadcrumb padding-left:80px 避让 traffic light） | 实现后视觉层次反转：整窗被画成 `bg-panel` 浮起，sidebar 又一层 elevated，**和 zcode-demo 相反**——该浮的 main 反而平了 |
| **现版** | 回归 zcode-demo 拓扑 | base 平铺全屏 → sidebar 透明融合 → main 是唯一 float-panel 浮起。traffic light 浮在 sidebar 顶部 52px 安全区 |

**判定依据**：用户明确「要和 zcode-demo 类似，左侧边栏和背景融为一体，右边工作区浮在背景上」。横跨 overlay 顶栏违背此语义，必须放弃。breadcrumb 从横跨顶栏移入 main-header（工作区上下文，语义更准）。

## 一、核心拓扑

```
窗口 (bg-base #1a1b1f 平铺全屏, border-radius:10px, 浮于桌面)
  .app-shell  flex  p-3(12px)  gap-3(12px)
    .aside-region (width 340px, 无 background —— 透明，融在 base 上)
      ├── padding-top: 52px        ← traffic light 安全区（三平台统一）
      ├── .a-logo / .a-nav / .a-user
    .main-panel (float-panel: bg-panel + border + radius:12px + shadow —— 浮起)
      ├── .main-header (42px: 会话名 + breadcrumb + 工具按钮)
      └── .main-body (工作区)
```

**三层语义**（视觉层次命门）：
- **base 平铺** — window-mock 的 `background: var(--bg-base)`，所有区域的基础底色
- **sidebar 透明** — aside-region **不设 background**，继承 base，视觉上与窗口底色融为一体
- **main 浮起** — main-panel 是**唯一**带 background/border/radius/shadow 的面板，靠这些属性视觉浮起，不靠 z-index 抬高

### main-panel 内 section 的底色语义（单/双 panel 切换）

main-panel(main) 始终是 float-panel（`bg-surface` + border + radius + shadow）。其内的 Panel section 底色随 panel 数量切两种语义（对齐 `workspace/draft-dual-panel.html` 的 `.panel` 模型）：

| panel 数 | section 底色 | 语义 |
|---|---|---|
| **单 panel** | 透明（继承 main-panel 的 surface） | section 即 main 内容区，不独立浮起。float-panel 语义归 main-panel 独占 |
| **双 active** | `bg-bg-elevated` + `ring-1 accent-ring` + opacity 1 | panel 间相对浮起（焦点），对齐 draft-dual-panel `.panel.active` |
| **双 standby** | `bg-surface` + opacity 0.5 hover 回升 0.78 | 退后，opacity 表达主从（draft-dual-panel L121 明确） |

section 在运行时注入 `--panel-bg` 变量（指向当前底色），供消息流内 sticky 浮层自适应——详见 `design-system.md §8.5`。

## 二、应用两态 + 应用导航按钮（收起 / ← / →）

应用只画两个状态。全屏 hover 时红黄绿由 **mac 系统从顶部下拉覆盖层提供**，应用不参与渲染——故无第三态，避免自绘半透明按钮与系统浮层打架。

| 状态 | traffic light | 应用按钮 (app-nav-controls) | sidebar 内容位置 |
|------|--------------|----------------------------|-----------------|
| **非折叠（窗口）** | opacity 1，常驻 | 浮层 `left:100px`，紧跟红黄绿右侧 | padding-top:52px 不变 |
| **折叠（非全屏）** | opacity 1，常驻 | **浮层隐藏**，chrome 三按钮迁入 P1 PanelHeader（`pl-[88px]`，按钮起 x=100，与浮层位置一致） | aside 归零，AppShell `!gap-0` |
| **全屏** | opacity 0，隐藏 | 浮层 `left:16px`，**左移占红黄绿位**（**320ms** 平移 = `--duration-slow`，与 traffic-light 同步） | padding-top:52px 不变 |
| **全屏 · hover** | 系统下拉覆盖层 | **应用不变**（同全屏静止） | 不变 |

> **折叠/非折叠 chrome 一致性**：非折叠浮层与折叠 header 内的 chrome 三按钮水平位置完全一致（按钮左缘均 x=100），切换折叠无跳动。红黄绿右缘 x=68 + 32px 呼吸 = 100。

**应用按钮三件套**（应用自绘 DOM，三平台统一）：
- `收起` → toggle sidebar 宽度（340px ↔ 折叠态）
- `← 后退` / `→ 前进` → **导航历史栈** back/forward（浏览器式）：栈条目 = (会话, 视图节点)，会话切换与会话内跳转都 push。**与 Flow 4「回退分支」解耦**——分支回退是对话级动作，走 Session Tree + 分支 pill，不走 chrome ←/→

### 全局快捷键 · ⌘B 三态优先级（2026-06-19 定）

`⌘B` / `Ctrl+B` 是三平台统一的全局快捷键，绑定**三个独立动作**。冲突解决按以下优先级：

| 优先级 | 触发条件 | 动作 | 落点 |
|--------|---------|------|------|
| **1（最高）** | sidebar 处于**非折叠态** | toggle sidebar → 折叠态 | sidebar |
| **2** | sidebar 折叠**且**当前视图**无**未保存编辑 | toggle sidebar → 非折叠态 | sidebar |
| **3（最低）** | sidebar 折叠**且**当前视图**有**未保存编辑 | 打开**分支 popover**（breadcrumb L3） | panel |

**判定逻辑**（伪代码）：

```
on ⌘B:
  if sidebar.expanded:       → 折叠
  else if !hasUnsaved():     → 展开
  else:                       → 触发分支 popover
```

**关键约束**：

- sidebar 折叠态是**第三优先级的前置条件**——展开态下绝不让 ⌘B 触发分支 popover（否则「收起」这个高频动作会被抢走）。
- 「未保存编辑」用 dirty flag 跟踪，覆盖：composer 正在输入 / subagent 流式输出未读 / 流式生成代码未审阅。`isContentEditable || data-dirty` 即认为有未保存编辑。
- **mac 视觉提示**：sidebar 折叠时，breadcrumb L3 旁短暂闪一下 `⌘B` chip（200ms fade in/out），告诉用户「这次按了它会弹分支 popover」。展开态不闪（用户预期就是 toggle）。
- **win/linux 视觉提示**：tooltip + status bar 出现一次。
- **不可达分支**：如未来出现「sidebar 折叠 + 视图无未保存编辑 + 视图不需要分支切换」的场景，第 3 优先级 fallback 为「toggle sidebar → 展开」（等价于优先级 2）。

**与 Flow 4 的边界**：分支 popover 内的「回退分支」是**对话级历史**，与 ⌘B 第 3 优先级的「打开 popover」是**两件事**——前者是 popover 内的按钮，后者只是打开 popover 的入口。两者在 popover 内部不冲突。

**配套文档**：决策矩阵与状态流转图见 `docs/page-design/v3/panel/draft-breadcrumb-popovers.html` 卡 E（⌘B 状态矩阵）。

**流畅命门**：两态间 sidebar 内容（logo/nav/user）位置**像素级不变**，唯一位移是 `app-nav-controls` 的 `left` 从 100px 平移到 16px（**320ms** 过渡 = `--duration-slow`），与 `traffic-light` opacity（同为 320ms、同曲线）**同时长同步**——两者是同一态变换。**win/linux** 两元素皆应用自绘、严格同步；**mac** traffic-light 由 OS 绘制（时长不可控），应用只保证 app-nav-controls 用 320ms。全屏 hover 红黄绿由 mac 系统落进 52px 留白里，不挡 nav。

## 三、安全区尺寸

| token | 值 | 用途 |
|-------|-----|------|
| `.aside-region padding-top` | **52px** | sidebar 内容起始 Y（三平台统一安全区） |
| `.traffic-light left/top`（win/linux） | **16px / 26px** | 绝对定位到窗口左上（应用自绘圆点，与 mac 同位） |
| mac `trafficLightPosition` | **{x:16, y:26}** | 主进程控制 OS 红黄绿（红黄绿高 12，中线 y=32）；**必须 titleBarStyle:'hidden'**（hiddenInset 会使 x 失效） |
| `.app-nav-controls left`（非折叠） | **100px** | 应用按钮紧跟红黄绿右侧（红黄绿右缘 68 + 32px 呼吸），top:21px（中线 32） |
| `.app-nav-controls left`（全屏） | **16px** | 红黄绿隐藏，按钮左移占位（**320ms** 平移 = `--duration-slow`，与 traffic-light 同步） |
| PanelHeader `pl`（折叠+非全屏） | **88px** | P1 header 让位红黄绿，chrome 按钮起 x=12+88=100（与浮层一致） |
| AppShell `gap`（折叠态） | **!gap-0** | aside 归零后强制 gap:0（必须 `!`，否则被 gap-3 同特异性覆盖为死代码），MainPanel 左右对称各 12px |
| win/linux `padding-top` | **52px** | 与 mac 一致留安全区；mimic_mac 圆点浮左上，app-nav-controls left:100px |
| 全屏 hover（mac） | 系统提供 | mac 下拉覆盖层显示红黄绿，应用不渲染第三态 |

## 四、Breadcrumb 位置变更

| | 初版（overlay C） | 现版（zcode-demo 拓扑） |
|---|---|---|
| 位置 | 横跨窗口顶栏，padding-left:80px 避让 | **main-header 内**（工作区上下文） |
| 内容 | 项目 ▸ 会话 ▸ 分支 | 项目名 ▸ 会话名 ▸ 分支名（branch 用 mono + accent） |
| 理由 | 横跨会破坏 sidebar 透明融合 | 进工作区顶栏，语义对、不与 traffic light 抢空间 |

## 五、跨平台对照（方案 X · 三平台统一红黄绿）

| 平台 | traffic light / 窗口控制 | 应用按钮（收起/←/→） | sidebar 安全区 |
|------|---------------------------|----------------------|---------------|
| **macOS** | 红黄绿浮窗口左上（**OS 系统绘制**，`titleBarStyle:'hidden'` + `trafficLightPosition:{16,26}` 控位） | 浮层 left:100px（非折叠）/ 16px（全屏）；折叠态迁入 P1 header（pl-88） | padding-top:52px |
| **Windows/Linux** | 自绘彩色圆点浮左上（**mimic mac**，`left:16px top:26px`，hover 显 close/min/max 符号） | left:100px（非折叠）/ 16px（全屏），与 mac 一致 | padding-top:52px |

**方案 X 取舍**：win/linux 用 `frame:false` + 自绘 3 个彩色圆点（复用 `.traffic-light` DOM），完全模拟 mac 红黄绿，hover 整组时圆点上显 close/min/max 符号。三平台左上视觉与交互完全一致。代价是 win/linux ~1 天工程量 + Windows 用户肌肉记忆（对开发者受众而言收益更大：VS Code/Cursor 在 Linux 均自绘控制）。**应用按钮三平台恒 left:100px**（全屏左移 16px）。

**为何放弃流派 A**：流派 A（窗口控制各平台原生）实测两个 bug——① win/linux `padding-top:12px` 不足，应用按钮 left:20px 撞 logo；② 右上角窗口控制侵入 main 浮起区，breadcrumb 被迫 `padding-right:120px` 避让。方案 X 同时消灭这两个 bug。

## 六、Z-index 分层（简化）

| z-index | 层 | 说明 |
|---------|-----|------|
| 系统 | traffic light | mac Electron OS 绘制（最顶）；win/linux 自绘 DOM（z-index:10，mimic mac） |
| 10 | traffic-light / app-nav-controls | 绝对定位浮 sidebar 安全区；win/linux 的 traffic-light 也是应用自绘 DOM |
| auto | main-panel（float-panel） | 靠 background/border/shadow 浮起，不靠 z-index |
| auto | aside-region（透明） | 无 background，继承 base |
| 0 | window-mock（bg-base） | 全屏底色 |

**对比初版**：横跨 overlay 顶栏需要 z-index:100 抬高，现版取消横跨层后，分层回到 base/panel 自然叠放，更干净。

## 七、实现要点（交付给前端）

1. **Electron 主进程**：mac 用 `titleBarStyle:'hidden'` + `trafficLightPosition:{x:16,y:26}` 精确控制红黄绿位置（**不用 hiddenInset**——inset 模式强制红黄绿水平内缩，`trafficLightPosition.x` 被系统忽略）。traffic light 仍由 OS 绘制并自动浮最顶，CSS 不画真实按钮，只在 sidebar 顶部留 `padding-top:52px`。
2. **应用导航按钮**（收起/←/→）是**应用自绘 DOM**，三平台统一渲染。收起 → toggle sidebar 宽度（折叠态细节属 sidebar L2）；←/→ → **导航历史栈** back/forward（浏览器式，栈条目 = (会话, 视图节点)）。**←/→ 与 Flow 4「回退分支」解耦**——分支回退走 Session Tree + 分支 pill。**折叠态**此组按钮迁入 P1 PanelHeader（chrome 槽位 `pl-[88px]`），浮层隐藏；非折叠态沿用 AppShell 浮层 `left:100px`，两态位置一致（按钮起 x=100）。
3. **按钮位移**：监听 `enter/leave-full-screen` 给根加 `data-fullscreen`，CSS `[data-fullscreen] .app-nav-controls{left:16px}` 触发 **320ms（= --duration-slow）**平移，traffic-light opacity 同为 320ms 同曲线。**win/linux 两元素皆应用自绘、严格同步**；**mac** traffic-light 由 OS 绘制（时长不可控），应用只保证 app-nav-controls 用 320ms。**全屏 hover 红黄绿由 mac 系统提供，应用不画第三态。**
4. **跨平台判定**：renderer 根 `<html data-platform="mac|win|linux">`。三平台 `.aside-region` 均 `padding-top:52px`。mac：`titleBarStyle:'hidden'` + `trafficLightPosition:{16,26}`，红黄绿 OS 绘制；win/linux：`frame:false` + 自绘 3 个彩色圆点（复用 `.traffic-light` DOM，`left:16px top:26px`）浮左上，hover 显 close/min/max 符号，点击 IPC 调 `win.minimize/maximize/close`。`app-nav-controls` 三平台恒 `left:100px`（全屏左移 16px）。折叠态 AppShell 加 `!gap-0`（强制覆盖 gap-3，使 MainPanel 左右对称）。唤回侧栏靠 ⌘B + header chrome 按钮（rail-restore 已移除）。
5. **全局快捷键**：注册 `⌘N`（新建任务）、`⌘K`（搜索）—— sidebar nav item 的 `.a-kbd` 是其视觉提示。mac 用 ⌘、win/linux 用 Ctrl。
6. **拖拽区**：main-header 空白区 `-webkit-app-region: drag`，按钮/breadcrumb 设 `no-drag`。
7. **修复已存在 bug**：真实 renderer 当前 `grep -webkit-app-region` 全空——sidebar logo 会被 traffic light 压住。本设计顺手把这个 bug 设计掉了（padding-top 安全区 + app-nav-controls 落点）。

## 八、待验证 / 待修

- [x] 全屏 hover 处理：改为 mac 系统提供，应用不画第三态（2026-06-18 定）
- [x] 应用按钮时长统一 **320ms（= --duration-slow）**，与 traffic-light 同曲线（2026-06-19 定）：win/linux 两元素皆应用自绘、严格同步；mac traffic-light 由 OS 绘制（时长不可控），应用只保证 app-nav-controls 用 320ms
- [x] 收起侧栏后的折叠态布局未定（logo 是否保留 / 折叠宽度 / 展开手势）——属 L2 模块 → `docs/page-design/v3/sidebar/draft-collapsed-state.html`（2026-06-19 定：3 路唤回冗余 + 320ms 同步 + 顶栏 3 按钮 + 状态保留）
- [x] breadcrumb 三段点击跳转目标屏幕未定（项目切换器 / 会话树 / 分支选择器）——属 L2 模块 → `docs/page-design/v3/panel/draft-breadcrumb-popovers.html`（2026-06-19 定：项目 360 / 会话 380 / 分支 320 三 popover，互斥 + 状态联动）
- [x] ←/→ 定为**导航历史**（浏览器模型，2026-06-19 定，**已确认 · unified_nav**）：栈条目 = (会话, 视图节点)，会话切换与会话内跳转都 push。**与 Flow 4「回退分支」解耦**——分支回退是对话级动作走 Session Tree + 分支 pill，不走 chrome ←/→（原「需对齐 Flow 4」依赖撤销）
- [x] 真实代码（System D 漂移）已同步（2026-06-28）：sidebar `padding-top` 安全区 + `data-platform` 判定 + app-nav-controls + titleBarStyle:'hidden' + trafficLightPosition 控位 + 折叠态 chrome 落 P1 header
- [x] 视觉探索稿：`docs/page-design/v3/shell/draft-overlay-states.html`（两态对比 + 拓扑示意 + 应用按钮 + 跨平台方案 X mimic_mac + 尺寸表）
