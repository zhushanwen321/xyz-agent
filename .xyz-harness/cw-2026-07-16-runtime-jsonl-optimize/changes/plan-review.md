# Plan Review — runtime-jsonl-optimize

> 审查方法：spec 阶段已对 FR/AC/INVAR 做深度禁读重建审查，plan 是 FR→Wave 映射。本阶段直接自审 coverage + architecture + feasibility。

## 审查范围

- spec FR 清单：FR-tail-read / FR-mtime-cache / FR-three-read-merge（3 项，含 7+7+4 个 INVAR）
- plan waves：W1（jsonl.ts readTail 工具）/ W2（session-file-utils extract 改造）/ W3（scanPiSessions 缓存 + scanner 取 outcome）

## FR → Wave 覆盖核对

| FR | Wave | changes | 覆盖 |
|----|------|---------|------|
| FR-tail-read | W1 + W2 | W1 readTail/readTailEntries 工具（行边界/UTF-8/退化/ENOENT）；W2 extractSessionName/Outcome 改用尾读 + fallback 全量 | ✅ INVAR-tail-1..7 全覆盖 |
| FR-mtime-cache | W3 | scanPiSessions 模块级 Map<path,{mtime,size,meta}>，statSync 比对，键含 (path,mtimeMs,size) | ✅ INVAR-cache-1..7 全覆盖 |
| FR-three-read-merge | W3 | scanPiSessions 一次读提 header+name+outcome 写缓存，ScannedSessionMeta 扩展，scannedToSummary 从 meta 取 outcome | ✅ INVAR-merge-1..4 全覆盖 |

**CW 的 mustFix warning（FR-1/2/3 未覆盖）是编号匹配问题**：spec 用语义命名（FR-tail-read 等），CW 找 FR-1/2/3 匹配不到。实际 3 个 FR 全覆盖，无缩范围。

## AC → Wave 验证路径

| AC | 验证点 | Wave 提供 |
|----|--------|----------|
| AC-tail-1..6（尾读正确性/fallback/UTF-8/退化/fallback缓存） | readTailEntries + extractSessionName/Outcome | W1+W2 |
| AC-cache-1..3（命中/size键/删除清理） | scanPiSessions 缓存 | W3 |
| AC-merge-1..2（三读合一计数/parseSessionHeader不破坏） | scanPiSessions + scanner | W3 |
| AC-regress-1（损坏 JSONL） | extract 行为对等 | W2 |

所有 AC 在对应 Wave 的测试文件可验证。

## 发现的问题

无 must-fix，无 should-fix。

### nit（只记录不进 issues）

- W2 和 W3 都改 `session-file-utils.ts`。W2 改 extract 函数内部实现，W3 改 scanPiSessions 加缓存 + ScannedSessionMeta 扩展。两处改动正交（不同函数），合并无冲突，但 dev 时注意 W3 的缓存层要包裹 W2 改造后的 extract（缓存 miss 时调 extract，hit 时跳过）—— 这个调用顺序在 W3 description 已写明。

## 审查结论

plan **就绪进 tdd_plan**。FR 全覆盖（3/3），AC 验证路径清晰，依赖链 W1→W2→W3 无环且合理（工具层→extract 改造→缓存整合，每层可独立测试）。
