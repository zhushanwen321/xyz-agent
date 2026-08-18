# subagent-workflow-sidebar-sync 计划文档审查报告

> 审查对象：`docs/todo/subagent-workflow-sidebar-sync-plan.md`（实现计划层，上游为 design v4）
> 审查依据：`rubric-design-doc.md`（P0/P1 清单）+ 项目 AGENTS.md / TEST-STRATEGY.md / docs/testing/11-real-e2e-specs.md + 源码交叉核实（声称事实前均已 read）
> 审查身份：对抗式——默认怀疑，逐项找反例；只报告不修改。

## Summary

4 must-fix, 10 suggestions.

总体判断：**设计→计划映射骨架完整**（M0-M3 → P0-P6、U1-U4 全覆盖、§8 场景 1-8 全部有归属、无产品级 scope creep；P4 依赖 P3 成立——P3 删内存广播后 extractor 才是唯一数据源，P4 先行会被旧枚举的全集广播污染）。DoD 整体 testable 良好。但 **4 处 must-fix 集中在「验证设施的真实性」与「设计移交给下一层的边界项未承接」**：两个 real E2E 前提转述错误/设施缺口（会导致 P2-P6 验收跑不起来或假 skip）、A6 探针无落点、extractor 空/错误语义边界全计划无承接。另有枚举连带文件、测试改造量、进程定位消歧等 10 项建议。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §1 形态 A ② | P0-11 事实 | 「注意 §5.3：mandatory npm install ~16s 与 pi spawn 竞态，**先等 runtime ready 再建 session**」是错误转述：runtime ready（runtime.port 文件出现，`launch-app-real.ts:85`）≠ extension 就绪；11-real-e2e-specs.md §5.3/§7 的真实对策是 `waitForExtensionsReady`（runtime 日志 "resolved N extensions" N≥8，90s 超时）。按计划字面实现 → pi 的 `--extension` 列表空 → LLM 无 subagent/workflow tool → P2-P6 所有强引导 real E2E 必然 skip | 改为「session.create 前调 waitForExtensionsReady（§5.3 既有函数），runtime ready 仅为前置之一」 |
| MUST_FIX | §3 P1 验证 | P0-13 验收可执行 / P0-12 遗漏 | mock E2E「mock ws 推 session.subagentsChanged → 断言 getSubagents RPC 发出 + 侧栏 DOM 更新」依赖的能力现状不存在：`mock/mock-ws.ts` 仅处理 ping→pong（文件头明言「连接骨架不灌业务数据」）；服务端帧注入唯一通道是 `api/mock/index.ts:90` 的模块私有 `pushSession`，E2E spec 外部无法触发；「RPC 发出」断言需 mock 层调用记录设施。P1 开发内容文件清单未列任何 `api/mock/` 扩展项（mock 层改动还会波及全部既有 mock 轨 spec，需回归） | P1 开发内容补 mock 层扩展条目（注入钩子 + subagent mock 数据 + RPC 调用记录），或降级为纯集成测试（@vue/test-utils mount + 直调 useMessageEffects 回调 + DOM 断言）并明说放弃 mock E2E spec |
| MUST_FIX | §0 总览 + §9 风险表 vs §4 P2 验证 | P0-13 自洽 / 映射不完整 | 总览与 P0 均声称「消解**全部** ⛏ 前提」，但设计 §11 的 A6（≥10MB 真实 session 实测 extractor 耗时，实施期门）仅在风险表一行「A6 探针并入 P2 验证」，P2 验证清单（§4）无对应步骤；≥10MB fixture 的获取/合成方式（真实历史 session 从哪来）、测法（何种触发路径下计时）、阈值判定均未给 | P2 验证补 A6 实测步骤（fixture 来源 + 计时方式 + >100ms 阈值判定与决策 7 缓存触发条件），或修正总览表述并显式声明 A6 归属阶段 |
| MUST_FIX | 全计划 | P0-12 遗漏 | 设计 §11 末行「边界」明确移交下一层：extractor「读取失败」（`readFileSync` catch 返回 `[]`，subagent-extractor.ts:107-110）与「真空集」语义合并 → RPC **success reply 带空数组** → `applyRecords` 瞬时覆盖非空历史分区。计划无任何阶段承接。P1 验证「RPC 失败 → loadError + 分区不被空数组覆盖」只覆盖 RPC **抛错**路径（现状已有，subagent.ts:143-149），覆盖不到「success reply 带 []」路径——设计要求的两条解法（reply 带 error 字段 / store 对 prior 非空且新结果为空做守卫）计划均未列 | P1（协议 reply 解耦时，顺手加 error/empty 区分）或 P3 增加对应开发条目；P1 该句验证断言与开发内容对齐 |
| SUGGESTION | §6 P4 开发内容 | P0-12 遗漏 | SubagentStatus 枚举连带未列全：①`packages/runtime/src/services/session/subagent-status.ts`（`normalizeSubagentStatus` 是 extractor 状态归一化必经依赖，输出旧枚举 running/closed/crashed/failed，新 6 态下映射表必须重写——这是语义设计工作，编译断只能暴露类型不匹配）；②连带测试 `runtime/test/subagent-status.test.ts`、`packages/shared/__tests__/subagent.test.ts`；③类型实际定义文件 `packages/shared/src/subagent.ts`（清单只写「packages/shared/src/」） | P4 清单补齐上述文件（风险表「类型收紧编译断清单」可兜底发现类型面，但补列才能体现真实工作量） |
| SUGGESTION | §5 P3 验证 | P0-12 低估 | 测试改造量低估：`runtime/test/event-interpreter-subagent-push.test.ts`（324 行 / 8 用例）**整体**围绕将被删除的「subagent 内存态 + session.subagents 全集广播」，P3 后整文件作废重写而非「改造」；event-interpreter 其余测试另有 24 处 subagent 引用 | P3 验证按「subagent-push 测试文件作废重写 + interpreter 测试 subagent 用例改造」列名估算 |
| SUGGESTION | §5 P3 E2E 场景 1 | 逻辑时序 | 「断言第一个完成后侧栏秒级（A10a/b）或有界（对账）显示终态」——秒级收敛 = A10 信号（P3 广播）**+** extractor sidecar 投影（P4 才实现）缺一不可；P3 时点第一个 subagent 完成仍在 60s 窗口内、主 JSONL 无终态 entry、extractor 不读 sidecar，「秒级」分支在本阶段不可能通过，是伪选项 | P3 场景 1 明确本阶段只验「有界收敛」路径（bg-notify 窗口 flush + 对账重拉）；秒级断言移至 P4/P6 |
| SUGGESTION | §2 P0-A8 | P0-11 事实（不影响决策） | 「用最小测试 extension **或 node 直接连 pi rpc 发 sendMessage**」——后者不存在：pi RPC stdin 命令集（pi-mono rpc-types.ts：prompt/steer/follow_up/…/get_commands，全量已核）无 sendMessage/custom_message 命令，`pi.sendMessage` 是 extension 进程内 API。A8/A10a 只能走「最小测试 extension」通道（计划已并列给出，探针整体可成立） | 删掉「node 直连 pi rpc 发 sendMessage」候选通道，避免实施者走死路 |
| SUGGESTION | §2 P0-A10 候选 b | P0-13 可执行性 | 「跑真实 subagent 抓 runtime 事件流」未给观测点：runtime 日志是否打印原始 pi 事件、需要什么日志级别、还是 pi stdout 直查——与 A5 的具体步骤（第二进程 tail -F + stdout 事件行判定）相比不可执行。A10 是 P3/P5 的裁决依据，验证粗化影响选型质量 | 补步骤：如 ①pi CLI 直连 + grep pi stdout JSONL 验证终止帧（lines:undefined）必然发出；②形态 B 隔离 runtime 验证事件到达（event-adapter.ts:303-304 已有解析点可挂探针日志） |
| SUGGESTION | §4 P2 E2E 步骤 3/4 | 可执行性 | ①进程定位消歧键未给：dev 模式 runtime 命令行（node tsx …/packages/runtime/src/index.ts --port=N，process-control.ts:206-243）与并行 dev app 的 runtime **同构**，`pgrep -f` 必须带 E2E 实例特征（`--port=<waitForRuntime 读到的端口>`）；kill -9 pi 同理（pi spawn 命令行含 `--session-dir`/cwd，用 E2E dataDir 路径消歧）。风险表只提端口冲突未提进程混淆误杀；②步骤 4「第二 WS 重连成功」：runtime 每次 spawn 重新生成 WS auth token（process-control.ts:141），重启后 spec 侧需重读 `runtime.port`/`runtime-token` 才能重连，计划未提示 | 步骤补 pgrep 消歧键（port/dataDir 路径）与第二 WS 重连的 token/port 刷新；「runtime 日志 ready」作为兜底观测保留 |
| SUGGESTION | §4 P2 E2E（场景 5+8 合并） | 归因准确性 | P2 时点 `STATE_TYPE_KEY_MAP` 的 `session.subagents` 条目仍在（删除在 P3），重连后 stateSnapshot replay 可能先于对账重拉恢复列表——「不需要任何信号送达，状态收敛到磁盘真相」的机制归因在 P2 阶段不纯（快照恢复也算「送达」）；纯对账归因要到 P6（P3 之后重跑）才成立 | P2 通过标准注明「本阶段快照恢复与对账重拉并存，纯对账归因由 P6 场景 8 关闭」 |
| SUGGESTION | §5 P3 开发内容 | P0-12 遗漏 | 「若选 A10a：extensions/subagent-workflow 发轻量事件 + event-adapter 透传」——`packages/runtime/src/infra/pi/event-adapter.ts` 改动未列入 P3 文件清单（条件分支同样占文件行） | 条件分支补 event-adapter.ts 文件行 |
| SUGGESTION | §1 形态 A | 前置缺失 | real spec 的 bundle 前置未提：real renderer bundle 需手动构建且与 mock bundle 输出冲突分批跑（11-real-e2e-specs §3），global-setup 检测到 real bundle 缺失时 build 的是 **mock** bundle → real spec 全挂。计划引用了 §4 范式（含 symlink）但漏此前置 | §1 形态 A 补「real bundle 手动 build 前置」一句（P6 套件全跑前尤其需要） |
| SUGGESTION | §7 P5 vs 设计 §7.4 | 冲突表面化 | 设计 §7.4 第三条（subagent 重建矩阵分支 4 转终态 + 补发无 turn bg-notify）与其 §6.6 决策 6.3（v3 收窄：由决策 5 extractor 投影解决，扩展 subagent 域不再必改）**自相矛盾**（v2 残留未清理）。计划 P5 忠于决策 6.3 未实施该条（选择正确），但未显式声明取舍，实施者对照 §7.4 会困惑 | P5 注明「设计 §7.4 第三条已被其决策 6.3 取代，本计划不实施」；建议上游设计文档同步清理 |
| INFO | §1 形态 A ① | 事实澄清 | `makePresetDataDir` 是各 spec **私有复制函数**（workspace-real/ask-user-real/workflow-thinkinglevel/tasks-drawer 4 处各自实现，非共享 fixture 导出）；实现依赖开发者本机 `DEV_PI_AGENT` 配置（models.json + 可用 provider key）——real E2E 的环境前提，新 spec 需复制约 50 行实现 | 新 spec 直接复制既有实现；无需动作，知悉即可 |
| INFO | §2 P0-A7 | 措辞 | 「若 ≠ 0.84.0」条件恒真（runtime 捆绑 0.84.1、AGENTS.md 载明），探针实际必然对捆绑版重跑 A1/A2，条件分支无意义 | 措辞直陈「对捆绑 0.84.1 重跑 A1+A2」 |
| INFO | §4 P2 DoD / §6 P4 场景 7 | testable 弱化 | ①P2 DoD「50 session 规模不产生 RPC 风暴（去抖生效）」：去抖（message.complete 1s 窗口合并）与重连全量重拉（一次性遍历 N sid × 2 RPC）是两个机制，重连场景去抖不参与，「风暴」无量化标准；②P4 场景 7「WS session.create resume」措辞不准——protocol 的 session.create 无 resume 参数，重开走 UI 点击/restore 链路（计划已并列「UI 点击」路径，不影响可执行） | ①拆开表述：重连重拉断言「N sid 恰好各 1 次 RPC」（单测可判），去抖断言归 message.complete；②改「UI 重开或 session.restore」 |

## 设计→计划映射核对结论（验收项 1）

- M0→P0、M1→P1+P2、M2→P3+P4、M3→P5 ✓；U1→P1、U2→P2、U3→P3+P4（拆分合理）、U4→P5 ✓
- 决策 1/2/3/5/6 有明确阶段条目 ✓；决策 4 依赖 A10 裁决（P0）+ P3 信号 + P4 投影 ✓；决策 7 仅风险表兜底（见 MUST_FIX-3 的 A6 缺口）
- §8 场景 1/2/3→P3、4→P5、5+8→P2、6→P6 手工、7→P4，P6 全量重跑 8 场景 ✓
- §11：A5/A7/A8/A10→P0 ✓；A6 无可执行落点（MUST_FIX-3）；「边界」行全计划未承接（MUST_FIX-4）
- scope creep：未发现设计之外的产品改动（探针脚本/mock spec/回归闸门均属验证形态）✓

## 已核实为真的关键引用（无需修改）

`launchRealApp`/`waitForRuntime`（launch-app-real.ts，签名一致）；`makePresetDataDir` 范式与第二 WS 监听范式（11-real-e2e-specs §4 + 4 个既有 spec）；runtime 崩溃自动重启（runtime-supervisor.ts 崩溃重启策略）；`spawn('pi')` 命令行可 pgrep 定位；protocol.ts:1283 getSubagents reply 复用 push 类型（待解耦现状一致）；route-inbound ROUTE_TABLE/InboundEffects.onSubagents（:93/:193）；event-interpreter 五个待删符号（:153/:155/:557/:580/:596）；message-bus TOPIC_TABLE/transient 语义/fallback='stream'/STATE_TYPE_KEY_MAP 'session.subagents' 条目（:55/:113/:134）；extractor readFileSync catch→[]（:107-110）与 findSubagentSessionFile（:281）；event-adapter stream 终止帧 lines:undefined 解析点（:303-304，A10b 挂点存在）；workflow RUNNING_RETRY_MS=500（workflow.ts:161）；DerivedStatus 9 态（derive-status.ts）；STATUS_ICON/DOT_CLASS（sessionStatus.ts）；useBackgroundWork.hasRunning（消费 subagentStore）；extension kill-9 恢复循环无 store.save（index.ts ~466-475）；verify-lifecycle-e2e.sh 形态 B（隔离 runtime + 行首 PASS/FAIL 标记 + 依赖 pgrep/lsof）；dev:smoke、validate-runtime-bundle.sh 存在；P4 依赖 P3 成立、P1/P2、P5/P3-P4 并行成立。
