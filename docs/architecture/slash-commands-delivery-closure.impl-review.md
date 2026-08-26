# slash 命令投递闭环：实现 vs 设计一致性对抗式审查

> 审查对象：`docs/architecture/slash-commands-delivery-closure.md`（含 e9a320ea0 W2 修正）vs 4 个实现 commit（75b8c434e / 57d2e7ac8 / b2ba4bb1e / e9a320ea0）。
> 审查方式：逐条对照 §3.3 D1-D5、§3.4 接口契约、§5 文件改动地图、§4 验收 S1-S6；所有事实经 `git show` diff + 源码 read + 端口探针核实；相关单测本次实测 23/23 通过。

## Summary

2 must-fix（1 个代码级 M1 残留 + 1 个验收流程阻塞）, 4 suggestions. 设计文档需更新 2 处；实现需修正 1 处；**S1-S6 真实 UI 验收未执行**（端口占用说法核实属实，但验收缺失构成完成度阻塞）。核心结论：W1 主线（D1-D5 + §3.4 五条契约 + CommandPopover 三处接线）**全部忠实落地**，质量良好；偏差集中在范围外三单元之一的 `useGitStatus.refresh()` M1 竞态残留、设计文档未登记范围扩展、验收未执行。

## Findings

| # | 优先级 | 位置 | 偏差点 | 设计原文 | 实现实际 | 判定 | 理由 |
|---|--------|------|--------|----------|----------|------|------|
| F1 | MUST_FIX | 57d2e7ac8 `useGitStatus.ts:135-149`（refresh 函数） | refresh() await 后写分区用 `update`（读实时 sid）而非 `updateFor`（捕获 sid），与同文件 runOp 不一致 | 设计 §3.3 D2：「ADR-0049 的 `updateFor(capturedSid)` 范式」；ADR-0049 checklist #3 / AGENTS.md 规则 8「WS handler 必须用 `updateFor(capturedSid)` 不用 `update`」 | `runOp` 正确用 `scoped.updateFor(sid,…)`，但 `refresh()` 的 `scoped.update((p)=>{p.result=r})` 在 `await gitApi.status(sid)` 之后调用——update 读的是 `sid.value` **实时值**（core SSOT `use-session-scoped-state.ts` update 实现已核） | **设计更合理→实现需修正** | 违反 ADR-0049 checklist #3（设计 D2 引用的同一范式，commit message 自称合规）。后果：refresh(A) 在途时切到 B → watch 触发的 refresh(B) 被 `pending` 守卫挡回 → A 的 git 状态（别的 worktree 的 branch/dirty/conflict）写入 B 分区并展示，直到下一 message.complete 才自愈；canCommit 的 hasConflict 判断随之短暂失真。修复方向：refresh 三处写全部改 `updateFor(sid, …)`（runOp 已示范） |
| F2 | MUST_FIX | §4 验收 / §3.3 P10 | S1-S6 真实 UI 验收未执行、无验收记录、P10 探针未测 | §4：「全部场景在真实环境执行：pnpm dev 启动真实 Electron app + runtime + pi 子进程，不 mock 任何一层」；W2 含「手动验收记录」 | 端口探针核实：9222=Electron PID 11745、1420=vite PID 11698，均属 `feat-font-optimize` worktree 的 dev 实例——**占用说法属实，非托词**；但仓内无任何 S1-S6 验收记录（grep 全 docs 仅设计文档自身命中），P10（打开延迟计时）随之未测 | **流程阻塞（非代码修正）** | 单测（mock api 层）只是交付物，设计明文规定验收以真实场景为准；本次修复的核心主张「skill 消失在真实链路中消除」目前**只有结构正确性证据、零运行时证据**。恢复路径：协调停掉 feat-font-optimize dev 实例（或等其释放 9222/1420）→ 本 worktree `pnpm dev` → 按 S1-S6 逐条执行 + P10 计时 → 回写验收记录 |
| F3 | SUGGESTION | §5 文件改动地图 | 测试路径与实际不符 | 「测试：`packages/renderer/src/components/panel/__tests__/`（CommandPopover 既有测试同位置）」 | 该目录**不存在**；既有 CommandPopover 测试实际在 `packages/renderer/src/__tests__/panel/`，新测试放 `__tests__/composables/use-command-sync.test.ts` + `__tests__/panel/`（含 composer-file-popover U33 回归）——遵循仓内既有惯例 | **实现更合理→设计应更新** | 设计对「既有测试位置」的事实陈述错误（read 核实）；实现按真实惯例放置。设计已自我豁免文件名（「实施期按现有命名惯例定」）但目录句仍误导后来者。设计 §5 应改为实际路径 |
| F4 | SUGGESTION | §5 拆分清单 / §1 in-scope | 三个范围外单元（useGitStatus / drafts / fileCandidates）+ dom-core 6 文件改动未在设计登记 | §5 文件改动地图仅列 2 文件（useCommandSync.ts 新增 + CommandPopover.vue 修改）；§1 in-scope 仅「CommandPopover 数据链的补拉接线与订阅 handler 分区写修正」 | 实际交付含 57d2e7ac8（useGitStatus 2 文件）、b2ba4bb1e（drafts 6 文件，跨 dom-core）、75b8c434e 内嵌 fileCandidates 清理——均源自 session 隔离审计，非 §5 拆分单元 | **扩展合理，设计应回写登记** | 扩展有真实价值（已核实）：drafts 裸 Map 从未注册 cleanup，`useSidebar.deleteSession:321` 调 `triggerSessionCleanups` 也清不到它——泄漏真实，迁移后工厂自动注册修复；useGitStatus/fileCandidates 的 watch-清空反模式违反 ADR-0049 checklist #2 亦真实。但设计文档是交付契约（AGENTS.md 产物自包含原则）：读者按 §5 会以为只改 2 文件。设计应补「实施期范围扩展登记」小节列明三单元、动机（ADR-0049 审计）、各自的 deviation（见 F7） |
| F5 | SUGGESTION | 75b8c434e `CommandPopover.vue` loadCandidates | fileCandidates 无 sid 守卫的 last-write-wins 竞态（与迁移前等价） | （设计未覆盖该单元） | `loadCandidates` 在 `await` 后无条件写实例级 `fileCandidates`：A 的迟到应答可覆盖已切到 B 的显示，直到 B 应答回来。commit message 称完整工厂分区因「factory current computed 在 happy-dom 不传播」回退——该说法是对已回退尝试的断言，**无 diff 可核，标记为无法核实**；deviation 已在代码注释登记 | **双方合理→登记即可** | 与迁移前行为逐位等价（旧 `loaded` 标志同样不防此竞态），非回归；fileCandidates 是短暂 UI 投影、真源在 useFileSearch store 分区（`store.get(sessionId)` 缓存已核实）。建议后续顺手加 `if (props.sessionId === capturedSid)` 守卫收口，不阻塞 |
| F6 | INFO | 75b8c434e `useCommandSync.ts` pull() | 失败分支返回伪造空 reply | §3.4 契约第 5 条只要求「失败 console.warn，store 不动」 | `.catch` 返回 `{sessionId: sid, commands: []}` 使 Promise 正常 resolve（去重条目经 finally 常规清理）；`applyCommands` 只在 then 分支，**store 确实未被写空**（D3 满足） | **双方合理→登记即可** | 当前消费方全部 `void`，无危害；但未来若有人 attach 该 Promise 消费 `commands` 字段，需感知「空数组=失败」语义。建议代码注释点明，或改 reject + finally 清理 |
| F7 | INFO | §3.4 契约第 4 条 | in-flight 去重选模块级 Map | 「per-sid in-flight 去重（同 sid 并发触发复用同一 Promise）」——未规定层级 | 模块级 `inflightCommandsFetch`，附 `__clearInFlightCommandsFetchForTest` 隔离钩子；带 `get(sid)?.promise === promise` 防误删守卫 | **双方合理→登记即可** | 模块级是实例级的超集（split-panel 双实例同 sid 也去重），契约抽象层级未违反；设计可选补一句实现选型说明 |
| F8 | INFO | b2ba4bb1e `Composer.vue` DraftStore.getDraft | 读操作经 `updateFor` 有创建空分区副作用 | （设计未覆盖该单元） | `getDraft` 用 `updateFor(sid, s => {text = s.text})`，工厂 `getOrCreatePartition` 会为从未保存过的 sid 创建 `{text:''}` 分区 | **双方合理→登记即可** | 无正确性影响（空分区与「未保存」语义同形，session 删除时 cleanup 兜底）；若在意 Map 体积可加只读访问器，非必须 |

### 一致性确认清单（对抗式核查后放行的项）

| 设计条目 | 核查证据 | 结论 |
|----------|----------|------|
| §3.4 契约 1-2：watch immediate 合并挂载+切 sid、onOpenPull 独立、sid 空不拉 | `useCommandSync.ts` 现状逐行核（watch immediate + `if (sid)` 双守卫）；§3.4 契约原文即按两机制描述三触发点 | ✅ 一致 |
| §3.4 契约 3：写 `reply.sessionId` 分区 | `api/domains/session.ts:118-122` 签名核实返回 `{sessionId, commands}`；pull 写 reply.sessionId | ✅ 一致 |
| §3.4 契约 5：失败 warn 保留旧值 | applyCommands 仅在 then 分支；测试「RPC 失败 → store 保留旧值」通过 | ✅ 一致（细节见 F6） |
| CommandPopover 三处接线 | 现状 188-209 行：setup 接线 + open&&slash watch + handler 第二参数，三处齐备 | ✅ 一致 |
| D2：handler 用捕获 sid | `useSessionEvents.ts:87-102` 闭包捕获语义核实；旧 `props.sessionId` 读法已删 | ✅ 一致（FM4 结构性修复成立） |
| D3：静默降级 | catch→`console.warn('[useCommandSync] ...')`，无 toast 无清空 | ✅ 一致 |
| D4：runtime 零改动 | 4 commit stat 全核：仅 renderer + dom-core + docs；无 runtime/shared/protocol 文件 | ✅ 一致（dom-core 属渲染端域包，不违 D4 实质） |
| D5：SWR | open watch 触发拉取，items computed 先读 store 旧值，应答 ms 级回写覆盖——结构成立；延迟实测（P10）未做，并入 F2 | ✅ 结构一致，运行时待验 |
| §5 待验证检查点 2：open watch 与 loadCandidates 是否合并 | 实现取「独立 watch」= 设计倾向项 | ✅ 一致 |
| W2 修正（e9a320ea0）：frontend 在 changeset ignore 名单 | `.changeset/config.json:14` 含 `@xyz-agent/frontend`；`packages/renderer/package.json` 包名核实一致 | ✅ 修正属实 |
| drafts 三分支语义保持 | git show 对照：save(oldId)/restore(newId)/clear 三分支结构逐行等价；空串 falsy ≡ 旧 Map.get undefined falsy（restore 分支 `if (saved)` 判定不变） | ✅ 一致 |
| 单测交付 | use-command-sync 9 例 + use-git-status 9 例 + file-popover 5 例本次实测 **23/23 通过**（mock api 层，符合设计「单测非验收替代」定位） | ✅ 通过 |

## 完成度结论

**W1 主线（设计核心范围）完成度高**：D1-D5 决策、§3.4 五条契约、CommandPopover 三处接线全部忠实落地且有单测护栏——设计的「最后一厘米」补拉闭环在代码层面**已经闭合**。W2 修正经核实属实。

**但整体不能宣告完成**，两个阻塞项：

1. **验收欠账（F2）**：设计 §4 用整节定义了 S1-S6 真实场景验收 + P10 探针，全部未执行、无记录。端口被兄弟 worktree 占用是真实客观障碍（已核实进程归属），但它只解释「为何未做」，不改变「未做」这一事实——修复主张（G1-G4）目前没有一条经过真实 Electron + runtime + pi 链路验证。**S1-S6 + P10 执行并留痕是 merge 前的硬门槛**。
2. **范围扩展的范式残缺（F1）**：useGitStatus 迁移自称 ADR-0049 #3 合规，但 refresh() 腿留有 M1 竞态（runOp 已正确示范修法，属一行级收口）。

**设计文档待更新 2 处（F3 测试路径、F4 范围扩展登记），实现待修正 1 处（F1 refresh updateFor）**；F5-F8 登记即可。完成顺序建议：F1 修码（含 9 例回归跑绿）→ 协调端口执行 S1-S6+P10 → 回写验收记录与设计登记 → 方可进入 merge 流程。
