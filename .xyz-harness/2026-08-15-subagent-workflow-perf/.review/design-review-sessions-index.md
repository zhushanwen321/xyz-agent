# 对抗式审查报告：sessions-index-design.md

审查对象：`.xyz-harness/2026-08-15-subagent-workflow-perf/sessions-index-design.md`（sessions-index.json 持久化索引消灭冷扫描 2.7s）
审查依据：`rubric-design-doc.md`（P0-1..18 / P1-1..8）+ 项目 AGENTS.md 约定
源码核实：`extensions/subagent-workflow/src/execution/` 下 record-store.ts / session-reconstructor.ts / manifest-store.ts / alive-store.ts / path-encoding.ts / session-file-gc.ts / finalize-record.ts / session-runner.ts / record-store-cache.test.ts 全部 read 核实

## Summary

1 must-fix, 7 suggestions.

文档质量总体很高：五段骨架完整、结论先行贯穿每章、4 方案对比带长期/短期双维评估、运行时断言探针三类标注（含 P-l0 诚实标注「推理 + ⛔ 单测门」）、29 处源码行号引用逐一核实**零事实错误**。核心安全性质（陈旧索引只导致多余探测、不产生错误数据）的 per-entry 锚定戳论证在「pi 自身写入协议」前提下成立（append 必变 size；sidecar 覆盖写必变 mtime，与现有 L1 同族依赖，`record-store.ts:91` 注释确证）。

唯一 must-fix 在验收章节：§4.1 bench 基线模式的轮次设计存在**索引自污染**，按文档字面实现会测出与文档预期矛盾的结果，且输出等价断言的对比基准未定义——验收有效性受损。其余 7 条为边界披露与表述精确性建议。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4.1 步骤 1（bench 基线模式） | P0-13 / P0-14 验收不可测试 | **基线轮次被索引自污染，中位数预期自相矛盾**。步骤 1 只在 5 轮前 `rm -f` 索引一次；而每轮结束时按 §3.3.3-⑤「首轮扫描结束即写」（fire-and-forget 异步落盘，且 §3.3.3-④ 明确 dispose 不取消挂起写），同进程 tsx 跑 5 轮（每轮 new RecordStore 模拟新进程）时：轮 1 无索引全量探测 ~2.7s + 落盘，轮 2-5 loadIndex 全命中 ~0.3s → **5 轮中位数 ≈ 0.3s，与文档「预期（基线）：中位数 ~2.7s」直接矛盾**。连带两个失效：(a) 步骤 2「冷启动（索引命中）」与步骤 1 轮 2-5 走同一代码路径，两模式对比退化成同路径自比；(b) 「两模式输出完全一致」的 ground truth 未定义——若基线轮走索引路径，等价断言恒真（空断言）。另 bench 内置断言「chmod 000 仍返回全部记录」与「两模式输出一致」在 chmod 注入后互斥（无索引冷扫探测失败记录消失、有索引保留，见 SUGGESTION-2），两断言的执行时机未区分 | 基线模式改为**每轮 rm 索引后再计时**（或脚本内置 `--baseline` 每轮删索引）；等价断言明确以「步骤 1 轮 1（无索引全量探测）的输出」为 ground truth 对比索引模式输出；chmod 断言独立成不参与两模式对比的单独轮次 |
| SUGGESTION | §1 目标 2 / §3.4 P-safety-b / §4.3 C1 | P0-12 边界披露 | **「零行为变化」存在一个未披露的例外：jsonl 不可读时行为相反**。索引命中路径零内容读取 ⇒ chmod 000 / 磁盘坏块等「文件不可读」场景下，冷启动仍返回全部记录；而无索引冷扫描会探测失败（readIdentityHeader 的 openSync 抛 EACCES → undefined）→ 负缓存 → 记录消失（已核实源码 `record-store.ts:539-541` + `session-reconstructor.ts:539`，A1 测试注释「若实现退化回读文件，记录会消失」反向印证）。差异方向良性（保留比消失好），但：(a) 与目标 2「与无索引时完全一致」的绝对表述冲突；(b) C1 声称「镜像 A1 手法」语义不同——A1 验证热缓存、C1 实际演示的是冷启动行为差异，文档未意识到这一点 | 在目标 2 或 §3.4 披露：「唯一行为差异是文件不可读场景——索引命中仍显示上次探测结果（无索引则记录消失）；视为可接受的鲁棒性提升」 |
| SUGGESTION | §3.4 三环论证（P-safety-a/b/c） | P1-5 MECE（失败模式遗漏） | **三环论证遗漏「索引内容自身被篡改」这一环**。三环覆盖「jsonl 变了 / 没变 / 并发写」，但未覆盖「索引文件内容被外部篡改或位翻转，且不破坏 JSON 语法、字段类型仍过校验、锚定戳恰好匹配当前 jsonl stat」——此时返回错误数据（如 task 被改一个字符）。这是持久化相对 L1 内存缓存**真正新增**的风险面（L1 不落盘无此暴露）。概率极低（位翻转大概率破坏 JSON 语法；用户无动机手改缓存）+ §3.1 的 rm 恢复出口存在，故不阻塞 | 在三环论证后补第 4 条边界声明：「索引内容被外部篡改（类型校验通过且戳匹配）不在防护范围——与任何持久缓存（含 pi session 文件自身）同款暴露，rm 即恢复」 |
| SUGGESTION | §3.3.3-③（残留 tmp 清理） | P0-12 副作用遗漏 | **崩溃残留的 `.tmp.<pid>` 永久堆积，无任何清理路径**。已核实 GC（`session-file-gc.ts:59-71`）只在 `records/` 子目录内匹配 `.json`，`<enc>/` 下的 `sessions-index.json.tmp.<pid>` 不匹配任何清理规则；文档的「renamed 标志模式」只清理**自己本次写失败**的 tmp，其他进程 SIGKILL 留下的 tmp 无人清（manifest 侧有 ADR-035 recoverTmpFiles 兜底，索引侧明确不做了）。每次崩溃残留一个 ~350KB，速率低但单调增长 | 至少声明堆积成本；或 loadIndex 时顺带删除「mtime 超过安全阈值（如 1h，避开正在写的进程）的同前缀 .tmp 文件」 |
| SUGGESTION | §3.3.1 佐证 3 / §3.3.3-⑤ | P1-5 表述精确性 | **幽灵条目存续期语义未展开**。「文件被删除后对应条目由下一次索引重写自然修剪」成立，但 dirty 仅由「真实探测」驱动（§3.3.3-⑤），纯删除（如 GC 清理旧文件）不产生 dirty → 幽灵条目保留到下一次**因其他原因**触发的 dirty 重写；若用户此后无新探测，索引永久含幽灵条目。无害（读侧 readdir 后只查存在的 basename）但索引膨胀，且「自然修剪」的表述容易被读成「删除即修剪」 | 在 ⑤ 补一句：「删除文件不触发重写；幽灵条目惰性修剪——仅在下一轮 dirty 重写时消失，期间无害膨胀」 |
| SUGGESTION | §3.3.3-③ / §5 Task 1 | P1-8（实现边界） | **「校验规则镜像 isIdentityData」不覆盖锚定戳字段**。已核实 `isIdentityData`（`session-reconstructor.ts:244-254`）只校验 id/agent/mode/task/startedAt；索引条目还有 mtimeMs/size/negative/slug 等自有字段。损坏的戳字段（如 mtimeMs 位翻转为字符串）不会产出错误数据（严格相等比对永不匹配 → 每次冷启动重探测该文件），但条目永久失效 | Task 1 的校验函数明确列出锚定戳字段的 number 类型校验（`negative: true` 判别 + mtimeMs/size typeof number） |
| SUGGESTION | §4.2 判定 4 | P0-14（断言强度弱化） | **并发验收的输出对比只断言 id 集**，弱于 §4.1 的五元组 (id/agent/task/rootSessionId/status)。并发 + 随机 append/touch 恰是最可能暴露戳校验漏网的场景（如 touch 只改 mtime 触发重探测后 task 漂移），id 集一致不能捕获 identity 字段级不一致 | 判定 4 对齐五元组对比（ground truth 同步重新计算） |
| SUGGESTION | §2.1（identity 稳定性表述） | P1-8 表述精确性 | **「identity……之后几乎不再变化」与探测链语义并置易误导**。已核实：resume 时子进程 session_start hook 经 `PI_SUBAGENT_*` env + `pi.appendEntry` 写新 identity entry（`session-runner.ts:845-860`），append 到尾部——即 resume 文件可能**头部有旧 identity、尾部有新 identity**，而探测链 head-first（`record-store.ts:504-507`）对这种文件取的是**头部旧值**。这是现有行为、索引忠实复刻同一条链，零行为变化成立；但「65% identity 在尾 64KB」的分布说的是「头部无 identity 的补写形态文件」，不是「resume 文件的最新 identity 在尾部被选中」。读者可能误以为索引需要理解「最新 identity」语义 | 精确表述为「identity entry append-only（resume 追加新条目）；探测链按 head→tail→anywhere 既定顺序确定性选取，索引只持久化该确定性结果，选取语义不变」 |

## 逐项判定（P0/P1 清单）

| 项 | 判定 | 依据 |
|---|---|---|
| P0-1 五段骨架 | 通过 | §1-§5 全齐，§5 拆 4 task 且有独立验收 |
| P0-2 delta 链引用 | 通过 | 全文无「vN」「Rxx」「参见上版」，自包含 |
| P0-3 结论先行 | 通过 | 文首一句话结论 + SCQA；抽查 §1/§2/§3.3.3/§4/§5 首句均为该章结论 |
| P0-4 问题定义触根因 | 通过 | §2.4「纯派生量缺少持久化层」，有真实 2.7s 实测例子与 syscall 拆解 |
| P0-5 重实现轻体验 | 通过 | §1 使用者旅程锚定 + §3.1 终态使用者视角 + §3.2 被否方案落到例子的可感知取舍 |
| P0-6 抽象术语定义 | 通过 | light/full、锚定戳、last-writer-wins、sidecar 三件套、负缓存均首现定义并绑例子 |
| P0-7 方案对比 ≥2 | 通过 | A/B/C/D 四方案 |
| P0-8 长期/短期双维 | 通过 | 对比表两列显式评估；A 标注【长期方案·推荐】、B 标注【短期方案】 |
| P0-9 明确推荐 | 通过 | 推荐 A + 三条被否方案落到 §1 例子的后果推演（B 击穿 L0、C 可用性事故、D 覆盖面不全——D 的「manifest 仅 finalize 时写」已核实 `finalize-record.ts:156` 是唯一 writeManifest 调用点） |
| P0-10 解决根因 | 通过 | 因果链：探测结果持久化 + per-entry 戳校验 → 冷启动 186MB 内容读归零、7k stat 保留为正确性机制；stat 锚定覆盖变化检测，方案打在「缓存层次缺磁盘形态」根因上 |
| P0-11 关键事实错误 | 通过（未发现影响决策的事实错误） | 29 处行号/API 引用逐一 read 核实全部准确（record-store.ts:91/136/194/196/197/303/380/410/417/420/441/475/476/509/536；session-reconstructor.ts:129/244/484/490/569；manifest-store.ts:97/99/128/173；alive-store.ts:22；path-encoding.ts:33；session-file-gc.ts:62；test:94/244）。A1-A4/B1-B5/D1-D2 既有测试存在（D1/D2 在 test:292/317） |
| P0-12 副作用/遗漏 | 可能不完整 | 多进程并发写、GC 交互（已核实佐证 3：`<enc>/` 下非 records/ 的 .json 不被 GC 匹配）、回滚兼容、Windows rename、版本振荡均有覆盖；遗漏项见 SUGGESTION-2/3/4/5（均不阻塞） |
| P0-13 验收可测试 | **不通过** | §4.1 基线模式轮次设计自相矛盾（见 MUST_FIX-1）：按字面实现测得 ~0.3s 与预期 ~2.7s 矛盾，且等价断言的 ground truth 未定义 |
| P0-14 验收真实/非抽象 | **不通过（同源）** | 真实目录副本 + 双场景 bench 的框架是对的（非单测/mock）；但两模式对比因基线污染退化为同路径自比，chmod 断言与一致性断言互斥未区分时机（MUST_FIX-1）；另 §4.2 判定 4 断言强度弱化（SUGGESTION-7） |
| P0-15 验收投入匹配 | 通过 | 新增持久化缓存层 → 2 个 bench + 8 单测 + 既有全量回归 + 每 task 独立验收 |
| P0-16 运行时断言探针 | 通过 | §3.4 九项探针三类标注；P-l0 诚实标注「推理 + ⛔ C6 门」；P-baseline/P-dist 标 ✅ 且附可复现方法；⛔ 项全部绑定 §4 验收/单测条目 |
| P0-17 物理数据流图 | 通过 | §2 ASCII 图标注磁盘路径（`<agentDir>/subagents/<enc>/sessions/`）→ 进程内 → 用户眼前 |
| P0-18 错误恢复指引 | 通过 | §3.1 失败路径表：rm 命令 + `PI_EXT_DEBUG=1` 日志路径 + 「无需动作，自动恢复」 |
| P1-1 关键概念例子 | 通过 | 锚定戳带具体数值例子（§3.3.3-①）；a.jsonl 探测例子 |
| P1-2 拆分 justification | 通过 | §5 四条「为什么这么拆」+ task↔§4 验收映射 |
| P1-3 受众背景 | 通过 | §1「系统是什么」段 + 读者定位声明 |
| P1-4 alternatives 记录 | 通过 | 文件锁/跨进程 merge/目录级单戳/TTL/dispose 时写/per-record sidecar/SQLite/manifest 全部记录否决理由 |
| P1-5 MECE | 可能不完整 | 三环论证遗漏「索引自身篡改」环（SUGGESTION-3）；其余失败模式分组无重叠 |
| P1-6 减法优先 | 通过 | sidecar 戳不入索引、不做 merge、不做 recoverTmp、不做 TTL/分片/压缩——多处选择不加机制 |
| P1-7 scope 越层 | 通过 | 层次声明「技术方案层 → 实现任务层」，接口只给数据形状不给函数级逐行设计 |
| P1-8 细节事实错误 | 少量 | 「几乎不再变化」表述（SUGGESTION-8）、校验镜像不完整（SUGGESTION-6）；均不影响决策 |

## 对抗式核心问题复核（任务指定四问）

1. **{mtimeMs, size} 锚定戳覆盖所有变化路径吗？** 在 pi 自身写入协议内覆盖：jsonl append 必变 size（identity 唯一变化路径 resume 是 append）、sidecar 覆盖写必变 mtime（但 sidecar 不入索引）。反例仅存在于外部工具场景（`cp -p` 保留 mtime + 同 size 覆写 identity entry、编辑器保 mtime 模式）——同样打败现有 L1 内存缓存（`record-store.ts:91` 注释「append-only jsonl 必变 size」是同一依赖），文档「不新增风险面」声明成立。**但风险敞口时长从进程生命周期（分钟-小时）拉长到永久**，文档未点明这一量变——归入 SUGGESTION-3 的边界披露，不阻塞。
2. **identity「一旦确定永不变」的前提有反例吗？** resume append 新 identity（同 id、字段可更新）、fork 走新文件（新 basename → 索引 miss）——均被「append 必变 size → 戳不匹配 → 重探测」覆盖。model/thinkingLevel 的 best-effort 差异（tail 探测拿不到途经 model_change 返回空串）：已核实 `getFullRecord`（`record-store.ts:557-582`）的 full 是独立走 `reconstructFromFile` 全量重建、不消费 light 的 model，**懒加载路径不受索引固化影响**。真正的表述瑕疵是 head-first 探测对「头部有旧 identity 的 resume 文件」取旧值（现有行为、索引复刻），见 SUGGESTION-8。
3. **last-writer-wins 交错丢条目的后果？** 成立且无害：慢扫描进程（2.7s 前开始 readdir）的快照缺新文件条目、或含旧锚定戳条目——读侧 per-entry 戳校验使两者都只导致「下次冷启动对该文件多重探测一次」（文档 §4.4 的 ≤1.5ms/文件 损失评估自洽：2.7s/1744 ≈ 1.55ms）。「陈旧索引永不产生错误数据」论证链在 (a)(b)(c) 三环内成立，第 4 环（索引自身篡改）见 SUGGESTION-3。
4. **tmp(pid)+rename 与 L0 的交互？** 正确：tmp 与最终文件都在 `<enc>/`（sessionsDir 的兄弟），rename 改的是 `<enc>/` 的 mtime；L0 dirStamp 监听的是 `<enc>/sessions/` 的 mtime（`record-store.ts:420-422`），两者物理不同目录，索引写不击穿 L0。P-l0 标注「推理 + ⛔ C6 门」诚实。反向也无问题：sessions/ 内变化不波及 `<enc>/`。
