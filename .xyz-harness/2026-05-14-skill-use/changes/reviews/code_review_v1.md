# Code Review v1

## 评审记录
- 评审时间：2026-05-14 23:35
- 评审类型：编码评审（Phase 2 阶段④）
- 评审对象：feat-skill-use 的 3 个 commit（4ad1ce8^..HEAD）
- 评审轮次：第 1 轮

## 评审范围

3 个 commit，7 个变更文件：

| Commit | 描述 | 变更文件 |
|--------|------|---------|
| `4ad1ce8` | feat(chat): pre-build skill args in ChatInput after slash selection | ChatInput.vue |
| `c1f581f` | test(sidecar): add skillPaths passing chain tests (Task 5) | test/skill-paths.test.ts, vitest.config.ts, package.json, tsconfig.json |
| `796e29e` | feat(chat): extract argumentHint from SkillInfo.description | useSlashCommands.ts |

## 发现的问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | **MUST FIX** | 数据语义 | `useSlashCommands.ts` L51 | `argumentHint: s.description` 错误地从 description 字段取值，而非从 `s.argumentHint`（SKILL.md frontmatter 的 `argument-hint` 字段）。spec 明确要求"argumentHint 不应从 description、triggers 或 content 中推导/截取"。 | 改为 `argumentHint: s.argumentHint` |
| 2 | LOW | 代码质量 | `useSlashCommands.ts` L51 | `argumentHint: s.argumentHint,` 缩进 4 空格，上下文 `.map()` 回调体用 8 空格。ESLint 已报警告。 | 改为 8 空格缩进 |
| 3 | LOW | 代码质量 | `ChatInput.vue` L35 | `:placeholder="placeholder"` 缩进 4 空格，前后属性（v-model、class）均为 8 空格。 | 改为 8 空格缩进 |
| 4 | LOW | 代码质量 | `ChatInput.vue` L112-119 | `placeholder` computed 块整体缩进异常：L119 的 `})` 缩进 2 空格但 L112 的 `const placeholder = computed(() => {` 在 0 空格。L115-116 的三元表达式 `?` / `:` 与 `return` 同列（4 空格），不符合常规对齐。 | 修正整个 computed 块缩进为一致的层级关系 |
| 5 | LOW | 代码质量 | `ChatInput.vue` L184-189 | `else` 分支体缩进 2 空格，应为 4 空格（`else` 在 2 空格层级，体应在 4 空格）。 | `activeCommand.value = cmd` 和内部 `if` 块缩进改为 4/6 空格 |

## 详细分析

### 问题 #1：argumentHint 数据源错误（MUST FIX）

**现状**：`useSlashCommands.ts` L51

```typescript
argumentHint: s.description,
```

**影响链路**：

1. **ChatInput 预填错误**：用户选中任意 skill 后，`handleSlashSelect()` 执行 `text.value = cmd.argumentHint`。由于 `argumentHint` 实际是 `description`，用户会在输入框看到 skill 的描述文字（如"使用 Qwen Code 无头模式执行快速代码改动"）而非参数提示（如 `[filename]`）。

2. **Placeholder 逻辑失效**：`placeholder` computed 的条件 `activeCommand.value.argumentHint` 几乎永远为 truthy（几乎所有 skill 都有 description），导致"输入附加文本…"分支永远不会触发，所有 skill 都显示"编辑参数后发送…"。

3. **SlashMenu 标签错误**（未在本次 commit 中，但在工作区已实现）：SlashMenu 的 `v-if="cmd.argumentHint"` 会为所有 skill 显示 argumentHint 标签，内容是 description 而非真正的参数提示。

**spec 违反**：spec "已做决策"表格明确声明：

> argumentHint 不应从 description、triggers 或 content 中推导/截取。正确的做法是从 SKILL.md frontmatter 的 argument-hint 字段提取。

spec "验收标准"第 6 条：

> mergeSkillCommands() 中 argumentHint 从 SkillInfo.argumentHint 读取

**数据流现状**（已实现但被此 bug 绕过）：

```
skill-scanner.ts parseSkillMd() → ScannedSkillInfo.argumentHint
→ stores/provider.ts importSkills() → SkillInfo.argumentHint
→ useSlashCommands.ts mergeSkillCommands() → 此处应读 s.argumentHint 但读了 s.description
```

**修复**：一行改动。

```diff
-        argumentHint: s.description,
+        argumentHint: s.argumentHint,
```

### 问题 #2-5：缩进不一致（LOW）

共 4 处缩进问题，集中在 ChatInput.vue 和 useSlashCommands.ts。均为代码提交时格式未对齐项目标准。ESLint 对 useSlashCommands.ts L51 有 warning（`Expected indentation of 8 spaces but found 4`），ChatInput.vue 的模板属性缩进未被 lint 规则覆盖。

这些不影响功能，但降低代码可读性。建议用 `eslint --fix` 或手动修正。

## 维度评估

### 1. Spec 合规性

| 验收标准 | 状态 | 说明 |
|---------|------|------|
| pi 进程启动时传 --skill 路径 | ✅ 通过 | 3 个 commit 前已实现，测试验证链路正确 |
| SlashMenu 展示参数提示 | ⚠️ 部分通过 | 数据源错误（#1），展示逻辑在 SlashMenu.vue 中但不在本次 commit 内 |
| parseSkillMd() 提取 argument-hint | ✅ 通过 | 非本次 commit 变更，已存在 |
| ScannedSkillInfo/SkillInfo 含 argumentHint | ✅ 通过 | 非本次 commit 变更，已存在 |
| importSkills() 透传 argumentHint | ✅ 通过 | 非本次 commit 变更，已存在 |
| **mergeSkillCommands() 用 s.argumentHint** | **❌ 不通过** | **用了 s.description（#1）** |
| 选择 skill 后预填 argumentHint | ⚠️ 预填逻辑正确，但数据源错 | 逻辑对、数据错 |
| 无 skill 时仅展示内置命令 | ✅ 通过 | mergeSkillCommands 过滤 enabled |

### 2. 代码质量

- TypeScript 类型安全：✅ 无 any，类型正确
- 错误处理：✅ 无新增错误路径
- 命名规范：✅ argumentHint 命名与 spec 一致
- 缩进格式：⚠️ 4 处不一致（#2-5）

### 3. 架构一致性

- 分层正确：sidecar 测试 mock 了外部依赖，未跨层调用
- 数据流方向：sidecar → shared → renderer 单向，无反向依赖
- 新增 vitest 配置合理，tsconfig include test 目录正确

### 4. 测试覆盖

**skill-paths.test.ts（7 个用例）**：

| 用例 | 覆盖路径 | 评估 |
|------|---------|------|
| RpcClient 传 --skill | create 路径基本传递 | ✅ |
| RpcClient 空 skillPaths | 空数组边界 | ✅ |
| RpcClient undefined skillPaths | 未配置边界 | ✅ |
| SessionPool 过滤 disabled + 不存在路径 | getSkillPaths 核心逻辑 | ✅ |
| SessionPool 无 enabled skill | 空列表边界 | ✅ |
| 空 sourcePath skill | falsy 边界 | ✅ |
| restoreSession 传 skillPaths | restore 路径 | ✅ |

覆盖完整，7 个用例覆盖了 create/restore 两条路径的 5 个边界条件。Mock 策略合理（mock child_process.spawn 捕获参数）。

**未覆盖**（非本次 commit 职责，但记录）：
- argumentHint 从 frontmatter 到 SlashCommand 的端到端传递
- ChatInput 预填逻辑的单元测试

### 5. 安全检查

- ✅ Vue 模板自动转义，argumentHint 渲染无 XSS 风险
- ✅ 用户输入（text.value）作为消息内容发送，无注入风险
- ✅ skillPaths 来自本地配置文件，非用户直接输入

## 结论

**需修改后重审**

## Summary

Code review v1 完成，1 条 MUST FIX（argumentHint 数据源错误，用了 `s.description` 而非 `s.argumentHint`），4 条 LOW（缩进不一致），需修改后重审。
