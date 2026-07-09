# ZCode 风格 UI Demo

一个独立的浏览器可运行设计稿，复刻 ZCode AI Agent 的 "layered float" 视觉与交互风格。

## 运行方式

```bash
cd docs/page-design/zcode-demo
python3 -m http.server 8080
# 浏览器访问 http://127.0.0.1:8080
```

> 必须用 http server 打开，不能直接用 `file://` 协议，否则 ES Module 会被浏览器 CORS 拦截。

## 文件结构

```
zcode-demo/
├── index.html              # 入口，加载 Tailwind CDN 与主模块
├── main.js                 # Vue 3 应用挂载
├── style.css               # 设计 token 与工具样式
├── App.js                  # 应用外壳：sidebar + 浮动主面板
├── ChatView.js             # 聊天视图核心布局
├── SettingsView.js         # 设置视图
└── components/
    ├── NavItem.js          # 侧边栏导航项
    ├── ReasoningBlock.js   # AI 思考/工具调用折叠块
    ├── ToolCallCard.js     # 单条工具命令卡片
    ├── ProcessPanel.js     # 进程面板（抽屉打开时的 mini chip）
    └── RightDrawerContent.js # 右侧抽屉内容（Diff / 浏览器 / 终端）
```

## 设计要点

### 1. Layered float 布局

- 背景层 (`base #1a1b1f`，2026-07-09 提亮校准，原 `#0d0d0f`) 是统一画布。
- 主内容区是一个带 margin 的浮动圆角面板 (`panel #222329`)，与背景形成层级。
- 侧边栏直接坐在背景层上，没有独立面板背景，靠 hover/selected 状态区分。

### 2. 聊天区域三栏结构

| 区域 | 宽度 | 说明 |
|------|------|------|
| Message stream | 50% chat area | 始终固定宽度，不会被抽屉挤压变形 |
| Composer | 同 message stream | 与消息流同宽、同容器概念 |
| Right zone | 50% chat area | 抽屉关闭时显示完整进程卡片；抽屉打开时显示抽屉 |

### 3. 进程面板交互

- **抽屉关闭**：完整进程卡片占据右侧 50% 区域，不遮挡聊天内容。
- **抽屉打开**：进程卡片收缩为右上角 mini chip (`✓ 进程 9/9 ▾`)，点击可展开临时浮层。
- 状态切换带 `transition-all` / `scale` / `opacity` 动画，避免生硬跳变。

### 4. 右侧抽屉

- 固定 50% 宽度，从右侧平移滑入/滑出 (`translate-x-full` → `translate-x-0`)。
- 支持三个标签：Diff、浏览器、终端。
- Header 工具栏按钮高亮当前打开的标签。

### 5. 消息流

- 消息内容占满 stream 容器宽度，不再使用窄居中列。
- 用户消息右对齐，最大宽度 80%。
- AI 消息左侧带头像，下方可嵌套 reasoning block 与 tool call card。

### 6. 最小分隔

- 只保留必要线条：主面板外边框、header 底部分隔线、drawer 左侧分隔线。
- 不使用大量边框分割区域，靠背景色阶 (`base` / `panel` / `panel-hover`) 区分层次。

## 颜色 token

```css
/* 2026-07-09 提亮校准后色值，对标 VS Code Dark+。原值见 design-tokens.md 暗色章节 */
--base: #1a1b1f
--panel: #222329
--panel-hover: #282930
--accent: #4f8ef7
--success: #22c55e
--border: rgba(255,255,255,0.08)
--text-primary: #f7f8fc
--text-secondary: #a8a8b5
--text-tertiary: #82828f
```

## 后续迁移方向

1. 将 `*.js` 组件迁移为项目真正的 Vue SFC (`.vue`)。
2. 用项目 `xyz-ui` 组件库替换原生 `<button>` / `<textarea>` 等 HTML 元素。
3. 将颜色 token 提取到 `packages/renderer/src/style.css` 与 `../design-system.md`。
4. 替换 demo 中的 emoji 图标为 lucide-vue-next 图标。
5. 右侧抽屉接入真实数据：Diff、浏览器预览、终端输出。
