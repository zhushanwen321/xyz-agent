# SessionService 深化重构设计 — 对抗式审查报告（第 4 轮·终审）

> 审查对象：`docs/design/session-service-deepening.md`（第 3 轮修订版）
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`
> 本轮范围：第 3 轮 must-fix 修复成立性 + 三攻击点 + 交叉引用一致性终检。已确认项不重查。

## Summary

0 must-fix, 2 suggestions（均为第 3 轮修订引入的轻微残留，可随实施带上）。**结论：设计就绪（DoR 达成）。**

**上轮修复判定**：第 3 轮 MUST_FIX（销毁路径时序契约）**修复成立**——D2③ 重写为创建/销毁不对称机制：销毁侧编排权留 Facade wrapper，9 步时序逐段写明（①summary 预取 → ②委托 lifecycle 纯删条目 → ③onSessionDelete → ④didDestroy 扇出 → ⑤同步直调各域清理 → ⑥clearSession 垫底含 :350 约束），与 removeSessionEntry 实装（:1837-1890）逐步核对一致；「lifecycle 拿走整条删除编排」入被否谱系且击穿理由正确（dispose 提前到 didDestroy 之前 = G3 级偏移）。P4 判据（九步逐段比对 + :350 约束）、检查点 2（9 步逐段归属核对，lifecycle 只承接第 ② 步）、§3.1 切分段、S3 行全部同步。第 3 轮两条 SUGGESTION（基座改按消费者重复声明 / markHandedOff 现状如实表述 + 迁 ISessionService 标注迁移非新增）**修复成立**，且被否谱系对应条目（基座 extend 被 ISP 纯度击穿；handoff 窄接口单消费者不划算）记录完整。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION（第 4 轮） | §3.1 终态地图 session-lifecycle.ts 行（:122） | P1-5 交叉引用一致性 | **地图行把 onSessionDisposed 归为 lifecycle 发布的窄事件通知，与同页切分段及被否条目矛盾。** 按 D2③ 不对称机制，销毁侧不存在 lifecycle 发布的 dispose 事件——编排权在 Facade wrapper，onSessionDisposed 是 Facade 在第 ⑤ 步同步直调的域模块方法（S4/S5/S6 后组装期接线）。地图行「session-lifecycle.ts … + 窄事件通知 onSessionRegistered/onSessionDisposed」是上一版对称设计的残留，字面读会引导实装者让 lifecycle 发布 dispose 事件——正是被否条目明确拒绝的形态。 | lifecycle 行只保留 onSessionRegistered；onSessionDisposed 挪注到 Facade wrapper/域模块接线处（如「session-service.ts 行：销毁编排 wrapper，第 ⑤ 步直调各域 onSessionDisposed」） |
| SUGGESTION（第 4 轮） | §3.3 D2③ 创建侧 / §3.5 P4 | P0-16 探针判据可再精确（不阻塞） | **创建侧订阅扇出的异常语义未声明。** 现状 initializeManagedSession 体内 registerReplicatedStates → ensureRecordEntriesCache → reconciler 是顺序内联调用，无异常隔离——前者抛错则后续不执行、异常沿 create 链传播。新机制若实装者照搬销毁侧 didDestroy handlers 的 per-handler try/catch 隔离模式（:1852-1858），创建路径异常会被静默吞掉（G3 偏移）。reconciler 自身 fire-and-forget + .catch 除外（现状如此，文档已正确保留）。 | D2③ 创建侧补一句「订阅扇出不设异常隔离、异常直接传播（与现状体内顺序调用等价）」；P4 创建侧判据可对应加「异常传播路径一致」 |

## 攻击点结论（本轮指定攻击面）

| 攻击点 | 结论 | 依据 |
|---|---|---|
| ① 创建侧订阅者执行时机（sessions.set 后）与 adapterFactory.attach（set 前）存在状态依赖反例？ | 通过 | 现状顺序（:1916-1985 实测）：adapter.attach → 构造 session 对象 → sessions.set（:1966）→ registerReplicatedStates → ensureRecordEntriesCache → reconciler。新机制 registerSession 原样保留该顺序（attach→set→同步直发→订阅者按现状体内顺序执行），attach→set 窗口系现状固有；窗口内中间读者全部有守卫（:632-639 的 `replicatedStates.get()?.xxx.markDirty()` 可选链、:868 等的 sessions.has 存在性守卫），新旧设计窗口等价。残留微缺口：订阅扇出异常语义（Findings #2） |
| ② 按消费者重复声明的签名漂移风险有无轻量防漂移手段？ | 通过 | 防漂移机制内建于「单一实现」：同一实现类（Facade/lifecycle）implements 多个窄接口，TS 结构化类型强制签名兼容——两个接口对同名方法声明不同签名则实现类无法同时满足，编译期报错。漂移不可能静默发生，无需额外手段。文档已写「重复声明、单一实现」，可把「单一实现 = 编译期防漂移守卫」一句点明（不强制） |
| ③ 销毁第 ② 步委托后，③④ 抛错造成「Map 已删、缓存未清」窗口与现状是否等价？ | 通过 | 现状 removeSessionEntry 体内 onSessionDelete（:1845 附近）为裸调用无 try/catch（仅 didDestroy handlers 循环有 per-handler 隔离，:1852-1858 实测）——onSessionDelete 抛错则 ⑤⑥ 步跳过，「Map 已删、缓存未清」窗口系现状固有。新设计第 ② 步为纯删除透传（Map.delete 不抛异常、不发事件），委托边界不引入新失败模式；③ 抛错后的跳过面与现状逐步一致。等价成立 |

## 交叉引用一致性终检

| 检查路径 | 结论 |
|---|---|
| D2①（重复声明/单一实现，scanner 可见面 = 2）→ §5 S2 行 / 被否谱系（基座 extend 条目，scanner 5≠2）/ §4.2 场景 B「≤13」（lifecycle 可见面 = 消费面 = 13 ✓） | 一致 ✓ |
| D2③ 不对称机制 → §3.1 切分段（创建 lifecycle 直发 / 销毁 Facade wrapper 9 步 / destroyAll 不引入通知）/ §5 S3 行 / P4（九步逐段 + :350 约束）/ 检查点 2（9 步逐段归属，lifecycle 仅第 ② 步） | 一致 ✓ |
| §3.1 地图 lifecycle 行 onSessionDisposed 归属 → D2③/切分段/被否条目 | 不一致（轻）——Findings #1 |
| markHandedOff 表述（现仅 internal 声明 + handoff-service:31 绑具体类；迁 ISessionService +1 行属迁移）→ D2① / S2 行 / D3 对齐说明 | 一致 ✓，与源码（interfaces.ts 无此方法、handoff-service.ts:31/282）相符 |
| onSessionRegistered 签名（id）→ §3.1:133 与订阅者需求（registerReplicatedStates/ensureRecordEntriesCache/reconciler 均只需 id） | 一致 ✓ |

## 四轮对抗轨迹与就绪判定

| 轮次 | must-fix | suggestions | 核心战果 |
|---|---|---|---|
| 第 1 轮 | 3 | 4 | 接口分组计数虚构（9/6/2）；S3 未计入三 Map 汇聚；场景 A 不可判定 |
| 第 2 轮 | 2 | 2 | 「按真实调用点」仍是注释换标签（实测 13/6/2 + interpreter/handoff 两消费者被遗漏）；destroyAll 对称性虚构 |
| 第 3 轮 | 1 | 2 | 销毁路径 9 步内部时序契约缺失（dispose 会被提前到 didDestroy 之前） |
| 第 4 轮 | 0 | 2 | 仅剩地图行归属残留 + 创建侧异常语义两个可随实施带上的轻微项 |

**设计就绪判定**：五段骨架完整；问题定义与三引力根因经源码核实成立；方案对比充分且有明确推荐；全部关键事实（2603 行/106 方法/21 接口方法/13-6-2 调用点矩阵/33 处 this.sessions/9 步销毁序列/56+63 方法接口/41-case handler）经四轮源码复核一致；验收为真实场景双分支行为比对 + 可判定收口标准 + 负向守卫验证，投入与 2603 行核心服务重构规模匹配；探针 P1-P5 均有降级路径。两条 SUGGESTION 可在 S2/S3 实施时顺手带上，不阻塞开工。

## 核实方法声明（第 4 轮）

- initializeManagedSession 创建序列（:1916-1985）与中间读者守卫（:632-639 可选链、:868 存在性守卫）复核——攻击点 ① 依据。
- removeSessionEntry 9 步序列与 onSessionDelete 裸调用 / handlers per-handler try/catch 隔离（:1837-1890）复核——攻击点 ③ 依据。
- 文档 §3.1 地图/切分段、D2①③、P4、S2/S3 行、检查点 2、被否谱系逐字比对——一致性终检依据。
- 本报告只报告不修复；所有修复方向为建议性质。
