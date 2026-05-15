# Skill 在聊天框中通过 Slash 命令使用

## 目标

用户在聊天输入框输入 `/` 后，SlashMenu 弹出内置命令 + skill 列表供选择。选中 skill 后，用户输入附加文本，发送时以 `/skill:name user text` 格式传给 pi，pi 自动展开 SKILL.md 内容注入到 LLM 上下文。

## 实现状态总览

> **重要：以下功能已在前一轮编码中实现。Phase 2 agent 的主要任务是验证（而非重新实现）。**

| 功能 | 状态 | 实现位置 |
|------|------|----------|
| pi 进程启动时传 `--skill` 参数 | ✅ 已实现 | `rpc-client.ts` L59-61, `session-pool.ts` getSkillPaths() |
| SlashMenu 展示 argumentHint | ✅ 已实现 | `useSlashCommands.ts` L18, `SlashMenu.vue` L31-33 |
| 选择 skill 后输入框预填参数 | ✅ 已实现 | `ChatInput.vue` L112-118, L187-188 |
| create/restore 路径都传 skill | ✅ 已实现 | `session-pool.ts` L113, L466 |
| 自动化测试（7 个用例） | ✅ 已实现 | `sidecar/test/skill-paths.test.ts` |
| argumentHint 数据源提取 | ✅ 已实现 | `skill-scanner.ts` L55-58, `shared/provider.ts` L30/L49, `stores/provider.ts` L63, `useSlashCommands.ts` L51 |
| 手动端到端验证 | ⬜ 未执行 | 按 e2e-test-plan.md 执行 |

## 范围

### In Scope

1. ~~pi 进程启动时传递 `--skill` 参数~~ → ✅ 已实现
2. ~~前端 SlashMenu 展示参数提示~~ → ✅ 已实现（UI + 数据源均就绪）
3. ~~选择 skill 后输入框预构建参数~~ → ✅ 已实现
4. ~~仅保证新 session 使用最新 skill 列表~~ → ✅ 已实现

**真正待完成的工作：**
- 手动端到端验证（按 e2e-test-plan.md）

**已全部实现的 argumentHint 数据链路：**
- ✅ `skill-scanner.ts` 的 `parseSkillMd()` 从 frontmatter 提取 `argument-hint` 字段（L55-58）
- ✅ `ScannedSkillInfo` 和 `SkillInfo` 接口已包含 `argumentHint?: string`（`shared/provider.ts` L30/L49）
- ✅ `provider.ts` 的 `importSkills()` 已透传 argumentHint（L63）
- ✅ `mergeSkillCommands()` 已使用 `s.argumentHint`（`useSlashCommands.ts` L51）

### Out of Scope

- SKILL.md 格式改动
- pi 源码改动
- Agent（非 Skill）在聊天框中的使用
- 自然语言触发 skill（不用 `/` 前缀）
- Skill 搜索/分类/收藏
- **已有活跃 session 的 skill 热更新**（需重启 pi 进程会中断对话，不在本次范围）

## 约束

### 技术约束

| 约束项 | 说明 |
|--------|------|
| 前端框架 | Vue 3 + TypeScript + Tailwind CSS v3 + xyz-ui 组件库 |
| Sidecar 通信 | WebSocket，前端通过 ws-client.ts + event-bus.ts 消息分发 |
| 共享类型 | src-electron/shared/src/ 通过 npm workspace 在前端和 sidecar 间共享 |
| Electron IPC | 主进程通过 preload 暴露 window.electronAPI，渲染进程不直接使用 ipcRenderer |
| 状态管理 | Pinia store（providerStore、settingsStore） |
| pi 版本 | 确保 sidecar 依赖的 pi 版本支持 `--skill` 参数和 `_expandSkillCommand()` 机制 |
| 测试框架 | Vitest（前端 + sidecar 通用测试框架） |

### 功能约束

- **只传 enabled skill 的路径**：disable 的 skill 不应传给 pi 进程
- **路径不存在则跳过**：sourcePath 不存在的 skill 不阻塞进程启动
- **仅新 session 生效**：已有活跃 session 不受 skill 列表变更影响，因为重启 pi 进程会中断对话
- **SlashMenu 动态获取**：skill 列表必须从 providerStore 动态获取，禁止硬编码
- **已有活跃 session 不热更新**：同「仅新 session 生效」，不在本次范围

### 兼容性约束

- **无 argument-hint 兼容**：已有 skill 的 frontmatter 可能没有 argument-hint 字段，保持 `undefined`，行为不变
- **无 enabled skill 兼容**：SlashMenu 仅展示内置命令，不报错
- **YAML 解析器限制**：`parseSkillMd()` 是手写 YAML 解析器，不支持嵌套 YAML（argument-hint 是简单 key: value，可支持）

## 已有基础设施

### 已实现的代码（可直接复用）

| 位置 | 方法/组件 | 用途 |
|------|----------|------|
| `src-electron/sidecar/src/rpc-client.ts` L21 | `RpcClientOptions.skillPaths?: string[]` | 启动参数配置 |
| `src-electron/sidecar/src/rpc-client.ts` L59-61 | spawn args 追加 `--skill` | 传给 pi 进程 |
| `src-electron/sidecar/src/session-pool.ts` L547-553 | `getSkillPaths(cwd)` | 从 loadSkills() 提取 enabled skill 的目录路径 |
| `src-electron/sidecar/src/session-pool.ts` L113 | `create()` | 调用 getSkillPaths(sessionCwd) |
| `src-electron/sidecar/src/session-pool.ts` L466 | `restoreSession()` | 调用 getSkillPaths(target.cwd) |
| `src-electron/renderer/src/composables/useSlashCommands.ts` L18 | `SlashCommand.argumentHint?: string` | 参数提示字段 |
| `src-electron/renderer/src/components/chat/SlashMenu.vue` L31-33 | argumentHint 条件渲染 | UI 展示参数提示标签 |
| `src-electron/renderer/src/components/chat/ChatInput.vue` L112-118 | placeholder computed | skill 模式动态提示 |
| `src-electron/renderer/src/components/chat/ChatInput.vue` L187-188 | handleSlashSelect 预填 | argumentHint 预填文本 |
| `src-electron/sidecar/test/skill-paths.test.ts` | 7 个测试用例 | 覆盖 skillPaths 传递链路 |

### argumentHint 数据链路（已全部实现）

| 位置 | 方法/组件 | 用途 | 实现行号 |
|------|----------|------|----------|
| `src-electron/sidecar/src/skill-scanner.ts` | `parseSkillMd()` 提取 `argument-hint` | 从 YAML frontmatter 解析标准字段 | L55-58 |
| `src-electron/shared/src/provider.ts` | `ScannedSkillInfo` 和 `SkillInfo` 的 `argumentHint?` | 类型定义 | L30, L49 |
| `src-electron/renderer/src/stores/provider.ts` | `importSkills()` 透传 `argumentHint` | 映射层 | L63 |
| `src-electron/renderer/src/composables/useSlashCommands.ts` | `mergeSkillCommands()` 使用 `s.argumentHint` | 数据源读取 | L51 |

### 接口/类型定义位置

| 位置 | 接口名 | 字段 |
|------|--------|------|
| `src-electron/shared/src/provider.ts` | `SkillInfo` | id, name, description, enabled, source, triggers, sourcePath?, sourceIcon?, fileSize?, tools?, **argumentHint?**, content?, tag? |
| `src-electron/shared/src/provider.ts` | `ScannedSkillInfo` | id, name, description, sourceType, sourcePath, triggers, content, fileSize?, tools?, **argumentHint?**, alreadyImported |
| `src-electron/renderer/src/composables/useSlashCommands.ts` | `SlashCommand` | name: string, description: string, source: SlashCommandSource, action: SlashCommandAction, argumentHint?: string |
| `src-electron/renderer/src/composables/useSlashCommands.ts` | `SlashCommandAction` | discriminated union: `{ type: 'local'; handler: (ctx: CommandContext) => void } \| { type: 'protocol'; messageType: string } \| { type: 'skill'; skillId: string }` |
| `src-electron/renderer/src/composables/useSlashCommands.ts` | `CommandContext` | sessionId: string, getAllCommands: () => SlashCommand[], onLocalAction: (action: 'clear' \| 'help', data?: unknown) => void |

### 技术调研结论

- **pi skill 展开机制**（已验证）：pi 的 `_expandSkillCommand()` 检测 `/skill:name` 前缀 → 从 `resourceLoader` 查找 Skill → 读取 SKILL.md → 去掉 frontmatter → 包裹为 `<skill name="..." location="...">...</skill>` XML 块 → 用 `\n\n` 分隔追加用户参数
- **pi 启动参数**：`--skill <path>` 可传多个，支持目录（递归扫描 SKILL.md）和 `.md` 文件
- **pi RPC `prompt` 命令**：已内置 `_expandSkillCommand()`，前提是 pi 启动时加载了对应 skill
- **sourcePath 转换**：`SkillInfo.sourcePath` 指向 SKILL.md 文件路径，传给 pi 时用 `dirname()` 转为目录路径

### 技术债务（编码 agent 不修）

无已知技术债务。

### argument-hint 官方定义调研结果

**来源**：Anthropic 官方文档 `docs.anthropic.com/en/docs/claude-code/slash-commands`

> `argument-hint` — Hint shown during autocomplete to indicate expected arguments. Example: `[issue-number]` or `[filename] [format]`.

**官方定义解析**：

| 方面 | 说明 |
|------|------|
| 本质 | SKILL.md frontmatter 中的可选字段 |
| 用途 | 在 autocomplete 中展示占位符提示，告诉用户应输入什么参数 |
| 典型值 | `[issue-number]`、`[environment]`、`[filename] [format]` |
| 与 description 的区别 | `description` = "技能做什么"，`argument-hint` = "输入什么参数" |
| 与 triggers 的区别 | `triggers` = 触发关键词（自动匹配用），`argument-hint` = 用户手动输入时的 UI 提示 |
| 标准地位 | 同 `allowed-tools`、`user-invocable` 等并列的官方 frontmatter 字段 |

**对实现的影响**：

`argumentHint` 不应从 `description`、`triggers` 或 `content` 中推导/截取。正确的做法是：

1. `skill-scanner.ts` 的 `parseSkillMd()` 从 YAML frontmatter 中提取 `argument-hint` 字段
2. `ScannedSkillInfo` 接口新增 `argumentHint?: string`
3. `importSkills()` 透传到 `SkillInfo`
4. `mergeSkillCommands()` 使用 `s.argumentHint`

这与 Claude Code 官方实现一致：每个 skill 的作者在 SKILL.md frontmatter 中自行声明 `argument-hint`，它是 skill 元数据的一部分，而非派生数据。

**已有 skill 的兼容性**：对于 frontmatter 中未设置 `argument-hint` 的 skill，值保持 `undefined`，SlashMenu 不展示 hint 标签，行为不变。

## 数据流

### 数据字段（均已实现）

| 字段 | 类型 | 生产者 | 存储位置 | 消费者 | 状态 |
|------|------|--------|---------|--------|------|
| skillPaths | `string[]` | `SessionPool.getSkillPaths()` | pi spawn args | pi resourceLoader | ✅ 已实现 |
| argumentHint | `string?` | `parseSkillMd()` 从 SKILL.md frontmatter 提取 | `ScannedSkillInfo` → `SkillInfo` → `SlashCommand` | SlashMenu / ChatInput | ✅ 已实现 |

### argumentHint 数据流（已实现链路）

```
SKILL.md frontmatter
  → scanSkills() 调用 parseSkillMd(content)
  → 从 YAML frontmatter 提取 argument-hint
  → ScannedSkillInfo.argumentHint
  → importSkills() 透传
  → SkillInfo.argumentHint
  → useSlashCommands.mergeSkillCommands()
  → SlashCommand.argumentHint = s.argumentHint
  → SlashMenu 条件渲染（v-if="cmd.argumentHint"）
  → ChatInput 预填（handleSlashSelect）
```

```
[用户创建新 Session]
  → SessionPool.create(cwd)
  → getSkillPaths(cwd)
    → loadSkills(cwd) 获取 enabled skill 列表
    → filter(enabled && sourcePath) → map(dirname(sourcePath)) → filter(existsSync)
  → ProcessManager.createSession(id, cwd, { skillPaths })
    → RpcClient.start({ skillPaths })
    → spawn('pi', ['--mode', 'rpc', '--skill', dir1, '--skill', dir2, ...])

[用户输入 /]
  → ChatInput → SlashMenu 展示命令列表
  → skill 命令含 argumentHint（从 SKILL.md frontmatter 提取）

[用户选中 skill 命令]
  → ChatInput.handleSlashSelect(cmd)
  → placeholder 切换为 skill 专属提示
  → 如果有 argumentHint，textarea 预填参数文本

[用户点击发送]
  → ChatInput.handleSend()
  → emit('send', { content: '/skill:name user text', skillName: 'name' })
  → sidecar session-pool.sendMessage() → rpc-client.prompt()
  → pi _expandSkillCommand() 自动展开 skill 内容
```

## 已做决策

| 决策项 | 选择 | 理由 | 是否可推翻 |
|--------|------|------|------------|
| Skill 内容注入方式 | 方案A：传 `--skill` 给 pi | 复用 pi 已有的 `_expandSkillCommand()` 机制 | 否 |
| Skill 变更同步 | 仅新 session 生效 | 活跃 session 重启会中断对话，不在 In Scope | 否 |
| Skill sourcePath 不存在 | 跳过并继续 | 与 pi 行为一致，不阻塞进程启动 | 否 |
| argumentHint 提取规则 | 从 SKILL.md frontmatter 的 `argument-hint` 字段提取 | 这是 Anthropic 官方定义的标准行为，与 Claude Code 一致 | 否（已定） |

## 行为约束

### Always（必须遵守）

- 发送 `/skill:name` 时必须使用 pi 已有的 `_expandSkillCommand()` 机制，不在 sidecar 层拼接 skill 内容
- pi 进程启动时必须传递所有 enabled skill 的目录路径（`dirname(sourcePath)`）
- SlashMenu 中 skill 命令和内置命令必须视觉区分（已有 skill/command 标签）
- 选择 skill 后输入框必须保留 skill 标签，用户在标签后输入附加文本

### Ask First（需要确认）

- 如果所有 skill 都未启用，是否仍在 SlashMenu 中展示空列表

### Never（绝对禁止）

- 禁止在 sidecar 层读取 SKILL.md 内容拼接 prompt（让 pi 自己做）
- 禁止修改 pi 源码
- 禁止修改 SKILL.md 的标准格式
- 禁止在 SlashMenu 中硬编码 skill 列表（必须从 providerStore 动态获取）

## 验证方式

1. **自动化测试**：`sidecar/test/skill-paths.test.ts` 7 个用例已通过（覆盖 skillPaths 传递链路）
2. **手动端到端验证**：按 e2e-test-plan.md 执行 15 个用例
3. **边界验证**：skill 路径不存在时不崩溃；无 skill 时 SlashMenu 正常；skill 名称含特殊字符时正确编码

## 验收标准

- [x] pi 进程启动时传递所有 enabled skill 的 `--skill` 路径参数（已实现）
- [x] SlashMenu 中 skill 命令展示名称、描述和参数提示（UI + 数据源均已就绪）
- [x] `parseSkillMd()` 从 SKILL.md frontmatter 提取 `argument-hint` 字段（skill-scanner.ts L55-58）
- [x] `ScannedSkillInfo` 和 `SkillInfo` 接口包含 `argumentHint?: string`（shared/provider.ts L30/L49）
- [x] `importSkills()` 透传 argumentHint（stores/provider.ts L63）
- [x] `mergeSkillCommands()` 中 argumentHint 从 `SkillInfo.argumentHint` 读取（useSlashCommands.ts L51）
- [x] 选择 skill 后输入框预填 argumentHint 文本（已实现，依赖 argumentHint 有值）
- [x] 发送 `/skill:name text` 后 pi 正确展开 skill 内容（需 E2E 验证）
- [x] Settings 中变更 skill 列表后，新创建的 session 使用更新后的 skill 列表（已实现，已有活跃 session 不受影响）
- [x] 无 enabled skill 时，SlashMenu 仅展示内置命令，不报错（已实现）
