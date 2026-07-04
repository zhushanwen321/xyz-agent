# Wave F2 · flow-2 数据契约前置（FileChanges 通道）

> 自包含 handoff。新 session 只读本文档即可开工。先读完"项目与全局上下文"。
> 性质：契约/设计先行，不做完整 UI 实现。为 flow-2（代码变更审查）启动铺数据地基。

## 项目与全局上下文（所有 Wave 共享，必读）

**项目**：xyz-agent（Electron + Vue3 + TS + Tailwind v3 + Pinia）。v3 冷蓝暗色设计（ADR-0018），暗色为真默认（ADR-0021-B）。
**工作目录**：`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`
**渲染层源码根**：`src-electron/renderer/src/`（审计文档误写 `components/workspace/panel/`，实际是 `components/panel/`）
**runtime 源码根**：`src-electron/runtime/src/`（三层架构 transport/services/infra）
**共享类型**：`src-electron/shared/src/`（前端与 runtime 间的 TS 类型定义）
**编码规范**：`docs/standards.md` + worktree 根 `CLAUDE.md`（禁止 scoped 自定义 CSS、禁止原生 HTML 表单元素、禁止 any、类型契约先行）

**设计稿 SSOT**（路径含空格，bash 必须整体加引号）：
`"/Users/zhushanwen/Library/Application Support/Open Design/namespaces/release-stable/data/projects/5c80f187-ed73-415b-8c81-f825302eacbc/docs/designs/v3-demo/"`
下称 `$V3`。本 Wave 关键：`$V3/flow-2-code-review/spec.md`（flow-2 完整设计）+ `$V3/panel/draft-message-stream.html`（FileChanges 块视觉）+ `$V3/panel/draft-detail-pane.html`（ChangeSet Detail）。

**审计产出**：`.v3-audit/`（`results/wave-W11-message-stream.md` WP-L3-11、`wave-W14-side-drawer.md` WP-L3-34 是本 Wave 核心关联）

**Phase D 已完成（6 commit）**：见 `git log --oneline -6`。本 Wave 不依赖 Phase D 组件改动，但依赖其 token 体系（`--surface-2` 等已就绪）。

**硬禁忌（必守）**：
1. ★ **AI 自身绝对禁止直接 read 图片，会卡死整个会话**。视觉对比走 subagent + 视觉模型。
2. dev server 等长跑进程必须**异步后台启动**。
3. 禁 `SKIP_LINT=1`/`--no-verify`/`eslint-disable`/`any`。
4. 路径含空格 bash 加引号。审计行号/路径会漂移，改前先读真实代码。

**模型路由**：subagent 需指定模型。契约设计/读代码→`kimi-coding/kimi-k2-thinking` 或 `deepseek/deepseek-v4-pro`。

---

## 本 Wave 目标（契约先行，不实现完整功能）

flow-2（代码变更审查）是 v3 核心交互。Phase D 调研（`.v3-audit/phase-D-wave0.md` 调研点 2）确认：**runtime 全链路无文件变更事件解析/推送**，但 pi 工具参数（edit/write/bash 等）的 `args.file_path` **可提取**。

本 Wave 只做**数据契约 + runtime 解析方案设计**，不做完整 UI（FileChanges 块渲染、Side Drawer、Accept/Reject 交互留 flow-2 完整实施）。原则：类型契约先行（user-memory 铁律），避免孤立建前端通道导致 flow-2 来了重构。

## T00 调研结论（事实依据，勿臆断）

- **pi 协议**：`PiToolExecutionStartEvent` 含 `toolName` + `args`（Record），`PiToolExecutionEndEvent` 含 `result`。工具参数里有 `file_path`（edit 工具等）。
- **runtime 现状**：`event-adapter.ts` 的 `handleToolExecutionStart/End` 只透传 `toolName` + `input`（整个 args），**不解析文件路径**。`message-converter.ts` 同样不解析。
- **shared types**：`message.ts` 无 `FileChange`/`fileChanges` 类型。`ToolCall` 有 `toolName`/`input`/`output`/`details` 无文件路径字段。
- **结论**：FileChanges 需从零建通道，但数据源（args.file_path）在 pi 协议里可用。

## 任务清单（3 项，契约层）

### F2-1 · shared types 定义 FileChanges 数据契约
- **改**：`src-electron/shared/src/message.ts`
- **定义**（参考 `$V3/flow-2-code-review/spec.md` §状态机 + §S3）：
  - `FileChange` 接口：`{ filePath: string; status: 'added'|'modified'|'deleted'; addLines?: number; delLines?: number }`
  - `ChangeSetStatus` 枚举：`'accumulating'|'ready'|'partially-reviewed'|'resolved'|'superseded'`（flow-2 spec §状态机 5 态）
  - `Message.fileChanges?: FileChange[]` 字段（挂到 assistant message）
- **约束**：类型完整、精确，禁止 any。参考现有 `ToolCall`/`ContentBlock` 类型风格。
- **必读**：`$V3/flow-2-code-review/spec.md`（状态机 + S3 变更集卡数据模型）、`shared/src/message.ts`（现有 Message 结构）

### F2-2 · runtime event-adapter 文件变更解析方案（设计文档）
- **产出**：设计文档（建议 `docs/architecture/adr/00XX-filechanges-channel.md` 或 `.v3-audit/flow2-data-design.md`），**不实现代码**。
- **设计内容**：
  - 哪些 pi 工具需解析（edit/write/multi_edit/write_file/mkdir/bash 等——先 grep pi 工具列表或读 pi 协议定义）
  - 从 `args` 提取 `file_path` 的规则（不同工具参数名可能不同：`file_path`/`path`/`filename`）
  - 如何判断 added/modified/deleted（edit=modified，write+不存在=added，需文件系统状态或 pi 反馈）
  - 行数统计来源（`result` 的 diff 解析？或 pi 工具输出？）
  - 事件推送时机（每个 tool_end 推增量？还是回合结束聚合？）
  - 与现有 `handleToolExecutionEnd` 的集成点
- **必读**：`src-electron/runtime/src/infra/pi/event-adapter.ts`（handleToolExecutionStart/End 现状）、`pi-protocol.ts`（PiToolExecutionStartEvent/EndEvent 定义）、`message-converter.ts`
- **参考**：`$V3/flow-2-code-review/spec.md`（数据流预期）、`$V3/research/pi-steer-followup-capability.md`（同类 pi 能力研究范例）

### F2-3 · chat store 数据处理骨架（types only）
- **改**：`src-electron/renderer/src/stores/chat.ts`
- **范围**：仅扩展类型处理——`Message.fileChanges` 字段在 store 的类型定义中声明，处理函数签名定义但 `throw new Error('not implemented')`（骨架模式，user-memory：骨架阶段 tsc+eslint 双绿）。
- **不做**：实际数据流处理逻辑、Turn.vue 渲染、FileChanges.vue 组件。
- **必读**：`stores/chat.ts`（现有 Message 处理 + G2-006 块类型契约注释）、`.v3-audit/results/wave-W11-message-stream.md`（块类型契约 4→7 类现状）

## 执行方式

串行：F2-1（types）→ F2-2（设计文档，独立）→ F2-3（store 骨架，依赖 F2-1 types）。
F2-1/F2-3 用 `kimi-coding/kimi-k2-thinking`；F2-2 设计文档用 `deepseek/deepseek-v4-pro`（需跨 runtime/pi 代码库读 + 综合设计）。

## 必读文档

- **flow-2 完整设计**：`$V3/flow-2-code-review/spec.md`（**本 Wave 核心 SSOT**）
- 数据契约现状：`src-electron/shared/src/message.ts`、`src-electron/runtime/src/infra/pi/{event-adapter,pi-protocol,message-converter}.ts`
- 审计缺口：`.v3-audit/results/wave-W11-message-stream.md`（WP-L3-11/13）、`wave-W14-side-drawer.md`（WP-L3-34，ChangeSet Detail 依赖本通道）
- 调研依据：`.v3-audit/phase-D-wave0.md`（T00 调研点 2 结论）
- 范例：`$V3/research/pi-steer-followup-capability.md`（pi 能力研究文档写法范例）
- 项目 ADR 目录：`docs/architecture/adr/`（若产出 ADR，按现有编号续）

## 验证

- F2-1/F2-3：`cd src-electron/renderer && npx vue-tsc --noEmit` + `cd src-electron && npx tsc --noEmit -p shared/tsconfig.json`（若有）+ 根目录 `npm run lint`，全零错误（骨架也要双绿）
- F2-2：文档评审——方案是否覆盖所有待决点（工具列表/参数名/状态判断/行数来源/推送时机/集成点）

## 边界（不做，留 flow-2 完整实施）

- 不做 FileChanges.vue 渲染组件（W11 WP-L3-11）
- 不做 Side Drawer / ChangeSet Detail / Accept/Reject（W14 全部，G-023）
- 不做 runtime 解析的代码实现（F2-2 只设计方案）
- 不做 SystemNotice / 消息操作菜单 / SteerFollowup pending 气泡（W11 其他 ❌ 项）
- 不做 SubAgent Detail（flow-3 范畴）

## flow-2 完整实施时序（本 Wave 之后的路线图，仅供参考）

1. 本 Wave（F2）：types + 解析方案设计 ✓
2. runtime 实现 event-adapter 解析 + 推 `message.file_changes` 事件
3. chat store 处理 fileChanges 数据流（填 F2-3 骨架）
4. `FileChanges.vue` 渲染组件 + Turn.vue 集成（回合折叠第二恒显锚点）
5. Side Drawer 容器 + ChangeSet Detail（Accept/Reject 5 态状态机）
6. 反向联动（源块点击→drawer）
