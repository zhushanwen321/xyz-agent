# Skill / Slash Command 基础设施扫描报告

> 扫描时间：2026-05-14
> 扫描范围：xyz-agent 项目中与 skill、slash command、聊天输入相关的代码架构

---

## 1. 文件清单与职责

### 1.1 共享类型层 (`src-electron/shared/src/`)

| 文件 | 职责 |
|------|------|
| `provider.ts` | 定义 `SkillInfo`、`ScannedSkillInfo`、`AgentInfo`、`ScannedAgentInfo`、`ScanSourceType` 等核心类型 |
| `message.ts` | 定义 `Message` 类型，含 `skillName?: string` 可选字段（标识通过 skill 命令触发的消息） |
| `protocol.ts` | 定义 WS 协议消息类型，含 skill 相关的 `config.scanSkills`/`config.setSkill`/`config.deleteSkill` 等 |
| `settings.ts` | 主题相关类型，不涉及 skill |
| `session.ts` | Session 类型，不涉及 skill |

### 1.2 Sidecar 层 (`src-electron/sidecar/src/`)

| 文件 | 职责 |
|------|------|
| `server.ts` | WS 服务器主路由，处理 `config.scanSkills`/`config.setSkill`/`config.deleteSkill` 等 skill CRUD 命令 |
| `skill-scanner.ts` | 扫描磁盘上的 skill 目录（`~/.pi/agent/skills/` 等），解析 SKILL.md 的 YAML frontmatter 和触发词 |
| `agent-scanner.ts` | 扫描磁盘上的 agent 目录，与 skill-scanner 结构类似 |
| `config-store.ts` | Skill 持久化（读写 `.xyz-agent/skills.json`），以及加载/保存/广播 skill 列表 |
| `session-pool.ts` | Session 管理，**不含任何 skill 相关代码**——skill 内容不经过此层传递给 pi |
| `rpc-client.ts` | pi RPC 客户端，**不含任何 skill 相关代码**——`prompt()` 只传原始文本 |
| `event-adapter.ts` | pi 事件翻译层，将 pi RPC 事件转为 WS 协议消息，**不含 skill 处理** |

### 1.3 前端渲染层 (`src-electron/renderer/src/`)

| 文件 | 职责 |
|------|------|
| **`composables/useSlashCommands.ts`** | Slash command 核心逻辑：注册内置命令、合并 skill 命令、过滤/排序 |
| **`components/chat/SlashMenu.vue`** | Slash 命令自动补全下拉菜单（键盘导航、点击选择、外部点击关闭） |
| **`components/chat/ChatInput.vue`** | 聊天输入框：检测 `/` 开头输入 → 显示 SlashMenu → 选择后执行或保留标签 |
| `components/chat/MessageBubble.vue` | 消息气泡：显示 `skillName` 标签（白底绿色勾号） |
| `components/panel/ChatPanel.vue` | 聊天面板：连接 ChatInput 事件，向上透传 send/send-command/local-action |
| `components/panel/PaneSessionView.vue` | Session 视图：处理 send（含 skillName）/send-command/local-action 事件 |
| `composables/useChat.ts` | Chat composable：发送消息 `message.send`，**不含 skill 特殊处理** |
| `composables/useProvider.ts` | Provider composable：监听 skill 相关 WS 消息，更新 providerStore |
| `stores/provider.ts` | Pinia store：管理 `skills`/`scannedSkills` 状态，提供 CRUD actions |
| `components/settings/SkillsPane.vue` | Settings 中 skill 管理面板（扫描、导入、编辑） |
| `components/settings/SkillSection.vue` | 单个 skill 展示行（启用/禁用、编辑按钮） |
| `components/settings/SkillModal.vue` | Skill 编辑弹窗（名称、描述、内容） |
| `lib/ws-client.ts` | WS 客户端：发送/接收消息，通过 event-bus 分发，**不含 skill 特殊处理** |
| `lib/event-bus.ts` | 事件总线：消息分发，**不含 skill 特殊处理** |

---

## 2. 现有数据流

### 2.1 Skill 配置管理（已完整实现）

```
[Settings UI]
  SkillsPane.vue → providerStore.scanSkillsAction()
  → ws-client.send({ type: 'config.scanSkills', payload: { sources } })
    → sidecar server.ts → skill-scanner.scanSkills()
    → 扫描 ~/.pi/agent/skills/, ~/.claude/skills/, ~/.agents/skills/
    → 返回 ScannedSkillInfo[]
    ← WS: config.scannedSkills
  ← useProvider.ts → providerStore.setScannedSkills()

  导入 → providerStore.importSkills()
  → ws-client.send({ type: 'config.setSkill', payload: { skill } })
    → sidecar server.ts → config-store.saveSkills()
    → 写入 .xyz-agent/skills.json
    ← WS: config.skillUpdated + config.skills（广播）
  ← useProvider.ts → providerStore.setSkills()
```

### 2.2 Slash Command 触发 Skill（已实现前端，**不完整**）

```
[用户输入 "/" ]
  ChatInput.vue → watch(text) → slashVisible = true, slashFilter = text.slice(1)
  → filteredCommands = filterCommands(mergeSkillCommands(providerStore.skills), slashFilter)
  → SlashMenu.vue 显示匹配的命令列表

[用户选择 skill 命令]
  SlashMenu @select → ChatInput.handleSlashSelect(cmd)
  → cmd.action.type === 'skill'
  → activeCommand = cmd（显示标签栏）

[用户点击发送 / 按 Enter]
  ChatInput.handleSend()
  → cmd.action.type === 'skill'
  → content = `/skill:${cmd.name} ${trimmed}`
  → emit('send', { content, skillName: cmd.name })

  ChatPanel @send → PaneSessionView.handleSend()
  → chatStore.addMessage({ ..., skillName: payload.skillName })
  → sendMessage(payload.content)  // ← 只传 content 文本！

  useChat.sendMessage(content)
  → send({ type: 'message.send', payload: { sessionId, content } })

  sidecar server.ts → session-pool.sendMessage(sessionId, content)
  → rpc-client.prompt(content)  // ← content = "/skill:code-trace ..."
    → pi stdin: { type: 'prompt', message: '/skill:code-trace ...' }
```

### 2.3 内置命令（已完整实现）

```
/clear → ChatInput → action.type === 'local' → handler(ctx) → ctx.onLocalAction('clear')
  → PaneSessionView.handleLocalAction → chatStore.clearMessages()

/compact → ChatInput → action.type === 'protocol' → emit('send-command', { type: 'session.compact' })
  → PaneSessionView.handleSendCommand → send({ type: 'session.compact', ... })
  → sidecar → session-pool.compact() → rpc-client.compact()

/help → ChatInput → action.type === 'local' → handler(ctx) → ctx.onLocalAction('help', commands)
  → PaneSessionView.handleLocalAction → chatStore.addMessage({ systemType: 'done', ... })
```

---

## 3. 实现状态矩阵

| 功能 | 状态 | 说明 |
|------|------|------|
| Skill 磁盘扫描 | ✅ 已实现 | `skill-scanner.ts` 扫描 3 个源目录，解析 SKILL.md |
| Skill 配置持久化 | ✅ 已实现 | `.xyz-agent/skills.json`，CRUD 完整 |
| Skill 设置 UI | ✅ 已实现 | SkillsPane + SkillSection + SkillModal |
| Skill 列表 → SlashMenu | ✅ 已实现 | `mergeSkillCommands()` 合并 skill 到命令列表 |
| `/` 输入触发自动补全 | ✅ 已实现 | ChatInput watch text → SlashMenu |
| Skill 选择后标签展示 | ✅ 已实现 | activeCommand 标签栏 + MessageBubble skillName 标签 |
| Skill 内容传递给 pi | ❌ **未实现** | 只传 `/skill:name` 前缀文本，skill SKILL.md 内容未注入 |
| pi 端 skill 协议支持 | ❌ **未知/待确认** | pi RPC 没有 skill 专用命令，依赖 prompt 文本传递 |
| Agent 扫描/管理 | ✅ 已实现 | agent-scanner + AgentSection + AgentModal |
| Agent 在聊天中的使用 | ❌ 未实现 | 无 agent 选择/切换的聊天入口 |

---

## 4. 关键架构洞察

### 4.1 Skill 传递给 pi 的当前方式（有缺陷）

当前实现将 skill 触发编码为 `/skill:skill-name user text` 纯文本前缀，通过 `prompt()` 发送给 pi。pi 收到的只是一段文本，**没有任何 skill 元数据或 SKILL.md 内容**。

这意味着：
- pi 不会自动加载 skill 的 SKILL.md 内容作为上下文
- `/skill:xxx` 前缀只是给 pi 的一个"提示"，但 pi 并不知道它意味着什么
- 要让 skill 真正生效，需要将 SKILL.md 内容注入到发送给 pi 的消息中

### 4.2 SlashMenu 的交互设计

SlashMenu 支持两种选择模式：
- **protocol/local 类型**（clear/compact/help）：选择后立即执行，不需用户输入额外内容
- **skill 类型**：选择后保留标签栏，等待用户输入附加文本，再发送

### 4.3 命令注册机制

`useSlashCommands` 使用模块级 `ref` 管理内置命令，通过 `initDefaultCommands()` 注册 3 个内置命令（clear/compact/help）。Skill 命令通过 `mergeSkillCommands()` 动态合并，每次 `providerStore.skills` 变化时自动更新。

### 4.4 数据流中的关键边界

| 边界 | 协议 | Skill 处理 |
|------|------|-----------|
| 前端 ↔ Sidecar | WS (JSON) | skill CRUD 通过 config.* 协议完整实现 |
| Sidecar ↔ pi | RPC (JSONL stdin/stdout) | **无 skill 协议**，只有 `prompt` 文本 |
| pi 内部 | LLM 调用 | 取决于 prompt 内容是否包含 skill 上下文 |

---

## 5. 待确认问题

1. **pi 是否支持 skill 协议？** — 需要确认 pi 的 RPC 模式是否有专门的 skill 加载命令（如 `load_skill`、`set_skills` 等），还是完全依赖 prompt 文本
2. **Skill 内容注入点** — 如果需要注入 SKILL.md 内容，最佳注入点是 sidecar 的 `session-pool.sendMessage()` 方法（在调用 `client.prompt()` 之前拼装内容）
3. **Skill 触发词匹配** — skill-scanner 已从 description 中提取触发词（triggers），但前端 ChatInput 只在用户显式输入 `/` 时触发 SlashMenu，没有做自然语言触发词匹配
4. **Skill 的 /skill: 前缀约定** — 这是 xyz-agent 自定义的约定还是 pi 识别的协议？需要确认

---

## 6. 文件依赖关系图

```
[聊天输入链路]
ChatInput.vue
  ├── useSlashCommands.ts (mergeSkillCommands, filterCommands)
  │     └── providerStore.skills (SkillInfo[])
  ├── SlashMenu.vue (UI 下拉菜单)
  └── ModelPicker.vue (模型选择)

[事件处理链路]
ChatInput @send
  → ChatPanel.vue (透传)
  → PaneSessionView.vue (handleSend / handleSendCommand / handleLocalAction)
    ├── useChat.sendMessage() → ws-client → sidecar → pi
    └── chatStore (addMessage / clearMessages)

[Skill 配置链路]
SkillsPane.vue
  → providerStore.scanSkillsAction() → ws-client → sidecar server
  → skill-scanner.ts → 磁盘扫描
  → config-store.ts → skills.json 持久化
  ← useProvider.ts → providerStore.setSkills()
```
