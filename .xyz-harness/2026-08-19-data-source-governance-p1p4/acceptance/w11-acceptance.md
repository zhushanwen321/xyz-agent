# W11 验收标准：非活跃 rename 短命 pi + 直写全删 + R1 allowlist 清空

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §3 W11 节（L366-400）是 W11 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W1、W3、W6（均已 committed）。
> 规模警戒：L 档（~400 行核心改动 6 文件）；若执行中超预算，优先上报拆分（handoff sidecar 迁移可独立先行 commit），不得压缩兼容读取逻辑。

## 目标（一句话）

绝对写规则全线生效——xyz runtime 对 pi session JSONL 的直接写入代码归零（persistSessionName + persistHandedOff + patchSessionCwd 三链路全部消灭/迁移），R1 变为无条件检查（sidecar 内置豁免与 fork 创建型登记除外）。探针结论直接采用：冷启动中位数 ~500ms，形态 = 逐次冷起，**不引入 warm pi（D2 已裁决，禁止重开）**。

## 交付物

1. `packages/runtime/src/infra/pi/process-manager.ts`（修改：新增 `withEphemeralPi(sessionFile, fn)`——spawn `pi --mode rpc` 附着该 session 文件 → 等就绪上限 5s → 执行 fn(rpcClient) → kill；复用现有 spawn 机制不新建子系统）
2. `packages/runtime/src/services/session/session-lifecycle.ts`（修改：renameSession 非活跃分支改 `withEphemeralPi(target.filePath, c => c.setSessionName(newName))`，失败走既有报错保留旧名；restoreSession 的 cwd 降级分支迁 tmp 读改写——patch 目标从源文件改为 tmp 拷贝）
3. `packages/runtime/src/infra/pi/session-file-utils.ts`（修改：删 `persistSessionName`（L417 附近）与 `patchSessionCwd`（L521 附近）；`persistHandedOff` 改写 sidecar `<sessionFile>.handoff.json`（沿用规则 #6 守卫 + 写后失效文件头缓存，对齐 persistSessionEnd 模式）；`extractHandedOff` 优先读 sidecar、fallback 尾读旧 JSONL marker（存量兼容））
4. `packages/runtime/src/infra/pi/session-store.ts`（修改：删两条转发与 import）
5. `packages/runtime/src/services/ports/session.ts`（修改：删两条端口声明）
6. `.githooks/check_pi_direct_write.py`（修改：ALLOWLIST 置空，删期限注释；sidecar 四后缀豁免核对含 `.handoff.json`（W3 建立时已预留））
7. 相关测试与 mock 清理

## 关键锁定（plan W11 步骤 3-6）

- 删 persistSessionName 全链路：代码引用按验收 1 两段式清零；注释按 [HISTORICAL] 惯例保留，逐条核对归属（描述历史机制而非现存调用）。
- handoff 迁 sidecar：scanSessionMeta 消费不变（仍经 extractHandedOff）；markHandedOff 内存态与调用链（handoff-service.ts:286 附近）不动。
- patchCwd 迁 tmp：restore 管线「读源文件 → stripSessionEndEntries → 写 tmpdir → pi switchSession(tmp)」中对 tmp 首行 header 应用 cwd fallback（读改写同处，源文件零写）。**扫描侧消费差异接受**（r4 补全：死路径 cwd 的 session 重启后 label fallback 显示 basename(死路径)、deleteByCwd 按真实历史值命中——比旧 home 修补值更正确）；活路径行为不变。
- fork 创建型核对（零代码改动）：核对登记表⑥条目在位 + 失败分支 unlink 语义登记边界。
- R1 allowlist 清空 + 登记表 legacy 例外①②③改「已移除（W11）」+ sidecar 家族子行补 .handoff.json（登记表更新主 agent 落，builder 交草稿）。

## 通过命令（builder 自验 + verifier 实跑）

1. **两段式 grep**：① 代码引用清零：`grep -rn "persistSessionName\|persistHandedOff\|patchSessionCwd" packages/ --include="*.ts" | grep -vE ':[[:space:]]*(//|\*)' | grep -v "\.test\.ts"` 输出为空（注意 persistHandedOff/extractHandedOff 若保留同名 sidecar 函数——函数重命名允许（如 persistHandedOffSidecar）以达成清零，重命名在汇报说明）；② 注释命中逐条人工核对归属（现存注释位置：jsonl.ts:60、session-file-utils.ts:96 等，前序删除自然缩减，执行时以 grep 实测为准）
2. `python3 .githooks/check_pi_direct_write.py` 空 ALLOWLIST 下 exit 0；`grep -n "ALLOWLIST" .githooks/check_pi_direct_write.py` 显示空数组
3. 行为级（场景 1 后半）留 P1 gate；单测层：非活跃 rename 走 withEphemeralPi 的 mock 测试、handoff sidecar 写读 fallback 测试、restore tmp patch 测试
4. 回归：`cd packages/runtime && pnpm typecheck && pnpm test`；handoff 全流程测试 + restore 测试 + 存量旧 session（JSONL 内含 handoff_marker）兼容读取测试；**扫描侧断言**：header cwd 死路径的未命名 session 扫描 label = basename(死路径)、deleteByCwd(死路径) 命中；活路径行为与迁移前一致

## 禁改清单（越界 = 验收失败）

- 验收权威文档；登记表（builder 交草稿，主 agent 落表）
- replicated-state.ts / replicated-states.config.ts（W6-W8）；W21 领地（core chat 域 + event-adapter message_end 段）；extensions/
- 禁 git 写操作；禁 any；短命 pi 测试用真实 spawn 或 mock child_process 二选一（汇报定案）

## 备注

- 完成后解锁 W19（sidecar 收口登记）与场景 1 后半验收（P1 gate）。
