# sessions-index 冷扫描实测证据（2026-08-15 采集）

> 对应设计文档 `sessions-index-design.md` §4.1（性能验收）与 §4.2（并发验收），实现 commit `e7011cdaa`（索引模块 + RecordStore 接入）、`38fd30433`（bench 脚本 + 实测数字回填）、`55af6815c`（bench 守卫补强）。本文是 §5 Task 3 要求落盘的 cold 报告，数字与设计文档 §4.1 回填值同源。

## 0. 结论（先行）

**目标达成**：真实 sessions 目录副本（1744 jsonl / 671MB / 1633 条记录）上，冷扫描（新进程首次 collectRecords）中位数 **972.8ms → 80.6ms，提速 12.1x**，预算 ≤300ms PASS（断言 A2）。输出等价（五元组与无索引全量探测的 ground truth 完全一致，1633 条，A1）、索引落兄弟位置且 sessionsDir 零新增（A3）、chmod 000 后全部记录仍经索引返回（零内容读取，A4）均 PASS。

| 模式 | 轮 1 | 轮 2-5 | 5 轮中位数 | 判定 |
|---|---|---|---|---|
| 基线（每轮 rm 索引，真冷启动） | 2069.7ms | 874.6-1232.0ms | **972.8ms** | 仅报告，无阈值 |
| 索引命中（冷启动） | 80.6ms | 69.1-97.8ms | **80.6ms** | **≤300ms PASS**（A2） |

成本分解（80.6ms 的构成，均有隔离测量）：

| 成本项 | 实测值 | 说明 |
|---|---|---|
| 索引文件体积 | **6.4MB**（1744 条，均值 ~3.7KB/条） | 真实 task 文本远长于设计估算 ~200B/条（350KB → 6.4MB 约 18x，「体积涨一个量级仍在几十 ms 量级」的结论经实测仍成立） |
| 隔离解析（readFileSync+JSON.parse，5 轮中位数） | **30.4ms**（19.4-34.1ms） | 冷启动 80.6ms 的其余部分为 ~7k stat syscall + sidecar 小文件 + 记录构造 |
| 写放大（P-throttle） | 60 次扫描 + 单进程 gt 扫描仅观测到 **1 次**索引变化 | mtime 口径（每 iter 末观测一次）；60s 节流 + 纯命中轮不写 |

## 1. 采集环境

- 时间：2026-08-15（数字随 `38fd30433` 回填设计文档 §4.1，同源）
- 机器：本地 macOS（bench 在本机真实数据副本上跑，不进 CI）
- 被测代码：本 worktree（feat-subagent-continuous-chat）commit `e7011cdaa` 起的实现；实测跑于 `38fd30433`（bench 就绪）后
- 数据：真实 `~/.pi/agent/subagents/` 下最大 `<enc>` 段的 `cp -R` 副本——1744 个 jsonl / sessions 目录 671MB，其中 1633 条记录 + 111 个无 identity 文件
- 体积口径：设计文档文首「586MB」是早前对原目录的历史测量值；本报告 671MB 是 /tmp 副本值（文件数相同，差额来自 cp 块对齐/文件系统分配粒度差异，非数据量变化）

## 2. 断言判定（cold-scan bench 内置，任一失败 exit 1，实测全 PASS）

| 断言 | 内容 | 结果 |
|---|---|---|
| A1 | 两模式输出的 `(id, agent, task, rootSessionId, status)` 五元组与 **--baseline 轮 1（无索引全量探测）** 的 ground truth 完全一致（对比基准是真全量探测输出，非索引路径自比） | PASS（1633 条一致） |
| A2 | 索引命中模式中位数 ≤300ms | PASS（80.6ms） |
| A3 | 索引落 `<enc>/sessions-index.json` 兄弟位置；sessionsDir 内 readdir 相对脚本启动时快照无新增文件 | PASS |
| A4 | chmod 000 全部 jsonl 后新实例首扫仍返回全部记录（零内容读取；与无索引冷扫「不可读文件记录消失」是良性的行为差异方向，故单独成轮不参与 A1 等价对比；win32/root 下退化为恒真自动跳过） | PASS（1633 条全经索引返回） |

## 3. 并发验收（P-throttle 观测来源）

`concurrent-scan.bench.ts`：同进程内 3 个 RecordStore 实例 × 20 轮 collectRecords（同进程多实例交错，非跨进程并发——写路径 tmp(pid)+fsync+rename 与跨进程相同，交错已覆盖 rename 竞争窗口），外部随机 append（不含 identity 特征串，ground truth 固定）/touch（仅 mtime）制造变化。四判定（D1 无未捕获异常 / D2 索引 JSON.parse 成功且含 version / D3 无 `.tmp.` 残留 / D4 每实例每轮五元组与单进程 ground truth 一致）全 PASS。写放大即 §0 表中「60 次扫描仅 1 次变化」的观测来源。

## 4. 复现命令

bench 以 `tsx` 直跑（**不进 vitest**：`vitest.config.ts` include 仅 `src/**/__tests__/**/*.test.ts`；不进 CI，本机数据依赖）。先复制真实目录副本——两个 bench 都拒绝在真实数据目录 `~/.pi/agent/subagents` 下运行（`55af6815c` 守卫，路径从 `os.homedir()` 动态推导），并发 bench 的 append 会不可逆污染真实 session 文件：

```bash
cd extensions/subagent-workflow

# 0. 复制真实目录副本（任取一个含 subagent 记录的 <enc> 段；空段会被判 0 恒真守卫拒绝）
ENC=$(ls ~/.pi/agent/subagents | head -1)
mkdir -p /tmp/bench-enc && cp -R ~/.pi/agent/subagents/$ENC /tmp/bench-enc/

# 1. 基线（无索引真冷启动）：--baseline 每轮 rm 索引——否则轮 2-5 命中上一轮
#    落盘的索引走快速路径，中位数会被测成 ~0.3s（与基线自相矛盾）
npx tsx bench/cold-scan.bench.ts /tmp/bench-enc/$ENC/sessions --rounds 5 --baseline
#    轮 1 输出（真全量探测）持久化为 ground truth（gt 文件路径见运行输出）

# 2. 冷启动（索引命中）：中位数断言 <=300ms
npx tsx bench/cold-scan.bench.ts /tmp/bench-enc/$ENC/sessions --rounds 5

# 3. 并发（3 实例 x 20 轮 + 随机变异四判定）
npx tsx bench/concurrent-scan.bench.ts /tmp/bench-enc/$ENC/sessions --workers 3 --iters 20

rm -rf /tmp/bench-enc   # 跑完清理副本
```

30.4ms 隔离解析的最小复现（`<indexPath>` = 副本的 `<enc>/sessions-index.json`；5 轮各计一次 readFileSync+JSON.parse 墙钟，排序取 `t[2]` 即中位数）：

```bash
node -e 'const f=require("fs");const t=[];for(let i=0;i<5;i++){const s=Date.now();JSON.parse(f.readFileSync("<indexPath>","utf8"));t.push(Date.now()-s)};t.sort((a,b)=>a-b);console.log(t[2])'
```

gt 文件按 sessionsDir 绝对路径哈希存 `os.tmpdir()`，跨两次调用共享 ground truth；目录内容变化后需先重跑 `--baseline` 刷新（gt 记录了来源 sessionsDir，不匹配即报错）。

## 5. 已知接受的残留（设计 §4.4，非缺陷）

- stat 校验（~7k syscall，几十 ms）保留——它是变化检测的正确性机制，不属于「重复探测不变量」。
- 首代并发冷启动仍各自全量探测（多实例无共享内存，首个落盘者之后命中）。
- 多进程下索引写入 last-writer-wins，个别文件的探测成果可能被后写者快照覆盖丢失 → 下次冷启动重探测一次（每次损失 ≤1.5ms/文件）。
