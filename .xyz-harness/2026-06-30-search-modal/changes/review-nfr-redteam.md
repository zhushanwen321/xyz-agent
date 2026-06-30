---
verdict: APPROVED
machine_check: PASS
dimension: redteam
review_mode: parallel
---

# 红队审查 — 必要性与比例性（search-modal NFR）

> 独立红队 fresh context。只跑「过度设计 / 不合理」反方质询。
> 机器检查：脚本报 7/8 passed → 1 FAIL，但该 FAIL 仅是 `review-nfr.md 不存在`（红队产物是本文件 `review-nfr-redteam.md`，属预期，按指令不计阻断）。NFR 文档自身全部结构性检查通过。**machine_check = PASS。**
> 方法论：对每个 ⚠️ 维度缓解 / 新建 issue / D-决策做 deletion test，并**对照源码核验威胁真伪**（ws-client.ts / pending.ts / useDetailPane.ts / file-service.ts）——区分「真威胁」与「agent 脑补」。

## Verdict

**APPROVED** — 未发现构成 CHANGES_REQUESTED 的过度设计。

核心结论：本 NFR 文档在比例性上**表现克制**（多次主动降级/拒膨胀，见下），14 条缓解项的验收方式（代码测试 vs 骨架约束）划分恰当，三处追踪发现的威胁经**源码核验均为真威胁非脑补**。仅有 2 条可选优化建议（AC-6.9 有更简替代 / 10s 阈值需⑤实测确认），均不阻断。

## 过度设计发现

### 1. F-1 → 新建 #17（WS 超时 race）— ✅ 不是过度设计，威胁为真、方案取了更轻项

**deletion test：删掉 #17 会怎样？**
- **威胁真伪（源码核验）**：`ws-client.ts:101-106` 的 `onclose` 只 stopHeartbeat + scheduleReconnect，**不 reject in-flight pending**；`pending.ts` 仅有 resolve/reject by-id，**无 clear/flush**；`useConnection.ts` 无任何「state→disconnected 时 flush pending」逻辑。→ WS 断连（runtime 崩溃/重启是现实场景，代码已有指数退避重连佐证其现实性）时 file/session 源 pending **永不 settle**，`Promise.allSettled` 永久 await，浮层永久 loading 挂死。**真 UX 阻断级 bug，非脑补。**
- **方案选择是否最小可行**：D-023 **明确拒绝了方案 B**（transport 层 onclose reject 全部 in-flight pending）——那是更彻底的根因修复，但影响面波及所有 9 个 WS domain 消费者，属跨 topic 共享基建。agent 选**方案 A**（domain 层超时 race），是两者中**更轻、更局部**的选项。非过度。
- **新建独立 issue vs 并入 #4**：#4 已承载 loadSeq/缓存/冒泡链多个并发关注点，再加 WS 超时 race 会超载单 issue 并发面。#17 独立 P1 + blocked_by #4 + 被 #8 依赖，拆分利于独立跟踪与回归。合理拆分，非为拆而拆。
- **10s 阈值合理性**：`file-service.ts` 中 `searchFiles` 全量递归**本身无 runtime 超时**（只有 `file.read` 经 `callFs→withTimeout` 用 `READ_TIMEOUT_MS=10_000`），故 NFR「对齐 runtime 现有超时约定」措辞略不精确——但 10s 作为「永不 settle」安全网（非为约束正常搜索耗时）是 generous 的（本地 fs 递归 5000 文件常 <5s），不易误杀慢但成功的查询。**注**（可选优化，非阻断）：⑤test-matrix 宜用项目内最大真实仓库实测确认 10s 不触发假阳性（大 monorepo 全量递归是否可能逼近阈值）。
- **结论**：保留。建议降级方案：**无**（已是更轻选项）。

### 2. GAP-2 → AC-6.9（file 跳转吞错层）— ⚠️ 威胁为真，但缓解方案存在更简替代（可选优化，非过度）

**deletion test：删掉 AC-6.9 会怎样？**
- **威胁真伪（源码核验）**：`useDetailPane.ts:89-92` 的 `openPreview` catch 确认**吞错**（`state.value.status='error'; state.value.error=...`，**不 re-throw**）。若 useSearchJump 调 openPreview 后依赖自身 catch 触发 toast，则 catch 永不触发，AC-6.5「file.read 失败→toast」假性 PASS。与 #4 AH-E1/E2（useFileSearch.load 吞错层）**同构**。真问题，非防御性过度。
- **缓解方案是否最小可行**：NFR 选「file 跳转直调 `fileApi.read` 校验不经 openPreview 吞错层」。这成立但**略别扭**——#6 文件跳转的目的本就是「在 DetailPane 打开预览」（UC-3 AC-3.2），直调 fileApi.read 仅校验后仍需调 openPreview 显示 → 可能**双读**（read 被调两次）；或需在 #6 重写 openPreview 的显示逻辑。
- **更简替代（未在 NFR 中评估）**：让 `openPreview` 在设 `status='error'` 后 **re-throw**（catch 末尾加 `throw e`，1 行），则 useSearchJump 正常调 openPreview + 其 catch 自然触发 toast，无双读、无旁路。代价是 useDetailPane 自身 `watch`（:140 `void openPreview(...)` 无 try/catch）需补 catch 防 unhandledRejection——属本 composable 内部协调，影响面仍局限。
- **结论**：D-024 标 `D-可逆` + `agent-opinionated`，可正常质疑。但这是**实现路径取舍**而非结构性过度设计——两种方案（旁路 read / re-throw）皆可，NFR 选了局部化的一种。**不阻断**；仅列为可选改进：⑤骨架实现时若发现双读别扭，可改用 re-throw 方案（AC-6.9 的约束本质「file.read 失败须能被 useSearchJump catch 捕获」仍满足）。建议降级方案：**AC-6.9 措辞可软化**为「file 跳转失败须确保 useSearchJump 能捕获并 toast（直调 fileApi.read 或令 openPreview re-throw 二选一）」，避免过早钉死实现路径。

### 3. 14 条缓解项验收方式扫描 — ✅ 划分恰当，无过度测试

逐条 deletion test（缩写）：

| 缓解项 | 验收方式 | 红队判定 |
|--------|---------|---------|
| MR-3.1/3.3（localStorage try/catch + 配额降级） | ⑤test-matrix 代码测试 | ✅ 基础健壮性，恰当 |
| MR-3.2（key 命名空间） | ⑤骨架约束 | ✅ 仅 key 名，最小 |
| MR-3.4（FIFO 淘汰用例） | ⑤test-matrix | ✅ 真并发竞态（同毫秒 write），恰当 |
| MR-4.1（loadSeq 守卫迁移） | ⑤骨架约束 | ✅ **D-022 显式拒生成重复 NFR-AC**——反膨胀纪律，正确 |
| MR-4.2（单源 reject 静默 vs 全源失败 toast） | ⑤test-matrix | ✅ 真 UX 区分（噪音 vs 反馈），恰当 |
| MR-4.4（缓存失效竞态 K-3） | ③issues 新 AC-4.10 | ✅ 真威胁（CommandPopover 未挂载→stale cache→搜不到刚改文件），自绑 watch 合理 |
| MR-4.5（error 冒泡链） | 已在 AC-4.5 | ✅ 假性 PASS 防护，真问题 |
| MR-6.2（file 跳转吞错层） | ③issues 新 AC-6.9 | ⚠️ 见上条 2，威胁真/方案可优化 |
| MR-7.1（debounce setTimeout + 孤儿查询守卫） | ③issues AC-7.14 补充 | ✅ close 触发孤儿查询（query=''→loadResults）是真资源浪费，open flag 守卫最小 |
| MR-8.1（loading setTimeout 清理） | 已在 AC-8.4 | ✅ 基础资源卫生 |
| MR-17.1（WS 超时 race） | ③issues #17 | ✅ 见条 1 |

**无「把简单风险塞进⑤test-matrix 过度测试」的现象**——相反，D-022（loadSeq 降骨架约束不进 test-matrix）+ 删除 AC-1.5（>200 字符查询标比例失当降级）两处体现了主动反膨胀。验收方式划分（代码测试 vs 骨架约束）与风险性质匹配。

### 4. D-023 / D-024 / D-025 决策 — ✅ 无可证伪的过度

- **D-023（F-1 新建 #17）**：`D-不可逆` + `confirmed_by ask_user`（用户拍板）。按红队铁律，须有「新证据证明过度」才能建议降级。源码核验威胁为真，方案取更轻项，无过度证据 → **保留**。
- **D-024（GAP-2 AC-6.9）**：`D-可逆` + `agent-opinionated`，可正常质疑。见条 2——实现路径可优化但不构成过度设计。
- **D-025（GAP-BL-1 DTO 映射）**：**事实性修正**（real 源返回 FileNode/SessionSummary/SessionCommand，非 SearchItem 形态，requirements.md:137/192 佐证）。不做 DTO 映射则 real domain 返回类型错误——这是**正确性必需**，非锦上添花。**保留**，无降级空间。

### 5. 残余风险登记的反过度设计纪律（正面记录）

NFR 多处体现「接受残余风险而非过度建设」的克制，值得记录（非发现项，是比例性正面佐证）：
- toast 错误文本含绝对路径/内部 code（GAP-BL-2）→ **接受为残余风险**（桌面单用户、诊断价值 > 泄漏），未建脱敏层，明确「后续多用户/远程模式再引入」。
- session.list 全量扫描耗时 → **接受**（YAGNI，后续按需加分页/索引），未本期实现索引。
- AC-1.5（>200 字符查询截断）→ **红队已降级删除**（手敲无粘贴路径，线性 indexOf 非嵌套，复杂度高估）。

这些是 agent 在比例性上的**正确判断**，反向印证本文档未陷入过度防御。

## [CROSS-VALIDATED] 与对齐组冲突

无（红队未判任何对象需结构性删除；仅 AC-6.9 标「实现路径可优化」，与对齐组的「AC 完整性」无冲突——AC-6.9 的存在本身是补完整性，红队只建议软化措辞）。

## 必须修改

无（APPROVED）。

## 可选改进（非阻断）

1. **AC-6.9 措辞软化**：将「直调 fileApi.read 不经 openPreview」放宽为「file 跳转失败须确保 useSearchJump 能捕获并 toast（直调 fileApi.read 或令 openPreview re-throw 二选一）」，避免过早钉死实现路径、规避双读别扭。⑤骨架实现时据实际复杂度裁决。
2. **#17 的 10s 阈值实测**：⑤test-matrix 用项目内最大真实仓库实测 file.search 全量递归耗时，确认 10s 不对慢但成功的查询产生假阳性；必要时上调或改为「对齐 file.read 的 READ_TIMEOUT_MS（10s）」的精确措辞（当前「对齐 runtime 现有超时约定」略含混——searchFiles 本身无 runtime 超时）。
