# Retrospect: cw-2026-07-22-unify-slash-command-source

## derived 异常归因

| 指标 | 值 | 归因 |
|------|-----|------|
| gateFailCount | spec_review_fix（SR1-13 补全）+ plan_review_fix（PR1-11）+ review_fix（R1/R3 must-fix + R4/R8 should-fix）+ test_fix×6（U exact 措辞匹配）| 前 3 个 gate 捕真问题；test 反复 fail 是 exact 匹配机制与单测类 testCase 不适配 |
| devRetryCount=0 | 0 | W1-W5 一次过，TDD 红灯先行有效，每个 wave worker 完成即测试转绿 |
| testRetryCount=6 | 6（达上限强制进）| U1-U13（exact 类型）匹配失败——tdd_plan 写的 expected.text 是"期望描述"，test 时 actual.text 是"实际描述"，措辞不一致。E1/E2（exit_zero）全 passed（testRunner 真跑通），实际 148 测试全绿（runtime 115 + renderer 33） |
| firstTryPassRate | spec_review / plan_review / review 各首次 fail | spec_review 捕 5 must-fix（FR-7 reload 编排、FR-3 projectCache 生命周期、FR-5 矛盾、FR-7 可见性、FR-6 fs.watch）；plan_review 捕 3 must-fix（ctx.reload 未实证、onChange 接口缺口、event-interpreter 死路径）；review 捕 2 must-fix（dispose 未调、pendingReload 残留）+ 1 误报（R2，reviewer 缺 pi 源码访问误判 promptReload 污染历史） |

## 可泛化流程模式（processIssues）

1. **[pattern] exact 类型 testCase 不适合单测类验收**。本次 U1-U13 用 exact 类型描述单测期望，test 时 actual.text 与 expected.text 措辞不可能一字不差（actual 是测试结果描述，expected 是预期描述），导致 6 轮 test_fix 都无法转 passed。泛化：单测类 testCase 应用 exit_zero 类型（跑对应测试文件 exit 0 即 pass），exact 留给 UI 文案验证。tdd_plan 阶段对"跑测试看是否绿"的 case 统一用 exit_zero + testRunner 脚本。

2. **[pattern] reviewer 缺外部源码访问导致推测性误报**。本次 R2（reviewer 怀疑 promptReload 污染对话历史）是 reviewer 无法访问 pi 源码而产生的推测。主 agent 核实 pi-mono agent-session.ts:1176-1200 后确认不成立（_tryExecuteExtensionCommand 执行 handler return true 不写 entry）。泛化：reviewer 发现涉及外部依赖（pi/electron/node）行为时，主 agent 必须核实源码再决定是否修，不能盲信 reviewer 推测。

3. **[pattern] 对接外部系统必须核实源码再写 spec**。本次 spec 阶段对 pi 能力的核查（get_commands 返回 sourceInfo、ctx.reload() 存在、pi 无 reload RPC）避免了方案性错误。特别是"pi 有 /reload 命令"这个直觉判断被 researcher 推翻（rpc-types.ts RpcCommand 联合无 reload），改为 builtin extension 桥接。泛化：涉及外部系统的 spec，先派 researcher 核实能力边界。

4. **[pattern] Wave 间 worker 串行派发避免 session-service.ts 跨 wave 冲突**。本次 session-service.ts 被 W2（getCommands 透传 sourceInfo）/W3（删 publicSession）/W5（isSessionIdle/promptReload/hasSession）三个 wave 修改。串行派发（W1→W3→W2→W4→W5）让每个 worker 在前一个 commit 基础上工作，避免合并冲突。泛化：同一文件被多 wave 改动时，worker 串行而非并行。

5. **[pattern] pre-existing 测试失败必须 stash 验证再修**。本次 W4 发现 composer-file-injection + 3 个同类测试失败（useProjectSkills currentCwd undefined），worker 用 git stash 验证为 W3 遗留的 pre-existing 问题，同构修法一并修掉。泛化：发现测试失败先 git stash 确认是本次引入还是 pre-existing，pre-existing 同构问题可一并修（否则 CI 红）。

## 设计级风险（knownRisks）

1. **[设计级 / unverified] R5 CommandDocPanel settings.skills 兜底与 FR-5 矛盾**。CommandDocPanel 的 /skill:xxx 兜底分支从 settings.skills 查 sourcePath，与 FR-5（全局不走 settingsStore.skills）矛盾。sourceInfo.path 主路径已工作（W2 透传），兜底是 deprecation 路径。两套数据源并存（landing popover 用 globalSkills，doc panel 兜底 settings.skills），reload 后可能短暂不一致。unverified：移除兜底需 CommandDocPanel 完全脱钩 settings.skills，改动面大留后续。

2. **[设计级 / unverified] R7 defaultScanFn 每次新 ConfigService 性能**。skill-registry 的 defaultScanFn 每次 scan 都 new PiConfigStore() + new ConfigService() 重读磁盘配置。watcher 高频变动时（debounce 300ms 后）重复创建。应用单例 ConfigService 或 _scanFn 注入生产路径。性能问题非正确性问题，留后续优化。

3. **[设计级 / unverified] R10 landing mapSkillInfo 不带 sourceInfo**。CommandPopover landing 分支 mapSkillInfo 产生的 skill 命令不带 sourceInfo（SessionCommand 有 sourceInfo 字段但内联对象没），点击后 CommandDocPanel 走 settings.skills 兜底（R5）。panel 态命令带 sourceInfo（来自 pi get_commands）。landing 与 panel 同一 skill 的 doc 面板行为不同。与 R5 相关，一并留后续。

4. **[设计级 / unverified] 端到端 reload 未实测**。W5 的 reload 编排（skill 变动 → builtin extension /__xyz_reload__ → ctx.reload）依赖真实 pi 子进程。单测覆盖了 orchestrator 逻辑（U10-U13）但未端到端验证：实际 skill 文件变动 → chokidar 触发 → onChange → orchestrator → promptReload → pi ctx.reload → get_commands 更新。需启动 xyz-agent dev 实测。

## test 未闭环说明（U1-U13 exact 匹配）

U1-U13（exact 类型）test 反复 fail 是 **exact 匹配机制与单测类 testCase 不适配**，非实现问题：
- E1/E2（exit_zero）全 passed——testRunner 真跑通（scripts/run-slash-tests.sh 执行 runtime 7 测试 exit 0）
- U1-U13 对应的实际测试全绿：skill-registry 3/3、reload-orchestrator 4/4、command-doc-panel 6/6、command-popover-landing 17/17、use-project-skills 5/5、rpc-client/session-service sourceInfo 透传断言、Landing.vue composerSid 改动 vue-tsc 0 错误。共 148 测试 passed。
- exact 匹配失败因 tdd_plan 写的 expected.text（期望描述）与 test 时 actual.text（实际描述）措辞不可能一字不差

修复方向（未来 topic）：单测类 testCase 统一用 exit_zero + testRunner 脚本（跑对应测试文件），不用 exact。
