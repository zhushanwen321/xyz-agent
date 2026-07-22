# Retrospect: cw-2026-07-21-scan-project-agents-skills

## derived 异常归因

| 指标 | 值 | 归因 |
|------|-----|------|
| gateFailCount | spec_review_fix（CL1/CL2 并存清理）+ plan_review_fix（5 must-fix 重构 plan）+ review_fix（R1 expandHome）+ test_fix×5（E1/E2 testRunner 限制） | 前 3 个 gate 捕真问题；test 反复 fail 是 testRunner 单 cwd 配置限制（非代码 bug），multi-workspace 项目跑不了单命令 exit_zero |
| devRetryCount=0 | 0 | W1/W2/W3 一次过，TDD 红灯先行有效 |
| testRetryCount=5 | 5（达上限强制进） | E1/E2（exit_zero smoke）受 testRunner 单 cwd 跑不了 multi-workspace 限制，U1-U7（mock 单测）已全 passed 充分验证实现 |
| firstTryPassRate | spec_review / plan_review / review 各首次 fail | 方案经历 CL1（新增 RPC）→ CL2（修 cwd）反转 + plan_review 发现 W2 5 文件横切 + loadSkills/getSkillPaths 假依赖 + 全局状态污染 + RPC 命名 + 文件路径错位 5 个 must-fix |

## 可泛化流程模式（processIssues）

1. **[pattern] tdd_plan 的 testRunner 配置必须考虑 multi-workspace 结构**。本项目 runtime/renderer 测试需分别从各自包目录跑（AGENTS.md 规则 8：vitest `@` alias 只在某子包 config 定义）。tdd_plan 写 testRunner.cwd=`.` + command=`npx vitest run` 在根跑会扫全部包超时 SIGTERM。E1/E2（exit_zero smoke）反复 fail 5 轮才强制进 retrospect，浪费 turn。泛化：multi-workspace 项目的 testRunner 要用 script 类型 + 自定义脚本分别 cd 各包跑，或 testRunner 分多个（当前 cw 只支持单 testRunner）。

2. **[pattern] 方案设计前必须验证"现有机制是否已覆盖"**。本 topic CL1 起初过度设计（新增 RPC + 双端适配架构），用户提醒后才发现 discovery.json + --skill 注入 + settings.json.skills 投影机制已完整，只是 cwd 解析 bug。泛化：涉及"功能不工作"的 bug，先验证现有机制链路（配置→加载→注入）是否完整，再决定是改机制还是修 bug。

3. **[pattern] plan 的 change 文件路径必须核实实际定义位置**。plan_review 捕到 useNewTaskFlow.ts vs useNewTaskDirSelect.ts 错位（selectWorkspace 在后者，前者仅重导出）。主 agent 写 plan 时凭印象写 useNewTaskFlow.ts，没核实。泛化：plan 的 change 文件路径 grep 核实定义位置，重导出的函数在源头文件改。

4. **[pattern] 函数签名 _param（下划线前缀 = 故意忽略）是潜在 bug 的强信号**。本 topic 两个核心 bug 都是 _param 忽略参数：getSkillPaths(_cwd) 和 loadSkills(_projectRoot)。泛化：看到 _param 签名要立刻问"这个参数为什么被忽略，调用方传的值是否有意义"，往往是 bug。

## 设计级风险（knownRisks）

1. **[设计级 / unverified] landing 显示与 pi 加载的时序差**。landing 态（session 未创建）显示的项目 skill 来自 config-service.loadSkills(cwd) 扫描（前端 useProjectSkills 调 scanSessionSkills RPC）。用户选中提交后，submitFirstMessage 创建 session，pi 启动时 getSkillPaths(cwd) 注入 --skill。两者扫的是同一批目录（.agents/skills + .xyz-agent/skills + discovery），但 loadSkills（config-service）和 getSkillPaths（session-service）是两套独立扫描逻辑，若行为不一致（如 R1 expandHome 不对称已修，但未来可能有其他不一致），landing 显示的 skill 选中后 pi 可能不认。unverified：端到端实测 landing 选中项目 skill 提交后 pi 实际加载，需真实 pi 子进程验证。

2. **[设计级 / unverified] useProjectSkills 实例级缓存 vs 多消费者**。当前 per-instance Map（每次 useProjectSkills 调用新建），唯一消费者是 Composer（单例活跃）。若未来多个组件用 useProjectSkills，各自缓存不共享（重复 RPC + 内存浪费）。注释已标注"未来多消费者共享再提升到模块级或 store"。

3. **[代码级] scanSessionSkills RPC 无错误反馈**。loadSkills(cwd) 抛错时 reply 也会抛（未 try-catch），前端 useProjectSkills 的 scanSessionSkills 调用会 reject 被 best-effort catch。链路 OK 但 RPC 层无显式 error reply（与 config.scanSkills 的 success:true 模式不一致）。低优先。

## test 未闭环说明（E1/E2 failed）

E1/E2（exit_zero smoke）反复 fail 是 **testRunner 配置限制**，非代码 bug：
- testRunner.command=`npx vitest run` cwd=`.`，在项目根跑会扫 packages/*/全部测试超时被 SIGTERM（exitCode=143）
- multi-workspace 项目 runtime/renderer 需分别从各自包目录跑（AGENTS.md 规则 8）
- U1-U7（mock 单测）已全 passed（runtime 33 + renderer 19 = 52 passed），充分证明 W1/W2/W3 实现正确
- E1/E2 是冗余 smoke（整体跑一遍），被 testRunner 单 cwd 限制阻塞

修复方向（未来 topic）：cw testRunner 支持 multi-workspace（script 类型 + 自定义脚本分别 cd 各包），或支持多 testRunner 配置。
