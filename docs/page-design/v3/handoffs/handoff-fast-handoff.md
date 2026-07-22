# Handoff · fast-handoff · 一键交接到新 session（待开工型 · spec 已立，待实现）

> 痛点3 主线。设计阶段已完成（spec 已立，三件套架构经 subagent 验证 V1-V8 正常成功路径；abort 取消 + agent_end 兜底恢复未验证，见 Step 1）。
> **与痛点2 共享三件套架构，可并行开发**。不依赖痛点1 的 parentSession/forkEntryId。
> 接手者读本文 + `../fast-handoff/spec.md` + `../fast-merge/spec.md`（三件套架构）即可开工。

## 1. 路径

- 目录：`v3/fast-handoff/`
- 文件：`spec.md`（✅ 设计规范 SSOT）
- 层级：L2 跨区联动 + Extension
- 配套 draft：待做（交互形态：PanelHeader 按钮 + loading + 跳转）

## 2. 要做的事情（实现 checklist）

### Step 1 · 三件套验证（⚠️ 规则 #4，与痛点2 共享验证）

痛点2 的 `tools/verify-merge-extension.cjs` 验证的三件套链路（V1-V8：setActiveTools + before_agent_start + turn_end + steer 重试 + waitForIdle），**正常成功路径被覆盖**，handoff 可直接复用结论。但 **abort 取消 + agent_end 兜底恢复未验证**——verify-merge-extension.cjs 只有正常成功路径，**没有取消测试用例**。handoff 的"生成中取消"（§5 Key States）依赖这条路径，必须补验证：

- [ ] 触发链路：`prompt("/handoff")` → handler 执行
- [ ] setActiveTools 锁工具集 + 恢复
- [ ] before_agent_start 注入 schema
- [ ] turn_end 检测成功 + appendEntry 回传
- [ ] **abort 兜底（merge 未验证，必补）**：触发 handoff 生成中 → 调 `SessionService.abort(sessionId)` → 确认 `agent_end{stopReason:'aborted'}` 触发 → §4.2 的 agent_end handler 恢复 SAVED_TOOLS + 清理 ACTIVE → 留在当前 session，不新建

### Step 2 · extension 实现

- [ ] 新建 `xyz-handoff-extension.js`（项目根）
- [ ] registerCommand("handoff")：设 HANDOFF_SCHEMA、setActiveTools、sendUserMessage 启动
- [ ] before_agent_start handler：注入 handoff 强约束
- [ ] turn_end handler：检测成功 → 恢复工具集 + appendEntry('handoff-result')
- [ ] try/finally 确保工具集恢复（防状态泄漏）

### Step 3 · extension 打包注入

- [ ] `electron-builder.yml` extraResources 加 `xyz-handoff-extension.js`
- [ ] `extension-service.getExtensionPaths` 追加
- [ ] `postbuild-validate.sh` 校验

### Step 4 · runtime handoff-service

- [ ] 新建 `packages/runtime/src/services/handoff-service.ts`
- [ ] 触发 slash command（`prompt("/handoff")`）
- [ ] 监听 custom_message 'handoff-result'
- [ ] 收到后：sessionApi.create(srcCwd) 新建空白 session
- [ ] 把 handoff 结构化数据格式化成 markdown
- [ ] 作为新 session 首条 prompt 发送
- [ ] 回前端触发跳转

### Step 5 · 前端 UI

- [ ] PanelHeader 加 handoff 按钮（Share 图标）
- [ ] 点击触发 handoff-service
- [ ] loading 态（生成中 / 新建中）
- [ ] 跳转到新 session

## 3. 关联文档（md）

- `v3/fast-handoff/spec.md` — 本单元设计 SSOT
- `v3/fast-merge/spec.md` — 痛点2，共享三件套架构
- `~/.agents/skills/handoff/SKILL.md` — 原 handoff skill（本方案自动化+结构化版）

## 4. 关联代码（pi 源码 + structured-output，实现时参照）

与痛点2 相同的三件套源码引用，加上：

| 能力 | 源码位置 | 用途 |
|---|---|---|
| sessionApi.create | `packages/renderer/src/api/domains/session.ts:28` | runtime 新建空白 session |
| useNewTaskFlow | `packages/renderer/src/composables/features/useNewTaskFlow.ts:168` | session 创建流程范式 |
| ExtensionCommandContext.newSession | `pi-mono/.../types.ts:348` | 备选（extension 内新建，本方案不用） |

## 5. 验收 P0

- [ ] handoff 入口在有内容 session 可见
- [ ] 三件套生成结构化 handoff（loading）
- [ ] **LLM 100% 在 pi agent loop 内**
- [ ] handoff 符合 schema（Ajv 校验）
- [ ] 新建空白 session（不继承历史）
- [ ] handoff 作为首条消息注入
- [ ] 自动跳转新 session
- [ ] setActiveTools 完成后恢复
- [ ] extension 走 builtin 打包
- [ ] **不改 pi 代码**
- [ ] **runtime 零 pi import**

## 6. 测试视角

- **构建者**：extension 三件套状态机、handoff schema 校验、sessionApi.create + 首条注入
- **使用者**：mount Panel，"点 handoff → 等 loading → 自动跳到新 session → 看到首条是 handoff → agent 开始处理"
- **观察者**：handoff 按钮位置、loading 态、跳转后新 session 首条消息格式

## 7. Open Questions（实现时与用户确认）

### 用户定
1. handoff 入口位置（PanelHeader 倾向）
2. schema 可自定义（v1 固定）
3. handoff 后当前 session 是否标记完成（倾向不标记）

### 实现时验证
1. before_agent_start per-run 限制（handoff 单 turn，影响小）
2. 新 session cwd（复用源 session cwd）
3. handoff 文档长度约束（schema description 或 prompt 约束 concise）

## 8. 风险

- **setActiveTools 状态泄漏**：与痛点2 同风险，try/finally + agent_end 兜底恢复
- **handoff 对话留在当前 session**：setActiveTools 锁工具集后只有 structured-output 调用 + 少量 assistant 文本，可接受（交接本来要花时间）。若用户在意，可 fork 临时 session 生成（增加复杂度，v1 不做）

## 9. 不在本 handoff 范围

- **痛点1 fork**：handoff 不依赖 parentSession/forkEntryId
- **痛点2 merge**：共享架构但独立 spec
- **pi 代码改动 / runtime LLM 调用 / completeSimple**：用户明确否决
