# 新建任务 · 流程与界面规范

**类型**: L1 流程设计 · 跨 `sidebar` / `workspace` / `overlays` 单元
**关联**: `sidebar/spec.md`（「新建」nav 入口 + ⌘N 触发）· `shell/spec.md`（traffic light 安全区 + 应用两态）· `panel/draft-composer-states.html`（composer 原语）· `overlays/spec.md`（popover/浮层归属裁决）· `overlays/draft-search-modal.html`（同源 Overlay 范式）
**配套 HTML**: `draft-landing.html` / `draft-directory-select.html` / `draft-branch-select.html` / `draft-directory-picker.html`

## 1. 流程定义

「新建任务」是用户从「无活跃会话」进入「准备开聊」的过程。与其把它当作「一个页面」，不如把它拆成 **5 步线性状态**，每步用最合适的形态呈现：

| # | 状态 | 形态 | 入口 | 出口 |
|---|------|------|------|------|
| 0 | 无活跃会话（Entry） | sidebar Session List 态 D（空态） | sidebar 底「新建任务」按钮 / `⌘N` | 步骤 1 |
| 1 | 落地空态（Greeting） | workspace 内 empty composer + 问候语 | 步骤 0 触发 | 步骤 2 / 3（用户主动） |
| 2 | 选目录 | composer 顶部 directory chip 上方 popover | 点 directory chip | 选中 → 落回步骤 1；或「打开文件夹」→ 步骤 4a |
| 3 | 选分支 | composer 顶部 branch chip 上方 popover | 点 branch chip | 选中 → 落回步骤 1；或「创建并检出新分支」→ 步骤 4b |
| 4a | 打开文件夹 | <b>系统原生目录选择器</b>（Electron <code>dialog.showOpenDialog</code>，不自绘） | 步骤 2 「打开文件夹」 | 选中 → 落回步骤 1 并更新 directory chip；取消 → 落回步骤 2 |
| 4b | 创建并检出新分支 | 居中 modal，表单式 | 步骤 3 「创建并检出新分支...」 | 创建 → 落回步骤 1 并更新 branch chip；取消 → 落回步骤 3 |

**关键观察**：步骤 1 是「常态」，步骤 2 / 3 是「临时浮层」，步骤 4 是「深一层模态」。三者用 **3 种不同的层级**——这种分层是 v3 反复验证的「最短路径」原则：

- **同层 popover**（步骤 2 / 3）：用户在 composer 内调整元信息，不打断主任务流。键盘 `Esc` / 点 chip 区域外即关闭，零副作用。
- **系统原生 dialog**（步骤 4a）：「打开文件夹」直接调 OS 原生目录选择器（<code>dialog.showOpenDialog</code>），<b>不自绘</b>——应用零干预，选中/导航/权限全交 OS。
- **居中 modal**（步骤 4b）：用户要做「不可逆选择」（创建新分支）才升级模态。模糊背景 + 居中卡片，强制聚焦。
- **落地空态**（步骤 1）：唯一「无前置交互」形态，所有后续动作都从这里派生。

## 2. 设计意图（为什么这么拆）

### 2.1 不做「单页新建向导」

Claude Code / Cursor 的「新建会话」有的是全屏向导（3 步表单），有的是直接跳到空 composer。xyz-agent 选 **后者**——原因：

- **任务上下文是用户边聊边给的**。强制「先选项目 → 再选分支 → 再写任务」会让用户在表单里卡住 30 秒，结果 80% 的人最终用的是默认值。
- **directory + branch 是「元信息」而非「任务」**。把它们做成 composer 顶部的 chip（可点击、可更换），既不打断主输入流，又让用户「随时可改」。
- **可恢复性**：写到一半发现选错目录，直接点 chip 换即可，不需要回退上一步。

### 2.2 popover 锚定在 chip 上方（而非下拉菜单）

composer 顶部的 directory / branch chip 是「触发器」+「状态显示」二合一：

- 视觉上 chip 一直显示当前选择（用户随时看到自己在哪个目录、哪个分支）。
- 点击后 popover 从 chip 上方展开（**向上展开**而非向下），原因是 composer 已经在屏幕下半部，向下展开会出屏。这是 v3 popover 一律向上展开的硬约束（见 `overlays/spec.md` 边缘态）。

### 2.3 模态只在「不可逆动作」上才用

步骤 4a（系统目录选择器）和 4b（创建并检出新分支）都是「改了就回不去」的操作：

- 选错目录 → 工作树切到错的 git repo
- 错建分支 → git 里堆个孤儿分支

所以这两种必须升级为居中 modal：模糊背景 + 强制聚焦 + 二次确认/可取消。普通「换目录」「换分支」不进 modal，因为不创建新东西（选已有分支/选已有目录），是 chip 状态切换。

### 2.4 composer 内嵌 directory + branch chip，而非拆出来

跟 Claude Code / Cursor 的「项目选择器在外层」不同，xyz-agent 把这两个 chip 塞进 composer 顶部：

- 写任务的上下文（目录、分支）跟任务本身强相关，物理上贴近。
- chip 是「可改但不必改」的元信息——大多数用户开新会话会沿用上一会话的目录/分支，不点 chip。
- chip 不进 composer 也不破坏 composer 原语（见 `panel/draft-composer-states.html`）——它只是放在 composer-box 上方的「附属元信息行」，与主输入流分离但视觉一体。

## 3. 详细交互

### 3.1 步骤 1 · 落地空态（draft-landing）

**布局**：
- zcode watermark 浮画布中央（`opacity 0.04` 的 SVG 描边，背景层），不抢主视觉
- 问候语「上午好呀，有什么想让我帮忙的吗」居中（22px / weight 650 / `--fg`）
- composer 卡片居中偏下：`--bg-input` 底 + `--border` 描边 + `--radius-lg` 圆角，**`width: 720px` max**（与 panel composer 同宽，自适应窗口）
- composer 顶部元信息行：directory chip（左） + branch chip（右），分隔 1px vertical divider
- composer 主输入区：placeholder 多色提示（`@` accent / `/` reasoning / `$` success / `#` info，每种 token 在 syntax doc 已定义）
- composer 底部工具条：`+` 插入 · 「完全访问」权限下拉 · flex spacer · 模型下拉 · 思考等级下拉 · 发送按钮

**键盘**：
- `⌘N`（mac） / `Ctrl+N`（win/linux）从任何状态唤起「落地空态」
- composer 聚焦即 `Enter` 发送、`Shift+Enter` 换行
- 任何时候按 `⌘K` 切到搜索浮层

**何时消失**：
- 用户发送第一条消息 → composer 进 streaming 态（`panel/draft-composer-states.html` §3 接管）
- 用户点 chip 进步骤 2 / 3（chip 区域可继续敲字，popover 是装饰性的）
- 用户点 sidebar 已存在的会话 → 切到该会话

### 3.2 步骤 2 · 选目录（draft-directory-select）

**触发**：点 composer 顶 directory chip
**形态**：popover 锚定 chip 中心，向上展开，宽度 380px

**结构**：
- 搜索 input（`搜索工作区`，placeholder `--subtle`）— 顶部 sticky
- 5–10 条最近 workspace 列表（folder icon + workspace 名 + 路径 subline）
  - 当前选中项走 Card-Active：`--surface-2` 底 + `inset 1px accent ring`
  - 右侧 ✓ 标记（用 `--accent` 描边对勾 SVG）
- 分隔线
- 2 个动作项：「打开文件夹」（folder-plus icon）+「远程连接」（cloud icon）
  - 动作项与列表项视觉一致（同一 row 高度），区别仅在图标语义——「动作」是图标语义而非位置区分，避免误以为「打开文件夹」是另一个 workspace

**键盘**：
- 打开即 focus 搜索框
- `↑` / `↓` 跨组扁平化（同 search modal 矩阵，`overlays/spec.md` §键盘契约）
- `Enter` 确认选中
- `Esc` 关闭
- 输入即时过滤（无 debounce，因为 list 小于 50 条本地缓存）

**与 File View 搜索的区分**（P0 严格隔离）：
- **本 popover**：全局「最近 workspace 列表」，跨项目，可切到任何 git repo
- **File View 树内搜索**：sidebar 内联 input，**当前 active session** 改动文件过滤
- 入口 / 范围 / 形态 / 结果全不同，不可混用（详 `overlays/spec.md` §严格区分）

### 3.3 步骤 3 · 选分支（draft-branch-select）

**触发**：点 composer 顶 branch chip
**形态**：popover 锚定 chip 中心，向上展开，宽度 420px（比 directory 略宽，因为分支名常较长）

**结构**：
- 搜索 input（`搜索分支`）
- 分组头「分支」+ 计数
- 分支列表（git-branch icon + 分支名 + 可选 `未提交的更改：N 个文件` subline）
  - 当前分支走 Card-Active（inset ring）
  - dirty 标记：`未提交的更改：2 个文件` 用 `--warning` 色的 warning dot + mono 小字（提示用户「切走会丢」）
- 分隔线
- 2 个动作项：「创建并检出新分支...」（+ icon）+「Git 图谱」（git-graph icon）

**键盘**：同步骤 2

**dirty 分支的特殊处理**（v3 关键交互）：
- dirty 分支不高亮、不禁用——允许切，但 popover 关闭前弹 **inline 二次确认条**（不弹 modal，行内条更轻），与 `sidebar/draft-session-item.html` §8 删除二次确认条同源
- 确认条文案：`「refactor-goal-extension」有 2 个未提交更改，切走将保留为 stash / 留在工作区 · 切走 / 取消`
  - v1 选「留在工作区」（不自动 stash，git 自然行为，不主动制造用户没要求的副作用）

### 3.4 步骤 4a · 打开文件夹 · 系统原生目录选择器（draft-directory-picker §1）

**触发**：步骤 2 选「打开文件夹」
**形态**：<b>操作系统原生目录选择器</b>（Electron <code>dialog.showOpenDialog({ properties: ['openDirectory'] })</code>），<b>应用不自绘 picker</b>

**为什么走系统原生而非自绘**：
- 原生体验用户最熟悉（系统级收藏 / 搜索 / 快捷键开箱即用）
- 免维护 mac / win / linux 三套 picker UI，且自绘永远不如原生
- 文件权限由 OS 托管（沙盒授权 / UAC / 文件系统权限），应用不重复造轮子

**数据流**：点「打开文件夹」→ renderer 经 IPC 调 `dialog.showOpenDialog` → OS 弹原生 dialog → 返回 `{ canceled, filePaths }` → 未取消则 `filePaths[0]` 回灌 directory chip + 载入工作区；取消则落回 directory popover。

**键盘 / 权限**：完全跟随 OS（应用不定义）。mac NSOpenPanel / win IFileOpenDialog / linux GTK FileChooserDialog，行为由各自平台决定。

**裁决 reversal**：v0 截图原型 + 早期 draft 曾走自绘 picker（理由：视觉一致性 / 跨平台一致）。现推翻——原生优先，自绘是维护负担且体验不如原生。

### 3.5 步骤 4b · 创建并检出新分支（draft-directory-picker §2）

**触发**：步骤 3 选「创建并检出新分支...」
**形态**：居中 modal，宽 560px、高 auto，模糊背景

**结构**：
- 顶部：「创建并检出新分支」（18px / weight 650）+ 关闭 X
- 描述：「基于当前 HEAD 创建一个新的本地分支，并在创建成功后立即切换过去。」（`--muted` 13px）
- 「分支名」label（12px / `--muted`）
- input（`--bg-input` 底 + `--border` 描边，placeholder `例如 feature/git-branch-switcher`，focus 时 `--accent` 1px ring）
- 提示文案：「首版只支持基于当前 HEAD 创建并切换。」（12px / `--subtle`，告知能力边界）
- 右下：「取消」（secondary）+「创建并切换」（primary，accent 实色）

**键盘**：
- 打开即 focus input
- `Enter` 提交（input 非空时）
- `Esc` 取消
- 提交时按钮变 spinner（`<200ms` 不显），成功 → 关闭 modal 落回步骤 1 并更新 branch chip

**为什么 v1 限制「基于 HEAD」**：
- v1 不接 git ref picker、tag、commit SHA——避免 v1 范围爆炸
- 写「首版只支持基于当前 HEAD 创建并切换」做显式能力声明（design-system §9 文案原则：「说原因 + 下一步」）

## 4. 边缘态

| 场景 | 处理 |
|------|------|
| 落地空态用户不点 chip 直接打字 | composer 正常工作，沿用上一会话的 directory / branch |
| 选目录 popover 内用户点 chip 区域外 | popover 关闭，不改 chip 状态 |
| 选分支 popover 内选到 dirty 分支 | 弹 inline 二次确认条（见 §3.3） |
| 系统原生 dialog 取消 | `result.canceled === true` → 落回 directory popover，chip 不变（应用零干预） |
| 创建分支 modal 用户没填名就点「创建并切换」 | 按钮 disabled |
| 创建分支 modal 用户填了已有分支名 | input 边框转 `--danger` + 下方「该分支已存在」红字（design-system §4 错误态） |
| `Esc` 优先级冲突 | 模态内 `Esc` 关闭当前模态；composer `Esc` 清空输入；浮层 `Esc` 关闭浮层。三者互不冲突（同一时刻只有一层） |

## 5. 已知差异 / 取舍记录

| 项 | 截图（v0 旧实现） | v3 本稿 | 取舍 |
|---|------------------|---------|------|
| 落地点缀字色 | v0 提示文字 `@` `/` `$` `#` 全部同灰 | v3 按 token 分色（accent / reasoning / success / info） | v0 灰字不区分，认知负担高；v3 分色让用户对 slash token 体系一眼有色彩锚点 |
| 问候语字号 | v0 26px | v3 22px | v3 收一档，给 composer 让位（composer 是真正的工作区，greeting 是仪式） |
| directory chip 选中态 | v0 直接在 chip 上画 ✓ | v3 选中态走 Card-Active（popover 内），chip 本身只显当前值 | chip 是触发器+状态显示二合一，✓ 在 popover 内即足够；chip 内画 ✓ 会让 chip 自身变成 Card-Active 风格但跟 popover 双重高亮打架 |
| 创建分支按钮文案 | v0 「创建并切换」 | v3 「创建并切换」 | 保持——动词开头（design-system §9） |
| 系统目录选择器 | v0 走 OS 原生 / draft 曾自绘 | v3 回归 <b>系统原生</b>（<code>dialog.showOpenDialog</code>），不自绘 | 理由见 §3.4：原生优先，自绘是维护负担 |
| 路径显示 | v0 完整绝对路径 | v3 monospace 路径 + 截断（>30 字符省略前缀） | 长路径会撑破 chip，monospace 保证等宽视觉 |

## 6. 遗留待裁决

- [ ] **popover 锚定算法**：当 chip 距视口顶部 < 300px 时，popover 应自动向下展开（fallback 行为）。本稿统一向上展开，fallback 未做。
- [ ] **dirty 分支切走副作用**：v1 选「留在工作区」（不自动 stash），但用户可能预期「自动 stash」。需要 v2 接 git stash 选项。
- [ ] **最近 workspace 列表数据源**：v1 走本地缓存（`~/.xyz-agent/recent-workspaces.json`），同步 vs 异步加载、是否需要权限请求（访问外部目录）待核。
- [ ] **远程连接**：「远程连接」动作项 v1 是 stub（点开 toast「v1 暂未支持」），v2 接 SSH remote picker。
- [ ] **Git 图谱**：「Git 图谱」动作项 v1 是 stub，v2 接 lazygit / tig 嵌入式 view 或独立 modal。
- [ ] **空 workspace 列表**：首次启动（无任何 workspace）时步骤 2 popover 显示「空状态」：「暂无最近工作区 · 选择一个本地目录开始」（按 design-system §7 三要素：subtle 图标 + 一句说明 + Primary 入口）。
