# Spec Review — runtime-jsonl-optimize

> 审查方法：禁读重建（派 fresh subagent 只给 objective + clarifyRecords + 代码事实，不读 specSections，从零重建期望 spec，再与初稿 diff）。

## 审查范围

- 重建章节：FR + AC + 隐含需求 + 决策（A/B/C/D 四块，13 个 FR + 16 个 AC + 11 个决策）
- 初稿章节：CL1 的 background + FR(3) + decisions(3) + outOfScope(4) + complexity
- diff 维度：completeness / consistency / reasonableness

## diff 结果（按 severity）

### must-fix（初稿遗漏/错误，不修会导致 dev 跑偏）

| ID | dimension | ref | 问题 | 修复 |
|----|-----------|-----|------|------|
| SR1 | reasonableness | FR-1/FR-2 | **尾读未命中策略遗漏（最大风险）**。初稿写"尾部块不含目标 entry 时返回 null"。但 session_info 是 append 的，若 session 早期命名后追加大量对话 entry，最后一条 session_info 实际在文件头部，永远落在任何合理 N KB 尾窗外 → 尾读找不到 → 返回 null → session 丢名字（语义退化，非优化）。CL1"总追加到尾部"的措辞误导。 | 用户已决策 fallback 全量：尾读未命中 → fallback 全量读保证正确性。常见无目标 session（实测 11/11）尾读 null 直接返回不触发 fallback，仍获全收益。早期命名长 session 退化为例外路径，行为不变。 |
| SR2 | completeness | FR-1 | **丢首行 + UTF-8 残行处理遗漏**。从 offset=size-NKB 读，该字节可能落在某行中间或多字节 UTF-8 字符中间。残行可能恰好是合法 JSON 导致误匹配。初稿完全没提行边界处理。 | 补 INVAR：尾块首行（offset≠0 时）视为残行丢弃，不参与 parse；不得产生乱码/false parse。补 AC：含 emoji/CJK 测试文件，offset 切在多字节字符中间，断言首行跳过、无误匹配。 |
| SR3 | consistency | FR-3 | **缓存必须模块级（跨两阶段 scan 共享）未明确**。初稿 FR-3 说"scannedToSummary 不再独立调 extractSessionOutcome"，但没明确缓存是模块级共享。scan 是两阶段：scanPiSessions 做 header+name，scannedToSummary 做 outcome。若缓存做成 per-call 或 per-function，scannedToSummary 阶段仍重复读。 | 补 INVAR：缓存必须模块级，跨 scanPiSessions + scannedToSummary 两阶段共享同一 Map<path,{mtime,size,meta}>。一次扫描流程中同文件至多 1 次读（miss）/ 0 次（hit）。补 AC：M 文件冷缓存全流程 read 总数 == M。 |
| SR4 | completeness | FR-2 | **缓存键缺 size 字段**。初稿 FR-2 只说 mtime keyed。pi _persist append 与 runtime persistSessionName/End append 可能与 scan 并发，同 ms 内 append mtimeMs 不变 → 缓存返回旧内容。 | 补 INVAR：缓存键含 (path, mtimeMs, size)。size 近零成本消除同 ms 并发写竞态。ScannedSessionMeta 已有 size 字段（:265）可用。残留限制：同 ms 写后回滚至同 size 理论可能，记已知限制。 |
| SR5 | reasonableness | FR-1 | **尾读实现机制未定，readFileSync+slice 不降 IO**。初稿没说尾读怎么读。若实现者选 readFileSync 全量读再 slice 末尾，等于只降 parse 不降 IO——对大文件不达目标（仍是全量 IO）。 | 用户已决策 openSync+readSync：从 offset=size-NKB 用 readSync 真 partial read 降 IO。保持 sync 不引入 async 传染。 |

### should-fix

| ID | dimension | ref | 问题 | 修复 |
|----|-----------|-----|------|------|
| SR6 | completeness | 全局 | **缺 AC 章节**。初稿只有 FR + decisions，没 acceptanceCriteria。tdd_plan 的 AC 映射率检查受影响。 | 补 AC（至少：尾读正确性、fallback 触发、缓存命中/失效、三读合一计数、UTF-8 残行、退化场景）。 |
| SR7 | completeness | FR-3 | **parseSessionHeader 的 head-read 优化 in/out of scope 未声明**。header 是首行，可 head-read 优化，但本次只做尾读。初稿没写明 parseSessionHeader 是否纳入优化。 | 补决策 D8：parseSessionHeader 结果进缓存（恢复路径冷，命中受益），但 head-read 单独优化标 out of scope（保持全量读 + 走缓存）。独立调用方（session-service.ts:886）不破坏。 |
| SR8 | reasonableness | FR-2 | **缓存容量策略未定**。初稿没说缓存是否有上限/淘汰。session 数很多时缓存膨胀。 | 补决策 D3：无上限（每条 ~几百字节，10k session ≈ 数 MB），附内存估算注释。 |
| SR9 | reasonableness | FR-1 | **fallback 后是否缓存最终结果未定**。fallback 全量读得到结果后，若不缓存，下次同 (path,mtime,size) 仍 fallback。 | 补决策 D11：fallback 后缓存最终结果（key 仍有效，避免重复 fallback）。 |

### nit（只记录不进 issues）

- FR 编号建议沿用 L6/M4 风格的语义命名（FR-tail-read / FR-mtime-cache）而非 FR-1/2/3，便于和 handoff backlog 对齐。
- N KB 取值建议写明依据（session_end 总在尾百字节够；session_info 早期命名靠 fallback；推荐 32KB 对齐 fs readahead）。

## 审查结论

spec **未就绪进 plan**。5 个 must-fix（含最大风险 SR1 尾读 fallback、SR2 行边界、SR3 模块级缓存、SR4 size 键、SR5 实现机制）。用户已确认 SR1=fallback 全量、SR5=openSync+readSync。须进 spec_review_fix：补完整 FR（含所有 INVAR）+ AC + 决策后复查。

关键教训：CL1"总追加到尾部"措辞导致初稿遗漏了"最后一条 session_info 可能在头部"的根本场景。禁读重建准确捕获了这一点（FR3 load-bearing 标注），说明尾读优化的正确性边界比"读末尾"复杂得多。

---

## 复查（spec_review turn 2，fix 后）

修复方式：CL2 提交完整修正 specSections（FR 3+3=6 含所有 INVAR + AC 12 + 决策 9 + outOfScope 5），覆盖 SR1-SR9 全部 issue。

逐条核对：
- SR1 (尾读 fallback)：FR-tail-read INVAR-tail-2 + D6 + AC-tail-2/3。✅
- SR2 (丢首行+UTF-8)：INVAR-tail-3 + AC-tail-4。✅
- SR3 (模块级缓存)：FR-mtime-cache INVAR-cache-1 + AC-merge-1。✅
- SR4 (size 键)：INVAR-cache-2 + D3 + AC-cache-2。✅
- SR5 (openSync+readSync)：D5 + FR-tail-read detail。✅
- SR6 (AC 章节)：补 AC 12 条。✅
- SR7 (parseSessionHeader scope)：FR-three-read-merge INVAR-merge-3 + D8。✅
- SR8 (缓存容量)：D3 + INVAR-cache-6。✅
- SR9 (fallback 缓存)：D9 + INVAR-tail-6 + AC-tail-6。✅

复查结论：**spec 就绪进 plan**。所有 must-fix/should-fix 已闭环，无新问题。AC 可机器判定（构造测试文件 + fs spy + mock statSync），verification 类型已标注。
