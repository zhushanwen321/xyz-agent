# slice5（cleanup-batch）符合性验证报告

- 验证对象：wave1 = `093e28fe3`（+ followup `459202f25`）、wave2 = `dcee2c9b6`（+ followup `f4f4f9f9f`），2026-08-16 05:16–06:23
- 验收依据：`.cw/swf-perf-impl/cleanup-slice-design.json` 的 interfaces（IF1-IF14）/ dataModels（DM1-DM6）contract 字段
- 验证方式：独立读源码 + git diff 考古 + 命令实跑 + 3 条对抗抽查（builder 自报一律待证实，以下结论只基于 verifier 自行读到的代码与实跑输出）
- 验证日期：2026-08-17

## 总结论

**PASS** —— 14/14 接口项符合（11 项 PASS、3 项 PASS-with-note、0 项 FAIL）；勿动清单 9/9 零触碰；typecheck exit 0；vitest 164 files / 2196 tests 全绿；对抗抽查 3/3 通过。3 处 note 均为方向安全的实现增强或设计明文允许的偏差，不构成不符合。

## 一、14 项逐项结论

| IF | 结论 | 证据（file:line） |
|----|------|------------------|
| IF1 manifestCache | PASS | `shared/resource-discovery.ts:109`（Map 定义，DM1 结构逐字段一致）；`:269-292`（async stat→驱逐/命中/读败不缓存不驱逐）、`:559-582`（sync 同构，双读者共享同一 Map）；`:157`（clearFileCache 追加 `manifestCache.clear()`）；`:112-118` piToManifest 按 kind 派生不分裂条目。测试 `resource-discovery-manifest-cache.test.ts` 覆盖契约 5 场景：同 mtime 不重读 `:109`、mtime 变重读 `:129`、坏 JSON 不缓存 `:139`、坏 JSON 不驱逐好条目（utimesSync 恢复 mtime 验证）`:150`、stat 失败驱逐 `:167`；另含 kind 共享 parse `:121`、无 pi 也缓存 `:182`、async↔sync 双读者互命中 `:215/:236` |
| IF2 两级并行 | PASS | `resource-discovery.ts:487-507`（targets.map + Promise.all，注释明示保序与 ES2 异常语义，无新增 catch）；`:365-387`（scanNpmDir entries.map + Promise.all + `perEntry.flat()` 按 readdir 原序 concat，scoped 子包级同样并行）；`:511-522`（合并去重块零改动：stem last-wins + available=false 不覆盖）；`discoverResourcesSync:666` 串行未动（4 个 commit 的 diff 均不含该函数行，`git show ... \| grep discoverResourcesSync` 空）。parity 测试（f4f4f9f9f）`resource-discovery.test.ts:337/:350/:361`（async name-clash last-wins / project 优先 / 4 源混合与串行版快照等价）。对抗抽查见 §四-3 |
| IF3 帧缓存 | PASS | `interface/list-component.ts:88`（`FRAME_TTL_MS = 50`）；`:144-152`（collectRecordsFrame：TTL 内复用，过期调 `service.collectRecords(LIST_LIMIT)` 刷新）；4 调用点统一 `:134`（hasRunning）/`:177`（handleInput filter）/`:232`（buildLines）/`:593`（buildDetailContent children）；`:159-162`（invalidate 只清 cachedKey/cachedLines，不清帧）。`list-view.ts` animTimer 零改动（该文件最后改动为 e726711d0，wave range 内 0 commits）。测试 `list-component.test.ts:353-399`：同帧 1 次计数 / advance 100ms 重扫 / invalidate 不清帧 / detailMode children 同帧共享（fake timers + spyOn 计数） |
| IF4 source 标签 | PASS | `orchestration/config-loader.ts:295`（第二参改 `deriveResourceSource(filePath, workspaceRoot)`）；`:106-108`（tmp 前缀判定 → "project-pi-tmp"，否则 "user-pi"，DS4 非 tmp 输出不变）。测试 `config-loader.test.ts:454`（.tmp → source=tmp）、`:466`（普通路径 → saved）、`:477`（`.tmp-other/` 前缀不误伤） |
| IF5 模板 hoisting | PASS | `orchestration/worker-script-builder.ts:54`（模块级 WORKER_TEMPLATE_PRE）、`:373`（WORKER_TEMPLATE_POST）、`:396`（函数体收敛为三段 concat）。快照测试 `worker-script-template-snapshot.test.ts:40-43`（`expect(out).toBe(loadFixture())` byte-identical）+ fixture `__fixtures__/worker-template.snapshot.txt`（15612 字节，非空非占位，head/tail 核实为真实 worker 源）。对抗抽查见 §四-1 |
| IF6 _KNOWN_FIELDS | PASS | 生成源 module scope：builder `:69`（PRE 段内 `const _KNOWN_FIELDS = new Set([...16 字段])`，快照 fixture 首段可见，紧随 `_workerLogs` 声明后）；agent() 体内 `:243` 仅引用 `_KNOWN_FIELDS.has(k)`，无 `new Set`（builder 全文 grep `new Set` 仅 `:69` 一处）。结构断言测试 `worker-script-template-snapshot.test.ts:70-97`（声明位置在 IIFE 前 + agent 体无 new Set + 16 字段逐字段一致 + 警告文案不变） |
| IF7 stringifySchemaCached | PASS | `shared/schema-jsonify.ts:19`（WeakMap<object, {compact?, pretty?}>）`:27-38`（实现）。接入点：`agent-opts-resolver.ts:65`（compact）+ `session-runner.ts:478`（pretty，formatSchemaInstruction 内）；wave1 diff 确认 resolver/runner 的 instruction 文本未动（仅 stringify 调用替换）。6 个 helper 单测 `schema-jsonify.test.ts`：逐字节一致 / 同对象二调同引用（toBe）/ 跨格式分别缓存 / 不同对象不污染 / spy 计数零 stringify / pretty 缩进锚定 |
| IF8 skill 缓存 | PASS | `orchestration/skill-discovery.ts:46`（skillMemo Map）、`:49`（clearSkillPathCache 导出）、`:55-57`（has 先行区分「缓存 undefined」与「无条目」）、`:80`（未命中也缓存 undefined）。搜索序 project→user→npm 解析逻辑零改动（`:59-77`）。测试 `skill-discovery.test.ts` 6 用例：project 优先 / user 次之 / npm 兜底 / hit 零 stat / 未命中也缓存 / clear 后重扫 |
| IF9 lint memo | PASS-with-note | `models/workflow-script.ts:41`（lintMemo Map）、`:97-105`（validate 首查 `srcRef === this.sourceCode` 命中返回缓存）、`:44`（clearLintMemo 导出）；`config-loader.ts:305-311`（invalidateCache 追加调用）。测试 `workflow-script-lint-memo.test.ts` 5 用例（vi.mock script-lint 计数：同引用 1 次 lint / 等值字面量命中 / 同 path 新内容重 lint / clearLintMemo 后重 lint / 不同 path 隔离）。**note**：DM2 表述「srcRef 引用相等」，实现为 JS 字符串 `===` 值比较——实现注释（workflow-script.ts:36-39）说明 JS 原始类型不可区分引用/值、lintScript 已验证纯函数故值键是引用键的正确超集；等值异引用从设计预期的「miss 走现状」变为「hit 增强收益」，语义安全（等值输入 lint 结果恒同），方向无害 |
| IF10 pollInterval unref | PASS | `orchestration/launcher.ts:80-85`（`timer.unref?.()` 防御 duck-type 写法 + 注释对齐 gcTimer.unref?.() 先例，resolve 语义不变）。设计明确无需新断言，launcher-nested-workflow / workflow-nesting-e2e 回归绿 |
| IF11 签名条件失效 | PASS-with-note | `interface/views/WorkflowsView.ts:176`（computeRenderSignature 具名导出，now 参数化）；`:283-292`（tick 条件失效：lastSignature 初始 undefined 首 tick 必失效，相同直接 return 不清 cache 不 requestRender，不同走现状清缓存+requestRender）；`:148-171`（字段核对表：每字段 ↔ 渲染消费点 file:line，DS8/ES7 交付物）。测试 `WorkflowsView-signature.test.ts` 17 用例覆盖 DM6 全部场景：同输入同签名 / 静态 200ms 不变 / 秒桶跨秒 / run status / completed-total / budget tokens / cost 第 4 位小数 / errorLogs 追加与封顶内容移 / 节点 status / totalTokens / toolCalls 计数 / elapsedSeconds 跨秒 / turns / eventLog 追加 / currentActivity 出现与 label 变 / lastError / sessionFile / 节点重排。**note**：签名字段集为 DM6 定义的超集——followup 459202f25 补入 errorLogs 指纹（length+末条 level:message，防封顶后 length 不变内容移漏失效）与 node.sessionFile（异步出现字段）；工具计数用 `countAllToolCalls`（execution-record.ts:597-606 followup 新增，reduce 免克隆，与 `getAllToolCalls(node.live).length` 恒等——同一 turns 源）。超集方向 = 多失效不多绘不漏绘，DM6 notes 明示无害；纯函数表述已按 exec-review 修正为「now 参数化 + projectLiveProgress 内含实时源只朝多失效偏离」 |
| IF12 truncLine | PASS | `interface/format.ts:453-467`（内层 `flat.indexOf("\x1b", end)` 循环 + 非 SGR ESC 时 `end` 推进到该 ESC 后继续找，无逐字符 slice+match O(n²) 残留）；`:394-397`（isSgrStart：sticky regex 仅在 ESC 位判定一次，等价旧 slice(pos).match）；`:413-415` 注释明确非 SGR ESC 边界语义。快照 `__fixtures__/truncline.snapshot.json` 11 用例（含 sgr-mixed-10k×2 / osc-title / bare-esc / csi-k-mixed-sgr / osc-inside-truncation / esc-at-end / cjk / emoji / exact-fit），测试 `truncline-snapshot.test.ts:30-50` 断言逐字节一致；显式行为测试 `:52-81` 覆盖 OSC 按文本计宽 / 裸 ESC 不吞字符不死循环 / CSI-K 混排 SGR 重应用 / 串尾 ESC。followup 459202f25 另在 format.test.ts 落地 legacy 差分 harness（从 git 历史恢复 legacyTruncLine + 300 seeded 对抗用例逐字节比对） |
| IF13 boundedPrettySerialize | PASS | `interface/helpers.ts:58-151` 实现符合 TC5 全部规约：原语逐值 JSON.stringify（`:79-81`）、toJSON 子树整体 stringify（`:90-93`）、任何 stringify 抛出/循环引用 → 整体回退 String(value)（`:85-88` throw + `:144-150` catch 整串回退，超预算仍截断+标记）、undefined/function/symbol 属性跳过（`:119-121`）、数组元素 → "null"（`:108-110`）、截断边界恰好 budget + exceeded（> 判定）加 `"\n... (truncated)"` 不补结构闭合（`:63-72`/`:143`）。接入 `:227`（notifyDone scriptResult 段）。测试 `helpers-bounded-serialize.test.ts` 9 用例逐 fixture 对照契约：深嵌套 >8000 `:104`（`toBe(legacySerialize(x))` —— 断言 === 全量原生串 + slice + 标记，非仅 length）/ 循环 `:110` / BigInt `:117` / Date toJSON `:123` / undefined·function 属性与数组 null `:129` / 恰好 8000 `:166` / 8001 `:175` / 转义序列中间切断（charCodeAt(7999)===92 裸反斜杠）`:183` / ≤8000 全形态 `:140`。对抗抽查见 §四-2 |
| IF14 死路径删除 | PASS | 全 src grep `TRIGGERING_EVENT_TYPES\|ON_UPDATE_MIN_INTERVAL_MS\|onEventThrottled\|clearThrottle\|throttleState`：生产代码零命中，仅 `execute-nesting.test.ts:8/:319-320` tombstone 注释（指向 ledger #22，即设计要求的留档）。`types.ts:531+` ExecuteOptions 无 onUpdate 字段（diff 确认 `:552-553` 字段删除）；`finalize-record.ts` 无 clearThrottle（diff 确认 deps 声明 + 2 调用点删除）；tombstone 注释 `subagent-service.ts:1368-1372`（含编译期 fail-fast 说明）；`stream-sink.ts:28` 注释改写为「delta 合并窗口时间（ms）」消除悬空引用；onEvent 直通收敛 `const onEvent = rawOnEvent`（`:1372`）；dispose 路径 throttleState 清理段一并删除（diff `:495` 区域）。残留的 `onUpdate` 字样均为 pi SDK tool 回调签名（subagent-tool.ts:42/:361-365、tool-workflow.ts:344）与渲染注释，非 ExecuteOptions 机制，TC4 明确保留 |

## 二、勿动清单核验（slice1-4 锁定的 9 条）

核验方法：`git log 093e28fe3^..f4f4f9f9f -- <file>` 逐文件确认 wave commit 范围内零触碰；触及文件逐一读 diff hunk 定位。

| # | 锁定项 | 物理位置 | 结论 |
|---|--------|---------|------|
| 1 | record-store per-file stat 戳缓存 | `execution/record-store.ts` | PASS——wave range 内 0 commits |
| 2 | notifier 滑动窗口+dedup+isIdle 退避 | `execution/notifier.ts` | PASS——0 commits（重点项：dcee2c9b6 未波及 notification.ts，subagent-service.ts diff 中 `this.notifier.flushPendingNotifications()` 仅出现在未改动上下文行） |
| 3 | injector session 缓存 | `injectors/subagent-list-injector.ts` / `workflow-list-injector.ts` | PASS——0 commits |
| 4 | turn.text += delta | `execution/execution-record.ts:289` / `session-reconstructor.ts:382` | PASS——reconstructor 0 commits；execution-record.ts 仅被 followup 459202f25 触及，diff 唯一 hunk 在 `:594` 后纯新增 countAllToolCalls（`:597-606`），`:289` 叠加行未动 |
| 5 | ajv.compile 不缓存 | `orchestration/args-validator.ts` / `shared/meta-parser.ts` | PASS——0 commits |
| 6 | stderr 64KB 截断 | `execution/session-runner.ts:149`（STDERR_MAX_CHARS = 64*1024） | PASS——session-runner.ts 被 wave1 触及但 diff 仅 2 个 hunk（`:28` import 行 + `:432-455` formatSchemaInstruction），`:149` 未动 |
| 7 | save 签名与 11 调用点零改动 | `orchestration/jsonl-run-store.ts` 及消费方（index.ts / error-recovery.ts / ports.ts / trace.ts） | PASS——全部 0 commits；subagent-service.ts 的 wave2 diff 中无任何 save 调用改动 |
| 8 | workflow-state-link 仅首写/done 写 | `orchestration/lifecycle.ts` / `index.ts` / `jsonl-run-store.ts` | PASS——0 commits |
| 9 | onUpdate 节流排除 text_delta | subagent-service.ts 节流机制 | PASS——onUpdate 机制整体按 IF14/TC4 设计删除（合法处置）；diff 全部改动均与「删除」直接对应（常量 / 字段 / 3 处 deps 注入 / 包装收敛 / dispose 清理段 / tombstone 注释），无复活、无重构外的意外触碰 |

**设计外文件披露**：wave2（dcee2c9b6）触及根级 `eslint.config.mjs`（+15 行）——per-file override 关闭 resource-discovery.ts 的 `taste/prefer-allsettled`。设计 interfaces 未列此文件，但 DS3 明确否决 allSettled（保持串行版异常向上传播语义），override 带 [HISTORICAL] 注释完整说明理由，符合项目「规则误报的唯一正当处理」规范。判定为合规的伴随改动，非违规。

## 三、命令实跑

| 命令 | 结果 |
|------|------|
| `pnpm extensions:typecheck` | **exit 0**（tsc --noEmit 无输出错误） |
| `cd extensions/subagent-workflow && npx vitest run` | **164 files / 2196 tests 全绿**（0 failed；duration 27.86s）。builder 自报 wave2 时点为 162/2164，当前 164/2196 系后续 commit（wave 后的 b843a5f49 测试修复等）增量，无失败项 |

## 四、对抗抽查证据（真实性，非存在性）

1. **worker 模板 byte-identical 快照独立重算**：tsx 探针直接 import `buildWorkerScript`，用快照测试同款样例脚本（覆盖 $ARGS/schema/parallel/pipeline/workflow/phase/log）独立计算输出，与 `__fixtures__/worker-template.snapshot.txt` 逐字符比对 → **14974 字节 === 14974 字节，byte-identical: true**。不依赖 vitest 断言真伪。（注：fixture 内容为 IF6 后最终形态——设计 IF6 contract 明确「两者同 commit 内先更新基线」，当前快照锁定当前实现 + 本抽查独立重算一致，防未来漂移的锚定有效。）

2. **IF13 等价性 fuzz**：tsx 探针经 notifyDone 公共入口（boundedPrettySerialize 为私有），对 200 个随机深嵌套对象（5 层、随机数组/对象/Unicode/控制字符/长字符串混合）独立比对 bounded 输出与 `JSON.stringify(x,null,2)` + try/catch String + slice(0,8000)+标记 的 legacy 全串 → **190 pass / 0 fail / 10 skipped**（skipped = 顶层 null，被 notifyDone 上游 `!== undefined && !== null` 守卫跳过整段，测试文件 :141-142 注释已声明该边界不属于序列化路径，首轮 4 个「fail」即此探针自身未排除顶层 null 所致，修正后归零）。定向用例：BigInt → `String(x)` 整串回退 true、循环引用 → `String(x)` true、Date(toJSON) === legacy true。断言口径为 === 完整 legacy 串，非仅 length。

3. **IF2 保序独立探针**：构造 6 源 fixture（user-pi / user-agents 混入真实用户目录 / npm scoped×3 + unscoped + 带 pi.manifest 包 / project-pi / project-agents，含同 stem 冲突），并行版 `discoverResources` 与串行版 `discoverResourcesSync` 交替各跑 30 轮 → **30/30 JSON 逐字节相等**；输出序 = targets 优先级序（`user-pi:dup.md \| user-pi:u1.md \| user-agents:... \| npm:m1/m2(manifest) \| npm:n-p1/n-p2/n-plain-pkg \| project-pi:a/b-proj \| project-agents:proj-agent`），实现是 `targets.map + Promise.all`（map 数组天然保序）+ 合并阶段按 allBySource 序消费，**非 allSettled 乱序**（全 src 该文件无 allSettled）。

## 五、遗留与说明

- 无 FAIL 项、无未完成核对项。14 项全部核对、9 条勿动全部核对、2 条命令全部实跑、3 条抽查全部执行。
- 3 项 PASS-with-note（IF9 值键超集、IF11 签名字段超集 + countAllToolCalls 恒等替换、eslint.config.mjs 设计外文件）均为 exec-review followup 或设计明文允许方向上的增强，不需返工。
- 临时探针（/tmp/probe-*.mts）已清理，未产生仓库内文件改动；本报告为唯一写入文件。
