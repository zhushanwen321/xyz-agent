# 前端 UI 优化设计

日期：2026-04-10
状态：已确认
范围：前端 Vue 组件 + Tauri 窗口配置 + Rust 后端 settings API

## 概述

5 项 UI 改进：消息视觉统一、工具调用合并、导航结构、窗口大小、设置页面。

## 1. 消息视觉统一

### 角色标记

| 角色 | 图标 | 文字 | 样式 |
|------|------|------|------|
| Assistant | λ | Assistant | 绿色 `#22c55e`，背景 `#22c55e22`，小圆角标签 |
| User | → | User | 灰色 `#a1a1aa`，背景 `#ffffff15`，小圆角标签 |

Assistant 标记位于消息左上方，User 标记位于消息右上方（右对齐）。

### 统一侧边色条

所有消息都有 3px 左侧色条，颜色按类型区分：

| 类型 | 侧边颜色 | 适用场景 |
|------|----------|---------|
| User 消息 | `#a1a1aa` (灰) | 用户发送的所有消息 |
| Assistant 文本 | `#22c55e` (绿) | Assistant 的文字回复 |
| 工具 - safe | `#22c55e` (绿) | Read 等只读工具 |
| 工具 - caution | `#eab308` (黄) | Bash、Write 等有副作用的工具 |
| 工具 - error | `#ef4444` (红) | 任何执行失败的工具调用 |

### 消息卡片结构

每条消息（文本或工具调用）是独立的卡片，有各自的背景和边框：

- **User**: 右对齐，背景 `#18181b`，边框 `#27272a`，最大宽度 75%
- **Assistant 文本**: 左对齐，背景 `#111113`，边框 `#27272a`，最大宽度 85%
- **工具调用**: 左对齐，与 Assistant 文本同级，有 header 行 + 可折叠输出区

### 布局示意

```
                    User ▸                        ← 标记右对齐
              ┌──────────────────┐┃               ← 灰色侧边条
              │ 用户输入内容       │┃
              └──────────────────┘┃

λ Assistant                                       ← 标记左对齐
┃┌────────────────────────────┐
┃│ Assistant 文字回复          │                   ← 绿色侧边条
┃└────────────────────────────┘
┃┌────────────────────────────┐
┃│ ✓ Read  file_path: "..."    │                  ← 绿色侧边条 (safe)
┃│─────────────────────────────│
┃│ 1  fn main() { ...         │                  ← 默认展开
┃└────────────────────────────┘
┃┌────────────────────────────┐
┃│ ✓ Bash  command: "..."      │                  ← 黄色侧边条 (caution)
┃│─────────────────────────────│
┃│ Finished in 1.2s            │
┃└────────────────────────────┘
```

## 2. 工具调用合并到 Assistant 轮次

### 当前行为

工具调用作为独立消息渲染，与 Assistant 文本分离。

### 改进行为

一次 Assistant 回复（一个 turn）内的所有内容归为一个消息组：
- 标题行只显示一次（λ Assistant）
- 文本片段和工具调用交替出现，各有独立卡片
- 工具调用默认展开（不需要点击）

### 前端数据模型变更

`ChatMessage` 接口不变，但渲染逻辑需要调整：

- `useChat.ts` 中已经将 `toolCalls` 挂载到 assistant 消息的 `toolCalls[]` 数组
- 渲染时，一个 assistant 消息内按顺序展示：文本卡片 + 工具调用卡片 + 文本卡片 + ...
- 需要区分"工具调用前的文本"和"工具调用后的文本"

工具危险等级映射（前端静态配置）：

```typescript
const TOOL_DANGER_LEVEL: Record<string, 'safe' | 'caution'> = {
  Read: 'safe',
  Bash: 'caution',
  Write: 'caution',
}
// error 级别由运行时 status 决定
```

## 3. Topbar 导航 + Sidebar 可折叠

### Topbar

高度 40px，位于最顶部，包含三部分：

| 区域 | 内容 |
|------|------|
| 左 | xyz-agent logo 文字 |
| 中 | Chat / Settings 导航标签 |
| 右 | 当前模型名 + Sidebar 折叠按钮 |

### Sidebar

- 默认展开，宽度 240px
- 点击 Topbar 右侧折叠按钮可收起至 0px（带过渡动画）
- 内容：新建会话按钮 + 会话列表
- 与当前实现基本一致，仅新增折叠功能

### 路由视图

Topbar 的 Chat / Settings 切换内容区域，使用简单的条件渲染（不需要 vue-router）：

- **ChatView**: 现有的聊天界面（消息列表 + 输入框）
- **SettingsView**: 新增的设置页面

## 4. 窗口大小

### 配置变更

`src-tauri/tauri.conf.json` 中修改默认窗口尺寸：

```json
{
  "app": {
    "windows": [{
      "title": "xyz-agent",
      "width": "75%",
      "height": "75%"
    }]
  }
}
```

Tauri v2 支持百分比字符串。如果不支持百分比，在 `lib.rs` 的 setup 中通过 `app.window()` API 动态设置。

## 5. 设置页面

### 暴露的配置项

| 分组 | 字段 | 类型 | 默认值 |
|------|------|------|--------|
| LLM | api_key | password | (从环境变量) |
| LLM | model | text | claude-sonnet-4-6 |
| LLM | base_url | text | https://api.anthropic.com |
| Agent | max_turns | number | 50 |
| Agent | context_window | number | 200000 |
| Agent | max_output_tokens | number | 8192 |
| Agent | tool_output_max_bytes | number | 100000 |
| Agent | bash_default_timeout_secs | number | 120 |

### 后端 API

新增两个 Tauri command：

```rust
// 读取当前配置
#[tauri::command]
fn get_config() -> Result<ConfigResponse, String>

// 更新配置（写入 config.toml）
#[tauri::command]
fn update_config(payload: UpdateConfigRequest) -> Result<(), String>
```

配置文件路径：`~/.xyz-agent/config.toml`

### 前端组件

SettingsView.vue：
- 分组展示（LLM / Agent 两栏或两区）
- api_key 用 password input
- number 类型字段用数字输入框 + 范围提示
- 保存按钮，保存后写入 config.toml
- 保存时提示"部分配置需要重启生效"

## 新增文件清单

| 文件 | 用途 |
|------|------|
| `src/components/Topbar.vue` | 顶部导航栏 |
| `src/components/SettingsView.vue` | 设置页面 |
| `src/composables/useSettings.ts` | 配置读写 composable |

## 修改文件清单

| 文件 | 改动 |
|------|------|
| `src/App.vue` | 集成 Topbar，添加路由逻辑 |
| `src/components/ChatView.vue` | 传递消息渲染改进 |
| `src/components/MessageBubble.vue` | 侧边色条 + 角色标记 + 统一卡片 |
| `src/components/ToolCallCard.vue` | 默认展开 + 危险等级颜色 |
| `src/components/Sidebar.vue` | 可折叠逻辑 |
| `src/composables/useChat.ts` | 文本片段拆分（工具调用前后） |
| `src/assets/main.css` | 新增侧边色条样式 |
| `src/types/index.ts` | 工具危险等级类型 |
| `src-tauri/tauri.conf.json` | 窗口尺寸 |
| `src-tauri/src/api/commands.rs` | get_config / update_config |
| `src-tauri/src/engine/config/mod.rs` | config 读写函数 |

## 不做的事

- 不引入 vue-router（用简单的条件渲染即可）
- 不做配置热重载（保存后提示重启）
- 不做深色/浅色主题切换
- 不做工具调用的折叠功能保留（默认全部展开，不做可折叠）
