# 影响面审查报告 r2：chat-pin-bottom-fix.md（v2）

> reviewer：tech-design-impact-review 第 2 轮。聚焦：上轮 2 must-fix 修复成立性、D7 新增影响面、INVAR-M4-2 / useMessageStreamScroll 引用面穷尽性（全仓 grep 复核）、交叉引用一致性。不重查上轮已确认项（wrapper 安全性、4 watch RO 覆盖性、P0-19/20、C-state-11 序号、mobile-renderer、testid 层级）。
> 审查方式：全仓 rg `scrollToIndex` / `useMessageStreamScroll` / `INVAR-M4-2` / `findItemIndex`（-g '!node_modules'）+ 实读 MessageStream.vue:400-420、composables/panel/ 目录清单、.githooks/ 清单。

## Summary

**0 must-fix, 4 suggestions**。上轮两条 must-fix 修复均成立：① 机器护栏扫描范围收窄后自洽——实核 `scrollToIndex(` 非测试调用点仅 useVirtuaFollow.ts:132/167、useMessageStreamRail.ts:174、TraceView.vue:286（范围外）三处，白名单（useVirtuaFollow + useMessageStreamRail）对扫描面完备；`findItemIndex(.*scrollSize` 禁用模式全 src 现有命中恰为待修三处（useVirtuaFollow.ts:131/166、MessageStream.vue:307），U1/U6 修复后可归零。② docs 悬空引用清扫已入改动地图且引用属实（composer-multi-skill-injection.md:265 / 其 impact-review.md:75 均实存）。D7 的四条反例重演与 5 处引用面清扫基本穷尽，新增影响面（rail 跳转脱离语义、session 切换瞬态）均已登记；剩余 4 条 suggestion 均为边角（ADR-0045 引用未列、行号漂移、测试注释命中禁用模式的顺序依赖、V9 断言补强）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION（新） | D7 同步清扫 / §6.2 | C-proc-10 / P0-12 | **INVAR-M4-2 引用面清扫清单漏 `docs/adr/0045-self-built-virtual-turn-list.md:45`**。全仓 grep 实核：该行明文「M4（rAF trailing 节流 + INVAR-M4-2 延迟求值守卫）是此前置依赖的基石」。判定为 suggestion 而非 must-fix 的依据：ADR 是历史决策记录（不可变惯例），且其引用的子机制（followIfStuck rAF 内重读 stickToBottom）在 INVAR-M4-2′ 下原样保留——不是悬空引用，是不变量 ID 语义改版的邻接面。但改版后读者从 ADR-0045 跳转过来的「INVAR-M4-2」理解会与新版脱节 | 清扫清单补一行判定：ADR-0045 不改写（历史记录），在 conversation-stream-block-rendering.md 的 INVAR-M4-2′ 改述处或 D7 文字中注一句「ADR-0045 所引 rAF 延迟求值守卫在 ′ 下保留」，封闭跳转断链 |
| SUGGESTION（新） | D7 同步清扫 | P0-12 | **MessageStream.vue 不变量注释行号漂移**。D7 清扫写 `MessageStream.vue:404-408`，实读该区段（400-418）为 rail 装配与 ChatViewDepsKey 注释；真正含「onScroll 只单向翻真，永不翻 false」断言的行是 **:418**（provide ChatViewDepsKey 前注释块），另 :390 也点名 INVAR-M4-2（rAF 重读语义，′ 下仍成立，可不改述）。实施者按行号定位会改错位置 | D7 清扫行改为「按 rg INVAR-M4-2 定位」（命中 useVirtuaFollow.ts:7/107/112/120、MessageStream.vue:390/418、ui/index.ts:12、conversation-stream-block-rendering.md:318、use-virtua-follow.test.ts:7/113），并注明 :390 与测试 :7/:113 属 rAF 重读语义、′ 下保留可不动 |
| SUGGESTION（新） | §4.4 ⑤ 禁用模式 / U3↔U4 顺序 | P0-12 | **`findItemIndex(.*scrollSize` 全 src 扫描（含测试）会命中 `use-virtua-follow.test.ts:13` 头注释**（「通过 v.findItemIndex(v.scrollSize) 派生」）。该文件在 U3 改写时注释会随新语义更新，M1 先于 M2（守卫落地）使现状安全——但这是**隐式顺序依赖**：守卫 spec 未声明「测试文件也在禁用模式扫描面」且未声明对 U3 改写完成的依赖；若实施顺序倒挂（U4 先行或 U3 改写漏掉头注释），守卫落地即红且报错形态（命中测试注释）容易误导排查方向 | §4.4 ⑤ 补一句：「禁用模式扫描含测试文件注释文本；use-virtua-follow.test.ts 头注释由 U3 同批改写，守卫（U4）在 M1 之后落地时天然归零」。或在守卫脚本内对命中位置做行内 `// guard-allow` 显式标记（不推荐，增加白名单面） |
| SUGGESTION（新） | §5.2 V9 / D7 | P0-12 | **D7 对 fixScrollJump 等量补偿的断言（「scrollSize 与 scrollTop 等量改变，distance 不变、也不触发」）无对应验收断言**。这是 D7「程序性写入碰不到 >40 分支」结构论证的支柱之一，目前只经 virtua 实装推理、未进探针/验收门。V9 场景（上滑脱离后 load-more）用户已脱离、验不到「贴底态 + 前插」分支；虽然实际交互中 load-more 按钮只在滚离底部后可见（贴底 + 前插难以共发），窗口 resize + 前插待收敛帧的组合仍存在理论瞬态——若瞬态 scroll 事件 distance > 40，stuck 被误翻 false 且无任何兜底再翻回 | V9 通过标准补一条可选项：贴底态（或强制 followToBottom(true) 后）触发 load-more，断言全程 stickToBottom 不变 false（Playwright 读 store 或观察后续流式仍跟随）；或在 §6.3 待验证点登记「前插瞬态 scroll 事件 distance 实测」，实施期一次性核掉 |

## 上轮 must-fix 修复成立性（复核依据）

- **MF1（扫描范围/白名单）→ 成立**。复核 `scrollToIndex` 全部非测试命中：useVirtuaFollow.ts:132/167（白名单内）、useMessageStreamRail.ts:174（白名单内，align:'start' rail 跳转合法用途）、TraceView.vue:286（components/panel/trace/，扫描面外 ✓）、useMessageStreamScroll.ts（待删）；composables/panel/ 其余约 28 文件与 components/panel/message-stream/ 无命中；MessageStream.vue 仅注释无调用形 `scrollToIndex(`。测试 9 文件全部位于排除面（`__tests__` / `.test.ts` / `_virtua-mock-helper.ts`——注意 helper 文件名不带 `.test.`，若守卫排除规则只写「排除 __tests__/.test.ts」，`_virtua-mock-helper.ts` 是否被排除取决于其所在目录 `__tests__/effects/`，路径含 `__tests__` 故被路径排除覆盖 ✓，建议脚本实现按路径段排除）。§4.4 代价段已补守卫四要素（S5 同修 ✓）。
- **MF2（docs 悬空引用）→ 成立**。实核 composer-multi-skill-injection.md:265（「滚动量计算（useMessageStreamScroll.ts:61）——无影响」）与其 impact-review.md:75 同引，均存在；§6.2 清扫行 + U4 + D5 三处交叉一致，check-doc-symbol-drift.mjs 已列入 U4 验收。全仓其余 `useMessageStreamScroll` 引用仅在待删/待改文件自身与本设计文档内，无第三处遗漏。
- 上轮 S1-S5 逐条核对：S1（D3 效果段语义差异声明 + 毫秒级窗口依据 ✓）、S2（§6.2 适配行点名三测试文件 + U3 同步 ✓，「等」字覆盖 grep 所见其余挂载级测试 SubagentDirectiveStream/tool-status-flip/skill-notice-stream/subagent-tab）、S3（§4.4 结构护栏 ③ + D3 采用段 wrapper 静态约束 ✓）、S4（D6 消费链补 useMessageStreamNotices.ts:109 → useNoticeStack，死路径自证注释已引 ✓——实核行号为 :110 相邻，误差一行不构成问题）、S5（守卫代价四要素 ✓）。

## D7 新增影响面核查

- **rail 跳转语义变化（反例 ④）**：判定成立。跳转中部后脱离 = 修复既有隐性扯回（现状 stuck 恒 true、下一 token 扯回），新行为下浮层点亮由判据 ③ 供给，语义自洽；rail 的 `updateActiveTurnIndex`（findItemIndex(scrollOffset) 反查）不受 D7 影响（只读不写 scroll）。
- **session 切换瞬态（反例 ③）**：已登记为已知行为，`nextTick followToBottom(true)` 一 tick 收敛，无用户可见后果，接受。
- **「回到底部」按钮点击路径**：followToBottom(true) 程序性落点 distance ≤ 0（D2 推导），双向化后不会自我脱离——结构论证闭合。
- **useStreamingPin keepMounted 远端增高**：fixScrollJump 顶锚补偿签名由 D3 判据 ③ 第二分支识别为「上方 reflow」→ 静默，不误标 unread——与 P-unread 探针门（⛔ M2）覆盖一致。
- **conversation-stream-block-rendering.md:318 旧断言**（「已实测无回归：对话完成无 onScroll」）：D7 改述后该文档实测记录需同步——已入清扫清单 ✓；其「手动折叠不触发 onScroll」若在 ′ 下实测有事件，反例 ① 的 distance ≤ 0 推导兜住，不脱离 ✓。

## 交叉引用一致性

§4.4 护栏表 ⑤ ↔ D7 清扫 ↔ §6.2 改动地图 ↔ U4 内容四向核对一致（useVirtuaFollow.ts 头部 / MessageStream.vue 注释 / ui/index.ts / conversation-stream-block-rendering.md / use-virtua-follow.test.ts 五处：前三后各有「改写/清扫」行覆盖）；护栏 ④ C-state-11 措辞含「禁止 findItemIndex(scrollSize) 模式」与守卫禁用模式一致；代价段四要素齐。

## 结论

v2 修订对上轮 2 must-fix + 5 suggestion 全部有效修复，无新增 must-fix。4 条 suggestion 建议随主审 r2 意见一并合入 v3 后进入实施；其中 ADR-0045 断链与 V9 断言补强两条建议在实施前处理（均为文字级），其余两条可随 U3/U4 实施自然消解。
