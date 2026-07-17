# Spec Review — system-prompt-config

日期：2026-07-16 · 审查方法：禁读重建（fresh subagent 仅从 objective + clarifyRecords 重建，不读初稿）+ 三维度审查

## 1. 审查范围与 diff 结果

盲重建产出：FR 12 条 / AC 16 条 / 决策 9 条 / UC 9 条 / outOfScope 8 条 / 易漏点 5 条。
与初稿 specSections（FR 5 / AC 7 / D 5 / UC 4）diff：

| 盲重建发现 | 初稿状态 | 判定 |
|---|---|---|
| 配置持久化/读写服务 FR（原子写、dataDir 动态推导） | 仅在 §3/§5 prose 与 D3/D5，无独立 FR | **SR1 should-fix** |
| 超长 prompt argv 上限（Windows ~32k）+ 校验 | 未覆盖 | **SR2 should-fix** |
| 「追加关闭时快照仍写」（替换效果的唯一可见出口） | 插件伪码已隐含（每轮无条件写），FR-5 未明示 | **SR3 should-fix** |
| 保存失败错误反馈 AC | §7 有 toast 一句，无 AC | **SR4 should-fix** |
| 配置损坏状态透出 UI（corrupted 标记） | D5 静默回退，未透出 | **SR5 should-fix** |
| hook 定位配置文件的通道（PI_CODING_AGENT_DIR 推导） | §4 已覆盖 ✓ | 无问题 |
| 扩展分发路径（asar 外、extraResources） | §5.7 已覆盖 ✓ | 无问题 |
| 空 flag 禁止（enabled 但空白不传参） | AC-1 已覆盖 ✓ | 无问题 |
| 进程池/预热边界 | 无池化（调研确认每 session 独立 spawn），§10 已注明 restore/fork 语义 ✓ | 无问题 |
| WS 命名建议 systemPrompt.* | 不采纳：项目 settings 域惯例为 config.*（config.setDefaultModel 范本），保持一致 | nit |
| schema 预留 version 字段 | 初稿无 | nit（实施时加入） |
| 恢复默认=关开关不删文本 | §7 隐含 | nit（补进决策） |
| 快照「来自任意会话最近一轮」语义 UI 标注 | §7 卡片3 文案已覆盖 ✓ | 无问题 |

## 2. 问题清单（进 CW tracking）

| id | severity | dimension | 描述 | ref |
|---|---|---|---|---|
| SR1 | should-fix | completeness | 缺「配置持久化与读写服务」独立 FR，诉求→FR 映射断档 | FR |
| SR2 | should-fix | reasonableness | 缺超长替换文本校验边界（argv 上限，Windows ~32k） | FR-1 |
| SR3 | should-fix | completeness | FR-5 未明示「追加关闭时快照仍写」 | FR-5 |
| SR4 | should-fix | completeness | 缺保存失败错误反馈的 AC | FR-4 |
| SR5 | should-fix | reasonableness | 配置损坏未透出给 UI，建议 getSystemPrompt 响应带 corrupted 标记 | AC-4 |

## 3. 三维审查结论

- **completeness**：objective 三诉求（替换/追加/UI+预览）均有 FR 落地；盲重建补出 SR1/SR3/SR4 三处断档。
- **consistency**：FR/AC 对齐，术语统一（核心段/动态段/快照）；无 FR 间矛盾。
- **reasonableness**：AC 均可机器判定（unit/script）；SR2/SR5 为边界与失败路径补强。

**结论**：无 must-fix。5 条 should-fix 全部采纳，进 plan 前通过 cw clarify 增补 specSections（FR-6 配置持久化、FR-7 输入校验与错误反馈；AC-8~AC-11；D6 关开关不删文本、D7 长度上限），spec 就绪进 plan。

## 4. 复查（turn 2）

逐条核对修复：SR1→FR-6+AC-8 ✓；SR2→FR-7+AC-9+D7 ✓；SR3→AC-10 ✓；SR4→FR-7 条款+AC-11 ✓；SR5→FR-6 corrupted 透出+AC-8 ✓。增补条目与既有 FR/AC 无冲突（FR-6/FR-7 为新增编号，AC-8~11 接续编号，术语一致）。无新问题，提交空 issues，spec 定稿进 plan。
