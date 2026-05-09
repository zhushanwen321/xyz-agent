# xyz-agent UI 设计审查报告

**日期**: 2026-05-08
**审查范围**: docs/designs/ 下 HTML 原型 + src/src/ 当前实现
**审查标准**: PRODUCT.md 设计原则、"每天 6 小时以上使用不疲劳"、P1 Spec 范围
**审查者**: impeccable

---

## 一、总体结论

信息架构基本合理，Warm & Soft 的基调正确。但存在 **6 个设计缺陷**，其中 3 个在 P1 阶段必须修复（影响阅读疲劳和交互效率），3 个建议修复（影响信息层级清晰度）。

**无结构性推翻**。不需要重新设计任何区域，只需调整边界情况的处理方式。

---

## 二、缺陷清单与修正方案

### 【P0】缺陷 1: Message Bubble 宽度在大屏幕上失控

**问题**: `max-width: 80%` 在 1920px 屏幕上可达 1200px，单行 85+ 字符，严重超出 65–75ch 的阅读舒适区。

**后果**: 长时间阅读助手的长回复时，眼睛横向扫描距离过长，疲劳度显著增加。

**修正方案**:
```css
/* 原 */
.msg { max-width: 80%; }

/* 修正 */
.msg { max-width: min(80%, 70ch); }
/* 助手消息（通常更长） */
.msg--bot { max-width: min(80%, 70ch); }
/* 用户消息（通常更短） */
.msg--user { max-width: min(70%, 50ch); }
```

同时，为 `.chat-msgs` 容器增加整体约束，防止极端宽屏下的过度拉伸：
```css
.chat-msgs {
  /* 新增 */
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
}
```

**HTML 变更**: 无需修改 HTML 结构，仅 CSS。

---

### 【P0】缺陷 2: AgentView 切换丢失滚动位置

**问题**: 当前使用 `display: none / block` 切换 AgentView。当用户从"主线对话"切换到"SubAgent-1"再切回时，滚动位置丢失，需要重新定位到之前阅读的位置。

**后果**: 多 Agent 并行场景下，用户反复切换查看进度时，每次都要重新滚动，交互成本极高。

**修正方案**:
将 `display` 切换改为 `visibility` + 绝对定位叠加，保留 DOM 和滚动状态：
```css
/* 原 */
.agent-view { display: none; }
.agent-view.active { display: flex; }

/* 修正 */
.chat-msgs { position: relative; }
.agent-view {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  visibility: hidden;
  opacity: 0;
  transition: opacity 0.2s var(--ease);
  overflow-y: auto;
}
.agent-view.active {
  visibility: visible;
  opacity: 1;
  z-index: 1;
}
```

**注意**: 需要为 `.chat-msgs` 增加 `position: relative` 作为定位上下文。

**HTML 变更**: 无需修改 HTML 结构，仅 CSS。

---

### 【P0】缺陷 3: Sidebar 折叠行为与设计规范不符

**问题**: 当前实现折叠后 `width: 48px`（mini 模式），但设计规范要求 `width: 0`（完全隐藏）。且与 P1 已有的"专注模式"（Cmd+3）功能重复，造成用户困惑。

**后果**: 两个不同的入口实现相似的"隐藏侧边栏"效果，用户不知道应该用哪个。

**修正方案**:
```css
/* 原 */
.sidebar.collapsed { width: 48px; }

/* 修正 */
.sidebar.collapsed { width: 0; border-right: none; overflow: hidden; }
.sidebar.collapsed .sidebar-inner { opacity: 0; }
```

同时，**移除 Sidebar 的独立折叠按钮**，折叠行为仅通过专注模式触发（Cmd+3 或 Header 的专注按钮）。Sidebar 标题栏的折叠按钮改为"在专注模式和标准模式之间切换"。

**HTML 变更**: Sidebar 头部按钮的行为描述需要调整。

---

### 【P1】缺陷 4: 系统消息与对话消息层级混淆

**问题**: 系统消息（SubAgent 完成/告警）使用全宽 + 左边框，与左侧对齐的助手消息在视觉上没有足够区分。用户快速扫视时会误认为是"一条很宽的助手消息"。

**后果**: 信息层级不清，用户需要额外认知成本来区分"这是对话内容"还是"这是系统通知"。

**修正方案**:
1. 系统消息前后增加额外间距（与对话消息形成区隔）
2. 系统消息使用 bg 色背景（而非 surface 色），与对话消息的 surface 背景形成区分
3. 系统消息居中显示（像 Slack 的系统提示），与左右对话形成明确的空间区分

```css
/* 新增 */
.msg--system {
  align-self: center; /* 从 stretch 改为 center */
  max-width: 600px;
  width: 100%;
  margin: 8px 0; /* 上下增加间距 */
  background: var(--bg); /* 使用 bg 色，而非 surface */
  border-left: 3px solid var(--success);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
}
```

**HTML 变更**: 无需修改 HTML 结构，仅 CSS。

---

### 【P1】缺陷 5: SlashMenu 无溢出处理

**问题**: SlashMenu 是绝对定位在输入框上方的浮层。当命令列表很长（10+ 项）时，菜单可能超出屏幕顶部，且当前无滚动处理。

**后果**: 部分命令无法访问。

**修正方案**:
```css
.slash-menu {
  /* 新增 */
  max-height: 280px;
  overflow-y: auto;
}
```

**HTML 变更**: 无需修改 HTML 结构，仅 CSS。

---

### 【P1】缺陷 6: Sidebar SessionItem 缺乏通知状态表达

**问题**: SessionItem 只有 7px 圆点表示状态（运行中/暂停/闲置），但无法表达"该 Session 下有 SubAgent 已完成"或"有需要确认的告警"这种更复杂的状态。

**后果**: P5 阶段用户需要逐个 Session 点进去才能知道有没有通知，信息获取效率低。

**修正方案**:
为 SessionItem 增加微型通知徽章（预埋 P5）：
```css
/* 新增 */
.s-item__notif {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  border-radius: 7px;
  font-size: 9px;
  font-weight: 700;
  color: white;
  margin-left: 4px;
}
.s-item__notif--done { background: var(--success); }
.s-item__notif--alert { background: var(--danger); }
```

同时，有未读通知的 Session 标题加粗：
```css
.s-item.has-notif .s-item__title {
  font-weight: 600;
}
```

**HTML 变更**: SessionItem 的 HTML 结构需要增加通知徽章元素。

---

## 三、Header 通知按钮的 P5 预留设计

当前 Header 的通知 pills（已完成/请求回应）在 P1 阶段隐藏（符合 Spec）。P5 实现时需要解决"全局 vs 按 Session"的问题。

**建议的 P5 方案**:
- Header 通知按钮显示**所有 Session 的汇总数量**
- 点击 Header 通知按钮 → 打开 **Overview（Mission Control）**，而非 Drawer
- Drawer 只展示**当前 Session** 的 SubAgent 任务树/Done/Alert
- 这样既保留了全局视角（Overview），又保留了局部细节（Drawer）

---

## 四、Drawer 小屏幕适配的 P4/P5 预留设计

**问题**: 标准模式（Sidebar 240px + Drawer 380px）在 1280px 屏幕上，Main Area 仅剩 660px。

**建议的 P4/P5 方案**:
- 屏幕宽度 < 1400px 时，打开 Drawer **自动折叠 Sidebar**
- 或者 Drawer 宽度从 380px 缩减到 320px
- 或者提供"全屏 Drawer"模式（overlay 覆盖整个 Main Area）

---

## 五、修正后的 HTML 文件清单

以下文件已在 docs/designs/ 目录下更新：

| 文件 | 修正内容 |
|------|---------|
| `css_design-system.css` | Message max-width、AgentView 切换方式、Sidebar 折叠、系统消息样式、SlashMenu 溢出、SessionItem 通知徽章 |
| `index.html` | Sidebar 折叠按钮行为、系统消息示例样式、SlashMenu 示例 |
| `views_standard.html` | AgentView 定位上下文、SessionItem 通知徽章示例 |

---

## 六、评分对比

| 区域 | 修正前 | 修正后 |
|------|--------|--------|
| 阅读疲劳度 | ★★★☆☆ | ★★★★★ |
| 交互效率 | ★★★☆☆ | ★★★★☆ |
| 信息层级清晰度 | ★★★☆☆ | ★★★★☆ |
| 长期可用性 | ★★★☆☆ | ★★★★★ |

---

## 七、下一步

用户确认修正后的 HTML 原型后，进入 craft 阶段，将修正同步到 src/src/ 的 Vue 组件中。
