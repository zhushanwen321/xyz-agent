# 影响面审查报告：chat-pin-bottom-fix.md

> reviewer：tech-design-impact-review（专审 P0-12 / P0-19 / P0-20，归口分工见 rubric-design-doc.md）。主审领地（P0-1~11/13~18/21、P1）的线索以 INFO 交接，不重复判定。
> 审查方式：全部结论经实读源码核实（MessageStream.vue、useVirtuaFollow.ts、useMessageStreamScroll.ts、useMessageStreamRail.ts、useForkNoticeStream.ts、useConstantHeightAssert.ts、ActivityStrip.vue、既有测试、.githooks/、docs/constraints.json、packages/mobile-renderer）。

## Summary

2 must-fix, 5 suggestions. 方案主体（wrapper 定位安全性、RO 网对 4 watch 的覆盖性、宿主写入面、已接受代价四要素）经核实成立；两处 must-fix 均为护栏/清扫清单的**枚举遗漏**——pre-commit 白名单漏列 TraceView.vue 等既有合法调用点（护栏落地即红），以及删除 useMessageStreamScroll 的 docs 悬空引用清扫未入文件改动地图（违反 C-proc-10 纪律）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4.4 ④ / U4（机器护栏） | P0-12 | **pre-commit 白名单枚举遗漏，护栏一落地即误红**。设计写「扫描 `scrollToIndex` 调用点白名单（useVirtuaFollow.ts / useMessageStreamRail.ts）」，但实读源码 `scrollToIndex` 在 src 下还有：`components/panel/trace/TraceView.vue`（trace 视图滚动，合法独立链路）与至少 9 个测试文件（`MessageStream.wire.test.ts`、`MessageStream-kind.test.ts`、`_virtua-mock-helper.ts`、`use-virtua-follow.test.ts` 等通过 mock handle 断言 scrollToIndex 调用）。按现白名单，未改动这些文件的任何提交也会被拦截，违反项目「pre-commit 检出问题必须全部正面修复」纪律（守卫本身成为误报源） | 白名单补 TraceView.vue，或将扫描范围收窄到「MessageStream 跟随链路目录」（composables/panel + MessageStream.vue）并排除 `__tests__`/`.test.ts`；在 §4.4 写明扫描范围定义 |
| MUST_FIX | §6.2 文件改动地图（U3） | P0-12 / C-proc-10 | **删除符号的 docs 悬空引用清扫未列入改动地图**。`docs/design/composer-multi-skill-injection.md:265` 明文引用 `useMessageStreamScroll.ts:61`（normalizeContent 投影面第 ⑤ 项），另有其 `.impact-review.md:75` 同引。AGENTS.md 设计文档同步纪律要求「符号删除须同批清扫 docs 与测试注释中的悬空引用，`check-doc-symbol-drift.mjs` 必须跑过」；文件改动地图没有该条目，实施者按地图执行必然漏 | 改动地图补一行「清扫：docs/design/composer-multi-skill-injection.md（+impact-review）中 useMessageStreamScroll 引用改为新链路表述，跑 check-doc-symbol-drift.mjs」；实施时全仓 grep `useMessageStreamScroll` 复核 |
| SUGGESTION | §4.3 D3（未读标记纪律） | P0-12 | **一处未声明的语义差异：对话完成收缩时「回到底部」按钮的点亮行为**。旧 isSessionActive watch 走 `followIfStuck`，非贴底时置 `unreadBelow=true`；新纪律规定「内容降低 → 不标 unread 的静默跟随变体」，trace 折叠（高度骤减）落在该分支 → 非贴底用户在对话完成瞬间不再点亮的按钮。实际窗口极窄（streaming 增长期已把 unread 置真且只有回贴底才清零，唯一差异序列是「流结束后、折叠前用户脱离贴底」的毫秒级窗口），但这是接管既有流程后未声明的行为变更 | 在 D3 或 Out-of-scope 显式登记该语义差异及「窗口极窄、判定可接受」的依据；或在完成路径保留一次标 unread 的补偿 |
| SUGGESTION | §6.2 文件改动地图 | P0-12 | **既有 MessageStream 挂载级测试的适配未列入**。地图只列 use-virtua-follow.test.ts 与删除 use-message-stream-scroll.test.ts，但 `MessageStream.wire.test.ts` / `MessageStream-kind.test.ts` / `MessageStream-subagent-force-working.test.ts` 等直接挂载 MessageStream：U2 的模板 wrapper + `:scroll-ref` + RO 挂载会进这些测试的渲染树（happy-dom RO stub 是否存在决定是否报错），其 mock Virtualizer 的兼容字段集也可能需随 U1 签名变更调整。§6.3 只标注了「单测 RO stub 待定」未点名这批文件 | 地图补「适配：MessageStream 挂载级测试（wire/kind/subagent-force-working）」或 §6.3 待验证点点名；U3 验收命令实际跑全量 renderer 测试会暴露，提前声明可避免「静默改测试」嫌疑 |
| SUGGESTION | §4.3 U2（wrapper 结构约束） | P0-12 | **wrapper 对 absolute 浮层的归属未显式声明**。现模板中空态欢迎语（`absolute inset-0`）、load-more 浮层（`absolute top-0`）是 scrollEl 直接子节点；U2 只说 wrapper 包 Virtualizer + tailEl。核实结论：只要 wrapper 保持「静态无样式」（无 position），它不构成 containing block，两个浮层即使误入 wrapper 仍锚定 scrollEl（`relative`），定位不破——安全成立，但该安全性依赖 wrapper 永不获得 position，这一约束值得与 28px 数学不变量同级的注释钉住 | U2/结构护栏补一条：「wrapper 禁止任何定位/尺寸样式（保持 static），空态欢迎语与 load-more 浮层留 wrapper 外」写入模板注释与 §4.4 结构护栏清单 |
| SUGGESTION | §4.3 D6（vlistBottom 消费面表述） | P0-12（INFO 交接主审 P0-11） | D6 称 vlistBottom「当前仅被 fork notice 的 absolute 定位基线消费（useForkNoticeStream.ts:81-92）」，实读还有第二条消费链：`useMessageStreamNotices.ts:110` 接收 vlistBottom → useNoticeStack 算 `forkNoticeBaseTop` → 注入 useForkNoticeStream。且 `forkNoticeTop` 的最终产物在 MessageStream 模板中已无绑定（ForkNotice 现为文档流 `py-1` v-for，非 absolute）——即整条定位链疑似死路径，与 §6.3 第三条待验证项一致但不完全等同。不影响 D6 修正本身的正确性（对两条链同时生效） | §6.3 待验证点补充 useMessageStreamNotices→useNoticeStack 这条链的核实；若确认死路径，D6 效果表述改为「整条 fork absolute 定位残留链待独立清理」（与 Out-of-scope 声明一致） |
| SUGGESTION | §4.4 已接受代价 | P0-20 | RO 回调/dev 断言代价四要素已齐（通过）；但 pre-commit 守卫本身的代价未量化：每提交一次全仓 grep 的耗时与 `findItemIndex(.*scrollSize` 误报面（正则若不锚定文件类型会扫 docs/测试快照）。量级小，补一句即可 | §4.4 代价段补守卫脚本的扫描范围与预期耗时 |

## 核实通过项（依据摘要）

- **wrapper 与既有接线的兼容性（P0-12）**：`onWheel` 绑在 scrollEl、事件冒泡不受 wrapper 影响；`useMessageStreamRail` 的 panelRightEdge 走 `scrollEl.closest('section')` + 独立 RO，与 wrapper 无关；`useStreamingPin` 的 keepMounted 是 Virtualizer prop，virtua 内部消费，与 wrapper 正交（scrollRef 等价性由 P-wrap 探针门覆盖，设计已列 ⛔ 与降级路径）；`:shift`/`:start-margin`/`:key=session` 均 prop 级，不受包裹影响。
- **4 watch 的 RO 覆盖性（P0-12）**：消息条数/末条文本/isCompacting 三者的效果均体现为 contentWrapEl 或 tailEl 高度变化（新 item、streaming 增高、ActivityStrip 行进出 tailEl），RO 结构性覆盖成立；唯一语义缺口见上表 SUGGESTION 1（完成收缩的 unread 点亮），已登记。
- **宿主/外部写入面（P0-19）**：不适用级别——方案纯 renderer 内存行为，唯一持久写入 = constraints.json 登记 + render-constraints.mjs 重生成（已在改动地图），无 DB/OS/第三方接触。
- **已接受代价四要素（P0-20）**：§4.4 末段量级/恢复路径/重审条件/显式判定齐备，判定「净成本不增」（替代同频 watch）有依据。
- **约束登记面**：`docs/constraints.json` 现有 C-state-01~10，`C-state-11` 序号可用，登记格式与重生成流程描述正确。
- **pre-commit 挂接先例**：`.githooks/` 经 `package.json` `"prepare": "bash .githooks/install-hooks.sh"` 安装，新增 `.mjs` 守卫参照 check_pnpm_store_layout.sh 先例可行（挂接方式与设计描述一致）。
- **mobile-renderer 不复用**：`packages/mobile-renderer/src/App.vue:15` 用的是 `MessageStreamStub`（TODO P3 待 ui 包导出），Out-of-scope 声明属实。
- **测试 DOM 层级**：`PendingBubble.test.ts:253` 断言 `[data-testid="pending-bubble-list"] > *`——pending-bubble-list 容器整体进 tailEl，内部结构不变，断言不受影响；ActivityStrip 的 testid 与 dev 断言（useConstantHeightAssert 随组件内）不依赖父层级。
