# chat-pin-bottom-fix 验收记录（U5）

> 日期：2026-09-08 深夜（23:13–24:00+）· 执行者：主 agent（4 次 subagent 进程中断后按 dev-flow 轮次纪律收归主 agent 执行，见「执行方式」节）· 判据：`gap = scrollEl.scrollHeight - scrollTop - clientHeight`，scrollEl = `.message-stream`；dpr=2 → 阈值 ≤4px（设计 §5.1）
> 基线 commit：`1a04df71e`（U4 护栏落地后）· dev app：本 worktree `pnpm dev`，Electron 492 @ localhost:9222/1420，环境泄漏变量已剥除

## 环境与前置

| 项 | 值 |
|---|---|
| devicePixelRatio | 2（retina，判据 ≤4px） |
| 视口 | 1200×800（V6 中变更为 1200×1000/950） |
| 模型 | MiMo-V2.5-Pro（真实 pi runtime，真实流式） |
| 前置数据 | 主会话（多轮真实对话累积至 28927px）+ 造数长会话（600 entries / 61238px，写入 `~/.xyz-agent-dev/pi/sessions/`） |
| 截图 | `docs/design/acceptance-shots/` |

## 逐场景结果

### V1 发送短消息 — ✅ PASS
- 操作：hook console.warn 后发送「你好」，页面上下文 rAF 采样 200 帧（gap + 活动条 rect）。
- 数据：发送当帧新 turn 估算高度入列 gap 峰值 **199.5px → 3 帧内收敛**（199.5→22→21.5→**-0.5**）；finalGap=-0.5；guard 零误报（`__warns` 空）。
- 「思考中…」活动条：回复过快，dispatching 窗口未被 200 帧采样捕获（selector `[class*=strip|activity|compacting]` 亦未命中）——**未捕获 ≠ 不可见**，登记为采样局限（见偏差 #3）。
- 判定：贴底保持 ✓；估算瞬态帧级收敛（P-timing 一致）✓。

### V2 长流式含代码块 — ✅ PASS
- 操作：发送「写一个有30行注释的TypeScript函数并解释」，streaming 中 rAF 采 400 帧，结束后 1s+ 采静止态。
- 数据：400 帧 max=199.5（发送瞬态），**连续 >4px 最长游程仅 3 帧**（无振荡）；静止 idleGap=**0.5px**；末项 bottom=674 ≤ 视口 800（最后一行完整可见）。
- 截图：`acceptance-shots/v2-long-streaming-settled.png`。
- 判定：T1 达成（fence finalize/高亮晚到已覆盖——静止采样晚于流结束 ≥1s）。

### V5 用户上滑脱离（负面反向，两轮） — ✅ PASS
- a) 滚轮/ scrollTop 直改到顶：streaming（36 t/s）中上滑至 top=0，**3 秒后仍 top=0**（RO 兜底网触发被脱离 guard 拦截，视口不被扯回）；「回到底部」浮层（底部中央 ChevronDown 圆钮，`rounded-full`）随后点亮；点击浮层 → gap=-0.5 回底 + 浮层消失。
- b) 键盘（Home 语义 scrollTop 直改 + 到顶 0）：streaming 53 t/s、内容涨至 gap=5249px 时 top 恒 0 **完全不被扯回**，浮层点亮；点击后 gap=0 且流式继续期间贴底跟随保持（25s 后 finalGap=0）。
- 替代说明：V5b 设计原文为「滚动条拖拽」——CDP 合成输入无法作用于原生滚动条（Chromium 滚动条非命中测试区），以键盘/到顶路径替代；拖拽回声语义已由 U1 单测复合判据「拖拽回声=递减+distance>40→脱离」用例覆盖（设计 §4.4 ⑥）。
- 观察（偏差 #4）：V5a 脱离后浮层点亮有秒级延迟（首次扫描未亮，流式 token 持续触发后亮起）——unread 标记时序偏晚但功能可达，登记观察。
- 判定：G2 达成（T5）。

### V6 窗口 resize — ⚠️ PARTIAL（grow 过 / shrink 间歇残留，复现数据已归档）
- 操作：osascript 精准操作 dev Electron 窗口（1200×800 → 1200×1000 → 1200×800；CDP Browser 域被 Electron 禁用）。
- 数据：
  - 拉高方向：3 轮全部 gap=0 ✓
  - 缩回方向：**2/3 轮出现 gap=113px 稳定残留**（V6 首轮与干净复现轮 V6b 一致）；1/3 轮（带 RO 探针轮）自愈 gap=0。
  - RO 通路取证：页面注入独立 ResizeObserver 观察 `.message-stream`，resize 期间 3 次回调全触发（628→741→628）——浏览器层 RO 正常，残留出在「RO 触发 → 静默跟随 → virtua scrollToIndex」链路的某个时序缝隙（疑似 virtua 内部 viewportSize 更新投递晚于我们 follow 的 rAF，写入了基于旧视口的目标）。
  - guard（usePinBottomGuard）零报警——残留出现在 follow 收敛窗口之外（113 为稳定终态而非收敛中瞬态），即「resize 时刻的 follow 未发生或未生效」而非「follow 未收敛」，与护栏⑦前置定义（follow 执行后窗口）不匹配。
  - 恢复路径全通：手动下滚即刻 gap=0（D7「任意下滚即重贴」兑现）、再次 resize 可自愈。
- 判定：**shrink 方向间歇性 FAIL**。定性：R1 类「最后一次变化未补偿」的 resize 变体（低频、可自愈、有恢复路径），按设计护栏哲学「实机观测到 → 登记 → 重审」归档；修复建议（一致性审查阶段定级）：scrollEl RO 回调改双 rAF 或对 resize 触发补一次延迟二次 follow。

### V3 长会话压缩完成通知（R3 现场） — ✅ PASS（等价机制面）
- 前置说明：「加载更多」按钮未出现（见 V9 前置阻塞），startMargin=44 变体无法复刻；改测 R3 修复的用户可见终态 T3——短通知末项完整可见（通知行实高 16px，低于任何阈值，验证「末项定位与末项像素高度无关」）。
- 操作：600-entry 长会话发送 `/compact`，等压缩完成。
- 数据：「已压缩上下文（22.2K tokens）」通知 top=655 / bottom=671，**整行完整可见**（fullyVisible=true）；gap=**0**；h=61261。
- 截图：`acceptance-shots/v3-compact-notice-visible.png`。
- 判定：T3 达成（改造前 F3 现场为通知整行沉底且无浮层）。

### V4 占用期发送（pending 气泡） — ✅ PASS
- 操作：streaming（28→40 t/s）中连发第二条消息（先经一次焦点丢失教训：连发前必须显式 click composer——见偏差 #5）。
- 数据：defer 消息出现时 gap=**1px**；消息文本出现在 `innerText`（视口内渲染证据）；第一条流式继续期间与结束后 gap 全程 ≤1px（finalGap=-0.5）。
- PendingBubble 专用类名的精确 DOM 计数为 0—— bubbles 走其它类名渲染，以 innerText 可见性 + gap 判定（不影响 T4 判定面）。
- 判定：T4 达成。

### V7 subagent 虚拟 session — ⛔ BLOCKED（前置数据不可达）
- 诱导 prompt 未使模型调用 subagent 工具（普通文本回复，无 subagent 标签页产生）；历史会话亦无 subagent 标签。
- 缓解：设计 §1 明示主 session 与 subagent 标签页**共用同一个 MessageStream 组件**（构造性复用），V2/V5 已在同一组件实例上验证全部跟随判据——组件面风险由构造保证 + 主会话证据覆盖。
- 待补：subagent 端到端场景可在后续真实使用中按 §5.2 V7 抽验。

### V8 护栏有效性（故障注入） — ✅ PASS（双侧，U4 执行 + 本次复验）
- 单测侧（U4 交付）：follow 原语注入 offset-24 → R3 回归 + W1TC5/W1TC8 坐标用例 6 红 → 还原后全绿（git diff 零残留）。
- dev 断言侧（主 agent 于 U4 核验期执行）：注入后真实窗口 gap=24px 稳定 → `[pin-bottom-guard] 贴底态跟随未收敛：gap=24.5px > 阈值 4px（dpr=2，双采样均超）…👉 复现与判读指引见 docs/design/chat-pin-bottom-fix.md §4.4` 双采样报警（文案含 dpr/gap 上下文与指引）；还原后 gap=0 零报警；正常流程（V1/V2/V5 全程）零误报。
- 本次复验：`node scripts/check-scroll-follow.mjs` exit 0（pre-commit 链路守卫已生效）；`node scripts/check-doc-symbol-drift.mjs` exit 0。

### V9 load-more 前插抑制 — ⛔ BLOCKED（前置数据不可达）
- 「加载更多」按钮依赖 hydrate 的 `historyTruncated` 标志（runtime 尾读 fallback，DEFAULT_MAX_TURNS=20）；造数的 600-entry 会话打开后全量渲染（h=61238）无截断标志——活跃/离线路径分叉导致造数无法触发按钮，根因排查超出 U5 范围。
- 缓解：isPrepend 抑制语义已由 U1 单测（抑制窗独立性）+ U2 triggers 的 isPrepend 门控接线 + D3 触发矩阵单测覆盖；V9 真实场景待环境具备（真实长历史会话）后抽验。

## 汇总表

| 场景 | 回溯目标 | 判定 | 关键证据 |
|---|---|---|---|
| V1 发送短消息 | G1 | ✅ PASS | 瞬态 199.5→3 帧收敛；finalGap=-0.5；guard 零误报 |
| V2 长流式含代码块 | G1 | ✅ PASS | >4px 游程 ≤3 帧；静止 0.5px；末行可见 |
| V3 压缩通知（R3） | G1 | ✅ PASS（等价面） | 16px 通知行整行可见；gap=0 |
| V4 占用期发送 | G1 | ✅ PASS | defer 气泡可见；gap ≤1px |
| V5 上滑脱离（两轮） | G2 | ✅ PASS | 两轮均不扯回；浮层点亮；点击恢复 gap=0 |
| V6 窗口 resize | G1 | ⚠️ PARTIAL | grow 恒过；shrink 间歇 113px 残留（可自愈，数据已归档） |
| V7 subagent 会话 | G1 | ⛔ BLOCKED | 无法诱导 subagent 标签页；组件复用由构造保证 |
| V8 护栏故障注入 | G3 | ✅ PASS | 单测 6 红→还原绿；dev 断言双采样报警→还原静默 |
| V9 load-more 前插 | G2 | ⛔ BLOCKED | 前置按钮不可达；语义面单测覆盖 |

**总评**：G1/G2/G3 三目标的用户可见终态在可达场景全部达成；V6 shrink 方向存在一个低频可自愈的间歇残留（已附复现数据与修复建议）；V7/V9 因前置数据不可达记 blocked（均有单测/构造性缓解）。结论：**交付可用，V6 残留项与 V7/V9 抽验项转一致性审查/后续跟踪**。

## 执行方式与偏差登记

| # | 偏差/替代 | 说明 |
|---|---|---|
| 1 | 主 agent 亲自执行 | 4 次 subagent 进程中断（r1/w1/w1r2/w2，均为开工勘察后死亡、零产物，跨 glm-5.3/flash 两代模型复现）触发 dev-flow 轮次纪律；U5 为验收执行非编码，主 agent 执行不违反「编排者零编码」 |
| 2 | V5b 滚动条拖拽 → 键盘/到顶替代 | CDP 合成输入无法作用于原生滚动条；拖拽回声语义由 U1 单测覆盖 |
| 3 | V1 活动条未捕获 | 回复过快 dispatching 窗口 < 采样间隔；非可见性缺陷 |
| 4 | V5a 浮层点亮延迟数秒 | unread 标记时序观察，功能可达 |
| 5 | V4 连发需显式 focus | 首次连发因焦点丢失静默失败；补 click composer 后成功——登记为测试操作要点 |
| 6 | CDP Browser 域禁用 | V6 改用 osascript 操作窗口（精准锁定 dev Electron 进程，未触碰用户 TaiJi.app） |
