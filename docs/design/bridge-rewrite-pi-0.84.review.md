# bridge-rewrite-pi-0.84.md 对抗式审查报告

> 审查人：tech-design-review subagent（2026-09-04）。审查依据 `rubric-design-doc.md`（P0/P1 清单 + 判定四态），写作准则 `design-principles.md`。
> 事实核实基准：本仓 node_modules 实装 `@earendil-works/pi-coding-agent@0.84.4`（`npm ls` 核对 ✅）+ `@earendil-works/pi-agent-core`（pi-coding-agent 同装版本依赖）+ `packages/runtime/src/` 源码。所有引用行号均为审查人亲自 read 所得。

## Summary

1 must-fix, 7 suggestions.

文档整体质量异常扎实：四断点、abort 全链、registerTool 语义、装配链、序列化陷阱等全部 load-bearing 断言逐条 read 实装源码核实为真（见文末核实清单）。唯一 MUST_FIX 是一条「运行时断言靠推理」类缺陷：冷启动同步窗口内 E1 错误（Plugin system initializing）按机制不可达，验收场景 V5-① 的通过标准无法按写定方式复现，且 D4 的 Degraded 恢复出口依赖同一不可达前提。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.1 场景 D / §3.3-D4 / §3.4-E1 / §4 V5-① | P0-13 验收不可达（兼 P0-14 / P0-12 / 准则 7） | **E1「同步窗口内工具调用收 initializing 错误」按机制不可达**：LLM 只能调用已注册进 `extension.tools` 的工具（pi 侧唯一注册点是 `registerTool`，loader.js:239-246 写 Map；未注册 = 工具不在 LLM 工具集 = 调用根本发不出）。冷启动同步完成前 bridge 零工具注册，用户在窗口内让 agent 调插件工具，实际现象是 LLM 层「工具不存在」，而非 E1 的 isError 回包。同一前提缺陷连带两处：① D4「重试到顶进入 Degraded 态，工具 execute 时按需重试同步」——Degraded 意味着 sync 从未成功 = 零工具注册 = execute 永不触发，本 session 无自愈出口（只能下个 session）；② V5-① 通过标准（收 initializing 错误→数秒重试成功）无法按写定方式复现，实施者会误判功能损坏或伪造验收。旧 bridge 的同款 guard（`resources/pi/agent/extensions/bridge/index.ts:30` `bridgeState !== 'Ready'`）同样是不可达死路径——本设计把一条历史死路径写成了验收场景。**注**：G3 本身不受影响（V5-②③ 仍有效），架构无需返工 | 改预期而非改架构：① V5-① 重写为真实现象（窗口内 agent 回复「无此工具」/unknown tool，数秒后重试成功），或改为真实可达路径（sync 成功后 plugin-service 重启窗口）；② E1 触发条件改写为可达路径（如 runtime 侧 plugin-service 不可用回包，bridge-handler.ts:39 先例），或显式登记 E1 仅覆盖「注册批内微窗口」并降级为防御性代码；③ D4 补 Degraded 出口说明（登记「本 session 不恢复、下个 session 重试」为已知限制，或给一个真实触发器如 session_start 事件重臂一轮 sync） |
| SUGGESTION | §3.3-D1 / §3.3-D6 / §3.2 / §5 U3 | P1-8 事实（枚举不完备，兼 P0-12 轻量） | 「四处 stringify」计数错误：bridge-handler.ts 实际有 **6 处**裸对象回包调用需适配——:32（sync payload）、:39（tool_execute 无 pluginService 分支）、:49（tool_execute result）、:74（intercept result）、**:80（default 未知 method 分支）**、:89（catch {error}）。文档的规范性表述「全部改为…含 catch 分支」正确，但「四处」枚举漏了 :39 与 :80；:80 恰是协议不匹配防御路径（E5 相邻），漏改会产出 `'[object Object]'` 错误回包，使该路径错误消息失去恢复指引价值 | 枚举改为「全部 6 处」并列出 6 个调用点行号；U3 单测矩阵补 default 分支与 not-available 分支的序列化形状断言 |
| SUGGESTION | §3.3-D6 / §5 文件改动地图 | P0-12 连带改动遗漏（降级：实施期测试即失败暴露，非架构影响） | 删除 event-adapter 旧 `bridge:*` 分支 + bridge-handler 回包改造会破坏 4 个现存测试文件：`packages/runtime/test/bridge-sync.test.ts`、`bridge-reconnect.test.ts`、`event-adapter-bridge.test.ts`、`plugin-hook-bridge.test.ts`（均断言旧通道行为，bridge-sync.test.ts:191 明确列举旧 method 集）。文件改动地图未列任何测试文件。另 `packages/runtime/src/services/plugin-service/bridge-interop.ts:81` 注释硬引用旧路径 `resources/pi/agent/extensions/bridge/index.ts`，旧目录删除后成悬空引用（C-proc-10 同批清扫纪律）；bridge-interop.ts 本身也不在文件地图（D7 引用了它但地图漏列） | 文件改动地图补 4 个测试文件 + bridge-interop.ts；U4 验收的「全量单测」显式列为「更新后全量单测」 |
| SUGGESTION | §3.4-E3 / §4 V2 | P1-3 受众背景 | E3 超时错误文案实体在外部文档（「超时文档 §5.2 文案」），本文读者拿不到具体文案就无法核对 V2 通过标准（「含 timed out after 10s (declared) + 指引」中的指引部分）。V1/V2/P-8/P-9 的「回补」语境同理依赖超时文档才完整 | E3 内联关键文案模板（时长 + declared 标记 + 恢复指引一句话），或摘录超时文档 §5.2 的文案骨架进本文 |
| SUGGESTION | §4 V6 | P1-1 关键概念无例子（验收可观察性） | V6「拦截消息出现在 LLM 上下文（agent 行为可观察到注入内容）」是间接断言——未定义怎么观察。且 intercept 映射到 `BeforeAgentStartEventResult.message`（CustomMessage Pick）后 `display` 取值未定：display=false 则对话流不可见，仅剩行为侧证据 | 测试插件把注入内容设计为可机器断言的指令（如「回复首行包含 TOKEN_X」），display 取值随 D 决策写明（注入类消息建议 display:false + 断言走 agent 行为/pi session 文件） |
| SUGGESTION | §3.4-E5/E7 vs §4 | P1-10 负面行为无验收 | 设计了两个防御行为但验收清单无对应场景：E5（marker 命中但 payload 非法 → malformed 回包不静默）、E7（老 runtime + 新 bridge → 空壳弹窗而非崩溃）。二者仅 U3/P-10 的单测覆盖，无真实链路验证 | V 清单补一条防御场景（如 dev 下用改动过的 payload 直发 marker 帧，断言 malformed 回包与 warn 留痕），或显式声明该防御以 U3 单测为验收边界并登记理由 |
| SUGGESTION | §3.3-D1 通道二（事件转发） | P1-6 显式化（防实现回归） | observe 类事件转发（bridge:event）必须 fire-and-forget（handler 内 `void` 发起、不 await 回包）——若实现者写成 await，每个 agent 事件都会把 pi 的 runner 事件管线串行阻塞在一次 runtime 往返上（runner 对每个 handler await）。文档仅以「与旧通道行为相同」「bridge 侧 void 丢弃」隐含此约束，旧代码（index.ts:64 `void api.extension_ui_request`）是显式的 | D1 或 D4 补一句硬约束：「observe 转发禁止 await select 回包（void 发起）；仅 intercept（需决策结果）允许 await」，防止实现期语义漂移 |
| SUGGESTION | §3.3-D3 / §2.3 | P1-8 行号偏移（均不影响决策） | 三处引用行号与实装有偏移：①「messages.d.ts:32-39」实际为 `pi-agent-core/dist/harness/messages.d.ts:18-25`（CustomMessage.content 类型，类型结论本身正确）；②「bridge-interop.ts:146-150」实际 getSyncPayload 在 :149-152；③「rpc-client.ts:217」spawn args 实际在 :216。其余全部行号引用（types.d.ts:36-41/68-120/906-979/1153、loader.js:239-246/428/463/479、rpc-mode.js:47-96/84/329-331/604-640/618-625、agent.js:330、agent-loop.js:455、event-adapter.ts:522-527/530/540-554/561、extension-timeout-manager.ts:95-96、session/types.ts:221、event-interpreter.ts:339、bridge-handler.ts:61-63/83-95、rpc-client.ts:205-211/634/794-801、extension-resolver.ts:190-246、electron-builder.yml:64-66、session-manager/src/index.ts:70-94/102-114、runner.js:552）逐一核实为精确命中 | 修正三处行号；不影响方案成立 |

## P0/P1 清单判定（四态）

| 检查项 | 判定 | 依据 |
|--------|------|------|
| P0-1 五段骨架 | 通过 | §1-§5 五段齐备，§5 含 justification 列 |
| P0-2 delta 链 | 通过（微瑕） | 无本档前版引用；「超时文档」为跨档规范引用（并入 E3 suggestion）；「对话中裁决」字样仅出现在 Answer 概述与变更历史，§3.2 论证自包含 |
| P0-3 结论先行 | 通过 | 标题下一句话结论 + SCQA 开篇；§3.2/§3.3 各组决策首句均为结论 |
| P0-4 问题定义 | 通过 | SCQA 的 Q 定义到根因层（私有通道依赖 + 装配体系脱队），四断点全部行级实锤（审查人独立复核为真） |
| P0-5 重实现轻体验 | 通过 | §1 系统说明 + 三角色 + 图；§3.1 场景 A-E 使用者视角先行 |
| P0-6 抽象术语 | 通过 | marker/staged/D1 取值链/taiji 组等首次出现均有定义或绑定先例 |
| P0-7/8/9 方案对比 | 通过 | 三组对比均 ≥2 方案、长期+短期+风险三维、有明确推荐与被否回看 |
| P0-10 因果链 | 通过 | 私有通道→公开契约（select+marker）、装配断裂→mandatory SSOT、abort 缺口→opts.signal，三路均打到根因 |
| P0-11 关键事实 | 通过（附 SUGGESTION） | 全部决策级断言核实为真（见核实清单）；「四处 stringify」枚举错误定级 P1-8（规范表述正确，不撼动方案） |
| P0-12 副作用/遗漏 | 不通过（已列 MUST_FIX + 2 SUGGESTION） | E1/Degraded 路径不可达（MUST_FIX）；测试文件与 bridge-interop.ts 连带改动遗漏（SUGGESTION，实施期即暴露故降级）。其余连带面（timeout-manager 登记点迁移、isBridgeRequest 保留、rpc-client 死分支清理、AGENTS.md 双登记、check-extension-dependencies/bundle-extensions 联动）文档均已覆盖且核实成立 |
| P0-13 验收 testable | 不通过（V5-①） | V5-① 通过标准按机制不可复现（MUST_FIX）；其余 V1-V4/V6-V8 均真实场景、可执行、有明确通过标准 |
| P0-14 单测/mock/抽象断言 | 不通过（场景 D/E1，并入 MUST_FIX） | E1 是对不可达运行时路径的断言（准则 7「把应该这样当就是这样」）。验收主体（V1-V8）为真实全链场景非单测 ✅；V6 可观察性偏间接（SUGGESTION） |
| P0-15 验收投入匹配 | 通过 | 8 场景 + 10 探针匹配大改动；G1-G5 逐条有对应场景（G1→V1/V2/V6/V7，G2→V3/V4，G3→V5，G4→V7，G5→V2/V4/V8） |
| P0-16 探针 | 通过 | 探针清单独立成节；⛔ 项（P-4/7/8/9/10）全部带降级路径；✅ 项审查人独立复核为真 |
| P0-17 物理数据流 | 通过 | §2.3 全链图标注进程边界、帧形状、文件:行号 |
| P0-18 错误恢复 | 通过 | E1-E7 表每条带恢复指引；E7 恢复（同版本部署）偏薄但已登记 |
| P1-2/4/5/6/7/9 | 通过 | 拆分有 justification、决策条目 item 化、减法优先（杀轮询/杀 append_entry/杀 commands 分支）、未越层 |

## 审查人独立核实清单（关键事实，全部亲自 read）

以下断言审查人 read 实装/源码逐一复核为**真**（文档引用行号精确命中，未列者见 SUGGESTION 行号偏移项）：

- **abort 全链（任务重点攻击方向）**：`rpc-mode.js:329-331` abort 命令 → `agent-session.js:1222-1225` `session.abort()` 调 `this.agent.abort()`（文档未提的中间包装层，行为一致）→ `agent.js:202-204` `abortController.abort()`（:330 创建于 `runWithLifecycle`，:340 `executor(abortController.signal)`）→ `agent-loop.js:455` `prepared.tool.execute(id, args, signal, ...)` 第三参透传（execute 签名 `types.d.ts:372` 核实）→ `rpc-mode.js:59-62` `onAbort → resolve(defaultValue)`（不 reject）。链路每段实读成立；文档 P-4 已诚实标注端到端未实跑并带降级路径。
- **select 帧与解析**：`rpc-mode.js:84` select 发 `{method:'select', title, options, timeout}`、parseResponse 三态归一 undefined；:47-79 createDialogPromise；:87-96 notify fire-and-forget。
- **迟到回包安全**：`rpc-mode.js:620-625` pending miss 静默 return。
- **stdin 命令集合**：`rpc-mode.js:604-640` 只认 extension_ui_response + 固定命令集。
- **loader**：:428 jiti default 导入、:463 `await factory(load.api)`、:479 非 factory 报错文案、:499-515 逐个串行 await、:238-247 registerTool 为 `tools.set` Map 覆盖 + `runtime.refreshTools()`；types.d.ts/loader.js/rpc-mode.js 全文 0 处 unregisterTool。**commit 后 registerTool 合法**（`loader.js:214-219` assertActive 只在 failed/stale 抛错，:382-393 commit 置 active）——D4 的 miss 后期重注册可行。
- **intercept 注入链**：`types.d.ts:845-849` BeforeAgentStartEventResult.message 存在（CustomMessage Pick）；`runner.js:903-908` 各 handler 的 result.message 聚合进 messages、handler 异常被 catch（:915-924）；`agent-session.js:914-929` 把每条 message 注入 LLM messages。收窄语义登记成立。
- **序列化陷阱**：`rpc-client.ts:789-804` null→cancelled / 无 method+对象→{id,response} 包裹 / confirm / 其余 `String(response)`；session-manager 先例 `session-manager-handler.ts:133` 已是 `JSON.stringify(data), 'select'` 同款用法。
- **runtime 识别链**：event-adapter.ts:522-527（旧 bridge:* 分支）、:530 INTERACTIVE_UI_METHODS、:540-554 SESSION_MANAGER_MARKER、:561 ASK_USER_MARKER、:374 parseSelectOptionsPayload；interpreter `services/session/event-interpreter.ts:339` bridge-ui 路由；`services/session/types.ts:221` kind 定义；extension-timeout-manager.ts:95-96 前缀判定；extension-message-handler.ts:103-107 isBridgeRequest 拦截；server.ts:439-447 registerExtensionTimeout 唯一登记入口（经 index.ts:330，仅 extension-ui kind 触发——D6「登记点迁移」改动的落点真实存在）。
- **装配链（任务重点攻击方向）**：`extension-resolver.ts`（infra/installers/）dev 分支 :230-247 扫 `<repoRoot>/extensions` 一层分组目录（:225-241 **不硬编码分组名**，逐组 scanDirectory）+ mandatory 名单过滤（:243-246）；scanDirectory :485-503 单层子目录 + isValidPiExtension（:438-460 pi manifest/keywords/peerDeps 判定）；packaged :203-222 读 staged。`bundle-extensions.mjs:63-71` 包名→`extensions/{taiji,universal}/<short>` 双探测。`prepare-builtin-extensions.sh:37` 从 mandatory JSON 读清单。`check-extension-dependencies.mjs:119-124` taiji 组必须在 mandatory 清单。四者合起来：`extensions/taiji/plugin-bridge/` + mandatory 追加的装配假设**成立**，无遗漏 guard。
- **旧 bridge 四断点**：`resources/pi/agent/extensions/bridge/index.ts` 88 行、:7 命名导出 activate、:19 extension_ui_request、:76 extension_ui_response 监听；ExtensionAPI（types.d.ts:906-983）无 extension_ui_request/addMessage，on() 注册表（:907-942）无 extension_ui_response；`bridge:append_entry` 全仓 grep 仅 bridge 自身 + 一个测试引用（零发送方属实）；extension-resolver.ts:194-198 [HISTORICAL] 注释与考古叙述一致；resources/pi/agent/extensions 运行时零装配点引用（仅注释/打包拷贝）。
- **marker SSOT 先例**：`packages/extension-protocol/src/extensions/session-manager/marker.ts:8`、`ask-user/marker.ts:8`、`core/markers.ts:7`；session-manager 依赖 `@xyz-agent/extension-protocol: workspace:*` 并 import marker（package.json:33 / index.ts:5）——D1 的「pi 侧 import 协议包」有生产先例。
- **其他**：mandatory-extensions.json 17 包结构与文档 D3 追加格式一致；electron-builder.yml:64-66 resources/pi extraResources；session-manager/src/index.ts:70-94（callSessionManager 骨架）与 :102-114（cancelled 折叠）；bridge-interop.ts:149-152 sync payload 形状；`extension.list` 为 runtime WS 命令（extension-message-handler.ts:130-136，V7 可执行）；message-dispatcher.ts:179-182 abort → client.abort() → rpc-client.ts:634。

## 结构化输出（Round 1）

```json
{ "report_file": "/Users/zhushanwen/Code/xyz-agent-workspace/fix-zcode-subagent-failed/docs/design/bridge-rewrite-pi-0.84.review.md", "must_fix": 1, "suggestion": 7 }
```

---

# Round 2（聚焦复审，v2 修订稿）

> 复审范围：仅上轮 1 MF + 7 SG 的修复成立性 + 修订新引入的断言/场景。上轮已核实为真的部分（四断点 / abort 链 / 装配链 / 探针清单 / 序列化陷阱机制）不重查。

## Summary (Round 2)

0 must-fix, 4 suggestions.

**上轮 MF 修复成立**：E1 新边界、Degraded 诚实登记、V5-① 真实预期、五处联动（E1/E2/场景 D/V5-①/D4）交叉一致，无残留旧表述（grep 核实 "initializing"/"四处" 仅存于变更历史引述）。7 条 SG 全部落实且新事实声明逐条核实为真（见下）。4 条新 finding 均为精度/可执行性打磨，不阻塞实施。

## Findings (Round 2)

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §4 V5-① | P0-13 弱化（可执行性） | ①的触发窗口是竞态：prompt 的首个 LLM 请求须早于「jiti 编译 + 首次 sync 往返」完成（~百 ms 量级；plugin-service 在组合根早于任何 session 装配，首包 sync 正常立即成功）。手工输入不可能稳定命中；未命中时场景退化为普通成功路径，①②形态对比无从展开。判据本身（形态差异）机制正确且可判 | 注明程序化触发方式（session 创建后立即经 WS/renderer 自动化发 prompt，连 9222）+ 未命中窗口时的判读规则（重试或标注窗口已关闭跳过①，不影响②③） |
| SUGGESTION | §3.3-D1 事件转发硬约束 | P1-8 引用精度（断言为真，行号指错 emit） | 约束引用「runner.js:903-908 事件管线串行」——该行段是 `emitBeforeAgentStart`（**intercept 专用** emit）。observe 事件（agent_start 等）实际走通用 emit：runner.js:623-641（:632 `await handler(event, ctx)`，逐 extension 逐 handler 串行）。断言本身成立（两条 emit 路径都串行 await），但按行号核对的验证者会看到 intercept 循环——与约束意图（约束 observe、放行 intercept）恰好相反 | 引用改为 runner.js:623-641（通用 emit），或双引用并注明 903-908 是 intercept 侧 |
| SUGGESTION | §3.4-E1 / §3.1 场景 D | P1-8 诚实性微调（不影响验收，无场景依赖 E1） | E1 例证「plugin-service 缺席时 not-available 回包」在**标准组合根装配下不触发**：index.ts:172 先建 server → :272 建 pluginService → :638+ `server.setServices({plugin: pluginService})` 才装配 handler，server.ts:208 `new BridgeHandler(this.pluginService ?? null)` 此时拿到恒非空实例。:39 是防御分支（无 plugin 系统的装配形态 / harness 下才可达）。v2 称其为「可达路径」严格说过强——机制上可达（server.ts:208 显式支持 null），标准装配下不可达 | E1/场景 D 补半句「标准装配下为防御分支，仅在无 plugin 系统装配形态触发」，防止下轮审查再次挑战该表述 |
| SUGGESTION | §4 V9 / §3.3-D6 | P1-1 可构造性步骤 + P0-12 轻量 | V9 可构造性成立但**注入路径未写明**：standalone pi spawn 的 `--extension` 清单来自 resolver，默认只含 mandatory 集合；本地测试 extension 须经 discovery.json 勾选额外扫描目录（extension-service.getExtensionPaths → resolver scanDiscoveryExtensions，extension-resolver.ts:75-80/:293-316）或 preset 路径才能注入。另：malformed 回包的**发送组件未钉**——event-adapter 是纯翻译层（返回 PiTranslatedEvent[]，无 client 句柄），回包要么由 marker 分支破例直发、要么参照 session-manager 的 `'__malformed__'` 哨兵（event-adapter.ts:542-547 先例）经 handler 回包；该新回包点同样需要 stringify+'select'（属新代码，不在 6 处现有清单内，宜一句话登记防漏） | V9 真实流程列明注入步骤（discovery 目录或 preset）；D6 malformed 防御钉住发送组件（建议哨兵经 handler，与 session-manager 同构）并注明该发送点同用 stringify+'select' |

## Round 2 核实清单（修订新引入的断言，全部亲自 read）

- **E3 内联文案模板**：`bridge-interop.ts:199-204` 实装模板与文档引用逐字一致（`'${request.toolName}'` / `${formatDurationMs(timeoutMs)}` / `${source}`，source ∈ {declared, default}，:197）✅。
- **V2 通过标准 "10s" 形态**：`formatDurationMs(10000)` → `10000 % 60000 ≠ 0` → `10000 % 1000 === 0` → `"10s"`（bridge-interop.ts:72-75）——「timed out after 10s (declared)」渲染精确成立 ✅。
- **§2.3 abort 链中间层**：新增「agent.abort()（agent-session.js:1222-1225）」与我 Round 1 实读一致（`async abort() { this.abortRetry(); this.agent.abort(); await this.waitForIdle(); }`）✅。
- **三处行号修正**：pi-agent-core/dist/harness/messages.d.ts:18-25（CustomMessage.content）✅、bridge-interop.ts:149-152（getSyncPayload）✅、rpc-client.ts:216/216-230（spawn args）✅。
- **6 处 stringify 枚举**：bridge-handler.ts 未改动，:32/:39/:49/:74/:80/:89 与 Round 1 read 一致；§3.2/D1/D6/U3 四处同步改「6 处」且 U3 单测矩阵含 default 与 not-available 分支 ✅。
- **五处联动一致性**：场景 D（:130）/ D4（:206-207）/ E1（:234）/ E2（:235）/ V5（:254）交叉引用闭合——miss 重同步前提（曾注册）与 Degraded（从未成功）互斥声明逻辑成立；正文无 "Plugin system initializing"/「四处」残留（仅变更历史引述）✅。
- **V9 帧机制**：marker 命中 + payload 非 JSON → malformed 路径机制上成立（parseSelectOptionsPayload 的 JSON.parse 失败返回 undefined，event-adapter.ts:374 起）；测试 extension 经 discovery 源可进 `--extension` 清单 ✅（注入步骤未写明，见 R2-S4）。
- **observe 串行断言**：runner.js 通用 emit（:623-641）确为逐 handler await——断言为真，行号引用需换（R2-S2）。
- **E1 边界装配时序**：server.ts:208 构造点位于 setServices 装配段（组合根 index.ts:638+，晚于 pluginService :272）——见 R2-S3。

## 判定（Round 2）

| 上轮 finding | 判定 | 依据 |
|--------------|------|------|
| MF（E1 不可达） | **修复成立** | 五处联动一致、真实现象成文、Degraded 出口诚实登记、V5-① 判据机制正确；残余仅 R2-S3 的「可达路径」措辞精度（标准装配下防御分支），无验收依赖 |
| SG1（stringify 6 处） | 修复成立 | 四处文本同步 + 行号逐一复核 + U3 矩阵补齐 |
| SG2（连带遗漏） | 修复成立 | 文件地图含 4 测试文件 + bridge-interop.ts；U4 验收改「更新后全量单测」+ 悬空注释清扫 |
| SG3（E3 文案） | 修复成立 | 模板逐字核实一致 |
| SG4（V6 可观察性） | 修复成立 | 行为断言 + session 文件断言 + display:false 预期成文 |
| SG5（E5/E7 验收） | 修复成立（附 R2-S4 精度项） | V9 已增、E7 边界声明成文且理由成立 |
| SG6（observe 硬约束） | 修复成立（附 R2-S2 引用精度项） | 约束成文且断言为真，行号引用指错 emit |
| SG7（行号三处 + abort 中间层） | 修复成立 | 全部复核一致 |

**结论**：MF 已闭合，架构与验收主线无阻塞项。4 条 suggestion 建议随 impl-plan 前顺手清掉（均为一句话级修改），设计就绪可进入实施拆分。

## structured-output（Round 2）

```json
{ "report_file": "/Users/zhushanwen/Code/xyz-agent-workspace/fix-zcode-subagent-failed/docs/design/bridge-rewrite-pi-0.84.review.md", "must_fix": 0, "suggestion": 4 }
```

---

# Round 3（终态确认，v3 修订稿）

> 复审范围：仅 Round 2 的 4 条 SG 修复落实性 + malformed 哨兵机制自洽性攻击 + E5/D6/V9/U3 四处联动终检。已确认项不重查。

## Summary (Round 3)

0 must-fix, 0 suggestions, 1 info.

**终态判定：设计通过，可进入 impl-plan 拆分。** 四条 Round 2 SG 全部落实且无新引入错误；malformed 哨兵机制（`bridge:malformed`）与既有 bridge-ui 路由链自洽，攻击未命中。

## Findings (Round 3)

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| INFO | §3.3-D6 / §5 U3 | 完善提示（不阻塞） | bridge:malformed 新 case 的回包点是第 7 个 stringify+'select' 发送点。D6 已声明「U3 一并实现防漏」，U3 验收矩阵有「malformed」场景字样，但「序列化形状」断言的字面枚举仍写「6 处」——实现者按字面写测试可能漏掉新 case 的回包形状断言 | U3 单测矩阵把序列化形状断言表述改为「6 处存量 + bridge:malformed 新回包点（第 7 处）」，一句话改动 |

## 四条修复落实核验（对照 Round 2 findings）

| Round 2 finding | 落实判定 | 核验依据（v3 文档 + 实装） |
|-----------------|---------|--------------------------|
| R2-S3（E1 措辞） | **落实** | E1 行（§3.4）补「标准组合根装配下该分支不触发（index.ts 组装顺序：pluginService 先于 server.setServices 装配，server.ts:208 构造点拿到恒非空实例）——仅在无 plugin 系统的装配形态触发，属防御分支」——与我 Round 2 核实的装配时序（index.ts:172→:272→:638+ setServices）一致；场景 D 引述同步（「标准装配下为防御分支，见 §3.4-E1 边界限定」） |
| R2-S4（V9 注入 + malformed 回包组件） | **落实** | V9 流程写明注入路径：discovery 扫描目录 → scanDiscoveryExtensions（extension-resolver.ts:293-316，行号核实正确）→ 进 `--extension` 清单，并注明 standalone 默认只装 mandatory 须显式注入。D6 哨兵机制钉死发送组件（详见下节攻击核验） |
| R2-S1（V5-① 竞态） | **落实** | 触发说明三要素齐备：窗口定义（prompt 首个 LLM 请求早于 jiti 编译 + 首次 sync 往返，百 ms 量级）、程序化触发方式（session 创建后立即 WS 自动化/9222 脚本发 prompt）、未命中判读（跳过①不影响②③，非失败） |
| R2-S2（runner.js 行号） | **落实** | observe 硬约束主引改 runner.js:623-641（:632 `await handler(event, ctx)`）——与我 Round 2 实读的通用 emit 一致；双注 903-908 为 intercept 专用 emitBeforeAgentStart 且「本就是等待决策的语义」——引用与约束意图对齐 |

## malformed 哨兵机制攻击核验（聚焦点 1）

攻击方向与结果（全部未命中，机制自洽）：

1. **路由链完整性**：event-adapter marker 分支产出 `{kind:'bridge-ui', method:'bridge:malformed'}` → interpreter 既有 `case 'bridge-ui'`（event-interpreter.ts:339）→ server.handleBridgeRequest → bridge-handler switch 新 case——与既有四 method 走完全相同的路由，**零新机制**。bridge-ui kind 的 method 字段类型为 string（session/types.ts:221），哨兵值类型合法。
2. **与帧级分支的冲突**：D6 同批删除 event-adapter 旧 `bridge:*` 前缀分支（:522-527）——删除后无任何帧级路径会拦截 `bridge:malformed`（帧 method 恒为 'select'，哨兵是 runtime 内部识别产物，不出现在帧上）。无冲突。
3. **timeout 登记覆盖**：D6 已写 bridgeRequestIds 登记移到「event-adapter 识别时」——malformed 哨兵请求同样产自识别点（识别失败是识别分支之一），requestId 登记随之覆盖，isBridgeRequest 前端拦截语义对 malformed 请求同样生效。闭合。
4. **先例引用准确性**：event-adapter.ts:542-547 确为 session-manager 分支的 `'__malformed__'` 哨兵产出段（Round 1 实读：:544-547 rawAction 收窄）。「同构」指「识别层产哨兵、handler 层统一回包」模式（session-manager 哨兵回 cancelled/ null，bridge 哨兵回 {error,hint} JSON——回包形态差异是两通道语义差异，非机制分歧），表述成立。
5. **序列化覆盖**：新回包点已登记「同用 JSON.stringify(...) + 'select'，不属 6 处存量清单，U3 一并实现防漏」——第 7 发送点显式入册（残余仅 INFO 级的 U3 矩阵字面枚举，见 Findings）。
6. **防御边界完备性**：识别失败两种形态（payload 非 JSON / 缺合法 method）→ 哨兵 case；JSON 合法但 method 为未知值 → 走 bridge-handler 既有 default 分支（:80，已在 6 处 stringify 清单内）——两条防御路径互补闭合，无静默丢弃路径。

## E5 ↔ D6 ↔ V9 ↔ U3 联动终检（聚焦点 2）

| 检查点 | 一致性 |
|--------|--------|
| E5 文案 ↔ D6 hint 文案 | 一致：E5「{error:'malformed bridge request', hint:...}（bridge-handler bridge:malformed 哨兵 case，§3.3-D6）」↔ D6「hint:'bridge extension and runtime protocol mismatch — redeploy same-version runtime+bridge'」；E5 恢复指引「按 hint 重部署同版本」与 hint 内容闭环 |
| E5 ↔ V9 通过标准 | 一致：V9「runtime 回 {error:'malformed bridge request', ...} 可解析 JSON」直接断言 E5 文案的可解析性（而非 '[object Object]'）——把序列化陷阱修复与 malformed 防御绑进同一验收 |
| D6 ↔ U3 实现归属 | 一致：D6「U3 一并实现防漏」↔ U3 内容列「payload malformed 防御」+ 验收矩阵「malformed」场景。残余：序列化形状断言字面仍为「6 处」（INFO） |
| V9 注入机制 ↔ 实装 | 一致：discovery 源经 scanDiscoveryExtensions（extension-resolver.ts:293-316）进 --extension 清单——行号与机制核实无误；「standalone 默认只装 mandatory」与我 Round 1 对 dev 分支 mandatory 过滤（:243-246）的核实一致 |
| 残留扫描 | 全文无旧表述残留（observe 行号已换、E1 双边界成文、v3 变更历史与实际修订逐条对应） |

## structured-output（Round 3，终态）

```json
{ "report_file": "/Users/zhushanwen/Code/xyz-agent-workspace/fix-zcode-subagent-failed/docs/design/bridge-rewrite-pi-0.84.review.md", "must_fix": 0, "suggestion": 0, "info": 1 }
```

**三轮累计**：Round 1（1 MF / 7 SG）→ Round 2（0 MF / 4 SG，MF 闭合）→ Round 3（0 MF / 0 SG，终态通过）。设计文档就绪，建议进入 impl-plan 拆分。
