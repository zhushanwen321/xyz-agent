# consistency-audit-fixes 验收报告（verifier，2026-08-17）

> 验收对象：builder 交付的 consistency-audit-fixes（Fix-1 代码缺口闭环 + Fix-2/Fix-3 文档勘误回写）。
> 验收基线：commit `242fd89a5`（`.xyz-harness/2026-08-15-perf/consistency-audit-fixes-acceptance.md`）。
> 验收方式：对抗式独立验收——builder 自报逐项实证，防篡改 + 命令实跑 + 断言语义审查 + 行为对抗抽查。

## 总结论：PASS（附 1 个 minor 问题，不构成打回）

## 1. 防篡改与越界扫描

| 检查项 | 结果 | 证据 |
|---|---|---|
| 验收文档未被篡改 | PASS | `git diff 242fd89a5 -- .xyz-harness/2026-08-15-perf/consistency-audit-fixes-acceptance.md` 输出为空 |
| `git diff 242fd89a5 --stat` 逐文件核对 | PASS | 9 文件改动：7 个验收条款点名/披露文件 + `builtin-providers.json`（认知外豁免） |
| `git status` 全量越界扫描 | PASS | untracked 仅 `.cw/*`（12 个）、`.shot-*.mjs`（2 个），全部在豁免清单 |

改动文件对照（基线 → 工作区）：

| 文件 | 定性 |
|---|---|
| `packages/runtime/src/transport/worktree-message-handler.ts` | Fix-1 条款 1 点名 |
| `packages/runtime/src/transport/worktree-message-handler.test.ts` | Fix-1 条款 3 点名 |
| `packages/runtime/src/transport/server.ts` | builder 披露清单外文件（见 §4 独立审查：最小必要成立） |
| `packages/runtime/src/services/worktree/worktree-service.ts` | builder 声明「主 agent 授权伴生注释更新」；diff 证实仅文件头注释，零代码行为改动 |
| `packages/runtime/src/services/startup-background-init.ts` | Fix-3 条款 2 点名；diff 证实仅 :10-16 注释，零代码行为改动 |
| `.xyz-harness/2026-08-15-perf/03-git-state-service.md` | Fix-1 条款 4 点名 |
| `.xyz-harness/2026-08-15-perf/05-scan-caching.md` | Fix-2 点名 |
| `.xyz-harness/2026-08-15-perf/06-startup-logging.md` | Fix-3 条款 1 点名 |
| `packages/runtime/src/generated/builtin-providers.json` | 认知外豁免（工作区既有 M 态，1 行 diff） |

builder 未执行 git add/commit/push（工作区全部为未暂存改动）。

## 2. 命令实跑

| 命令 | 结果 | 与自报对照 |
|---|---|---|
| `cd packages/runtime && npx vitest run` | 253 files / 2907 tests 全绿（30.55s） | 一致 |
| `cd packages/runtime && npx tsc --noEmit` | 零输出，exit 0 | 一致 |
| `npx eslint`（4 个改动源文件 + 测试文件） | 4 源文件零输出；测试文件被项目 ignore pattern 排除（warning 非 error，exit 0） | 一致（自报「源文件零输出」措辞准确） |
| 单跑 `worktree-message-handler.test.ts` | 18 tests 全过（含新增 4 个） | 新测试真实执行 |

## 3. 验收条款逐条对照

### Fix-1（worktree 写操作失效闭环）

| 条款 | 结论 | 证据 |
|---|---|---|
| 1. create 成功 reply 前失效、失败不失效 | PASS | worktree-message-handler.ts:79-81：`requestCwd = workspaceHint ?? process.cwd()` 后 `this.ctx.gitService?.invalidateStatusCache({ cwd: requestCwd })` 紧接 `return this.ctx.reply(...)`；catch 分支（:82-84）直接 sendWorktreeError，无失效调用 |
| 2. 组合根既有注入模式、不自建实例 | PASS | 注入链 index.ts:483 `setServices(...gitService...)` → server.ts:128 `this.gitService = git` → server.ts:255 `gitService: this.gitService ?? null` 传入 handler ctx；handler 内零 `new`，仅消费 ctx。GitMessageHandler 同款走法（server.ts:213-217 `if (this.gitService)` + ctx 字段） |
| 3. 新测试真实断言（非空洞） | PASS | 见 §5 断言语义审查 |
| 4. 03 文档 §5 标注已闭环 | PASS | 03:206 追加「**已闭环：挂 invalidateByCwd（2026-08-17）**」段，含调用点/缺省值/失败路径语义/取代旧「接受陈旧」声明，与代码实况一致 |
| 5. vitest 全绿 | PASS | 253/2907 |

### Fix-2（05 文档 R-13 勘误）

| 条款 | 结论 | 证据 |
|---|---|---|
| 1. §3.3 D7-2 勘误段（剪枝不做、保持 matchPath 级、指向 plan.md R-13） | PASS | 05:115 勘误段，三要素齐全 + file-service.ts:281-283 实况引用（行号核对准确：matchPath 判定 :281、continue 跳过下钻 :282） |
| 2. §4 V6 措辞修正 | PASS | 05:145 改为「取反规则行为与**改造前**一致（以改造前实测为基线……）」 |
| 3. 勘误段自包含 | PASS | 含裁决源、理由、实施口径、被否内容说明，无需对话上下文 |

### Fix-3（06 文档 D8-1 勘误）

| 条款 | 结论 | 证据 |
|---|---|---|
| 1. §3.3 D8-1 勘误段（七步串行 + 硬约束 + listen 不受影响 + 代价） | PASS | 06:108 勘误段四要素齐全；七步与代码逐字一致（见 §6 抽查 c-2） |
| 2. startup-background-init.ts 注释措辞对齐、零行为改动 | PASS | diff 仅 :10-16 注释（「收敛实现——串行链」表述），代码零改动 |
| 3. 勘误段自包含 | PASS | 列全七步含各步职责注释 |

## 4. server.ts 4 行最小必要性独立审查

builder 理由「WorktreeMessageHandler 的 ctx 在 server.ts setServices 内构造，注入物理必经」——**证实**：

- `WorktreeMessageHandler` ctx 的**唯一**构造点是 server.ts:248-257（`if (worktree)` 块内）；index.ts 不直接构造该 handler，只经 :483 `setServices` 传 service 实例。
- gitService 已是 server 私有字段（:64/:128），GitMessageHandler 注入即用 `this.gitService`（:217）——「git handler 同款走法」属实。
- 更小改动路径不存在的论证：绕开 server.ts 需改 WorktreeService 构造使其携带 gitService（违反「编排层不感知缓存」分层，改动面更大）或给 server 新增 setWorktreeHandler 类入口（两文件联动，更大）。实际净代码改动仅 1 行（`gitService: this.gitService ?? null`）+ 3 行注释，接口字段声明在 handler 文件内。**判定：最小必要成立。**

与验收条款 2 字面「走组合根 index.ts 既有注入模式」的偏差说明：项目既有注入模式实为「index.ts setServices → server.ts 构造 ctx」（index.ts:329 注释佐证 GitMessageHandler 同链），builder 遵循的是该既有模式，条款精神（组合根注入、不自建实例）满足。

## 5. Fix-1 新测试断言语义审查（防空洞）

4 个新用例（worktree-message-handler.test.ts:157-241，单跑全过）：

1. **invocationCallOrder 用例（:159-185）**：有效。独立 `reply = vi.fn()` 覆盖 ctx.reply，`invalidateStatusCache.mock.invocationCallOrder[0] < reply.mock.invocationCallOrder[0]`（vitest 全局单调递增调用序）真实锁定「失效先于 reply」；前置 `toBeDefined()` 双断言防「未调用 → undefined 比较」假阳性；另有 toHaveBeenCalledTimes(1) + toHaveBeenCalledWith({cwd:'/project'}) + reply payload 断言。
2. **process.cwd() 缺省用例（:187-200）**：有效。payload 无 workspaceHint → 断言 `{ cwd: process.cwd() }`。
3. **失败路径用例（:202-219）**：有效。`create` mock 真实 throw 扁平错误（带 code），断言 invalidate not called + reply not called + sendError calledTimes(1)——确走 catch→sendWorktreeError 分支，且该分支无失效调用（源码 :82-84 佐证）。
4. **gitService null 用例（:221-241）**：有效。`await expect(...).resolves.toBeUndefined()`（不抛错的显式断言，非仅不崩）+ reply 正常携带 worktree.created payload（成功路径行为不变）。

## 6. 行为对抗抽查（3 条，≥2 达标）

### a. requestCwd 推导与 worktree-service cwd 语义一致性 — PASS

handler `requestCwd = workspaceHint ?? process.cwd()`（worktree-message-handler.ts:79）与 worktree-service.create 内部 workspace 探测起点 `detector.detect(workspaceHint ?? process.cwd())`（worktree-service.ts:155）**完全同式**，失效的 cwd 与实际操作的 repo 上下文一致，未失效错误目录。生产链上 index.ts:483 已传 gitService，`?? null` 仅防御测试/未注入场景。

### b. invalidateStatusCache vs invalidateByCwd 名称差异 — PASS（非语义缺口）

`GitService.invalidateStatusCache(target)`（git-service.ts:110-113）在 `target.cwd !== undefined` 时**无条件**调 `this.opts.stateService.invalidateByCwd(target.cwd)`；`GitStateService.invalidateByCwd`（git/git-state-service.ts:278-280）按缓存键后缀 `${KEY_SEP}${cwd}` 匹配删除，覆盖共享该 cwd 的全部 session。方法链闭合：验收文档写的 `invalidateByCwd(cwd)` 与实现的 `invalidateStatusCache({cwd})` 是同一失效语义（门面 → 实现两层）。

### c. 勘误段与裁决源/代码实况一致性 — PASS

- **c-1（05 vs plan.md:150-155 R-13）**：R-13 原文「matchPath 级剪枝现状不动 / 安全条件剪枝不做 / V6 措辞改『与改造前一致』/ W24 只做 matcher mtime 缓存 + 短路径直通」四要点，05 勘误段逐条覆盖且无添加私货；file-service.ts:281-283 实况（matchPath 命中 + 默认隐藏模式 → continue 跳过下钻，不检查 matcher 是否含取反规则）与勘误段描述吻合。
- **c-2（06 七步 vs startup-background-init.ts）**：勘误段 ①migrateProviderConfig(:57,setMigrationGate:82) ②migrateBuiltinExtensions(:90) ③checkAndAutoUpgrade(:100) ④getPiVersion(:116,mutate+补发) ⑤skillRegistry.initGlobal(:128) ⑥pluginService.initialize(:138) ⑦ensureAutoRenameDefault(:148)——与代码执行顺序**逐字一致**，逐步 await 全串行属实；「唯一硬约束 ②→③ 更严格满足」「listen 不受影响」「代价 = 各段之和」三论断均与代码结构相符。

## 7. 发现的问题

### minor-1：测试注释不实引用（不影响验收结论）

- 位置：`packages/runtime/src/transport/worktree-message-handler.test.ts:163`
- 内容：注释称「对齐 git-message-handler.test.ts 的模式」——**该文件不存在**（transport/ 下仅有 git-message-handler.ts，无对应测试文件），且 `invocationCallOrder` 在整个 runtime 测试中无先例（本文件是唯一使用点）。
- 影响：断言本身有效（vitest 官方 API，单跑通过），但注释会误导后续读者去对照一个不存在的「既有模式」。
- 处理建议：注释改为「用 vitest invocationCallOrder 断言调用序」即可去除虚假先例引用（由主 agent 酌情修，不阻塞本验收）。

### 观察记录（非缺陷，条款范围内设计选择）

`invalidateByCwd` 按发起 cwd 后缀精确匹配，同 bare repo 下**其他** worktree cwd（未发起请求的面板）的 branches 缓存仍有 ≤2s TTL 陈旧窗口。验收条款 1 原文即「对发起请求的 cwd 调失效」，worktree-service.ts 头注释与 handler 注释均如实披露该影响面语义，2s TTL 自愈。不构成 FAIL。

## 8. 结论

- Fix-1 / Fix-2 / Fix-3 全部验收条款 PASS（共 11 条逐条见 §3）。
- server.ts 4 行最小必要成立（§4）。
- 3 项命令实跑与 builder 自报一致（§2）。
- 3 条行为对抗抽查全部 PASS（§6）。
- 唯一发现：minor-1（测试注释不实引用），不构成打回。

**总结论：PASS**
