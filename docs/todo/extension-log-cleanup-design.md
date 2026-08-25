# Extension 日志热路径清理设计（P1–P5）

> **一句话结论**：session JSONL 里 60% 的 entry 是两个可修的刷屏源（P1 子 agent UI 请求 GUI 兜底误报、P2 资源发现同名遮蔽重复告警）+ 一个结构性放大器（P3 logger 零限流）造成的；本设计在调用方修掉两个刷屏源与附带丢失的 notify 功能缺陷、在 logger 基建层加限流防线、并清掉全部裸 console 存量（77 处），使 custom entry 回到「只记真实异常」。

## 1. 背景目标

### 1.1 SCQA

- **S（情境）**：xyz-agent 的 20 个 `@zhushanwen/pi-*` extension 用共享包 `@zhushanwen/pi-extension-logger` 统一日志——warn/error 经 `pi.appendEntry` 写成 custom entry（`<extName>:log`），不进 LLM 上下文、不显 TUI，供事后排查。子 agent（`pi --mode rpc` 子进程）内的 UI 调用则由 `subagent-workflow` 扩展的透传矩阵管理。
- **C（冲突）**：2026-08-23 审计实测 `~/.xyz-agent/pi/sessions` 全目录 **878/1450 entry（60%）是 `subagents:log` 日志**，最坏单文件 323 条中 261 条（81%）；其中 P1 误报 338 条、P2 重复告警 539 条。附带一个功能缺陷：**子 agent 内扩展的 notify 用户提醒在 GUI 主 agent 下被丢弃**（回 cancelled，用户永远看不到）。
- **Q（问题）**：怎么让 session JSONL 回到「custom entry 只记真实异常」，且未来新增热点日志不再复发同类事故，同时把丢掉的 notify 提醒找回来？
- **A（答案）**：调用方修复两个刷屏源（P1 分类转发、P2 按 source 分级降噪：机器源重复降 debug、纯用户源保留 warn 首报）+ 基础设施加限流防线（P3 logger per-msg 窗口限流）+ 清存量（P4 去双写、P5 裸 console 全量迁移）。本文展开方案与取舍。

### 1.2 系统是什么

**日志三层通道**（SSOT：[docs/extensions/logging-conventions.md](../extensions/logging-conventions.md)）：pi 宿主层不提供 logger 接口，extension 的日志按受众分流——AI 实时走 tool result / block reason（pi 原生）；事后排查走 `logger.warn/error` → `appendEntry` 持久化为 custom entry；开发调试走 `logger.debug` → 文件日志（`XYZ_AGENT_DEBUG=1` 才写）。裸 `console.*` 被 SSOT 禁止（raw stderr 在 TUI alternate-screen 下越过渲染层污染输入区）。

**子 agent UI 请求透传链路**：子 agent 是 `pi --mode rpc` 子进程，它内部扩展调 `ctx.ui.*` 时，pi 的 rpc-mode 把这些调用变成 stdout 上的 `extension_ui_request` 消息（fire-and-forget 类：notify / setStatus / setWidget / setTitle / set_editor_text；dialog 类：select / confirm / input / editor——RPC 实现见 `node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js` 约 L88-167）。父进程的 subagent-workflow 扩展解析后按透传矩阵分流：TUI 下 fire-and-forget 直接回 `{ack:true}` 不透传（保护输入区）；GUI（rpc）下全透传——dialog 类进 L2 串行队列，fire-and-forget 直接转发给实际 handler。

### 1.3 设计目标（从使用者体验倒推）

1. **G1（复盘可用）**：用户/开发者重开或复盘 session 时，custom entry 以真实异常为主——常规 session（派过 subagent）的 `subagents:log` 占比从 60% 降到 5% 以下。
2. **G2（提醒不丢）**：子 agent 内扩展发出的 notify 用户提醒，在 GUI 主 agent 下到达用户可见层（转发到主 agent 的 `ctx.ui.notify`）。
3. **G3（防线常在）**：任何单一 warn/error 消息源失控刷屏时，logger 层自动限流聚合，开发者新增热点日志不会复发「60% 噪音」事故。
4. **G4（存量清零）**：extensions/ 全部源码无裸 `console.*` 调用（77 处迁移），TUI 输入区不再被 stderr 污染，且有 lint 守卫防回归。

### 1.4 Scope

**In-scope**：P1 GUI 兜底误报修复 + notify/setStatus/setWidget/setTitle/set_editor_text 转发；P2 同名遮蔽告警 source 分级降噪（机器源→debug，纯用户源→warn + 进程内去重）；P3 extension-logger 限流；P4 tool-error 双写去冗余；P5 裸 console 全量迁移 + no-console lint 守卫。

**Out-of-scope**（明确不做，理由见 §2.8）：

- P6 消费侧（runtime session-entry-mapper 已把 custom entry 路由到 `customDataEntries` 纯数据通道，无害）
- P7 合理 warn/error（error-recovery 故障 fallback、subagent-service cleanup 兜底——真实异常，保留）
- TUI 模式下 fire-and-forget 不透传（透传矩阵既有设计：保护 TUI 输入区，刻意丢弃）
- xyz-agent renderer 对转发的 setWidget/setStatus 的渲染增强（本设计只保证「转发到主 agent ctx.ui」，渲染是 xyz-agent 侧后续课题）
- 历史已写入的 JSONL 存量清理（只堵增量，不动旧文件）

## 2. 现状与问题分析

**根因一句话**：两类「信息本来只该出现一次」的事件（未知 method、同名遮蔽）在无任何幂等/限流机制的链路上被放大成每请求/每 session 一条，而 logger 对 warn/error 无条件持久化，三件事叠加成 60% 噪音。

### 2.1 基线数据（2026-08-23 审计实测）

| 指标 | 值 |
|---|---|
| `~/.xyz-agent/pi/sessions` 全目录 entry 总数 | 1450 |
| 其中 `subagents:log` | 878（60%） |
| 最坏单文件 | 261/323（81%） |
| P1 `unknown dialog method` 误报 | 338 条（method=setWidget 为主） |
| P2 `[resource-discovery] duplicate ... shadows ...` | 539 条（量最大） |

消费侧已闭环验证无害：`packages/runtime/src/infra/pi/session-entry-mapper.ts` 把 custom entry 路由进 `customDataEntries`（不进 messages / LLM 上下文 / renderer 渲染）。真实代价 = JSONL 体积膨胀 + session 重放逐行 `JSON.parse` 开销 + 复盘信噪比崩塌。

### 2.2 物理数据流：一条 warn 如何变成 60%

```
[P1 链路]                                     [P2 链路]
子 agent 扩展调 ctx.ui.setWidget(...)         pi 主进程 session_start hook
        │                                              │
rpc-mode.js: 转 extension_ui_request           subagent-list-injector.ts
(fire-and-forget, stdout)                      + workflow-list-injector.ts
        │                                     （各自 session_start + before_agent_start
spawn-event-adapter.ts 解析                    两处 fallback 调用）
        │                                              │
handler 链: createUiRequestHandlerForMode      discoverResources 汇合（三条链：
  ├─ TUI: !dialog → 回 ack（不透传）✅无此问题  agent/workflow injector 各两处 +
  └─ GUI: !dialog → realHandler               config-loader 第三链）
        │                                              │
        ├─ channel 命中(ask_user 已注册         resource-discovery.ts discoverResources
        │   → channel handler；gui_widget        L544-551 [D8d] 同名遮蔽 warn
        │   注册方当前缺位（唯一 register         （每 session 全量重扫必触发；7 个
        │   在测试文件），命中路径为预留）          agent 名重复于 npm 源与用户目录源）
        └─ channel miss → defaultDialogForward        │
             switch 只认 select/confirm/       logger.warn（无分级无去重）
             input/editor → default 分支:             │
             logger.warn + 回 {cancelled}      extension-logger appendEntry
        │                                     （warn 无条件持久化，零限流）
        │                                              │
        └──────────────> appendEntry("subagents:log") <┘
                                  │
                          父 session.jsonl（60% 噪音）
```

关键事实：**同一文件系统状态在每次 session_start 都被全量重扫并重新告警**（P2），**同一子 agent 的同类 UI 请求每条都独立告警**（P1），而 logger 对两者无条件放行（P3 放大）。

### 2.3 P1：GUI 兜底误报 + notify 丢失（338 条）

`extensions/universal/subagent-workflow/src/execution/ui-request-handler-factory.ts` 的 `defaultDialogForward`（channel miss 后的兜底）：

```ts
async function defaultDialogForward(req: UiRequest, ctx: ExtensionContext): Promise<UiResponse> {
  const ui = ctx.ui;
  switch (req.method) {
    case "select": ... case "confirm": ... case "input": ...
    case "editor": ...
    default: {
      // 未知 dialog method（非 select/confirm/input/editor）——保守 cancelled 不阻塞子进程
      logger.warn("[subagents] defaultDialogForward: unknown dialog method",
        { detail: { method: req.method, id: req.id } });
      return { cancelled: true };
    }
  }
}
```

**失败模式 A（刷屏）**：GUI 模式下 fire-and-forget 请求（实测以 setWidget 为主，来源是子 agent 内扩展的 widget 渲染调用）channel miss 后落到 default 分支——method 是 `setWidget` 不是四个 dialog method 之一，于是每次调用产生一条 warn。338 条由此而来。

**失败模式 B（功能缺陷）**：子 agent 内扩展调 `ctx.ui.notify(msg, "warning")` 想提醒用户（如任务完成/需要授权），rpc-mode 把它变成 `extension_ui_request {method:"notify"}`；父进程 GUI 分支透传到 defaultDialogForward → default 分支 → **回 `{cancelled:true}`**。用户提醒静默丢失——这不是日志问题，是 notify 语义被 dialog 兜底错误吞掉。

**根因**：透传矩阵在 TUI 分支对非 dialog method 有显式分流（回 ack），GUI 分支缺同样的分流——fire-and-forget 请求被误交给「只会 dialog」的 defaultDialogForward。

**修复可用的完整事实**（已核实 pi 0.84.1 实装）：RPC 模式下能到达父进程的 fire-and-forget method 全集 = `notify / setStatus / setWidget / setTitle / set_editor_text`（rpc-mode.js 约 L88-167；setWorkingMessage/setFooter/custom 等在 RPC 模式是 no-op 不产出请求；pasteToEditor 归并到 set_editor_text）。`UiRequest` 类型已含全部对应字段（notifyType/statusKey/statusText/widgetKey/widgetLines/widgetPlacement/title/text）。主 agent `ctx: ExtensionUIContext` 有全部五个方法可承接（notify L76 / setStatus L80 / setWidget(带 placement) L97 / setTitle L115 / setEditorText L131，见 `dist/core/extensions/types.d.ts`）。

### 2.4 P2：同名遮蔽告警每 session 重复刷屏（539 条）

`extensions/universal/subagent-workflow/src/shared/resource-discovery.ts` L544-551（discoverResources 内）：

```ts
// [D8d] 同名遮蔽可观测：高优先级源覆盖低优先级同名资源时 warn——此前
// 「有检测无报告」，用户自定义 agent/workflow 被静默遮蔽后排查无从下手。
if (existing && existing.path !== r.path) {
  logger.warn(
    `[resource-discovery] duplicate ${config.kind} "${key}" from ${r.source} shadows ${existing.source}`,
    { shadowed: existing.path, kept: r.path },
  );
}
```

**失败模式**：`reviewer / oracle / researcher / worker / general-purpose / planner / context-builder` 7 个 agent 名**结构性重复**存在于 npm 源（`@zhushanwen/pi-subagents`）与用户目录源（`~/.agents/agents/` 等）。触发链共三条（均在同一 `discoverResources` 函数内汇合，[D8d] warn 位于其 L544-551）：agent 侧 `subagent-list-injector.ts`（session_start + before_agent_start fallback 两处）、workflow 侧 `workflow-list-injector.ts`（同样两处）、以及 `orchestration/config-loader.ts`（约 L223，第三条调用链）。同一遮蔽事件每 session 必刷 7 条、每 fallback 重扫再刷一次 → 539 条。同步版 `discoverResourcesSync`（agent-registry hot-reload 路径）无 [D8d] 告警，天然不产生噪音。

**根因有两层**：① 告警描述的是**文件系统状态**（静态），却在**每次发现**（动态）时无幂等地重复上报；② 更关键的是，npm 包与用户目录之间的同名重复是**安装拓扑的正常状态**（装了 agent 扩展包 + 用户目录存在同名文件），不是用户配置错误——为正常拓扑每 session 报 7 条 warn，信息量为零。[D8d] 的告警初衷是「用户自定义 agent 被静默遮蔽后排查无从下手」，但 539 条噪音恰恰把真信号海没了。

**进程模型事实（决定去重策略）**：xyz-agent runtime 的 ProcessManager 明确注释「Each session gets its own isolated pi process spawned via `pi --mode rpc`」（`packages/runtime/src/infra/pi/process-manager.ts` L142-143）——**每 session 一个独立 pi 进程，进程生命周期 ≈ session 生命周期**；本地 pi CLI 同样每次调用新进程。因此任何模块级/进程级状态无法跨 session 记忆，去重设计必须面对这个现实。

### 2.5 P3：extension-logger 零限流（结构性放大器）

`extensions/shared/extension-logger/src/index.ts`：`warn`/`error` 无条件 `pi.appendEntry(...)`——没有任何 per-message 频率控制或去重。P1/P2 各自是「单点逻辑缺陷」，P3 让任何未来的单点缺陷都自动升级为 JSONL 污染事故。这是「防线缺失」而非「错误」：三层通道设计（logging-conventions.md）定义了日志去哪，没定义日志去多少。

### 2.6 P4：tool-error 双写（每个工具错误 2 条 entry）

`extensions/universal/unified-hooks/src/hooks/tool-error-handler.ts`（tool_execution_end isError 分支）：

```ts
pi.appendEntry("unified-hooks:tool-error", entry);          // 专属 entry：含全量字段
logger.warn(`[unified-hooks] ${e.toolName} error (callId=${e.toolCallId})`, entry);
// ↑ 泛化 entry：customType "unified-hooks:log"，message = toolName + callId（专属 entry 的子集）
```

注释声称双写是「埋点契约」（专属 customType 可被过滤脚本消费）。但专属 entry 已含 `timestamp/toolName/toolCallId/errorText` 全量字段，泛化 entry 无任何独有信息；且已核实 `packages/` 与 `apps/` 下**无任何代码消费 `unified-hooks:log`**——契约载体是专属 entry，泛化那条是纯冗余（每个工具错误让 JSONL 多长一行）。

### 2.7 P5：裸 console 存量违反 SSOT（77 处）

logging-conventions.md 关键约束 1「禁止裸 `console.*`」是现行 SSOT，但存量实测（当前分支，排除注释/测试/字符串字面量）：

| 类别 | 处数 | 主要分布 |
|---|---|---|
| console.warn | 58 | model-switch/config 11、quota-providers/cache 14、scheduler 9、permission 11、rename-session 3、llm-shared 5、model-switch/advisor 3、todo 3、其他 9 包各 1-2 |
| console.error | 10 | msg-id-mapper 3、system-prompt-trace 2、rename-session/index 2、subagent-workflow 1、system-prompt 2 |
| console.debug | 9 | 零散（含 quota-providers、pending-notifications、file-lock 等） |

（统计口径：排除 node_modules/dist/测试文件/行内注释/字符串字面量——`worker-script-builder.ts` 生成 worker 脚本的字符串字面量不计，见下；合计 77 处，分布 31 文件。）

**冲突表面化**：`scheduler/src/importer.ts` L146-147 注释声称「诊断输出统一 console.warn（项目 convention）」——与 logging-conventions SSOT 直接矛盾。SSOT 是 logging-conventions，scheduler 注释过时，迁移时一并修正注释，禁止两种说法并存。另 `worker-script-builder.ts`（orchestration/）L97 是生成 worker 脚本的**字符串字面量**（worker 内 monkey-patch console.warn 重定向到日志数组，最终走 logger 上报）——不是违规，保留。无 eslint no-console 规则，违规可持续累积无守卫。

### 2.8 明确不修的项

- **P6 消费侧**：custom entry 进 `customDataEntries` 纯数据通道，不进 LLM/渲染——修了没有用户可感知收益。
- **P7 合理日志**：error-recovery（14 条）全是故障 fallback 路径、subagent-service（8 条）是 cleanup/EPIPE 兜底——真实异常信号，保留。
- **TUI fire-and-forget 不透传**：透传矩阵刻意设计（TUI 输入区保护），GUI 分支修复不改变 TUI 行为。

## 3. 解决方案

### 3.1 终态（使用者视角）

**场景 1（复盘可用，G1）**：开发者用 subagent 派发了带 widget 渲染的任务，session 结束后 `jq -r 'select(.type=="custom")' session.jsonl` 查看——没有 `unknown dialog method`，没有 duplicate 遮蔽告警（npm↔user 机器源重复降 debug 后默认零 warn；纯用户源重复仅首报 1 条）；custom entry 只剩真实异常（如有）。

**场景 2（提醒不丢，G2）**：子 agent 内扩展调 `ctx.ui.notify("review needs your confirmation", "warning")` → 父进程转发到主 agent `ctx.ui.notify` → 主 agent 是 GUI（rpc，含 xyz-agent 桌面）时该 notify 作为 `extension_ui_request` 到达 xyz-agent runtime，进入其既有通知链路。TUI 主 agent 下不透传（透传矩阵既有设计，回 ack 保护输入区——见 §2.8，G2 明确不含 TUI）。

**场景 3（防线常在，G3）**：某扩展出现新的高频 warn（如每 token 一条）→ logger 每分钟同消息只持久化前 10 条 + 窗口末尾 1 条聚合摘要（`... [+M suppressed in last 60s]`）；`XYZ_AGENT_DEBUG=1` 的文件日志不受限流（排障时全量可查）。

**失败路径与恢复**：怀疑限流吞掉了需要的诊断 → 运行 `XYZ_AGENT_DEBUG=1 pi ...` 重现，grep `~/.pi/agent/logs/<extName>-<date>.log`（全量）；怀疑机器源遮蔽被 debug 降级误吞 → 同样 `XYZ_AGENT_DEBUG=1` 重现，文件日志含完整 `[resource-discovery] duplicate ...` 记录（排查路径保留，见 D3）；纯用户源遮蔽首报仍走 warn 默认可见；转发后仍看不到 notify → 检查主 agent 是否 TUI 模式（TUI 分支不透传，见 §2.8）。

### 3.2 P1 方案对比：defaultDialogForward 补 fire-and-forget 分类转发

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. defaultDialogForward 内补 5 个 fire-and-forget case，映射主 agent `ctx.ui.*` 同名方法并回 `{ack:true}`；default 分支保留 warn + 改回 ack | channel miss 后的兜底语义完整覆盖全部已知 method；未知 method 仍有可观测信号；透传矩阵不变 | 中（一个 switch 扩展 + 字段映射，类型层已就绪） | 低：转发 void 方法无死锁面；TUI 行为零变化 | ✅ |
| B. GUI 也学 TUI 对非 dialog 全部回 ack 不透传 | 最省一行，但 notify/setWidget 全静默丢弃——把功能缺陷从「误报」变成「静默」，G2 失败 | 最低 | 功能缺陷扩大化 | ❌ |
| C. 在 handler 工厂层按 `isDialogMethod` 分流，fire-and-forget 不进 realHandler | 分流点集中，但**绕过 channel 业务路由**——setWidget 的 gui_widget channel（已注册时走 channel handler 渲染）会被短路，破坏既有链路 | 中 | 高：channel 机制回归 | ❌ |

**若用 B**：§3.1 场景 2 的用户提醒永远不可见，且 setWidget 信息全丢——用「静默」换「不误报」，是把症状藏起来（违反问题定义）。**若用 C**：一旦未来 xyz-agent 或用户本地注册了 gui_widget channel（当前无生产注册方，为预留机制），其 widget 渲染会立即回归（channel handler 再也不会被调到）。

**方案 A 转发映射表**（字段名取自 `UiRequest`，已核实与 rpc-mode.js 产出的 envelope 一致）：
| req.method | 主 agent 调用 | 回复 |
|---|---|---|
| notify | `ctx.ui.notify(req.message ?? "", notifyType)` | `{ack:true}` |
| setStatus | `ctx.ui.setStatus(req.statusKey ?? "", req.statusText)` | `{ack:true}` |
| setWidget（`req.channel === undefined`，普通 widget） | `ctx.ui.setWidget(req.widgetKey, req.widgetLines, { placement: req.widgetPlacement })` | `{ack:true}` |
| setWidget（`req.channel === "gui_widget"`，带 marker 但 channel 未注册） | **不转发**（回 ack，见下） | `{ack:true}` |
| setTitle | `ctx.ui.setTitle(req.title ?? "")` | `{ack:true}` |
| set_editor_text | `ctx.ui.setEditorText(req.text ?? "")` | `{ack:true}` |
| 未知 method（default） | 不转发，`logger.warn` 保留（P3 限流兜底） | `{ack:true}`（原 `{cancelled:true}`） |

notifyType 需要 run-time 收窄（`UiRequest.notifyType` 是 `string`，`ctx.ui.notify` 要 `"info"|"warning"|"error"` 字面量联合——非法值 pi 会静默降级 info，收窄后显式 fallback "info"）。default 分支回 ack 的理由：isDialogMethod 认定的 4 个 dialog method 都有 case，落到 default 的一定不是 dialog（fire-and-forget 或未来新 method），fire-and-forget 的正确应答是 ack（与 TUI 分支先例一致）。

**setWidget 的 channel-miss 语义（设计期决策，非实施期发现）**：channel 解析（spawn-event-adapter 的 `parseFromMarkerArray`）只读不写——`req.channel === "gui_widget"` 时 `widgetLines[0]` 仍保留 `"\0XYZ_GUI_WIDGET:{...}"` marker 行，且主 agent 侧不存在 gui_widget 渲染器（channel 未注册正是 renderer 缺位的表现，当前全仓无生产代码注册 gui_widget）。转发 marker 行 = 转发主 agent 无法渲染的协议内嵌 payload。故决策：`req.channel` 非空的 setWidget 不转发、回 ack（内容对主 agent 无意义）；`req.channel === undefined` 的普通 setWidget（子 agent 扩展直接渲染文本行）全量转发。channel 命中时仍走既有 channel handler 优先链（registry resolve 在 defaultDialogForward 之前），不受本决策影响。

### 3.3 P2 方案对比：同名遮蔽告警降噪

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 按 source 分级 + warn 路径进程内去重：遮蔽对中**任一侧是机器源**（npm/npm-dev/project-pi/project-pi-tmp/project-agents/user-extension-paths）→ `logger.debug`；**双侧均为用户个人源**（user-pi/user-agents）→ 保持 `logger.warn` + 进程内 Set 去重（key=(kind,stem,shadowedPath,keptPath)，cap 1024 对齐 observability 范式） | 噪音大头（安装拓扑常态）归 debug 默认静默；真信号（用户双目录重复配置）保留 warn 首报；分级依据是发现机制打的封闭枚举标签（`ResourceSource` 8 值，resource-discovery.ts L40），非启发式；[D8d] 排查路径保留（debug 文件日志可查） | 低（分级判断 + Set ~20 行，单文件） | 低：分类边界清晰（source 枚举），无双义场景 | ✅ |
| B. 纯进程级去重 Set（所有遮蔽每进程首报一次） | 实现最简 | 最低 | **致命**：每 session 一进程（§2.4 进程模型事实），进程级 ≈ session 级，每 session 首报 7 条照发——539 条大头不消，G1 不达 | ❌ |
| C. 跨进程持久化去重（状态文件记已报 pairs + mtime 失效） | 能跨 session 记忆 | 高（新持久化机制） | 高：状态文件生命周期/失效/多进程写竞争都是新断言源；为消日志引入跨进程状态，违反减法 | ❌ |
| D. 全部降 debug（含用户双目录重复） | 最彻底静默 | 最低 | 真信号也丢：用户手写两个同名 agent 只能靠 debug 日志发现，D8d 场景完全无默认可见性 | ❌ |

**若用 B**：审计的 539 条 = 多 session × 7 条跨进程积累，进程级 Set 在每 session 新进程下每 session 仍发 7 条首报——只压掉同 session 内 fallback 重扫的小头。**若用 C**：为消日志引入持久化状态机，新故障面远大于收益。**若用 D**：§2.4 的用户双目录同名场景（如 `~/.pi/agent/agents/worker.md` 与 `~/.agents/agents/worker.md` 都是手写）降 debug 后无默认提醒，配置错误静默。

**分级依据的语义**（非启发式，免「结构性判定模糊」批评）：`ResourceSource` 是发现机制对每个资源打的**实际来源标签**（L40 封闭枚举，8 值）——机器源 = 包管理/工程配置产物（npm 包安装、dev-link、项目 .pi 目录），其重复是拓扑常态；用户个人源 = 用户手工编辑的两个目录（user-pi `~/.pi/agent/<kind>/`、user-agents `~/.agents/<kind>/`），双个人源同名重复是用户配置错误，保留 warn。[D8d] 场景「npm 遮蔽用户手写 agent」降 debug 后的排查路径：`XYZ_AGENT_DEBUG=1` 重现，文件日志含完整 duplicate 记录——按需可观测而非每次必报。

**已知限制（诚实声明）**：D8d 原始场景「用户手写 agent 被 npm 包同名遮蔽」降 debug 后，默认配置下无任何可见信号触发用户去查——用户需先怀疑「我写的 agent 怎么没生效」才会开 `XYZ_AGENT_DEBUG=1` 排查。这是「消除 539 条噪音」与「保留零信号遮蔽告警」之间的刻意取舍：噪音每天都在污染全部 session，而遮蔽排查只在用户主动怀疑时才需要。缓解面：注入列表仍只含生效 agent（用户发现缺项即可触发怀疑）；debug 日志保留了完整 duplicate 记录可验证。若未来实践中发现该取舍误伤，升级路径是在主 agent 启动时输出一次性摘要（每进程 ≤ 1 条含全部遮蔽对的聚合 entry），不回到每 session 逐条刷屏。

### 3.4 P3 方案对比：extension-logger per-msg 窗口限流

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. per `(extName, msg)` 固定窗口限流：60s 窗口内同消息前 10 条直写，超出抑制并计数，窗口过期后下一条触发时先补 1 条聚合 entry（`... [+M suppressed in last 60s]`）；纯惰性实现（无 timer）；Map cap 512 超限清空；只限 appendEntry 通道，fileLog 全量不限 | 防线在基建层，对全部 20 包生效，未来热点自动兜底；聚合保留计数信息（「发生了 M 次」不丢） | 中（一个状态 Map + 窗口判断 ~30 行；extension-logger 是共享包，但依赖走 `workspace:*`，无 20 包发版闭包） | 低：已知限制——key 是 msg 原文，动态拼接 msg（嵌 id）不命中限流；cap 防 Map 无界 | ✅ |
| B. 全局 per-extName 限流（每分钟 N 条不分消息） | 实现最简 | 低 | 高：一个失控源把其他源的正常 warn 也限掉，误伤 | ❌ |
| C. 不动 logger，只靠调用方修复（P1/P2/P4/P5 全修即覆盖已知热点 100%） | 零基建改动 | 零 | 无防线：下一个新增 warn 热点复发同类事故 | ❌（留作降级路径） |

**若用 B**：P7 的 error-recovery 合理 warn（故障风暴期真实多样）会被无关源的配额挤掉——限流必须 per-msg 才能区分「失控重复」与「多样真实」。

**参数依据**：10 条/60s 对正常诊断宽松（P1/P2/P4 修复后常规 session 同消息 warn ≤ 2 条）；对失控源保留前 10 条完整 detail + 每分钟 1 条计数摘要，诊断信息不丢。warn 与 error 用同一套参数（减法：一套机制，error 风暴的前 10 条 + 计数足够定位）。

**已知限制（诚实声明）**：key 用 msg 原文，调用方若把 id 拼进 msg（如 `session=${id}`）则每条 msg 不同、限流不命中——根治靠调用方把动态值放 `data` 参数（P5 迁移时顺带规范），logger 侧以 cap 512 防御 Map 无界。**降级路径**：若实施中发现限流逻辑与 appendEntry 的 session 隔离约束冲突（extension-logger 的单 session 约束注释），回退为方案 C（调用方修复已覆盖已知热点，限流延后独立 PR）。

### 3.5 P4 方案对比：tool-error 双写去冗余

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 删除 `logger.warn` 调用，保留专属 `pi.appendEntry("unified-hooks:tool-error", entry)`；注释更新（埋点契约由专属 customType 承载） | 每工具错误 1 条 entry；契约载体不变 | 最低（删 1 行改注释） | 极低：已核实无代码消费 `unified-hooks:log`；专属 entry 含全量字段 | ✅ |
| B. 删专属 entry，保留 logger.warn | `unified-hooks:tool-error` customType 消失，按 customType 过滤的既有脚本失效 | 低 | 破坏埋点契约 | ❌ |
| C. 双写保留，靠 P3 限流兜底 | 限流对「不同 msg（含 callId）」不命中，双写继续 | 零 | 未解决 | ❌ |

**若用 B**：审计里「按 customType 统计工具错误」的既有用法（正是本次审计的统计方式）失效。

### 3.6 P5 方案对比：裸 console 全量迁移 + lint 守卫

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 全量 77 处逐处迁移到 `getLogger(<extName>)`（按语义定 warn/error/debug 级别，动态值入 data）；shared 包（quota-providers/llm-shared）新增 `@zhushanwen/pi-extension-logger` workspace 依赖；迁移后启用 eslint `no-console`（extensions/ 范围） | SSOT 落地 + lint 防回归，存量清零 | 中高（77 处 × 31 文件 10+ 包，机械但量大） | 低：行为变化——生产默认下这些诊断从「stderr 可见」变「appendEntry/静默」，符合 SSOT 立场（诊断不刷 TUI） | ✅ |
| B. 只迁高频热路径（scheduler/model-switch/quota-providers），低频残留 | 残留违规，lint 守卫无法启用（存量会报错），SSOT 名存实亡 | 低 | 违规持续累积 | ❌ |
| C. 写 codemod 脚本批量替换 | 每处需人工判断级别与 data 结构化，脚本无法自动定级；过度工程 | 中（脚本+全量人工复核） | 错误迁移扩散 | ❌ |

**若用 B**：no-console lint 上线即红（存量报警），要么 disable 规则要么修存量——等于绕回 A。**行为变化声明（重要）**：迁移后生产默认（无 XYZ_AGENT_DEBUG）下，原 console.warn 的诊断信息不再打印到 stderr——这是 SSOT 的刻意立场（TUI 污染 > 诊断可见性），排障走 `XYZ_AGENT_DEBUG=1` 文件日志或 session JSONL 的 custom entry。

**msg-id-mapper（taiji 组）3 处 console.error**：同样迁移（`getLogger("xyz-client-msg-id-mapper")`），hook 异常路径低频，appendEntry 持久化优于 stderr。

### 3.7 关键决策汇总

**D1：P1 修复位置 = defaultDialogForward 内补 case + setWidget channel-miss 语义（选定）**
- **采用**：方案 A（§3.2 映射表）；channel 路由优先级不变（registry 命中仍走 channel handler）；`req.channel === "gui_widget"` 的 setWidget 不转发回 ack（渲染器缺位，marker 行无渲染意义），`channel === undefined` 全量转发。
- **被否**：工厂层分流（方案 C）——绕过 channel 业务路由，短路 gui_widget/ask_user 既有链路；全 ack（方案 B）——notify 永久静默。
- **证据**：rpc-mode.js 约 L88-167（fire-and-forget 全集）；types.d.ts L68-131（主 agent 五方法签名）；spawn-event-adapter.ts 约 L42-68（ExtensionUiRequest 变体定义）；`parseFromMarkerArray` 只读不写（marker 行必然残留在 widgetLines[0]）；全仓无生产代码注册 gui_widget（唯一 register 在测试文件）。
- **效果**：G1（消灭 338 条误报）+ G2（notify 转发可达）。

**D2：未知 method 保留 warn 不降级（选定）**
- **采用**：default 分支 `logger.warn` 保留（协议演进信号值得 warn），回 ack 不回 cancelled；刷屏风险由 P3 限流兜底。
- **被否**：降 debug——pi 未来新增 method 时完全静默，丢协议演进可观测性；新加 per-session 去重 warn——与 P3 限流功能重叠，违反减法原则。
- **证据**：DIALOG_METHODS 注释「避免 Pi 未来新增 method 时误判为 dialog」——协议演进是已预期的事件。
- **效果**：未知 method 首条 + 限流摘要可见，G3 防线覆盖。

**D3：P2 降噪 = source 分级（机器源→debug，纯用户源→warn）+ warn 路径进程内去重（选定）**
- **采用**：方案 A；分级依据 `ResourceSource` 封闭枚举（非启发式）；key 含 path（文件系统变化产生新 key，新遮蔽仍报）；Set 对齐 ui-request-observability 的 cap 模式。
- **被否**：纯进程级 Set（方案 B）——每 session 一进程（process-manager.ts L142-143 实证）下进程级≈session 级，每 session 首报照发，539 条大头不消；跨进程持久化（方案 C）——新故障面大于收益；全降 debug（方案 D）——用户双目录真信号无默认可见性。
- **证据**：`ResourceSource` 8 值枚举（resource-discovery.ts L40/L452-479，源标签在发现时打上）；process-manager.ts L142-143（每 session 独立 pi 进程）；[D8d] 注释本意「排查无从下手」——debug 文件日志保留排查路径；ui-request-observability.ts 约 L63-100（cap 1024 + 清空策略先例）。
- **效果**：G1（npm↔user 重复每 session 7 条 → 0 条；用户双目录重复每进程 ≤ 1 条首报）。

**D4：P3 限流 = per-msg 固定窗口 + 聚合摘要，只限 appendEntry（选定）**
- **采用**：方案 A；参数 10 条/60s/Map cap 512；纯惰性无 timer；fileLog 全量不限。
- **被否**：全局 per-extName（误伤多样真实 warn）；不加防线（复发风险）。
- **证据**：extension-logger index.ts（appendEntry 无条件调用现状）；依赖现状仅 3 包消费（smart-context/subagent-workflow/unified-hooks），均为 workspace:* 直挂本地源码零发版链；P5 迁移后新增约 16 包依赖（终态）。
- **效果**：G3。

**D5：P4 只删泛化 entry（选定）**
- **采用**：方案 A；注释同步更新「契约载体 = 专属 customType」。
- **被否**：删专属（破坏 customType 过滤契约）；留双写靠限流（动态 msg 不命中限流）。
- **证据**：packages/ apps/ 全 grep 无 `unified-hooks:log` 消费方；专属 entry 字段 ⊇ 泛化 entry。
- **效果**：G1（每工具错误 -1 条冗余）。

**D6：P5 全量迁移 + no-console lint（选定）**
- **采用**：方案 A；worker-script-builder 字符串字面量保留（lint 查 AST 不命中字符串，无需豁免注释）；scheduler 过时注释一并修正。
- **被否**：只迁热路径（lint 无法启用）；codemod（定级需人工）。
- **证据**：logging-conventions.md 关键约束 1（SSOT）；eslint.config.mjs 现无 no-console 规则。
- **效果**：G4。

### 3.8 探针清单

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P-ff-set | RPC fire-and-forget method 全集 = 5 个（无遗漏） | 已读 rpc-mode.js 约 L88-167 逐方法核对（setWorking* / setFooter / setHeader / custom 为 no-op 不产出请求；pasteToEditor 归并 set_editor_text） | ✅ 设计期已验证 | — |
| P-ui-sig | 主 agent ctx.ui 五方法签名与 UiRequest 字段一一对应 | 已读 types.d.ts L68-131 + dialog-queue.ts UiRequest 定义 | ✅ 设计期已验证 | — |
| P-consume | 无下游消费 `unified-hooks:log` / `subagents:log`；gui_widget 无生产注册方 | packages/ apps/ 全 grep 零命中（后者唯一 register 在 ui-channels.test.ts） | ✅ 设计期已验证 | — |
| P-process | 每 session 一个独立 pi 进程（进程级状态不跨 session） | process-manager.ts L142-143 注释「Each session gets its own isolated pi process」 | ✅ 设计期已验证 | — |
| P-fwd-notify | notify 转发后主 agent（rpc 模式）stdout 产出 `extension_ui_request {method:"notify"}` | 本地 pi CLI：主 agent `--mode rpc` + 子 agent 场景，观察 stdout | ✅ 终验通过（真实子 agent spawn 全链路：主进程 stdout 出现转发 notify，pid 不同于主进程） | 失败 → 检查 defaultDialogForward 分支是否被 channel 抢先；仍失败 → GUI 转发降级为仅 ack + warn（保 G1 弃 G2，G2 转独立 issue） |
| P-widget-gate | channel-miss 的 setWidget：channel==="gui_widget" 回 ack 不转发；channel===undefined 全量转发且 widgetLines 干净 | 单测：构造两种 setWidget 请求走 defaultDialogForward，断言主 agent ui.setWidget 调用与入参 | ✅ 单测通过（两种 setWidget 请求断言转发/ack 行为） | 若语义与 gui_widget 协议约定冲突（如 [1:] 有真实渲染内容）→ 改为转发前剥离 marker 行（对齐 channel 解析产物） |
| P-noise-zero | npm↔user 结构性重复不再产生 warn entry | 本地 pi CLI 起 session（机器上存在 7 个 npm↔user 重复名），jq 统计 duplicate warn = 0 条 | ✅ 终验通过（双 session 0 条 + XYZ_AGENT_DEBUG=1 复验 debug 落文件） | 失败 → source 分级判断错误，检查 ResourceSource 标签映射 |
| P-user-warn-once | 纯用户源重复每进程首报 1 条（fallback 重扫不重复） | 单测：同进程内连续两次调 discoverResources，断言第二次 0 条；真实场景：手工构造双用户目录同名 agent 后起 session，jq 统计 ≤ 1 条 | ✅ 终验通过（HOME 重定向双用户源每进程恰 1 条）+ 单测 fallback 重扫 0 条 | 失败 → 去重 Set 生命周期判定错误，改 globalThis Symbol.for 桥接单例（对齐 observability 范例——防 extension 模块重加载重置模块级 Set） |
| P-limit | 10 条后抑制 + 窗口末尾聚合 1 条 | vitest fake timers + 注入 100 条同 msg | ✅ 单测通过（fake timers 全语义） | 失败 → 回退方案 C（调用方修复已覆盖已知热点），限流独立 issue |
| P-limit-real | 限流在真实 session 生效（非仅单测） | 临时测试 extension 挂 `--extension` 制造高频 warn，跑真实 session，jq 验证 JSONL 含 `[+M suppressed]` 聚合 entry | ✅ 终验通过（flood 探针 100 条 → 10 直写 + [+90 suppressed] 聚合 + 1 新窗口条） | 失败 → 检查 appendEntry 路径是否绕过限流封装；仍失败 → 同 P-limit 降级 |
| P-ratio | 常规 session `subagents:log` 占比 < 5% | 重放审计统计脚本（同口径对比基线 60%） | ✅ 终验通过（0.0% < 5%，基线 60%） | 未达标 → 按占比分解剩余源逐个处理 |

## 4. 验收

改动规模：中大（跨 5 个问题域、10+ 包、行为变更含 UI 转发）——用多真实场景验收。全部在本地 pi CLI 实测（项目规范：extension 改动优先本地 pi CLI，不经 xyz-agent 桌面），配 `--extension` 直挂本地源码。

- **V1（回溯 G1，P1+P2）**：本地 pi CLI 起 rpc 模式主 agent，派发一个子 agent 任务（其扩展会调 setWidget/notify），结束后 `jq` 统计该 session JSONL：`unknown dialog method` 0 条、`duplicate ... shadows` 0 条（本机 7 个重复名均为 npm↔user 机器源参与，降 debug 后默认零 warn；若现场存在纯用户源重复则 ≤ 1 条首报）。**再开第二个 session**（新进程）重复同任务：duplicate warn 仍为 0 条（机器源分级不依赖进程记忆）。通过标准：两个 session 合计 `subagents:log` 占比 < 5%（基线 60%）。
- **V2（回溯 G2，P1）**：同 V1 环境，子 agent 内扩展调 `ctx.ui.notify("task done", "info")` → 主 agent（rpc 模式）stdout 出现转发的 `extension_ui_request {method:"notify", message:"task done"}`（即探针 P-fwd-notify）。**负面验证（透传矩阵回归）**：主 agent 换 TUI 模式跑同场景 → 不产生 unknown-method warn、子 agent 不阻塞（TUI 分支回 ack 不透传，方案 A 不触及）。
- **V3（回溯 G3，P3）**：单测（fake timers）验证限流状态机语义：同 msg 第 1-10 条直写、11-100 抑制、窗口滚动后首条附 `+90 suppressed`；`XYZ_AGENT_DEBUG=1` 下文件日志全量 100 条（限流只作用 appendEntry）。**真实场景补充**：临时测试 extension 挂 `--extension` 制造高频 warn 跑真实 session，`jq` 验证 JSONL 实际出现 `[+M suppressed]` 聚合 entry（即探针 P-limit-real）。
- **V4（回溯 G4，P5）**：`grep -rn "console\.\(warn\|error\|log\|debug\|info\)(" extensions/ --include="*.ts"` 排除测试/注释/字符串字面量后 0 命中；`pnpm extensions:lint`（含新 no-console 规则）通过；TUI 冒烟跑一个带 quota 查询的 session，输入区无 raw stderr 污染。
- **V5（负面验证，P2/P4/P7 不误伤）**：(a) 手工构造双用户目录同名 agent（`~/.pi/agent/agents/` 与 `~/.agents/agents/` 同名）后起 session，duplicate warn 首报可见（分级只降机器源，纯用户源保留）且同进程内 fallback 重扫不重复报；(b) 触发一个真实 tool error，`unified-hooks:tool-error` 专属 entry 仍存在且含 errorText（P4 只删泛化）；(c) kill 一个子 agent 进程，error-recovery 的 fallback warn 仍正常出现（P7 未被限流误伤——进程内仅首条 + 摘要）。
- **V5c 实施后勘误（errata）**：终验 2 次真实 kill 子进程实测发现，kill 路径实装上不走 logger.warn（子 agent 死亡经 record 状态上报 `closed due to parent-shutdown`，error-recovery.ts 的 deps.log 调用全部为 debug 级）——本设计 V5c「kill 触发 error-recovery fallback warn」的预设与实装有偏差（审计的 14 条来源应为其他 msg）。P7 实质未误伤的判据修正为：U1-U5 diff 未触及 error-recovery/lifecycle/record-store 故障路径文件 + 限流保同 msg 前 10 条直写。
- **V6（回归，P1 channel 链路不被短路）**：本地临时测试 extension 注册 gui_widget channel（或复用 ask-user 扩展的 ask_user 注册链），跑子 agent 场景断言 channel handler 仍被调用（registry resolve 优先于 defaultDialogForward，方案 A 不改优先级）；另断言 channel miss 的 gui_widget-marker setWidget 回 ack 不转发（D1 语义）。注：gui_widget 当前无生产注册方（全仓唯一 register 在 ui-channels.test.ts），故本项用本地临时注册而非 xyz-agent 桌面环境。
- 单测（typecheck/lint/test 三连 + 上述 vitest）作为回归辅助，不计入验收本体。

## 5. 下一层拆分

实施顺序按「收益 × 独立性」排：U1（量最大最独立）→ U2（含功能修复）→ U3（最小）→ U4（量大机械）→ U5（基建兜底，放最后因为它的价值是兜住 U1-U4 的遗漏 + workspace 依赖变更面最大）。

| 单元 | 内容 | 主要文件 | justification | 独立验收 |
|---|---|---|---|---|
| U1 | P2 source 分级降噪（机器源→debug，纯用户源→warn）+ warn 路径进程内去重 Set（cap 1024） | `resource-discovery.ts`（discoverResources 内 [D8d] 分支 + 模块级 Set）；injector × 2 与 config-loader 无需改（去重在汇合点覆盖全部三条触发链） | 539 条量最大；分级依据是既有封闭枚举非新机制；去重在汇合点覆盖三链 | V1 后半（两个 session 均 0 条）+ V5a + P-noise-zero/P-user-warn-once |
| U2 | P1 fire-and-forget 分类转发 + default 回 ack + notifyType 收窄 + setWidget channel-miss 门控（channel==="gui_widget" 回 ack，undefined 转发） | `ui-request-handler-factory.ts`（defaultDialogForward 扩展）；测试补 `ui-request-handler-factory.test.ts` 分支覆盖 | 338 条 + G2 功能修复；类型层已就绪改动集中在单 switch；门控语义设计期已定（D1）非实施期发现 | V1 前半 + V2 + V6 + P-fwd-notify/P-widget-gate |
| U3 | P4 删泛化 logger.warn + 注释更新 | `tool-error-handler.ts`（删 1 行 + 注释） | 最小改动；独立于其他单元 | V5b |
| U4 | P5 console 全量迁移（77 处，按包分批 commit）+ shared 包加 extension-logger 依赖 + scheduler 过时注释修正 + eslint no-console（extensions/ 范围，`extensions:lint` 纳入） | 各 extension src（清单以 lint 输出为准）；`quota-providers` / `llm-shared` 的 package.json；根 eslint 配置或 extensions lint 配置 | 机械但量大，独立成单元避免与其他修复混杂；lint 规则必须与迁移同 PR（否则规则上线即红或迁移无守卫） | V4 |
| U5 | P3 extension-logger per-msg 窗口限流 + 聚合摘要 + Map cap + 单测（fake timers） | `extension-logger/src/index.ts` + 测试；3 个 workspace 消费包无需改动（依赖 workspace:*） | 基建兜底放最后：先消灭已知热点，限流价值 = 兜住未知的；独立可回退（D4 降级路径） | V3 + V5c |

**每单元完成门槛**：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 三连通过 + 该单元独立验收项过 + 完成即 commit（conventional 风格）。

**待验证检查点（设计阶段无法确定，诚实标注）**：

1. eslint no-console 的启用位置（根 config 对 extensions/ 的 override，或 extensions 专用 config）——U4 实施时按项目 lint 结构定，规则误报按项目规范修正规则本体并加 [HISTORICAL] 注释，禁 eslint-disable 静默。
2. 限流与 extension-logger 单 session 约束（globalPi 模块级共享）的交互——U5 实施时确认限流状态与 logger 实例同生命周期，无跨 session 污染（探针失败走 D4 降级路径）。
3. setWidget channel-miss 门控的渲染语义假设（marker 行无渲染价值）——若 U2 实施中发现 gui_widget 协议的 [1:] 有真实渲染内容，按 P-widget-gate 降级路径改为剥离 marker 行转发（探针兜底，不阻塞设计）。

**文件改动地图汇总**：`resource-discovery.ts`（U1）· `ui-request-handler-factory.ts`（U2）· `tool-error-handler.ts`（U3）· 31 文件 77 处迁移涉及 10+ 包 src 与 2 个 package.json + eslint 配置（U4）· `extension-logger/src/index.ts`（U5）。新增文件仅测试与去重 Set 所在模块，无新目录。
