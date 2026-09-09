# 审查报告：subagent-agent-end-recovery.md（第 3 轮 · 轻量确认终审）

> 审查人：tech-design-review（主审）。本轮聚焦 = 第 2 轮唯一 suggestion（D4 第三类差异面清单）的修复闭合判定 + 修订连带引入的新事实断言核实。不重查第 2 轮已确认项（修复验证表 / 新增核实通过项 / 攻击记录 a/b/d）。

## Summary

0 must-fix, 0 suggestion. 设计文档达到可实施终态（DoR 满足，三轮审查收敛）。

第 2 轮 suggestion 修复闭合：D4 差异清单三分法 MECE、「参数面各持现值不做统一取值」使行为不变替换可逐项对照、tee/EPIPE 归宿三层防线（决策声明 + 拆分项 + S8 验收断言）消除静默丢失面。修订连带引入的两组新事实断言（identity 尾行实测、判据落点层级事实）全部 read 源码实锚成立，且正文/拆分表/验收三处同步一致。

## Findings

无（本轮无新发现）。

## Suggestion 修复闭合判定（第 2 轮唯一 finding）

**判定：闭合。**

| 聚焦点 | 判定 | 依据 |
|---|---|---|
| 三类清单 MECE | 通过 | 分类轴完备互斥：**语义分叉**（行为逻辑不同 → 四维策略注入，D4 :238-243）、**参数面**（同机制不同取值 → 显式参数注入，:245）、**单侧附加面**（一侧独有 → 归宿声明，:247）。kill 语义的「共享默认 + 单侧覆盖」形态归语义分叉第 4 维，无跨类重叠；逐项扫描归一面无第四类遗漏（Runtime stderr 收集为纯内存 client 外壳行为，不挂在被替换的行读取原语数据流上，无静默丢失面，不需归宿声明） |
| 「各持现值不做统一取值」可对照性 | 通过 | :245 显式声明「归一后两侧以参数注入保持现值，不做统一取值（统一取值是行为变更，超范围）」——参数行为（get_state 预算/重试节奏/TTL/buffer 上限）由 S8 的 runtime 包全量测试守卫（现值行为有既有测试锚定）+ 会话行为一致断言对照；四维策略各声明两侧注入值，S8 断言覆盖第 1 维（早期帧缓冲）、第 2 维（迟到 response 丢弃 → 会话行为一致）、tee（第 3 维附加面）；kill 语义（第 4 维）由 runtime 现有测试链 + 打包三阶段覆盖且切换前后代码路径同一，无需独立断言——「逐项可对照」成立 |
| tee/EPIPE 静默丢失面 | 通过 | tee 三层防线：D4 归宿声明（随行读取原语暴露 hook，:247①）→ U7b 显式「hook 消费接回（piSessionLog 不丢）」（:316）→ S8 显式验收断言「pi-\<date\>-\<sessionId\>.jsonl 切换后仍持续写入」（:298）；EPIPE 计数归失败处理策略 + 计数状态随策略注入保留（:247②）+ U7b 重复声明（:316）。U7a 改动地图同步含「参数面/单侧附加面清单」（:315），实施面无悬空 |

连带确认：D3b 行号引用已修为 :2668-2711 → :2668-2671（:219），与 resolveRunOutcome 实装一致。

## 连带修改的新事实断言核实（修订摘要未列，文档声称「第 2 轮审查」击穿驱动）

两组设计变更伴随新事实断言，按「声称前必核实」纪律逐项实锚：

1. **identity entry 实测位于 session 文件尾行（D2 IO 模式从头部窗口读改为尾行定长读）——断言成立**。`extensions/universal/session-reader/src/discovery/subagents.ts:17-18` 与文档逐字对应：「identity 在 subagent 文件 **尾行**（非首行……实测 019fe635 的 identity 在 71/71 行）。故 header 读首行、identity 读尾行，两次定长读」；`core/execution-tree.ts:106-119`（readTailIdentity 读尾行）独立印证该机制非孤证。正文被否谱系（:203）、IO 量级声明（:209）、U2 改动地图（:310「identity 尾行定长读 + 全读 fallback」）、S9 探测方式（:299 轮询 identity entry）四处联动一致。
2. **D3a 判据落点从 agent-opts-resolver 改为 session-runner tools 汇合点——层级事实成立**。`worker-message-pump.ts:746` `resolveAgentOpts(opts)` 实锚，且全仓 grep 证实 agent-opts-resolver 的生产 import 方仅此一处（唯一生产调用方 = workflow 路径 dispatchAgentCall）；`session-runner.ts:1847` `agentTools: opts.agentConfig?.tools` 为两条入口的 tools 汇合点（工具路径与 workflow 路径均汇入 runSpawn → buildSpawnInvocation）。正文判据落点（:213）、被否谱系②（:217）、U3 改动地图（:311）三处同步。
3. **S9 前者对照组的隐含矛盾已被连带修正（正向改进，非我方 finding）**：初版「等握手成功再 abort」与「sessionFile 缺失」矛盾（握手成功 = sessionFile 已回填，扫描分支不可达）；修订后「wrapper 持续抑制 get_state + 轮询到 identity entry 再 abort」使「sessionFile 缺失 ∧ identity 已在盘」的前置条件自洽，场景可操作。

## 检查项覆盖（归口主审，第 3 轮增量）

| 检查项 | 判定 | 依据 |
|---|---|---|
| P0-11 关键事实 | 通过 | 连带修改的新断言全部实锚（见上节）；无未核实的新声明 |
| P0-13 验收可测性 | 通过 | S8 tee 落盘断言、S5 钩子落点（sessionDir 入参 + mkdtemp 对齐测试红线）、S9 修正后前置自洽 |
| P1-5 MECE | 通过（上轮 SUGGESTION 闭环） | D4 三类清单互斥完备（见闭合判定表） |
| P0-16 探针 | 通过 | ⛔ 检查点族维持 5 条且 identity 落点已由实测先例消解（尾行定长读落地，探针降级为确认项） |
| 其余归口项 | 沿第 2 轮判定，修订未触碰 | 不重查 |

**终态结论**：三轮收敛完成（3+1 → 0+1 → 0+0）。文档可进入下一层拆分实施（U1-U7b）。
