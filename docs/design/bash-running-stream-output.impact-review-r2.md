# 影响面复审报告 r2（P0-12 / P0-19 / P0-20）

> 第 2 轮聚焦复审。审查人：tech-design-impact-review。不重查上轮已确认项（protocol 占位桶 / mock 链路 / apply-entry 只作用 end / extractGui 双源 / detail 无条件 spread 等）。

## Summary

2 must-fix, 2 suggestions.

上轮 2 must-fix 的修复方向均成立（MF1 的 ring 治理落到 U1 生产端截断 + D4 四要素，被否谱系三案均给出击穿反例；MF2 的 subagent 事实修正与源码一致）。修订方自列的四个「不放心的攻击点」中，**③ detail 绕过截断**经源码证伪（pi bash 首帧 `content: []` 且后续帧恒发 details 对象，detail 通道不携带文本）；**④ S5 可执行性**通过（`yes | head -c 2000000` 输出带换行、pi 自身 50KB 快照封顶，步骤真实可跑）；但 **① 量级论证**被发现存在双份携带的 2× 低估，**② 无换行单行的截断行为**确实未定义——两者都落在 D4 的 P0-20 量级/有界性声明上。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §6.4 量级要素 / §4 WS ring 代价段 / §6.5 方案对比总表 | P0-20 已接受代价量级错误 | 「ring 满载 ≤8MB」低估 2×：U1 payload 同帧携带 `output`（stripAnsi 后）与 `outputRaw`（截断后原文），二者从同一 ≤8KB 原文派生——ANSI 占比低的输出（大量 ANSI 转义被 strip 后仍接近 8KB）下两字段合计 ≈16KB/帧，ring 上界应为 ≈16MB；重连 snapshot 单消息同步同倍低估（§4「snapshot ≤8MB 单消息」、§6.4「最坏同量级（≤8MB）」）。显式判定的对象数字错了，判定本身（接受）需按修正后量级重述 | 三处量级统一改为 ≤16MB（或明确「单字段 ≤8KB、双字段帧 ≤16KB」推导式），显式判定按修正后数字重述；若想守住 8MB，可改为「截断后原文（outputRaw）≤8KB 且 output 由其派生不再单独计费」需要相应改 U1 规格，二选一 |
| MUST_FIX | §6.4 采用段 / U1（§7）normalizeWithTailCap 规格 | P0-20 有界性保证存在未定义分支 | 尾窗截断规则「从截断点后首个换行起保留尾窗」对**截断点后无换行的单行超长输出**（现实场景：单行 minified JSON / base64 块 / 无换行 curl 响应，pi 侧 50KB 快照内单行可 >8KB）行为未定义：无换行可锚时要么保整行（帧无界，D4「≤8KB」不变式被击穿、ring 上界失效）、要么保空（尾窗语义丢失）。S5 的 `yes` 用例全是换行输出，测不到该分支 | normalizeWithTailCap 显式定义 fallback：截断点后无换行时按字节硬截断至 cap（可接受半行/标注截断），保证不变式「截断后原文 ≤8KB」无例外；U1 单测补无换行用例 |
| SUGGESTION | §8.2 S5 回溯列 | P1-8 细节事实（不阻塞） | S5 回溯写作「目标 1（成本有界）+ 目标 3」——成本有界属目标 3（§2 目标 3「新增内存代价有界且显式判定」），目标 1 是可观察性；标号错位不影响场景本身 | 改为「目标 3（成本有界）+ 目标 1」 |
| SUGGESTION | §6.1 被否段第二 bullet | P1-8 可补实证 | 「（及首帧的整个 partialResult 对象）」提到首帧 detail 走 `details ?? 整个对象`，本轮已核实 pi bash 首帧为 `onUpdate({ content: [], details: undefined })`（bash.js `if (onUpdate)` 分支）——首帧整个对象进 detail 时 content 为空数组、不携带文本、无帧膨胀。建议补这句实证，防止下轮审查再对该分支发起同类攻击 | 在 §6.1 或 §7 回归面表补一行首帧形态实证（content:[] 空、体积可忽略） |

## 逐攻击点结论（修订方自列四点）

| # | 攻击点 | 结论 | 依据 |
|---|---|---|---|
| ① | 8KB 量级论证 | **击中（MF-1）**：双字段同帧 2× 低估；多 session 并发已在 D4 重审条件覆盖（>5 并发）、per-session ring 与源码一致（message-bus.ts:33/202），这两半不成立 | 见上表 MF-1 |
| ② | 无换行单行 >8KB | **击中（MF-2）**：截断规格未定义 fallback，有界性保证有例外分支 | 见上表 MF-2 |
| ③ | detail 通道绕过截断 | **不成立**：pi bash `emitOutputUpdate` 恒发 details 对象（`{truncation, fullOutputPath}`），`?? ` 不落穿；首帧 `details: undefined` 但 `content: []` 无文本 | bash.js emitOutputUpdate + `if (onUpdate) onUpdate({content:[], details:undefined})` |
| ④ | S5 可执行性 | **通过**：`yes xyz-agent-stream-check \| head -c 2000000` 输出带换行、SIGPIPE 正常收口；pi 快照自身 50KB 封顶（truncate.js DEFAULT_MAX_BYTES），帧链路 50KB→8KB（截断）真实可触发；重载窗口走既有 gap 恢复路径。注：S5 输入全为换行输出，恰好覆盖不了 MF-2 分支——这正是 MF-2 未被 S5 兜住的原因 | truncate.js:10-11 + S5 步骤推演 |

## 交叉引用一致性终检

| 链路 | 结论 |
|---|---|
| §1 目标 ↔ §4 代价声明 | 一致（§2 目标 3「有界且显式判定」↔ §4 ring 代价段↔ D4），但量级数字随 MF-1 连带修正 |
| §6.4 四要素 ↔ §7 回归面表 | 一致（WS ring 行引用 D4；useToolMeta 行与 S1 观察点对齐；subagent 行与 §9.3 复查项对齐） |
| §7 ↔ §8 验收 | 一致（S1-S5 各回溯目标，S4 覆盖判别式负面验证与 subagent 回归面） |
| §9.3 ↔ §6.1/§7 | 一致（subagent 复活复查项、AnsiText 成本、pi 其他工具三点均在前文有对应登记） |

除 MF-1 涉及的三处量级数字外，交叉引用一致。
