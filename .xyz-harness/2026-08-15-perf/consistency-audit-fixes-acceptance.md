# 一致性核查修复验收基线（2026-08-17）

> 背景：8 个核查单元（oracle subagent）对 `.xyz-harness/2026-08-15-perf/` 全部设计文档 vs 代码实现做事后一致性核查。19 个决策 + 31 wave 主体全部对齐；发现 3 个待修复项（1 代码缺口 + 2 文档勘误未回写）。本文档是修复的验收基线，builder/verifier 禁改；以本文件 commit 基线为准。

## Fix-1（代码缺口）：worktree 写操作 git 状态失效检查点未闭环

**核查发现**：03 文档 §5 与 plan.md W17 注意事项均要求「worktree 写操作（worktree add/remove）挂 invalidate 或在汇报声明接受陈旧，**二选一写明**」——实际两者都没做：`services/worktree/worktree-service.ts:292/:351` worktree add 走 `gitExecutor.exec` 直连，`transport/worktree-message-handler.ts` 无任何 invalidate 调用，W17 commit message / plan.md / dev-acceptance.md 三处均无「接受陈旧」声明。

**修复方案（长期方案：挂 invalidate）**：worktree.create 成功后对发起请求的 cwd 调 `GitStateService` 的失效方法（`invalidateByCwd(cwd)`，git-state-service.ts 既有），使共享同 cwd session 的 `git.status`（含 branches 列表）不残留 2s TTL 陈旧窗口。

**验收条款**：
1. `packages/runtime/src/transport/worktree-message-handler.ts` worktree.create 成功路径（reply 前）调用 git 状态失效，失败路径不失效（对齐 U2 六写操作「全部成功后 reply 前调用，失败路径不失效」语义）
2. 依赖注入走组合根 `packages/runtime/src/index.ts` 既有注入模式（worktree handler 拿到 GitStateService 引用），不得在 handler 内自建实例
3. 新增或扩展 runtime vitest 测试：真实断言 worktree.create 成功后 invalidate 被调、失败后不被调（测试框架 vitest，从 `vitest` 导入，命令 `npx vitest run`）
4. 03 文档 §5 的 worktree 检查点同步标注「已闭环：挂 invalidateByCwd（2026-08-17）」
5. `cd packages/runtime && npx vitest run` 全绿（存量不回归）

## Fix-2（文档勘误回写）：05-scan-caching.md 正文未回写 R-13 裁决

**核查发现**：plan.md:148-153 R-13 已裁决「D7-2 安全条件剪枝降级为不做，W24 只做 matcher mtime 缓存 + 短路径直通，matchPath 级剪枝保持改造前行为」；代码（file-service.ts:281-283）符合裁决。但 05 文档 §3.3 D7-2 仍完整保留「安全条件剪枝」方案描述、§4 V6 验收仍是「剪枝安全条件生效，取反目录未被误剪」——只读 05 文档会误以为该机制已实现。

**修复方案**：在 05 文档补勘误段（模式对齐 04 文档「实施期补记」：就地标注、不删正文、日期 + 指向裁决源）。

**验收条款**：
1. 05 文档 §3.3 D7-2 处有「实施定案/R-13 勘误」段：写明安全条件剪枝不做、保持 matchPath 级剪枝、指向 plan.md R-13 为裁决源
2. 05 文档 §4 V6 场景的验收措辞同步修正（改为「取反规则行为与改造前一致」口径）
3. 勘误段自包含（不依赖对话上下文可懂）

## Fix-3（文档勘误回写）：06-startup-logging.md D8-1「可并行」实现为全串行

**核查发现**：06 §3.3 D8-1 写「migrateProviderConfig、getPiVersion、skillRegistry.initGlobal、pluginService.initialize 相互可并行」；实际 `packages/runtime/src/services/startup-background-init.ts:46-154` 全串行 ①→⑦ 逐个 await，且该文件 :10-14 注释自称「顺序约束（06 §3.3 D8-1 定案）」与文档字面不符。

**修复方案**：文档补勘误段（实现是有意收敛，改文档不改代码行为）；代码注释措辞顺带对齐。

**验收条款**：
1. 06 文档 §3.3 D8-1 处有实施定案勘误段：写明实际实现为全串行 ①→⑦（列出七步）、唯一硬约束 migrateBuiltinExtensions→checkAndAutoUpgrade 满足且更严格、listen 提前主目标不受影响、代价 = 后台总完成时间为各段之和
2. `startup-background-init.ts:10-14` 附近注释措辞改为不与文档冲突的表述（如「06 §3.3 D8-1 的收敛实现（串行链）」），不改变任何代码行为
3. 勘误段自包含

## 越界禁改清单（builder）

- 禁改：本验收文档、`.xyz-harness/2026-08-15-perf/` 除 05/06/03 三份指定文档外的其他文件、`packages/` 下除 Fix-1 条款 1/2 与 Fix-3 条款 2 点名文件外的任何文件
- 禁 git add/commit/push（主 agent 统一提交）
- 认知外改动不碰：`packages/runtime/src/generated/builtin-providers.json`（工作区已有 M 态，非本任务产物）、根目录 untracked 的 `.cw/`、`.shot-*.mjs`

## Verifier 验收动作

1. 防篡改：`git diff <基线> -- .xyz-harness/2026-08-15-perf/consistency-audit-fixes-acceptance.md` 为空
2. 命令实跑：`cd packages/runtime && npx vitest run`（全绿）+ Fix-1 新测试真实存在且断言语义有效（非空洞断言）
3. 条款对照：本文档 Fix-1/2/3 逐条核验，行为对抗抽查 ≥2 条（如：worktree.create 失败路径确实不失效；05/06 勘误段是否真的与 plan.md R-13 / startup-background-init.ts 实况一致）
4. 越界扫描：`git status` 全量对照禁改清单
