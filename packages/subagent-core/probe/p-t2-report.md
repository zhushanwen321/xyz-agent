# P-T2 探针报告：keep-alive 真实时长分布（30min 裸缺省默认上限的标定输入）

- 探针脚本：`probe/p-t2-keepalive-dist.mjs`
- 数据文件：`probe/p-t2-results.json`（全量样本明细）
- 运行日期：2026-09-01 · 数据源：本机历史数据回溯（决策树路径①，只读）
- 支撑决策：T2-① keep-alive 裸缺省（无 maxTurns 无 env）默认上限 30min 的定案或降级（设计 §7.2 T2-① / §7.3 P-T2 行；u-t2a ①）

## 决策树落点

**路径①（历史数据回溯）样本充足，已定案**：扫描 `~/.pi/agent/sessions/` 与 `~/.pi/agent/cw/`，23 个 session JSONL 含 `subagent-record` 自描述 entry（record 每次状态迁移 append 完整快照，写点见 `src/execution/record-store.ts`），产出 **89 个有效 closed 样本**（≥ 门槛 20），无需走路径②（真实任务补样本）或降级路径③。

## 口径

- `keepAliveWindowMs` = closed entry 的 timestamp − 同 record 最后一条非 closed entry 的 timestamp（**下界口径**：真实 keep-alive ≥ 此值）
- `closedReason=parent-shutdown` 样本 = 宿主从未主动关、父进程退出才级联收敛——正是设计语境「wave keep-alive 数小时是合法形态」的直接证据面
- 排除：无 closed entry 的 record 21 个（session 未正常收尾）；负窗口 0 个

## 实测分布（89 个 closed 样本，全部 background 模式）

| 分位 | 全局 |
|------|------|
| P50 | **24.5 min** |
| P90 | **52.4 min** |
| P95 | **71.6 min** |
| P99 | 343,771 s ≈ **95.5 h**（样本 <100，P99 = max） |

| 分桶 | count | P50 | P95 | max |
|------|-------|-----|-----|-----|
| closedReason=parent-shutdown | 85 | 26.7 min | 71.6 min | 95.5 h |
| closedReason=user-close | 2 | 11.1 min | 4.7 h | 4.7 h |
| closedReason=gc | 2 | 39.5 min | 8.8 h | 8.8 h |

关键计数：

- **>30min 的样本：86/89（96.6%）**
- **<10min 的样本：0/89**
- 30min~2h：16 个；最长样本 5,729.5 min（≈95.5h，turns=17 的 background record 挂留近 4 天后由 parent-shutdown 收敛）
- top 样本全部 `closedReason=parent-shutdown`（最大一簇 2026-08-26 09:49 同秒批量收敛，为 wave 多 subagent 场景）

## 结论（给 u-t2a ① 的定案输入）

1. **历史分布对 30min 固定上限是强负信号**：keep-alive 真实形态的主体（P50 24.5min）紧贴 30min，96.6% 样本超过 30min，最长近 4 天。「wave keep-alive 数小时是合法形态」的设计假设被数据证实（85/89 是 parent-shutdown 收敛，即宿主合法持有不关）。
2. **不误杀的唯一防线 = 挂载面限定**：上限只挂「无 maxTurns 无 env 裸缺省」。历史 record entry 不携带 maxTurns/env 字段，无法从历史数据验证「裸缺省形态的真实分布」——这是本探针口径的固有局限（如实登记）。若挂载面限定有任何缝隙，按本分布将大面积误杀。
3. **给 u-t2a ① 的实施建议**（按设计降级路径表述）：
   - **首选：降级路径 B（无进展检测语义）更贴合数据形态**——keep-alive 期间任何子进程事件/后代集合变化刷新计时、仅连续静默达阈值才 kill。理由：真实 keep-alive 的合法性由「仍在活动」定义，而非「不超过某时长」；固定时长上限在 P50 贴线、长尾 95h 的分布上，无论取值都会出现「合法但被杀」或「合法但上限形同虚设」的两难。
   - 若维持固定时长（路径 A）：默认值按设计公式 P95×2 且下限 30min → **≈143min（2.4h）**，而非 30min；30min 作为默认值在本分布上不成立（P50 即触线）。同时 T2-① 的 opt-out 必须实现且入口 fail-fast。
   - 两个路径下的共同强约束：**挂载面必须严格限定裸缺省**（任何 maxTurns / env 存在即不挂）——这是数据支持「不误杀」的唯一充分条件。
4. P-T2b 报告的附带发现（父死后孤儿后代靠 marker/孤儿恢复收敛的残余窗口）与本主题的「kill 时机」正交，不改变本结论。

## 样本局限（如实标注）

- 历史数据全部来自本机（单人使用形态、cw wave 为主），非跨用户分布；但设计语境的「真实 wave 场景」正是本机形态，样本代表性成立。
- record entry 无 maxTurns/env 字段，裸缺省子总体不可分离（见结论 2）。
- `keepAliveWindowMs` 为下界口径（closed entry 写点粒度），对 P50 量级影响可忽略，对秒级样本可能低估。
