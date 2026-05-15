# Skill Slash 命令使用 — 实现计划

复杂度：**L1**（改动集中，无数据库，无复杂 API）

## 实现状态总览

> **重要：Task 1-5 已在前一轮编码中实现。Phase 2 agent 的主要任务是验证 + 补充 argumentHint 数据源。**

| Task | 状态 | 说明 |
|------|------|------|
| Task 1: Sidecar 传 --skill | ✅ 已实现 | rpc-client + process-manager + session-pool |
| Task 2: SlashMenu argumentHint | ✅ 已实现 | UI 组件就绪，argumentHint 恒为 undefined |
| Task 3: ChatInput 预填参数 | ✅ 已实现 | placeholder + 预填逻辑 |
| Task 4: restoreSession 传 skill | ✅ 已实现 | 同 Task 1 链路 |
| Task 5: 自动化测试 | ✅ 已实现 | 7 个用例全部通过 |
| Task 6: 手动 E2E 验证 | ⬜ 未执行 | 按 e2e-test-plan.md |
| Task 7: argumentHint 数据源 | ✅ 已实现 | skill-scanner.ts L55-58, shared/provider.ts L30/L49, stores/provider.ts L63, useSlashCommands.ts L51 |

---

### Task 1: Sidecar 层传递 `--skill` 参数给 pi 进程 — ✅ 已实现

### 描述
Sidecar 层已实现 pi 进程启动时传递 skill 路径。

**已实现的代码：**

`src-electron/sidecar/src/rpc-client.ts`:
- `RpcClientOptions` 接口包含 `skillPaths?: string[]`（L21）
- `start()` 方法遍历 skillPaths 追加 `--skill <path>` 到 spawn args（L59-61）

`src-electron/sidecar/src/process-manager.ts`:
- `createSession()` 透传 `options?: RpcClientOptions` 给 RpcClient（L99-111）

`src-electron/sidecar/src/session-pool.ts`:
- `getSkillPaths(cwd)` 私有方法（L547-553）：从 `loadSkills(cwd)` 获取 enabled skill → `filter(enabled && sourcePath)` → `map(dirname(sourcePath))` → `filter(existsSync)`
- `create()` 调用 `this.pm.createSession(id, sessionCwd, { skillPaths: this.getSkillPaths(sessionCwd) })`（L113）
- `restoreSession()` 调用 `this.pm.createSession(id, target.cwd, { skillPaths: this.getSkillPaths(target.cwd) })`（L466）

### 验收标准
- [x] `RpcClient.start()` 在 spawn args 中包含 `--skill <path>` 参数
- [x] 只传 enabled skill 的路径
- [x] 无 enabled skill 时不传 `--skill` 参数
- [x] sourcePath 不存在的 skill 被跳过
- [x] `create()` 和 `restoreSession()` 都传递 skill 路径
- [x] 路径传的是 `dirname(sourcePath)`（目录路径）

---

### Task 2: 前端 SlashMenu 增加参数提示 — ✅ 已实现（UI 就绪）

### 描述
SlashCommand 类型已增加 argumentHint 字段，SlashMenu 已有条件渲染。

**已实现的代码：**

`src-electron/renderer/src/composables/useSlashCommands.ts`:
- `SlashCommand` 接口包含 `argumentHint?: string`（L18）
- `mergeSkillCommands()` 中 `argumentHint: undefined`（L52），有 TODO 注释

`src-electron/renderer/src/components/chat/SlashMenu.vue`:
- 条件渲染 `v-if="cmd.argumentHint"` 展示参数提示标签（L31-33）

### 验收标准
- [x] SlashCommand 类型增加可选的 argumentHint 字段
- [x] SlashMenu 中有 argumentHint 的命令项展示参数提示标签
- [x] 无 argumentHint 时展示不受影响
- [x] 内置命令不受影响

---

### Task 3: 选择 skill 后输入框预构建参数 — ✅ 已实现

### 描述
ChatInput 已实现动态 placeholder 和 argumentHint 预填。

**已实现的代码：**

`src-electron/renderer/src/components/chat/ChatInput.vue`:
- `placeholder` computed（L112-118）：skill 模式返回 `'编辑参数后发送…'` / `'输入附加文本…'`
- `handleSlashSelect()`（L187-188）：`if (cmd.argumentHint) text.value = cmd.argumentHint`
- `clearCommand()`（L158-160）：重置 `activeCommand` 和 `text`

### 验收标准
- [x] 选中有 argumentHint 的 skill 后，textarea 预填 argumentHint 文本
- [x] 选中无 argumentHint 的 skill 后，placeholder 变为通用提示
- [x] 取消 skill 标签后恢复默认状态

---

### Task 4: Session 恢复时传递 skill 路径 — ✅ 已实现

### 描述
restoreSession 已调用 getSkillPaths(target.cwd)。

### 验收标准
- [x] `restoreSession()` 创建的 pi 进程也传递 skill 路径

---

### Task 5: 自动化测试 — ✅ 已实现

### 描述
`src-electron/sidecar/test/skill-paths.test.ts` 包含 7 个测试用例，全部通过。

### 验收标准
- [x] RpcClient passes --skill args（正常）
- [x] RpcClient omits --skill (empty array)
- [x] RpcClient omits --skill (undefined)
- [x] getSkillPaths filters enabled/disabled/non-existent
- [x] No enabled skills returns empty
- [x] Empty sourcePath skipped
- [x] restoreSession passes skillPaths

---

### Task 6: 手动端到端验证 — ⬜ 未执行

### 描述
按 `.xyz-harness/2026-05-14-skill-use/e2e-test-plan.md` 执行手动端到端测试。验证完整链路：从 SlashMenu 选择 skill → 输入参数 → 发送 → pi 展开 SKILL.md → LLM 回复体现 skill 上下文。

### 验收标准
- [ ] 完整链路通畅，无崩溃
- [ ] pi 的 LLM 回复体现 skill 上下文被加载
- [ ] 无 enabled skill 时正常工作

### 风险点
- 需要本地 pi 进程可运行且有有效 API key
- E2E 测试依赖 sidecar 进程和前端 dev server 同时运行
- skill 路径必须存在（测试用 SKILL.md 需预先准备好）

---

### Task 7: argumentHint 数据源提取 — ✅ 已实现

### 描述
argumentHint 完整数据链路已实现：从 SKILL.md frontmatter 的 `argument-hint` 字段提取，经 scanner → shared 类型 → store 透传 → SlashMenu/ChatInput 消费。

**官方定义**（Anthropic 官方文档）：`argument-hint` 是 SKILL.md frontmatter 中的标准可选字段，在 autocomplete 中展示占位符提示，告诉用户应输入什么参数。

**已实现的方案**：
- ✅ `parseSkillMd()` 从 YAML frontmatter 提取 `argument-hint` 字段（skill-scanner.ts L55-58）
- ✅ `ScannedSkillInfo` 和 `SkillInfo` 已包含 `argumentHint?: string`（shared/provider.ts L30/L49）
- ✅ `importSkills()` 已透传 `argumentHint`（stores/provider.ts L63）
- ✅ `mergeSkillCommands()` 已使用 `s.argumentHint`（useSlashCommands.ts L51）

### 文件变更
| 文件 | 操作 | 说明 |
|------|------|------|
| `src-electron/sidecar/src/skill-scanner.ts` | 已修改 | `parseSkillMd()` 新增 `argument-hint` 正则提取 |
| `src-electron/shared/src/provider.ts` | 已修改 | `ScannedSkillInfo` 和 `SkillInfo` 新增 `argumentHint?: string` |
| `src-electron/renderer/src/stores/provider.ts` | 已修改 | `importSkills()` 透传 `argumentHint` |
| `src-electron/renderer/src/composables/useSlashCommands.ts` | 已修改 | `mergeSkillCommands()` 使用 `s.argumentHint` |

### 验收标准
- [x] `parseSkillMd()` 从 frontmatter 提取 `argument-hint` 字段（skill-scanner.ts L55-58）
- [x] `ScannedSkillInfo` 接口包含 `argumentHint?: string`（shared/provider.ts L30）
- [x] `SkillInfo` 接口包含 `argumentHint?: string`（shared/provider.ts L49）
- [x] `importSkills()` 透传 argumentHint（stores/provider.ts L63）
- [x] `mergeSkillCommands()` 使用 `s.argumentHint`（useSlashCommands.ts L51）
- [x] frontmatter 无 `argument-hint` 时保持 `undefined`
- [x] SlashMenu 中 skill 项展示参数提示（如有 argumentHint）

### 风险点
- 已有 skill 的 frontmatter 可能没有 `argument-hint` 字段 → 兼容处理：保持 undefined，不影响 UI
- `parseSkillMd()` 是手写 YAML 解析器，不支持嵌套 YAML → `argument-hint` 是简单的 key: value，无嵌套风险
- 需要重启 sidecar 才能看到新 skill 的 argumentHint（Settings 页面执行 scan 后生效）
