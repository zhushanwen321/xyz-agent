# integrity-hardening 实施一致性审查（R2）

> 审查日期：2026-08-20 / 审查范围 `git diff 3d9f31186..fb779dbc1`（R1 修复轮，13 文件）+ 全量复核（22 决策 / 10 验收场景抽查）/ 与 R1 的关系：R1 报告 19 项 finding 修复验证 + 修复引入新问题 + 全量漂移复查。审查基调：对抗式，逐项找反例，反驳不了才放行。
> 声明：S3/S4 打包态实测无法在审查中重放，仅验证仓内记录的自洽性与机制正确性；其余所有断言均经 read 源码 / 跑测试 / 程序化比对核实。

## Summary

**0 must-fix, 2 suggestion, 1 info.** R1 的 19 项 finding 全部修复到位，无一表面应付——三处高风险回写（收殓判据、CSP 定稿、强杀收敛编排）经逐字/逐行比对与代码实况一致；两处代码行为修复（quota quarantine、file-lock parity 测试）经真实运行验证通过。新 finding 集中在文档可追查性：§2「现状」章节的当下断言未随实施收尾（其中一处交叉引用已与所指注释内容相反），以及一批设计期行号引用漂移（D3a 段落本轮被编辑却未顺带修正）。

## R1 修复验证（19 项对照表）

| R1 项 | 判定 | 依据 |
|---|---|---|
| MUST_FIX #1（收殓判据 7 处回写） | **到位** | §1 术语/§2.5 图示/§3.4 方案 A/D4a/D4b/S6/门 4 全部改写为 argv（`--mode rpc` + `--session-dir` 精确等值）+ `ppid===1`，与 `packages/runtime/src/services/reap-orphan-pi.ts:134-157` 实况逐项吻合；「单实例锁不承担跨实例保护」与头注释防线③一致；S6 验收法已改 `ps -axo pid=,ppid,command=`（与 `defaultListProcesses` 实现一致）；dev 隔离论据与 `apps/electron/main/main.ts:121-128`（缺省 `~/.xyz-agent-dev` + setPath userData）一致。残留见新 SUG#1（§2.5 图示时态） |
| MUST_FIX #2（D3a 手动编排） | **到位** | 方案对比 A 与 D3a 均如实改写：双层守卫（`_killing` 标志 + 先删 processes Map）拦截 exit 事件、收敛为 message-dispatcher 内手动编排五步、注明「第二份副本，两处必须同步维护」——与 `packages/runtime/src/services/session/message-dispatcher.ts:215-233` 实际编排（detach → destroy → persistSessionOutcome → publish session.exited → removeSessionEntry）逐步一致 |
| MUST_FIX #3 + 门 5（CSP 定稿回写） | **到位** | D2c 定稿指令集与 `packages/renderer/index.html:16` 实际 CSP **程序化比对 EXACT MATCH**（含新增 `font-src 'self' data:`）；三处同步确认——D2c 修正③、§6 门 5（补 font-src 后打包态零违规）、§4 验收记录 S3（「CSP meta = 定稿指令集」「补 font-src 后 rebuild 复验全绿」）；index.html 注释（W2 dev + S3 打包双态记录）与 W2/S3 记录互证，font-src 三处口径一致 |
| MUST_FIX #4（worktrees.json 登记行） | **到位** | `worktree-registry.ts:162` withFileLock（async 版）✓；降级无锁 RMW + warn 在 `:166-178` ✓；登记参数（retries 10 / factor 2 / 100ms~10s / randomize + stale 30s + onCompromised fn 前抛错）与 `extensions/shared/file-lock/src/file-lock.ts:79-92` 逐项吻合；`reconcileWithPhysical` 确在 `worktree-manager.ts:371` ✓ |
| MUST_FIX #5（rename-session-ext-config 行） | **到位** | `config.ts:26`（import withFileLockSync）/`:207`（锁内写）/`:130-132`（uniqueTmpPath）全部核实；「锁失败返回 success:false 不降级」与 `:206-213` 一致且与 worktrees 行降级语义的差异理由如实登记；「runtime 侧 tmp 同步对齐」为真——`worktree-config-helper.ts` setRenameModel 实传 uniqueSuffix（`pid_随机段`） |
| MUST_FIX #6（worktree-config-helper 注释） | **到位** | 注释改写为「W4 起已持同一把锁…双端闭环；extension 侧锁失败不降级」，与现实一致，原「留待主 agent 决策」误导性表述已删 |
| MUST_FIX #7（G3 边界） | **到位** | G3/D3a 终态/S5 表三处登记「全新 session 首 turn 冻结→pi 未 flush→SESSION_NOT_FOUND→需新建 session，损害限于未完成 turn」，三处表述一致无矛盾 |
| MUST_FIX #8（§4 验收执行记录） | **到位且自洽** | S1-S10 全登记，「未列 PASS 均非已验收」声明 + S7/S8 deferred / S9 待 push 如实分级；G2 断言现有 S3/S4 实测背书。S3 记录（7 断言、data:font 抓取→补 font-src→rebuild 复验）与 D2c/门 5/index.html 四处闭环自洽；S4 的「双新实例 1.4s exit 0」+「旧版无锁并存不互斥」澄清机制上正确（requestSingleInstanceLock 确需双方实现），与 D2d 无矛盾 |
| SUGGESTION #1（门 1-5 回写） | **到位** | §6 实施期门 5 项全部「已消解」格式；门 4 如实记「探针结论否决设计判据」而非粉饰为验证通过 |
| SUGGESTION #2（附录 B v4） | **到位** | v4 条目六波 commit hash（026734166/e3263ba83/0308eb1a1/29a555815/797655021/3d9f31186）经 git log 全部核实存在且波次内容与 commit message 吻合 |
| SUGGESTION #3（quota quarantine） | **到位且行为正确** | `cache.ts:197-203/:261-266` 两处均「先 existsSync 再 quarantine」——ENOENT（无文件正常态）不隔离，边界正确；rename 失败仅升级日志不阻断降级路径；隔离后写回不再把半截文件合法化。**实测：`npx vitest run src/__tests__/cache.test.ts` 29/29 通过**（26 旧 + 3 新，新增用例真实覆盖半截 JSON 隔离 + ENOENT 不隔离），与既有单测兼容 |
| SUGGESTION #4（reap 注释论据） | **到位** | 原「dev 与打包版默认共用同一数据目录」假命题已改为 dev 自动隔离 + 真实场景（XYZ_AGENT_DATA_DIR 显式同目录双开），与 main.ts:121-128 一致，防线②结论未动 |
| SUGGESTION #5（AGENTS.md） | **到位** | shared 库列举补 file-lock |
| SUGGESTION #6（parity 测试） | **到位且真实** | `packages/runtime/test/file-lock-parity.test.ts` 3 用例经真实运行通过——不止常量对照，第三个用例真做了**跨侧行为互斥断言**（runtime 持锁期间 extension 侧 ELOCKED fail-fast、释放后可获取），同时守护 lockfile 路径推导一致。import 路径（`../../../extensions/shared/file-lock/src/file-lock.js`）经 vite TS-importer 解析 `.js`→`.ts` 成功，proper-lockfile 经 workspace node_modules 链解析成功；`packages/runtime/vitest.config.ts` include `test/**/*.test.ts` 覆盖，CI 会跑到 |
| INFO #1（auto-rename 路径） | **到位** | 登记表改为 `<piAgentDir>/auto-rename-enabled`，与 `worktree-config-helper.ts:52` 一致 |
| INFO #2（chat-app 排期） | **到位** | 附录 B v4 注明「经用户授权后提前至 W0 执行」 |
| INFO #3（D8b 形态） | **到位** | D8b 补「实施形态说明（W5）：等效 grep/node 实现并注明同步维护义务——长期双维护点」 |
| INFO #4（hideThinkingBlock） | **到位** | 新注释「不在 xyz 侧 SCOPE_FIELDS.model 写域…靠字段域 merge 保锁内最新值」，与 `SCOPE_FIELDS.model = ['defaultProvider','defaultModel','defaultThinkingLevel','enabledModels']` 实际一致 |
| INFO #5（stale 精度） | **到位** | D1a 改为「未显式设 stale——proper-lockfile lockSync 默认 stale 10s 仍生效」，默认值 `stale: 10000` 已从 `node_modules/proper-lockfile/lib/lockfile.js` 核实 |

## 新 Findings

| 优先级 | 位置 | 类型 | 描述 | 修复方向 |
|---|---|---|---|---|
| SUGGESTION | `integrity-hardening.md:76`（失败模式 G）与 §2.5 图示（约 :132-137） | 现状断言未收尾 + 交叉引用反转 | 两处以当下时态断言「设计期问题仍存在」：① 失败模式 G 说对账兜底「（worktree-registry.ts:17，✅已核实注释原文）**在代码里不存在**（全仓无 `branch --list`/tmpdir 对账）」——W4 后 `worktree-registry.ts:17` 注释已改写为「条目丢失由 reaper 对账兜底（worktree-manager scan 的双向 diff，**见 reconcileWithPhysical**）」且 `worktree-manager.ts:322/:371` 对账代码存在：行号指向的注释内容与文中引述相反，「在代码里不存在」为假。② §2.5 图示「现状: 无任何组件扫描/回收它们」保留旧定性，而 W3 已实现收殓（`startup-background-init.ts:66-69` 挂载 reapOrphanPiProcesses）。半新半旧的编辑比原文更易误导 | 两处补时态标注（设计期快照，已由 D5b/W3 落地，见 §3.4/§3.5） |
| SUGGESTION | `integrity-hardening.md:218`（D3a）、`:275`（D6a）、`:375`（§6） | 行号引用漂移（设计期写入、未随代码演进更新） | ① D3a 与 §6 两处引用 `rpc-client.ts:418` 的超时 reject——实际 reject 已是 `rpc-client.ts:452` 的 `reject(new RpcTimeoutError(type, timeout))`，:418 现为无关内容；② D6a 引用 `session-service.ts:210`（槽）/:350（注入）——实际 `:216`（onSessionDestroyedHandlers）、`:361`（setOnSessionDestroyed），:350 是 setOnSessionCreated；③ D3a 引用 `session-service.ts:724-728`（ensureActive restore）——ensureActive 定义在 `:751` | 三处行号按当前代码更新（452 / :216+:361 / :751） |
| INFO | `extensions/shared/quota-providers/src/cache.ts:181` + `data-source-registry.md` §6 | 登记表覆盖缺口（低危） | quota-cache.json 的缓存写入仍用固定 `${CACHE_PATH}.tmp` 且无锁——多 pi 进程内扩展实例并发写方。本次 quarantine 修复改善了损坏面，但并发写面（tmp 同名互踩 → 单次写入丢失）未治理；数据为易失缓存（TTL 2 分钟）危害低，附录 A 已将「非原子写族 quota 日统计」列为 out-of-scope backlog——本条提示登记表规约的覆盖缺口 | 后续补登记表条目（豁免锁/易失缓存论证）或 backlog 显式列出 |

## 全量复核抽查结论

22 条决策中本轮修复触及的 10 条（D1c/D1e/D2c/D3a/D4a/D4b/D5a/D5b/D8a/D8b）已逐项重验为一致；未触及的 12 条抽查无新失配（D6a 仅行号漂移，见 SUG#2）。10 个验收场景经 §4 验收执行记录全量登记后无「文档声称已验而实际未验」项；S9（CI invariants job 远端实跑）如实标待验，是唯一残留的未闭环验收项。

## 结论

**R1 修复总评：19/19 真修到位，无表面应付**。残留 0 must-fix；2 suggestion 均为文档可追查性问题，1 info 为登记表覆盖缺口。R2 后该设计文档与代码的一致性达到可收尾状态。
