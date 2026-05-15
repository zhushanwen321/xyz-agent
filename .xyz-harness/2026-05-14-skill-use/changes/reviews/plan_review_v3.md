# 计划评审 v3 — 前一轮误操作后的现状校准

## 评审记录
- 评审时间：2026-05-14
- 评审类型：计划评审（前一轮误操作后重新校准）
- 评审对象：`.xyz-harness/2026-05-14-skill-use/spec.md` + `plan.md`
- 评审轮次：第 3 轮
- 评审背景：v2 已通过，但代码已在前一轮误操作中部分/全部实现并 commit，需重新评估 plan 是否反映代码库现状

---

## 一、各 Task 实现状态逐项验证

### Task 1: Sidecar 层传递 `--skill` 参数给 pi 进程 — ✅ 已实现

| 验证项 | 文件 | 行号 | 状态 |
|--------|------|------|------|
| `RpcClientOptions` 增加 `skillPaths?: string[]` | `rpc-client.ts` | L21 | ✅ 已存在 |
| `RpcClient.start()` 追加 `--skill` 参数到 spawn args | `rpc-client.ts` | L59-61 | ✅ 已存在，遍历 skillPaths 逐个 push `--skill <path>` |
| `ProcessManager.createSession()` 透传 options | `process-manager.ts` | L99-111 | ✅ 已存在，`new RpcClient({ cwd, ...options, env: ... })` |
| `SessionPool.create()` 读取 skill 列表并传递路径 | `session-pool.ts` | L113 | ✅ 已存在，调用 `this.getSkillPaths(sessionCwd)` |
| `getSkillPaths()` 私有方法 | `session-pool.ts` | L547-553 | ✅ 已存在，`loadSkills()` → filter enabled → `dirname(sourcePath)` → `existsSync()` 过滤 |

### Task 2: 前端 SlashMenu 增加参数提示 — ✅ 已实现

| 验证项 | 文件 | 行号 | 状态 |
|--------|------|------|------|
| `SlashCommand` 类型增加 `argumentHint?: string` | `useSlashCommands.ts` | L18 | ✅ 已存在 |
| `mergeSkillCommands()` 中 `argumentHint: undefined` | `useSlashCommands.ts` | L52 | ✅ 已存在（预留字段，不提取） |
| SlashMenu 渲染 argumentHint 条件展示 | `SlashMenu.vue` | L31-33 | ✅ 已存在，`v-if="cmd.argumentHint"` |

### Task 3: 选择 skill 后输入框预构建参数 — ✅ 已实现

| 验证项 | 文件 | 行号 | 状态 |
|--------|------|------|------|
| placeholder 动态计算 | `ChatInput.vue` | L112-118 | ✅ 已存在，skill 时返回 `'编辑参数后发送…'` / `'输入附加文本…'` |
| `handleSlashSelect()` 中预填 argumentHint | `ChatInput.vue` | L187-188 | ✅ 已存在，`if (cmd.action.type === 'skill' && cmd.argumentHint)` |

### Task 4: Session 恢复时传递 skill 路径 — ✅ 已实现

| 验证项 | 文件 | 行号 | 状态 |
|--------|------|------|------|
| `restoreSession()` 调用 `getSkillPaths(target.cwd)` | `session-pool.ts` | L466 | ✅ 已存在 |

### Task 5: 自动化测试 — ✅ 已实现

| 验证项 | 文件 | 状态 |
|--------|------|------|
| `skill-paths.test.ts` 存在 | `sidecar/test/skill-paths.test.ts` | ✅ 文件存在 |
| 7 个测试用例全部通过 | — | ✅ `vitest run` 报告 7 passed |

测试覆盖场景：
1. `RpcClient` 正确传递 `--skill` 参数 ✅
2. `RpcClient` 空 skillPaths 不传参数 ✅
3. `RpcClient` undefined skillPaths 不传参数 ✅
4. `SessionPool.create()` 收集 enabled skill 目录 + 跳过不存在路径 ✅
5. 无 enabled skill 时不传 `--skill` ✅
6. 空 sourcePath 的 skill 被跳过 ✅
7. `restoreSession()` 正确传递 skillPaths ✅

### Task 6: 端到端验证 — ⬜ 未实现（手动测试，无代码变更）

这是手动验证任务，无代码变更，在 Phase 2 执行阶段执行。

---

## 二、Plan 与代码库现状的一致性分析

### 核心问题：plan 描述的是"从零开始"的实现，但代码已经写好了

plan 的每个 Task 都用"改造"、"增加"、"修改"等动词描述待做的工作，但实际代码已经完整实现。plan 作为执行指导文档，**文件变更表中的"操作"列全部标注为"修改"，与实际情况（代码已存在）不符**。

### 问题列表

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | `plan.md` Task 1-5 文件变更表 | 所有 Task 的文件变更表标注"操作: 修改/新增"，但代码已 commit。执行 agent 按 plan 操作时可能重复实现或产生冲突 | plan 应在每个 Task 开头标注实际状态（✅/🔧/⬜），文件变更表改为"验证"而非"修改"。剩余工作仅为 Task 6 的手动端到端验证 |
| 2 | LOW | `plan.md` Task 5 测试场景 | plan 描述 5 个测试场景，但实际实现了 7 个测试（多了 `skillPaths: undefined` 和 `empty sourcePath` 两个边界用例） | 更新 Task 5 描述以反映实际测试场景数量，或标注"至少覆盖以下场景" |
| 3 | LOW | `plan.md` Task 3 描述 | 描述了"预填 argumentHint 作为占位提示或默认文本"和"使用 textarea 的 placeholder 属性"两种方案，实际实现同时使用了两种：placeholder 动态展示提示文字 + 预填文本。与 plan 描述有偏差但行为更合理 | 更新 Task 3 描述以反映实际的双策略实现：placeholder 展示提示 + argumentHint 预填文本 |
| 4 | LOW | `plan.md` Task 2 风险点 | 风险点提到"不同 skill 的 description 格式差异大，参数提取不准确 → 已决定不做提取，预留字段即可"。实际实现确实如此。但 `argumentHint` 字段当前永远为 `undefined`，SlashMenu 的 `v-if` 永远不触发，相当于死代码 | plan 可补充说明 argumentHint 的实际数据源将在未来由 SKILL.md frontmatter 扩展字段或用户手动配置填充。当前阶段该功能为"预留接口" |

---

## 三、spec 合规性验证（针对已实现代码）

尽管 plan 已在 v2 通过，但因代码已实现，需反向验证实现是否符合 spec：

| Spec 验收标准 | 代码实现 | 合规 |
|--------------|---------|------|
| AC1: pi 进程启动时传递所有 enabled skill 的 `--skill` 路径参数 | `rpc-client.ts` L59-61，`session-pool.ts` L113+L466+L547 | ✅ |
| AC2: SlashMenu 中 skill 命令展示名称、描述和参数提示 | `SlashMenu.vue` L31-33 条件渲染，`useSlashCommands.ts` L18 预留字段 | ✅（argumentHint 预留，当前无数据源，UI 上不显示，不违反 spec） |
| AC3: 选择 skill 后输入框预填 `/skill:name ` 文本 | `ChatInput.vue` L112-118 placeholder + L187-188 预填 | ✅ |
| AC4: 发送 `/skill:name text` 后 pi 正确展开 skill 内容 | 由 Task 1 的 `--skill` 参数机制保证，pi 端 `_expandSkillCommand()` 机制已验证 | 需端到端验证（Task 6） |
| AC5: 新创建的 session 使用更新后的 skill 列表 | `getSkillPaths()` 每次调用 `loadSkills()` 读最新配置 | ✅ |
| AC6: 无 enabled skill 时 SlashMenu 仅展示内置命令 | `mergeSkillCommands()` 先 filter `s.enabled`，无 skill 时 skillCmds 为空 | ✅ |

### Spec 行为约束验证

| 约束 | 代码实现 | 合规 |
|------|---------|------|
| Always: 使用 pi 已有的 `_expandSkillCommand()` | sidecar 层不读取 SKILL.md，只传 `--skill` 参数 | ✅ |
| Always: 传所有 enabled skill 的 sourcePath（目录路径） | `dirname(s.sourcePath!)` | ✅ |
| Always: SlashMenu 中 skill 和内置命令视觉区分 | `cmd.source === 'builtin' ? 'command' : 'skill'` 标签 | ✅ |
| Never: sidecar 层不读取 SKILL.md 内容 | 未发现 SKILL.md 读取代码 | ✅ |
| Never: 不修改 pi 源码 | 未涉及 pi 源码 | ✅ |
| Never: 不硬编码 skill 列表 | 从 `providerStore.skills` 动态获取 | ✅ |

---

## 四、结论

plan 的 v2 内容已经过充分评审（spec 完整、plan 可行、一致性正确），代码实现与 spec 高度一致。**核心问题是 plan 文档描述的是"待实现"状态，但代码已经实现**。

### MUST FIX: 无

所有 spec 需求已正确实现，测试通过，无架构违规。

### 下一步建议

plan 需要更新以反映"大部分已实现"的现实：
1. 每个 Task 标注实际状态（✅/⬜）
2. 已实现 Task 的描述从"改造为..."改为"已实现，验证..."
3. 剩余工作仅为 Task 6（手动端到端验证）+ 代码验证

这样 Phase 2 的执行 agent 不会重复实现已有代码。

---

### 结论

通过（附带建议：更新 plan 反映实现现状）

### Summary

计划评审 v3 完成，第3轮。0 条 MUST FIX，4 条 LOW。Task 1-5 已全部实现并测试通过，剩余 Task 6（手动端到端验证）。plan 文档需更新以反映代码已实现的现状，避免执行 agent 重复工作。
