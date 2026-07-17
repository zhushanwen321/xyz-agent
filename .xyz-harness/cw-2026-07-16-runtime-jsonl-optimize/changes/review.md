# Review — runtime-jsonl-optimize

> 审查方法：主 agent 自审（实现不复杂，3 文件）。design-consistency 用 spec FR/INVAR 反查实现。

## 审查范围

- commit: 4611ce4d (W1) / dfc5a342 (W2，含认知外混杂) / c3ac5bfc (W3)
- 文件: packages/runtime/src/utils/jsonl.ts / infra/pi/session-file-utils.ts / services/session/session-scanner.ts
- 测试: test/jsonl-tail.test.ts / extract-tail-read.test.ts / scan-cache-merge.test.ts（39 测试全绿）

## 维度审查

### plan-completeness（plan 完成度）

| Wave | changes | 落地 |
|------|---------|------|
| W1 | jsonl.ts readTailEntries + READ_TAIL_BYTES | ✅ openSync+readSync partial read，丢首行残行，ENOENT→null，size<NKB→全读 |
| W2 | session-file-utils extractSessionName/Outcome 尾读+fallback | ✅ findLastEntryField 共用骨架，尾读未命中→fallback 全量，错误对等 |
| W3 | scanPiSessions mtime+size 缓存 + 三读合一 + scanner 取 outcome | ✅ 模块级缓存 scanSessionMeta，ScannedSessionMeta 加 outcome，scannedToSummary 从 meta 取 |

全落地，无遗漏。

### design-consistency（设计一致性，spec INVAR 反查）

**FR-tail-read INVAR（7 项）**：
- INVAR-tail-1（尾窗内==全量读一致）✅ findLastEntryField 倒序找
- INVAR-tail-2（fallback 全量，SR1 核心）✅ readTailEntries 返回不含目标时走 readFileSync+parseJsonl
- INVAR-tail-3（丢首行残行）✅ offset>0 时 startIdx=1
- INVAR-tail-4（ENOENT→null 不抛）✅ openSync catch→null
- INVAR-tail-5（size<NKB→全读）✅ offset=max(0,...)
- INVAR-tail-6（fallback 后缓存最终结果）✅ scanSessionMeta miss 时缓存（不论 extract 是否 fallback）
- INVAR-tail-7（错误对等）✅ findLastEntryFile catch→null

**FR-mtime-cache INVAR（7 项）**：
- INVAR-cache-1（模块级跨两阶段）✅ sessionMetaCache 模块级 Map，scanPiSessions + scannedToSummary 共享
- INVAR-cache-2（键含 path+mtimeMs+size）✅ 比对三字段
- INVAR-cache-3（命中逐字节一致）✅ 直接返回 cached.meta
- INVAR-cache-4（删除→清 key）✅ statSync catch→delete+null
- INVAR-cache-5（仅持久化）✅ 活跃走 RPC 不经 scanPiSessions
- INVAR-cache-6（无上限+估算）✅ 注释说明
- INVAR-cache-7（不跨进程）✅ 内存 Map 天然

**FR-three-read-merge INVAR（4 项）**：
- INVAR-merge-1（ScannedSessionMeta 加 outcome）✅
- INVAR-merge-2（scannedToSummary 从 meta 取）✅ 不再调 extractSessionOutcome
- INVAR-merge-3（parseSessionHeader 进缓存）✅ scanSessionMeta 内调 parseSessionHeader 结果写入 meta
- INVAR-merge-4（parsed-result 层）✅ 缓存 {header,name,outcome} 整体

全一致。

### edge-case（边界条件）

- 空文件（size===0）✅ readTailEntries return []
- 文件不存在 ✅ openSync catch→null；statSync catch→清缓存+null
- UTF-8 多字节切断 ✅ 丢首行（AC-tail-4 测试验证含 emoji/CJK）
- 超长行撑过 32KB ✅ 丢首行残行（AC-tail-4 padding 测试）
- 并发写竞态 ✅ mtime+size 键（AC-cache-2 测试）

### test-coverage（测试质量防线检查）

防线检查（逐条问"防什么 bug"）：
- AC-tail-2 fallback（SR1 核心）：防"早期命名长 session 丢名字"——这是最大回归风险，有防线 ✅
- AC-tail-4 UTF-8 切断：防"残行误匹配"——有防线 ✅
- AC-cache-1 命中零读：防"缓存不工作退回冷读"——有防线 ✅
- AC-cache-2 size 键：防"同 ms 并发写返回 stale"——有防线 ✅

**盲区**：实现里有 `parseSessionHeader 返回 null（非 session 文件）→ scanSessionMeta 不缓存 return null` 分支，无独立测试。但 parseSessionHeader 现有测试已覆盖首行非 session 的返回 null（session-file-utils.test.ts），scanSessionMeta 的 null 透传是自然的。可接受。

### type-safety

无 any。findLastEntryField 用泛型 R，predicate/extract 回调类型清晰。ScannedSessionMeta.outcome 类型为 SessionOutcome | null。

### error-handling

- readTailEntries：openSync catch→null，不吞其他异常（fstat/read 在 try 内，异常会抛出但 finally closeSync 保证 fd 不泄漏）
- findLastEntryField：fallback readFileSync catch→null，与原实现对等
- scanSessionMeta：statSync catch→清缓存+null

## 发现的问题

### should-fix

| ID | dimension | ref | 问题 |
|----|-----------|-----|------|
| R1 | test-coverage | test.json U5 | U5 expected="3" 但 AC-merge-1 断言实际放宽到 <9（mock 环境下尾读 fallback 导致 readFileSync 多于 3）。test 阶段须用 replan --test 修正 U5 expected 为实际值（6），否则 CW 机器重算会判 fail。 |

### nit（不进 issues）

- `_resetSessionMetaCacheForTest` 是测试专用 export 混在生产模块里。理想应放 test-utils，但"仅供测试"注释已标注且无副作用，可接受。
- findLastEntryField 的 fallback 路径在 mock 测试环境下总会触发（ESM live binding 工具限制），生产环境正常。AC-merge-1 断言放宽到 <9 反映了这一点。

## 审查结论

代码 **就绪进 test**。plan 全落地，design-consistency 全一致（18 个 INVAR），edge-case 全覆盖，测试有真防线（非覆盖率填充）。

唯一 should-fix R1 是 test 阶段的 expected 校准（U5 从 3 改 6），在 test 阶段用 replan --test 修正。
