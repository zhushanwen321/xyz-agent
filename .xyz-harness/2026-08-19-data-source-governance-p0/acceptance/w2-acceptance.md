# W2 验收标准：数据登记表初版

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §2 W2 节（L121-143，基线 commit 见 ledger）是 W2 的验收权威。builder 与 verifier 禁止修改两者。
> 规格 SSOT = plan W2 节全文（任务步骤 5 条逐条执行）；本文档只做锁定提炼。两者冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W1 已 committed（legacy 例外登记以 W1 之后的代码现状为准）。

## 目标（一句话）

12 类 GUI 数据的 owner / 权威源 / 唯一写入口 / 字段空值语义 / 已知例外有一张可查的 SSOT 表 `docs/architecture/data-source-registry.md`，成为后续全部 wave 与护栏（S1/R2/R3）的依据。

## 交付物

1. `docs/architecture/data-source-registry.md` [新增]（唯一交付文件）

## 内容验收（plan W2 任务步骤 1-5 逐条）

1. **12 条数据行**：按父文档 §2.2 清单逐条建表，每条字段 = `编号 / GUI 数据 / 权威源 / owner（目标模块，P0 标注「现状 → 目标（W 编号）」）/ 唯一写入口 / 字段空值语义 / 已知例外`。
2. **空值语义三条区分**（D1b，防双登记矛盾）：
   - `sessionName` 空 = 合法态（未命名，必须整字段覆盖）——label 是 sessionName 在 xyz 侧同一数据链投影，**不单独登记**「label 空 = 未设置（可守卫）」语义
   - `thinkingLevel` 无空值语义（永不 guard）
   - `modelId` / `tokenCount` 磁盘扫描占位值 `''` / `0` 不覆盖已知真值
3. **例外与合法形态登记**（七项，r3/r4 审查补全集）：① 非活跃 rename 直写（`persistSessionName` 非活跃分支 session-lifecycle.ts:302 附近，移除期限 = W11）；② `persistHandedOff` handoff_marker 直写（session-file-utils.ts:464 附近 openSync('a')，活跃交接源 pi 在场；移除期限 = W11，迁移形态 = sidecar）；③ `patchSessionCwd` 整文件重写（session-file-utils.ts:518 附近，atomicWrite；竞态边界 = 仅 restoreSession 在 pi spawn 前调用；移除期限 = W11，迁移形态 = restore tmp 读改写）；④ 队列内容唯一提交方 = renderer（D6，扩展 deliverAs 注入禁用）；⑤ sidecar 家族四后缀合法形态（.meta.json / .preset.json / .project.json / .handoff.json，xyz 自有文件，W19 收口确认）；⑥ fork 文件创建型（createForkedSessionFile session-fork.ts:175 附近，唯一创建入口）；⑦ 非写点注记（session 删除链 + pi-maintenance renameSync 属非内容写，不在写点定义与 R1 范围）。
4. **#1 label 条目写点处置全集**（6 处全有着落）：活跃 rename 直写 + tryPersistLabel 兜底直写已于 W1 移除（切 RPC / 退役为显示派生）；非活跃 rename 直写 + persistHandedOff + patchSessionCwd 带 W11 期限登记；createForkedSessionFile 创建型登记保留。
5. **plugin sessionData 条目**：已 owner 化声明（权威 = runtime SessionDataStore，packages/runtime/src/services/plugin-service/session-data-store.ts，非多源病灶）。
6. **表头声明**：本表 P1 起演进为可执行配置（ReplicatedState 配置即登记条目，W6-W8 执行时同步维护）。

## 通过命令（builder 自验 + verifier 实跑）

1. 行数核对：`grep -c "^| " docs/architecture/data-source-registry.md` 覆盖 12 条数据行 + 1 条 plugin 声明 + 例外/合法形态登记（人工计数核对）。
2. 内容级 grep：表内含「移除期限 = W11」；含 sessionName / thinkingLevel / 占位值守卫三类区分表述；#1 条目含 6 处写点处置去向；handoff/patchCwd 条目含竞态边界表述。
3. 一致性（登记表 vs 代码，W1 完成后现状）：
   - `grep -n "persistSessionName" packages/runtime/src/services/session/session-lifecycle.ts` 代码命中（排除注释行）仅剩非活跃分支 1 处
   - `grep -n "persistHandedOff\|patchSessionCwd" packages/runtime/src/infra/pi/session-file-utils.ts` 命中确认两条 W11 例外实现本体在位
   - `grep -rn "tryPersistLabel\|labelPersisted" packages/runtime/src --include="*.ts"` 命中数 = 0（W1 已删，登记表不登记已删机制为现存例外）

## 禁改清单（越界 = 验收失败）

- 两个验收权威文档（w2-acceptance.md / data-source-governance-plan.md）
- 一切代码文件（W2 是纯文档 wave，任何 .ts/.vue 改动 = 越界）
- 禁止 git add/commit/push

## 备注

- 行号引用以 plan 基线 commit 的源码为准，执行时按符号名定位并如实记录偏差。
- 完成后解锁 W3 + W4（并行，两者领地：.githooks/ vs taste-lint/）。
