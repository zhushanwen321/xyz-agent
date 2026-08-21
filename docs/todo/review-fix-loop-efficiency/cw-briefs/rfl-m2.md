# rfl-m2：M2 打分与 eval（T7-T8，设计文档 §9 里程碑 M2）

## 任务背景

质量不可评：无打分手段；clean 终止路径有数据黑洞（all-clean 轮在聚合/reconcile 之前 break——末轮 fix 的对账与回归回填永不发生）；aggregator 固定用主模型（无降档省钱通道）。

设计文档：`docs/todo/review-fix-loop-efficiency/tier-1-cheap-wins.md` §6.6（4 维度 × 10 分制打分 + clean 轮黑洞修复）、§6.4（aggregatorModel 降档）、§6.7（eval 双层：客观回填权威、LLM 打分弱信号）、§7.2（scores round 语义与 clean 轮 entry 形态）。

## 目标

交付目标 5（质量可评）+ 6（聚合便宜）：
- T7：打分 rubric 进 aggregator prompt（**新增 prevFixResult 入参**——否则 aggregator 没有打分材料；reviewer 4 维度 evidence 40%/severity 20%/actionability 25%/reconciliation 15% + fix 4 维度 coverage 30%/self-check 30%/minimality 20%/regression 20%）+ scores 落盘 state.scores + regression 维度由 workflow 确定性回填（10 − 10×(regressed/fixes)，非 LLM）+ **clean 轮确定性对账回填**（all-clean 轮 break 前跑 reconcileIssues + 上轮 fix regression 回填，堵数据黑洞）。
- T8：aggregatorModel 参数（VALID_ARG_KEYS + pi-meta + 主循环 aggregator 调用 model: aggregatorModel ?? MODEL）+ usage 提示（模型路由参考 AGENTS.md，无条目先与主人确认）。

## 关键语义（设计钉死）

- scores.round = 被打分对象所在轮（R2 聚合给 R1 fix 打分 → round=1）。
- R1 聚合打 R1 reviewers（无上轮 fix）；R2+ 聚合打当轮 reviewers + 上轮 fix（LLM 三维度 coverage/self-check/minimality）。
- regression 维度永远 workflow 确定性计算：正常轮在 reconcile 后回填进上轮 fix entry；clean 轮（无聚合）由确定性回填创建 entry（LLM 三维度 null、total null、note 标注）。
- R1 无 fix 打分（无上轮 fix）。
- aggregator prompt 打分是弱信号（降档模型顺带做），客观层（状态机回填）才是 eval 权威——打分失败/缺失一律降级 WARN 不影响循环。

## 验收标准

见 spec.json（C1-C5）：rubric prompt、scores merge/backfill 纯函数、clean 轮回填、aggregatorModel 参数、e2e 全链路（R1 reviewer 分 + R2 fix LLM 分 + regression 回填 + clean 轮确定性回填 + fix-attempted→fixed）。
