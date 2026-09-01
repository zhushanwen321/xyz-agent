# P-T2c 探针报告：chatMode post-run（agent_end → agent_settled）真实时长分布

- 探针脚本：`probe/p-t2c-settled-window.mjs`（主）· `probe/p-t2c-compact-oneoff.mjs`（compact 量级附属实验）
- 数据文件：`probe/p-t2c-results.json`
- 运行日期：2026-09-01 · 环境：本机真实 pi CLI（`@earendil-works/pi-coding-agent` 0.84.2 dist 实装）+ 模型 `xiaomi-token-plan-cn/mimo-v2.5-pro` + `--mode rpc`，真实 LLM 网络往返，非 mock
- 支撑决策：T2-③ settled 等待固定硬上限（默认 10 分钟）定案（设计 §7.2 T2-③ / §7.3 P-T2c 行；u-t2a ③）

## 方法

pi `--mode rpc` stdout JSONL 事件行不带时间戳，探针在接收时以 `Date.now()` 打点。串行发多轮 prompt（等上一轮 `agent_settled` 到达才发下一轮），每轮记录 `agent_end` 行与 `agent_settled` 行的接收时刻差。轮次计划：3 轮短 prompt + 60KB / 120KB / 400KB 三档长上下文（400KB ≈ 100k tokens，逼近 auto-compact 阈值的尝试）。

## 实测数据（主探针，6 轮）

| 轮 | 标签 | prompt 大小 | turn 执行时长（ack→agent_end） | agent_end → agent_settled |
|----|------|------------|------------------------------|---------------------------|
| r1 | short-1 | 40 B | 2.3 s | **0 ms** |
| r2 | short-2 | 40 B | 2.9 s | **0 ms** |
| r3 | short-3 | 40 B | 1.6 s | **0 ms** |
| r4 | long-60KB | 60,000 B | 5.5 s | **0 ms** |
| r5 | long-120KB | 123,823 B | 22.3 s | **0 ms** |
| r6 | long-400KB | 412,335 B | 36.5 s | **0 ms** |

- 样本数 6；min = max = P50 = P99 = 0 ms（ms 粒度下，两事件行同 chunk 到达；精确表述为 **< 1–2 ms**）
- 全部 6 轮窗口内无 `compaction_start` / `compaction_end` 事件

## compact 场景（附属实验）

主探针 400KB（~100k tokens）一轮未触发 auto-compact（mimo-v2.5-pro 上下文窗大，未达阈值）——auto-compact 在窗口内触发的设计最坏形态**未能直接复现**，改用显式 `{"type":"compact"}` 命令测 compaction 执行耗时作量级代理：

| 指标 | 实测值 |
|------|--------|
| 上下文规模（3×400KB 填充后 input tokens） | 299,798 |
| 显式 compact 耗时（compaction_start → compaction_end） | **40,136 ms（40.1 s）** |

注：显式 compact 不在 settled 窗口语义内，此数据仅作 auto-compact 分支的量级参照。

## 结论

1. **维持 10min 默认硬上限（定案）**：正常形态 post-run 窗口实测 ≈0ms，与 10min 上限相差 **4 个数量级以上**；即便以 30 万 tokens 上下文的 compaction 耗时 40.1s 作最坏窗口代理，10min 仍有 ~15x 余量。设计文本「正常秒级、默认 10min 已是量级余量」获得实测支撑且偏保守。
2. 触达 10min 上限的唯一想象空间是「极端大 session + 慢模型的 auto-compact 长尾」，按探针失败分支（P99 接近或超过 → 上调 P99×10）的比例，即使按 40s 代理 ×10 = ~7min 仍在 10min 之内，无需上调。
3. 固定上界（非刷新语义）的合理性旁证：窗口内 6 轮全部无事件输出，wedged-but-chatty 形态在本环境未观察到，但一旦发生固定上界是唯一可收敛的形态（设计已论证）。

## 样本局限（如实标注）

- 样本 n=6（<100），P99 即 max；但 max ≈ 0 与上限差 4 个数量级，结论对样本量不敏感。
- **auto-compact 在窗口内触发的场景未直接复现**（400KB 未达该模型阈值），其窗口上限以显式 compact 40.1s 作量级代理而非实测。若未来模型/阈值变化使 auto-compact 常态化触发，建议复跑本探针并在 ROUND_PLANS 增大填充档位。
- 无 extension 形态（见偏差登记 D1）：extension 在窗口内的 agent_end handler 工作未计入，实测为下界。
