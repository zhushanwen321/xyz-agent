# agentRef 路径统一 v3 完善 —— 实施计划

> 日期：2026-08-08
> ADR：ADR-0003（决策记录）
> 前置：ADR-0002（路径统一）已实施（commit b7e0b60dd，1657 tests 绿）
> 本文档 = ADR-0003 的详细实施计划（阶段拆分 + 文件改动地图 + 精简清单 + 验证检查点）
> 下一层 = 可实现任务（接口先行、错误规格、物理数据流、运行时断言探针全适用）

## 0. 结论摘要

两批工作：**修复 + 增强**（M2 bug 修复、session 级发现、fail-fast、错误规格、文档）与**减法精简**（删临时文件机制、删 info、字段统一）。精简是 M2 修复的连带收益——删路径中间态的同时，整套 activeTempFiles 机制变得冗余。净效果：代码减少、机制更直、一个真实 bug 被根治。

## 1. 物理数据流（现状 bug vs 修复后）

### 1.1 现状（M2 bug 路径）

```
agent-opts-resolver.resolveAgentOpts:
  agent systemPrompt → fs.writeFileSync(/tmp/.../agent-prompt-xxx.md)   [落盘]
                       systemPromptFiles.push("/tmp/.../agent-prompt-xxx.md")   [路径!]
  schema SO 指令     → fs.writeFileSync(/tmp/.../so-xxx.txt)            [落盘]
                       systemPromptFiles.push("/tmp/.../so-xxx.txt")           [路径!]
  return { systemPromptFiles: [路径, 路径] }

execute-options-mapper.mapToExecuteOptions:
  appendSystemPrompt: opts.systemPromptFiles   [路径数组赋给「内容」语义字段]

session-runner.runSpawn (L642-656):
  appendParts = [buildEnvBlock(...)]                                 [内容]
  + opts.agentConfig?.systemPrompt                                   [内容, workflow 路径通常空]
  + ...opts.appendSystemPrompt   ← spread 路径数组当文本! BUG         [路径垃圾]
  + WRAP_UP_HINT                                                     [内容]
  + ASK_USER_RPC_PROMPT                                              [内容]
  writePromptToTempFile(appendParts.join("\n\n"))                    [拼成最终文件]
  --append-system-prompt <最终文件路径>                              [pi 读文件]

最终 pi 收到的 append 文件内容:
  [env block 正文]
  /var/folders/xxx/agent-prompt-yyy.md      ← 路径垃圾，本该是 agent systemPrompt 正文
  /var/folders/xxx/so-zzz.txt               ← 路径垃圾，本该是 schema SO 指令正文
  [wrap-up 正文]
  [ask_user 正文]
```

### 1.2 修复后

```
agent-opts-resolver.resolveAgentOpts:
  agent systemPrompt → appendSystemPrompt.push(discovered.systemPrompt)   [内容! 不落盘]
  schema SO 指令     → appendSystemPrompt.push(SO_INSTRUCTION)            [内容! 不落盘]
  return { appendSystemPrompt: [内容, 内容] }   [与 ExecuteOptions 同名同义]

execute-options-mapper.mapToExecuteOptions:
  appendSystemPrompt: opts.appendSystemPrompt   [透传，字段同名]

session-runner.runSpawn:
  appendParts = [envBlock, agentConfig?.systemPrompt, ...appendSystemPrompt, wrapUp, askUser]   [全内容]
  writePromptToTempFile(join) → --append-system-prompt <文件>   [pi 读，内容正确]
```

根治点：不再产生「路径作为中间态」，从源头消除「路径被当内容」的可能。

## 2. 阶段拆分

按依赖关系排序。每阶段独立可验证、独立可 commit。

### 阶段 R1：M2 修复 + 临时文件机制精简（D1+D2+D3）

**Why 先做**：真实 bug，且精简掉临时文件机制后，后续阶段的代码面更干净。

改动：
- `agent-opts-resolver.ts`：
  - 删 `fs.writeFileSync` 两处（agent + schema 临时文件）
  - 删 `activeTempFiles.add` 两处
  - `systemPromptFiles: string[]` 局部变量 → `appendSystemPrompt: string[]`
  - agent 内容 push `discovered.systemPrompt`；schema 内容 push SO 指令字符串
  - 删 `import fs/path/randomUUID`（若不再用）；删 `sessionDir`/`activeTempFiles` 参数
  - 删 `cleanupAllTempFiles` 函数
- `models/types.ts`：`AgentCallOpts.systemPromptFiles?: string[]` → `appendSystemPrompt?: string[]`
- `execute-options-mapper.ts`：`appendSystemPrompt: opts.systemPromptFiles` → `appendSystemPrompt: opts.appendSystemPrompt`（透传）；更新 L37 注释
- `error-recovery.ts` L284-289：`resolveAgentOpts` 调用删 `sessionDir`/`activeTempFiles` 实参；`hasResolverDeps` 判定收敛（只需 `agentRegistry`）
- `ports.ts` L132-140：`LifecycleDeps` 删 `activeTempFiles?: Set<string>`；更新注释
- `index.ts`：删 `import { cleanupAllTempFiles }`；删 `session_shutdown` 里的 `cleanupAllFiles(...)` 调用
- **探针测试（新增）** `m2-append-content-probe.test.ts`：断言 `resolveAgentOpts` 返回的 `appendSystemPrompt` 数组每项 `isPath=false containsContent=true`（内容含 agent 正文关键词 / SO 指令关键词，无 `/var/folders` / `/tmp/` 路径模式）

验证检查点：
- ⛔ 探针测试断言 appendSystemPrompt 全为内容（无路径）
- ⛔ e2e：workflow agent-call 带自定义 agent.md，mock 子进程收到的 `--append-system-prompt` 文件内容含 agent systemPrompt 正文
- ✅ 现有 execute-options-mapper.test.ts / agent-opts-resolver 相关测试迁移到新字段名

### 阶段 R2：发现注入 session 级缓存（D4）

改动：
- `injectors/subagent-list-injector.ts` + `workflow-list-injector.ts`：
  - 拆为「发现」+「渲染」两层。发现层 `discoverAll()` 返回 `DiscoveredResource[]`（agent）/ workflow meta 列表
  - 渲染层 `renderInjection(resources)` 接收已发现列表，输出 XML（不变）
- `index.ts`：
  - `session_start`：调发现层，结果存 per-session 缓存（Map<sessionId, {agents, workflows, mtime}>，sessionState 范围）
  - `before_agent_start`：从缓存取，调渲染层注入（不调 discoverResources）
  - `session_shutdown`：清该 session 缓存
- 缓存 key：sessionId（per-session，支持 split mode 多 session）
- mtime 失效：开发期 live edit 场景，before_agent_start 可选检查关键文件 mtime（复用 loadByPath 的 mtime 缓存机制），变更则刷新缓存。**默认不做热刷新**（与 skill 一致：新 session 才刷新），避免引入复杂性

验证检查点：
- ⛔ 单测：同 session 两次 `before_agent_start`，`discoverResources` 只被调一次
- ⛔ 单测：新 session 触发重新发现
- ⛔ e2e：注入段内容在 session 内多 turn 稳定

### 阶段 R3：review-fix-loop 启动期 stat fail-fast（D6）

改动：
- `workflows/review-fix-loop.js`（或 review-fix-loop-utils.cjs）：
  - 启动期（parseBatches 后、首 agent 调用前）遍历所有 batchN/fixAgent/agents 路径，`fs.statSync` 校验
  - 不存在 → `throw new Error("Agent file not found: <path>. Check <available_subagents> <location>.")`
  - fallowScan 不参与 stat（它是工具标记非路径）
- 错误经 workflow run 错误通道返回（launcher 捕获 → textResult isError）

验证检查点：
- ⛔ e2e：batchN 传不存在的路径，workflow 启动即报错（断言错误消息 + 断言未触发任何 agent 调用 mock）

### 阶段 R4：砍 info action（D5）

改动：
- `tool-workflow.ts`：
  - `WORKFLOW_ACTIONS` 删 `"info"`
  - 删 `actionInfo` 函数
  - `ToolWorkflowDetails` 联合类型删 info 分支
  - tool schema `action` 描述删 `info`；`name` 描述删 `/info`
  - gui details 的 info 分支删除
  - promptGuidelines：`call "workflow info <ref>" for parameters/usage/when` → `for parameter details, read the <location> script file (script header has @pi-meta parameters + usage)`
- `registry.getPath` 保留（run action 仍需按路径加载脚本）——info 砍不影响 getPath
- 测试：删 info 相关用例；改 promptQuality-batch1 的 info 断言为 read 引导

验证检查点：
- ⛔ 单测：`WORKFLOW_ACTIONS` 不含 info；actionInfo 已删
- ⛔ promptQuality：promptGuidelines 断言含 `read the <location> script file`，不含 `workflow info`

### 阶段 R5：错误规格三态统一（D7）

改动：
- `agent-opts-resolver.ts`：agent 路径 loadByPath 失败文案 → `Agent file load failed: <path> — ...`
- `agent-ref.ts` normalizeRef：相对路径拒绝文案 → `must be an absolute path ... Use <location> ...`
- `config-loader.getWorkflowByPath` / `registry.getPath`：workflow 路径不存在文案 → `Workflow file load failed: <path> — ...`
- 统一三态（非绝对路径 / agent 不存在 / workflow 不存在）均带 `<location>` 恢复指引

验证检查点：
- ⛔ 单测：三态错误消息各一例，断言含 `<location>` 指引关键词

### 阶段 R6：文档工艺 + 零残留验收（D8）

改动：
- 本文档（/tmp）迁移到项目 docs/（如 `docs/design/agent-ref-v3-refinement.md`）
- ADR-0002 末尾加指针：「实施完善见 ADR-0003」
- 零残留 grep（验收红线）：
  - `grep -rn 'systemPromptFiles' src/` → 0 命中
  - `grep -rn 'cleanupAllTempFiles\|activeTempFiles' src/` → 0 命中
  - `grep -rn '"info"' src/interface/tool-workflow.ts` → 0 命中
  - `grep -rn 'workflow info' src/ docs/ workflows/` → 0 命中
  - 注释/文档中 M2 bug 描述更新为「已修复（ADR-0003）」

验证检查点：
- ✅ grep 全绿
- ✅ ADR-0002 指针已加

## 3. 精简清单（删减汇总）

用户额外要求「哪些需要删减，精简可能更好」。净删除项：

| 删除项 | 原位置 | 删除理由 | 连带删除 |
|---|---|---|---|
| agent/schema 临时文件写入 | agent-opts-resolver.ts L60-70, L110-123 | M2 修复：内容直传，不产生路径中间态 | — |
| `cleanupAllTempFiles` 函数 | agent-opts-resolver.ts L139-145 | 无临时文件需回收 | index.ts import + session_shutdown 调用 |
| `activeTempFiles: Set<string>` 参数 | resolveAgentOpts 签名 / ports.ts / error-recovery.ts | 无临时文件需跟踪 | hasResolverDeps 判定简化 |
| `sessionDir` 参数 | resolveAgentOpts 签名 | 不再写 workflow-tmp 目录 | error-recovery 调用简化 |
| `AgentCallOpts.systemPromptFiles` 字段 | models/types.ts L126 | D3 字段统一为 appendSystemPrompt | mapper 改名映射降为透传 |
| `actionInfo` 函数 + info action | tool-workflow.ts | D5 减法：read 覆盖全集 | WORKFLOW_ACTIONS / details / schema / 引导文案 / 测试 |
| review-fix-loop `loadAgentMd`/`parseAgentMd` | （S4 已删） | 已精简 | — |

**净效果估算**：agent-opts-resolver 删约 40 行（临时文件逻辑 + cleanup）；tool-workflow 删约 30 行（actionInfo + details 分支）；index.ts/ports.ts/error-recovery 各删几行接线。新增探针测试约 40 行。总体净减少。

## 4. 待验证检查点（诚实标注）

| 检查点 | 状态 | 说明 |
|---|---|---|
| M2 appendSystemPrompt 全为内容（无路径） | ⛔ R1 探针 | 复刻 v3 m2-chain-probe 思路 |
| e2e agent systemPrompt 正文进入子进程 | ⛔ R1 | mock 子进程读 --append-system-prompt 文件 |
| session 级发现只调一次 | ⛔ R2 | spy discoverResources |
| 注入段 session 内多 turn 稳定 | ⛔ R2 | e2e |
| review-fix-loop 路径错误 fail-fast | ⛔ R3 | 不存在路径启动即报 |
| info 已删、引导改 read | ⛔ R4 | grep + 单测 |
| 三态错误消息含 location | ⛔ R5 | 单测 |
| 零残留 grep | ⛔ R6 | 红线验收 |
| workflow @pi-meta parameters 结构 | ✅ 已确认 | chain.js 等有 parameters 声明（info 砍的判断依据） |
| M2 bug 现状（路径当文本） | ✅ 已确认 | session-runner.ts:651 + mapper:64 逐行核实 |
| temp-prompt.ts 仍需要 | ✅ 已确认 | session-runner 最终拼接文件机制正确 |
| subagent tool 路径不受 M2 影响 | ✅ 已确认 | resolveIdentity 不写临时文件，经 agentConfig.systemPrompt（内容）→ session-runner L646 消费；M2 精简面只动 resolveAgentOpts 链，不扩 subagent-service |

## 5. 验收标准

1. `pnpm extensions:typecheck` + `pnpm extensions:lint` + `pnpm extensions:test` 全绿
2. M2 探针测试通过（appendSystemPrompt 无路径残留）
3. session 级发现：同 session 多 turn discoverResources 调用一次
4. review-fix-loop 不存在路径启动期 fail-fast
5. `workflow info` action 不存在（grep + schema）
6. 三态错误消息统一带 `<location>` 指引
7. 零残留 grep 全绿（§R6 清单）
8. 真实 pi 运行验证：复用 `XYZ_EXTENSION_PATHS=... pi -ne --extension ...` 方式，确认注入段 session 级稳定、agent systemPrompt 生效（可让 agent 自报收到的 system prompt 关键段落）

## 6. 实施顺序与 commit 粒度

R1（M2+精简）→ R2（session 级发现）→ R3（fail-fast）→ R4（info）→ R5（错误规格）→ R6（文档+验收）。

每阶段一个 commit。R1 最关键（真实 bug），优先。R2-R5 可并行规划但串行 commit（避免测试基线漂移）。R6 收口。

## 7. 风险

- **R2 session 级缓存与 split mode**：多 session 并发需 per-session 缓存隔离。复用 sessionState 机制（现有 per-session Map 模式，ADR-036 范式）
- **R1 精简面边界（已确认）**：M2 bug 与精简只影响 workflow agent-call 路径（resolveAgentOpts 链）。subagent tool 路径经 resolveIdentity → agentConfig.systemPrompt（内容）→ session-runner L646 正确消费，不写临时文件、不经 systemPromptFiles。R1 不动 subagent-service
- **R4 模型仍调 info**：存量 session 的模型可能调 info → unknown action 报错。可接受（引导语已改 read，新 session 生效）；不做兼容
