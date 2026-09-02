# llm-retry-settings 设计文档对抗式审查记录

> 审查对象：docs/design/llm-retry-settings.md（commit db569f2ef 及其第 1-3 轮修订，未单独提交，修订与记录同批提交）
> 审查方式：tech-design-review agent 对抗式审查（同一 agent 保留上下文多轮聚焦复审）
> 结论：**4 轮收敛，终轮（第 4 轮）must_fix == 0，设计就绪，可进入实现层。** 累计 findings 16 条（must-fix 3 + suggestion 13），全部修复进文档或吸收进验收步骤，无遗留。

## 收敛轨迹

| 轮次 | must-fix | suggestion | 击穿点摘要 | 修复 |
|---|---|---|---|---|
| 1（全面审查） | 1（MF-1） | 5（SG-1~5） | D8 `provider.timeoutMs=0` 语义与实装相反——「0=禁用超时」的 int32 映射只作用于全局 `httpIdleTimeoutMs`（sdk.js:188-190），provider.timeoutMs=0 原样透传成 0ms 立即超时 | D8 合法域改 1–600000 + 理由更正 + §2.2 补「0 陷阱」+ demo 同步；SG-1 存量超域值语义（D8 补充段）、SG-2 非 plain object 规则（D3）、SG-3 S4 前提（P3）、SG-4 行号、SG-5 S1 步骤 |
| 2（聚焦复审） | 1（MF-2） | 4（SG-6~9） | 第 1 轮修复引入的事实错误：rpc `set_model`/`set_thinking_level` 并不落盘 settings.json（`options.persist` 条件性且 rpc 入口不传，rpc-mode.js:367-374/:390 + agent-session.js:1252-1261/:1358-1366）；唯一无条件落盘 rpc 写点 = `set_auto_retry`（rpc-mode.js:430） | §2.2 补「pi rpc 面的落盘写点」bullet；S4 重锚 set_auto_retry；P3 改「已消解」；D2 删失准举例并登记 pi-settings-store.ts:8 注释失准（随 U4 修）；SG-6 全量校验取舍明示、SG-7 非 plain object 规则统一到任意层级、SG-8 configured 定义、SG-9 行号二次校正 |
| 3（聚焦复审） | 1（MF-3） | 2（SG-10/12） | S4「向活跃会话发 rpc」在 xyz 架构不可执行（sendCommand 为 rpc-client 内部方法 :457，transport 零透传）；S4 判定力缺口（enabled 断言恒真 + pi 异步 flush 假通过）；configured 对坏值未表态 | S4 改为验收脚本自 spawn 独立 pi 进程（PI_CODING_AGENT_DIR 既有机制 rpc-client.ts:172，零基建）；两编排确定性断言 + 到达确认 + 判定力声明；D7 坏值表态 + S7 第三用例 |
| 4（聚焦复审） | **0** | 2（SG-13/14） | 无 must-fix。SG-13/14 为 S4 验收脚本执行细则（轮询超时上限、stdin 报文平铺形态示例） | 已直接吸收进 S4（报文示例 `{"id":1,"type":"set_auto_retry","enabled":false}`、10s 轮询超时、编排 B 统一期望值条件） |

## 第 4 轮（终轮）审查结论原文摘录

> **总体判断：无 must-fix，设计就绪。** MF-3 的独立 pi 进程路径经全证据链核实成立（env 名 `PI_CODING_AGENT_DIR` 由 `APP_NAME="pi"` 派生、值形态与 `getPiAgentDir()`（pi-paths.ts:67-70）一致、pi 侧 config.js:421 确实消费该 env）；SG-10 的两编排重构消灭了恒真断言与假通过路径，判定力声明的逻辑经推演成立；SG-12 坏值表态与 D8 标注机制经「同款标注」锚定为单一体系而非两套。……交叉引用终检通过（§2.2 末条 ↔ S4 执行方式 ↔ D2 ↔ D3 ↔ D7 ↔ D8 ↔ S7 ↔ P3 ↔ U4 互引闭环无悬空）。
>
> **设计就绪结论：可以进入实现层。** 依据：三轮 must-fix（D8 timeoutMs=0 语义反转 / P3 rpc 写点事实错误 / S4 执行路径不可执行）全部修复且经源码逐条复核；文档全部 pi 语义声称（两层重试字段/默认值/退避公式/触发条件、锁协议、异步写队列、persistScopedSettings 键级 patch、PI_CODING_AGENT_DIR 机制、报文形态）与 0.84.4 实装一致；§1→§3 因果链（G1-G4 对应 D1-D8）与 §4 验收（S1-S7 真实依赖、可判定、逐条回溯目标）成立。

## 事实核查方法

审查 agent 对文档全部 pi 语义声称逐条与**实装编译 JS**（node_modules/@earendil-works/pi-coding-agent@0.84.4/dist、@earendil-works/pi-ai/dist）对照，第 2 轮起全部行号用 grep -n 锁定；xyz 侧声称与 packages/runtime、packages/core、packages/renderer 源码对照。主 agent 对三波 must-fix 的证据均做过独立复核（规则：审查方的修复方向也要重演验证）。
