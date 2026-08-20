# cache-probe：前缀稳定性数据收集工具

设计文档：[docs/todo/cache-probe-design.md](../../docs/todo/cache-probe-design.md)。目标：把「gap<30min + 模型未切换」的 turn 首笔 cache miss 残差归因为「前缀变化（可修）」vs「服务端淘汰（不可修）」，为 resume 固化系统提示词方案提供 GO/NO-GO 依据。

组成：

- `extension/cache-probe.js` — pi 探针 extension（零行为影响，变化时写 `cache-probe` custom entry，含 9 个指纹 hash）
- `analyze.py` — 归因分析脚本（只读，单数据源扫 session 文件）

## 挂载方式

本地 pi CLI（数据收集期不进 builtin 清单）：

```bash
pi --extension <repo>/scripts/cache-probe/extension/cache-probe.js "<prompt>"
pi --continue --extension <repo>/scripts/cache-probe/extension/cache-probe.js "<prompt>"
```

探针经 `--extension` 加载必然位于 extension 链头（pi 源码 `resource-loader.ts` 的固定顺序），但 spFull/toolsSent 从 `before_provider_request` 的最终请求体提取，已是 LLM 实际收到的前缀，不受链位置影响。

已知限制（实测查明）：pi CLI 启动路径（`--session` / `--continue`）的 session_start reason 恒为 `startup`（`resume` 仅运行时 switch session 出现），因此 CLI 数据里 baseline entry 的 startReason 不区分新开/续开——跨进程识别靠 baseline 标记本身 + 时间戳 gap，漂移检测靠 hash 对比，均不受影响。同进程内修改 AGENTS.md 不会进入 system prompt（pi 启动快照），contextFiles 漂移只出现在跨进程边界——这是 pi 的行为，不是探针缺陷。

## 归因分析

```bash
python3 scripts/cache-probe/analyze.py ~/.pi/agent/sessions ~/.xyz-agent/pi/sessions
```

输出五部分：扫描概览 / 命中率基线 / 归因矩阵 / 进程边界漂移 / GO-NO-GO 决策建议。

## 收集期检查点（每日）

1. 跑一次 analyze.py，确认 `sessions_with_probe` 在增长、`error entries` 为 0 或已知原因
2. 抽查新 session 文件：`grep cache-probe <file>.jsonl | tail -3`，确认 entry 的 `hashes` 含 9 个 key 且为 64 字符 hex

## 终止标准与退役（对应设计文档 §8 场景 H）

- **终止**：归因矩阵 turn 数 ≥ 200 且跨 AGENTS.md 编辑 / extension 升级事件 ≥ 3 次（analyze.py 第 5 部分样本不足会提示继续收集）
- **GO**：前缀变化贡献 miss ≥ 50% → 探针转正进 builtin 清单与快照方案另立设计
- **NO-GO**：前缀变化贡献 ≤ 30% → 停止加载即退役；已写 entry 留在 session 文件无影响（xyz-agent 全链路已核实安全），归档设计文档结论
