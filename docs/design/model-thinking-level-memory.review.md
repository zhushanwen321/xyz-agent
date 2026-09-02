# model-thinking-level-memory 设计审查记录

- 审查方：tech-design-review agent（agentId `agent_750c6d29-23d9-4aab-9ace-c4bef8415464`，同一 agent 保留上下文贯穿全部 4 轮）
- 被审文档：[model-thinking-level-memory.md](model-thinking-level-memory.md)（审查期间历经 4 轮修订，最终形态 = commit `b27c175ce`）
- 结论：**0 must-fix，设计就绪**（第 4 轮终检由审查方明示「修完可判就绪，主 agent 自查落实即可」，两点已自查落实）

## 收敛轨迹

| 轮次 | 形式 | must-fix | suggestion | 关键 findings |
|---|---|---|---|---|
| 1 | 全审 | 4 | 5 | MF-1 landing 自动初值污染记忆表；MF-2 armed 消费规则被 (a)(b)(b')(c) 三序列击穿；MF-3 A3 验收无效（同模型不触发 watch）；MF-4 A4 被内存 Map 遮蔽；SG-1 Out-of-scope 论据与 runtime 源码矛盾（model-service.ts:93-110） |
| 2 | 聚焦复审 | 2 | 4 | MF-A 门禁判别轴错位（sessionId 单轴挡不住 auto 值经首发透传，send.ts:179 → flow.ts:269,276-277）；MF-B staging 态 sessionId 非空、门禁与 B5 声称矛盾；SG-A armed 残留暴露面 (i)(ii)；SG-B 命中路径绕过幂等跳过 |
| 3 | 聚焦复审 | 2 | 3 | MF-C defaultModel 晚到路径 memory-aware 失效（`!current` 分支时序误判）；MF-D 「成功校正」被微任务次序击穿（flush 先于 await 续段，陈旧 token 延迟伪恢复）→ 定稿「成功清 + in-flight 豁免」；SG-E A2(a) re-select 构造退化 |
| 4 | 轻量终检 | 2 | 1 | MF-E 跟随 watch 缺 immediate（早到路径失效）；MF-F 规则 4/5 缺 callId 归属校验（并发连切误清）；SG-H E7 惰性加载窗口含初值路径。审查方明示修完自查即可 |

## 定稿机制（相对初版的关键演进）

- 记录门禁：双轴（已建态 + 非 staging 快照）+ landing 自动初值 memory-aware（`localAuthored` 标志 + 跟随 watch `{immediate:true}` + 变化触发，覆盖 defaultModel 早到/晚到双路径）
- armed 六防线：callId 归属校验（规则 4/5）、in-flight 按 callId 引用计数（规则 1）、匹配幂等消费（规则 2）、不匹配保留（规则 3）、成功清（规则 5，时序依据 = flush 先于 await 续段）、换绑清（规则 6）
- 被否谱系 7 条，每条附击穿反例事件序列（见设计文档 §3.3 被否项）

## 遗留（实施期门，非设计缺陷）

- §3.3 探针表前两条（armed 9 断言点序列族 / landing 跟随三行为 + 双路径污染反例）= U5 实施期单测门
- §5 检查点 2（真实模型 supportedLevels 同体系性）随 Gate B 真实验收确认
