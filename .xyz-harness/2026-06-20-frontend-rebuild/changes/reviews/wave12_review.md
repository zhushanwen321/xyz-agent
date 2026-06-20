---
verdict: fail
must_fix: 1
wave: "1+2"
---

# Wave 1+2 独立审查报告

> 审查对象：4 个 commit（`3c21f7b4` FG0 / `defb7541` FG1 骨架 / `7ace6bdd` FG1 实现 / `497de353` FG2）。
> 文件状态一律取 `497de353`（Wave 2 结束）时的精确状态，经 `git show <hash>:<path>` 核对，不含 Wave 3-5 后续改动。
> 对照基准：spec §3/§4/§5/§8.5、plan/plan-frontend §2、design-tokens.md、CLAUDE.md、shared/*.ts。
> 不审范围：sidebar/panel/overview/settings/workspace/composables/features 目录（Wave 3-5）。

## 总结论

整体工程质量高：分层铁律严格遵守，类型全部引用真实 shared 协议（无臆造），design-tokens 与 SSOT 逐值一致，单测有效覆盖 UC-2 数据流，骨架→实现两步交付符合 plan §1.5 C 方案。

**阻断 1 项**：FG0 装 shadcn Button 时漏声明依赖 `class-variance-authority`，干净环境 `vue-tsc` 失败，违反 spec §6.5 验收。该问题在 Wave 2 交付状态（497de353）真实存在，后续 commit `dab8a4fa` 已修复，但 Wave 2 自身交付不满足验收标准。

---

## A. 架构铁律（spec §3）

### A1. stores 之间互相 import —— **PASS**
`git show 497de353:stores/*.ts | grep "from.*stores/"` 全空。navigation/session/chat/panel/sidebar 五个 store 均只 import `vue`/`pinia`/`@xyz-agent/shared`/`@/types`，零跨 store 引用。文件头注释均显式声明"依赖方向：无（stores 间禁止互相 import）"。

### A2. api/ + lib/ 无业务语义 —— **PASS**
- `api/index.ts` 仅做 `VITE_MOCK` 三元切换门面，无 `useX`/`defineStore`/`features/` 引用。
- `api/transport.ts`/`pending.ts`/`events.ts`/`domains/*` 均为纯管道/注册表/签名转发，无业务编排。
- `lib/utils.ts` 仅 shadcn 标准 `cn()`（clsx + tailwind-merge），9 行，无业务。
- mock 模拟业务（send 流式、switchSession 抛错）是 D2/D7 允许的合理行为，不算"api/ 含业务语义"。

### A3. features 越界检查 —— **PASS**
`497de353` 时 `composables/` 仅 `useConnection.ts`（连接态 UI，spec §1 明确"保留"），无 `composables/features/` 目录。断链 symlink（`useChat.test.ts`/`useSlashCommands.test.ts`）在 `3c21f7b4` 已删除（见 G1）。Wave 1+2 未越界建 features。

---

## B. spec 决策合规

### B1. D1 导航历史栈 —— **PASS**
`stores/navigation.ts` 逐项核对 spec D1：
- `MAX_ENTRIES = 50`（导出常量，L11）✓
- `entries[] + pointer` ✓
- 分支截断：`push` 中 `if (pointer < length-1) entries.splice(pointer+1)`（L31-33）✓
- 超限丢最早：`if (length > 50) entries.shift()`（L35-37）✓
- `back`/`forward` 边界 no-op：`if (pointer > 0)` / `if (pointer < length-1)`（L43/L47）✓
- 扩展 `'overview'` view：`NavEntry.view` 含 `'chat'|'overview'|'settings'`（types.ts）✓

### B2. D2 mock 独立于 transport/ws-client —— **PASS**
`api/mock/index.ts` 仅 import `./data`，零 `transport`/`ws-client`/`pending`/`events` 引用。`api/index.ts` 按 `import.meta.env.VITE_MOCK === 'true'` 三元切换 mock ↔ real，两套签名一致。切换点单一、干净。

### B3. D6 SessionStatus 派生 —— **注意**
`stores/session.ts` `derivedStatus(id)` 返回 `computed(() => 'waiting')`（固定值），`void id` 显式忽略参数。这是 FG1 骨架占位，注释说明"实现阶段从 message/tool 状态派生"。
- 合规性：spec D6 明确"实现位置：`stores/session.ts` 的 computed **或** `composables/features/useSessionStatus.ts`"，且派生依赖 message（在 chat store）——session store 不能 import chat store（铁律 2），故真实派生逻辑必然落在 features 层（Wave 3+）。FG1 提供"签名占位入口"合理。
- 偏差点：plan T1.4 标题写"含 D6 派生"，易误读为 store 内实现派生。实际 store 仅占位。**SHOULD_FIX**（plan 描述应澄清派生落点在 features，或 T1.4 拆出独立 task）。

### B4. D7 mock 工程默认 —— **PASS**
逐项核对 spec §D7 表 + plan-frontend：
- 镜像 shared 类型全字段：`mock/data.ts` fixtureSessions 含 `gitBranch`/`gitIsWorktree`/`thinkingLevel`/`tokenCount` 等全部可选字段（s1 全填证明）✓
- 不模拟失败：`chat.send` 永走 CANNED_REPLY 成功路径 ✓
- switchSession 抛错（契约要求）：`if (!fixtureSessions.some(s => s.id === id)) throw` ✓
- 内存持久化：`fixtureSessions.push` 内存，注释"reload 重置，不写文件"✓
- 流式事件名按 protocol.ts：`message.message_start`/`message.text_delta`/`message.complete` 三个 type 在 `protocol.ts` `ServerMessageType` 均存在 ✓
- mock id 不往返：直接 resolve Promise，不模拟 UUID ✓
- mockConnect 200ms 直进 connected：`TIMING.ack=40`/`startGap=60`/`chunk=70`，transport.connect `waitForConnected` 走 ws-client 状态机 ✓

---

## C. plan Interface Contracts 一致性

### C1. 方法签名逐一对照 —— **注意**（2 处偏差，均非阻断）

**完全一致项**（transport.connect/send/on、session.list/create/switchSession、chat.send/abort/streamSubscribe、navigation 全部、session.list/activeId/active、panel、sidebar）。

**偏差 1 — chat store `messages` 类型**：
- plan-frontend §2：`messages | Ref<Message[]> | array`
- 实际：`messages: Ref<Map<string, Message[]>>`（`stores/chat.ts` L20）
- 判定：plan 同行 Edge case 写"按 sessionId 分区（store 内 Map）"，实际 Map 实现更符合 UC-2 隔离 + CLAUDE.md #7 三层隔离。**plan 签名描述不准确，实现更正确**。NIT（建议更新 plan 签名为 `Ref<Map<string, Message[]>>` 并补 `getMessages(sessionId)` 到契约表）。

**偏差 2 — 缺 `getHistory`**：
- plan-frontend §2 session 域仅 list/create/switchSession，无 getHistory。实际代码也未提供。
- 影响：`mock/data.ts` 的 `fixtureMessages`（s1 含完整 toolCall/contentBlocks 回合）运行时不被消费——用户切到 s1 看不到历史，只有 `chat.send` 后才有消息。
- 判定：符合 Wave 1+2 契约（plan 未列 getHistory），历史加载 defer 到 T5.4（mock fixture 深化）。但 `fixtureMessages` 当前是"结构验证死数据"，UC-2 "消息流显示 user/assistant 块"在切换已有 session 场景下不成立。**注意**（非违约，但建议 plan 标注 fixtureMessages 消费时机）。

**无偏差项确认**：
- `switch` → `switchSession`：plan §2 已注明"switch 是 TS 保留字"，实际 domains/session.ts + mock 均用 `switchSession` ✓（非臆造偏差）
- mock 无多余方法（未臆造 getHistory/rename 等）✓

### C2. NavEntry 类型 —— **PASS**
plan-frontend §4：`type NavEntry = { view: 'chat'|'overview'|'settings'; sessionId?: string; activeTab?: string }`
`types.ts` 逐字段一致 ✓。

### C3. DerivedStatus / PanelTreeNode —— **PASS**
- `DerivedStatus = 'running'|'waiting'|'done'|'stopped'|'error'`（types.ts）与 spec D6 5 态完全一致 ✓
- `PanelTreeNode = PanelTree`（复用 shared `PanelLeaf | SplitNode`，非臆造 union）✓

---

## D. design-tokens SSOT 一致性

### D1. token 值逐项对照 —— **PASS**
`style.css` 与 `design-tokens.md` 暗色表逐值核对，22 个 token 全部一致：
`--bg #0d0d0f` / `--surface #151519` / `--surface-hover #1b1b20` / `--fg #f0f0f5` / `--muted #8a8a95` / `--subtle #5a5a65` / `--border rgba(255,255,255,0.06)` / `--border-strong rgba(255,255,255,0.12)` / `--accent #4f8ef7` / `--accent-hover #6ba3ff` / `--accent-soft rgba(79,142,247,0.12)` / 四状态色 / 字体 / radius 3-8-12 / space-1..16 / shadow-1-2-glow / ease + 三 duration。

**无臆造 token**：style.css 没有 `--reasoning`/`--section-bg`/`--divider`/`--accent-light` 等自造变量（design-tokens.md「已知裂缝」点名要求归一的那些）。**无缺失**：亮色变体有意未落地（注释"design-tokens 仅给部分亮色值，未给全前不臆造落地"），符合 YAGNI。

### D2. 命名 SSOT —— **PASS**
`--fg`（非 `--text-primary`）/ `--muted`（非 `--text-secondary`）/ `--subtle`（非 `--text-tertiary`）/ `--border`（非 `--divider`）/ `--surface`（非 `--panel`/`--section-bg`）。文件头注释显式引用 ADR-0018 归一裁决。tailwind.config `colors` 映射全部走 `var(--xxx)`，无硬编码 hex。

### D3. radius 3/8/12（D5 裁决）—— **PASS**
- `style.css`：`--radius-sm:3px` / `--radius:8px` / `--radius-lg:12px` ✓
- `tailwind.config.ts`：`borderRadius.sm:'3px' / DEFAULT:'8px' / lg:'12px'`，另加 `md:'8px'`（shadcn 组件用 `rounded-md`，映射同值 8px，不违反 SSOT）✓

---

## E. CLAUDE.md 前端规范

| 项 | 判定 | 证据 |
|----|------|------|
| E1 禁原生 HTML 表单元素 | **PASS** | shell 三组件仅 `div/aside/main/slot`；index.html 是入口骨架（`html/meta/link/script`，非表单元素）|
| E2 禁 Emoji | **PASS** | AppShell/AsideRegion/MainPanel/App.vue 零 emoji；MainPanel 占位文"view: xxx 待 Wave 3+ 填充"纯文字 |
| E3 禁硬编码颜色 | **PASS** | 组件内全用语义类（`bg-bg`/`bg-surface`/`border-border`/`text-subtle`）；scoped style 用 `var(--shadow-1/2)`。style.css 的 hex 是 token 定义（允许）|
| E4 radius 语义类 | **PASS** | MainPanel `rounded-lg`；tailwind 已映射语义类 |
| E5 行数上限 | **PASS** | AppShell `<template>` 5 行 / `<script>` 20 行；AsideRegion 5/3；MainPanel 6/4。远低于 400/300 |
| E6 无 any | **PASS** | payload 用 `Record<string, unknown>`（pending/events）；`readString` 返回 `string\|undefined`；domains/stores 全具体类型。零 `any` |
| E7 emit 单 payload | **PASS** | shell 组件零 emit（AsideRegion 纯展示槽，MainPanel/AppShell 无 emit）|

---

## F. 代码质量

### F1. 错误处理 —— **PASS**
- `pending.resolve`/`reject` id 不存在 no-op（`if (!req) return`）✓ 防 double-resolve
- `mock.switchSession` 不存在 id 抛错（契约要求）✓
- `mock.chat.send` 不模拟失败（D7）✓
- `chat.appendAssistantChunk` 对未知 type `default: return`，对 `findLastAssistantIndex < 0` 提前 return，对重复 complete（`last.status !== 'streaming'`）跳过 ✓
- `transport.connect` `waitForConnected` 无超时——注释明确"由调用方保证"，是 mock 优先阶段的设计选择（real 联调时再补超时），**注意**（联调前需补超时，防 runtime 不可达时 Promise 永挂）

### F2. Vue 响应式 —— **PASS**
`stores/chat.ts` 显式采用"取出 → 新数组 → `Map.set`"不可变更新（文件头注释说明响应式策略）。`appendAssistantChunk` 的 text_delta/complete 分支均 `[...prev]` 浅拷贝后替换目标元素再 set，规避了"就地突变 plain 数组元素不触发响应性"陷阱。

### F3. 资源泄漏 —— **注意**
- `transport.waitForConnected` 的 `watch` 在 connected 后 `stop()` ✓
- `events.on`/`mock.streamSubscribe`/`wsClient.onMessage` 均返回取消函数 ✓
- `AppShell` `useEventListener` 自动卸载清理 ✓
- **`mock/index.ts` `timers` Set 永不清理**：`sleep()` 把每个 `setTimeout` 句柄 `timers.add(t)`，但 fire 后无 `timers.delete(t)`。Set 无限增长（每次 send 推 N 个 chunk = N 个残留句柄）。**SHOULD_FIX**（内存介质 reload 重置可缓解，但工程整洁性欠佳；应在 `sleep` 的 `setTimeout` 回调里 `timers.delete(t)`，或改用 `Promise` 直接 `new Promise(r => setTimeout(r, ms))` 不入 Set）。`cancelled` Set 在 send 开头 `cancelled.delete(sessionId)` 清理 ✓。

### F4. 单测覆盖 —— **PASS**
`__tests__/fg1-dataflow.test.ts` 6 case 有效覆盖 UC-2 数据流核心路径：
1. `session.list` 返回 3 fixture 全字段（断言 `id/label/status/tokenCount/gitBranch`）
2. `session.create` 追加并返回
3. `switchSession` 抛错 / resolve 双向
4. `chat.send` 流式 start→deltas→complete 时序（断言首尾 type + delta 数 > 0）
5. chat store `appendUser` + `appendAssistantChunk` 产出完整 user+assistant 回合（断言 role/status/content）
6. chat store 按 sessionId 隔离（s1/s2 互不干扰）

未覆盖 abort 流转（D7 DEFERRED G-025，合理）、id 往返（D7 不模拟，合理）。覆盖度对 FG1 范围充分。

---

## G. Wave 1+2 交付完整性

### G1. FG0 shadcn 装机 —— **PASS**
`3c21f7b4` 装机产出：`button` / `dialog` / `dropdown-menu` / `input` / `scroll-area` / `tooltip`（6 域）。`components.json` 配置正确（`@/components` + `@/lib/utils` 别名、`cssVariables:true`、`baseColor:zinc`）。断链 symlink（`useChat.test.ts`/`useSlashCommands.test.ts`）已删除（plan T0.1）✓。基础组件够 Wave 3-6 消费。

### G2. FG1 骨架全 throw + tsc 绿 —— **FAIL**（MUST_FIX）

**骨架全 throw** ✓：`defb7541` 时 `git show` 确认 navigation push/back/forward、chat appendUser/appendAssistantChunk/setStreaming、api/domains/session 三方法、transport 三方法、mock 全方法均 `throw new Error('not implemented: ...')`。session `derivedStatus` 例外返回 `computed('waiting')`，注释说明"不 throw 以保响应式"——是有意设计（getter 返回合法默认值让响应式链不断），符合 plan §1.5"state/getter 合法初始值"。

**tsc 绿** ✗ —— **MUST_FIX**：
- `3c21f7b4`（FG0）装 shadcn Button 时，`components/ui/button/index.ts` `import { cva } from 'class-variance-authority'`（L2）
- 但 `497de353` 时 `renderer/package.json` `dependencies` **无 `class-variance-authority`**（经 `git show 497de353:src-electron/renderer/package.json` 核对，仅 `@lucide/vue`/`@vueuse/core`/`clsx`/`pinia`/`reka-ui`/`tailwind-merge`/`vue`/`vue-i18n`）
- 后续 commit `dab8a4fa`（"fix(deps): 补声明 class-variance-authority"）自承认："之前能跑靠 node_modules 残留，**干净重装后 vue-tsc 报 'Cannot find module class-variance-authority'**"
- 验证 `cva` 不是 reka-ui 传递依赖（当前 `node_modules` 顶层无 `class-variance-authority`，`find` 无嵌套命中），必须显式声明
- 违反：spec §6 整体验收"lint + vue-tsc 通过"、plan §1.5 step A"tsc 绿即交付"

**结论**：Wave 2 交付状态（497de353）在干净环境（`npm ci` + `vue-tsc --noEmit`）下 tsc 失败。开发机因 node_modules 残留可过，属"假绿"。后续 `dab8a4fa` 已修复（补 `^0.7.0` + 同步 lock），但 Wave 2 自身不满足验收。判 MUST_FIX（虽已事后修复，但作为 Wave 1+2 独立审查，须记录此交付缺陷）。

### G3. FG2 快捷键 + traffic light 安全区 —— **PASS**
- `AppShell.vue` `useEventListener(window,'keydown')` 绑定 ⌘[/⌘]：`metaKey || ctrlKey` 跨平台、`canBack`/`canForward` 守卫、`preventDefault` ✓；`useEventListener` 自动卸载清理 ✓
- `AsideRegion.vue` scoped style `padding-top: 52px`（CLAUDE.md #11：32 安全区 + 20 呼吸，三平台恒定）✓
- 注释引用 shell/spec.md SSOT，全屏两态切换明确 DEFERRED（spec §8.5 P1 v1 边界）✓

**注意**（非 G3 阻断，记录供后续）：win/linux `mimic_mac` 自绘 traffic light 圆点（CLAUDE.md #11 要求）在 FG2 未实现——AsideRegion 仅留白。spec §8.5 P1 v1 范围只要求"安全区"，mimic_mac 属平台视觉细节，可能 defer，但需确认是否应在 Wave 2 或更晚补。

---

## MUST_FIX 清单（阻断）

| # | 维度 | 问题 | 证据 | 修复状态 |
|---|------|------|------|---------|
| 1 | G2 | shadcn Button 依赖 `class-variance-authority` 未声明，干净环境 `vue-tsc` 失败，违反 spec §6.5 / plan §1.5 | `3c21f7b4:components/ui/button/index.ts:2` import cva；`497de353:renderer/package.json` deps 无 cva；后续 `dab8a4fa` 自承认"干净重装后 Cannot find module" | **后续 `dab8a4fa` 已修复**，但 Wave 2 交付状态（497de353）不满足验收 |

---

## SHOULD_FIX 清单（建议）

| # | 维度 | 问题 | 建议 |
|---|------|------|------|
| S1 | F3 | `mock/index.ts` `timers` Set 永不清理（`sleep` 入 Set 不出） | `setTimeout` 回调内 `timers.delete(t)`，或改 `new Promise(r => setTimeout(r, ms))` 不入 Set |
| S2 | B3 | plan T1.4 标题"含 D6 派生"易误读为 store 内实现，实际 derivedStatus 是占位、真派生在 features | plan 澄清派生落点在 `useSessionStatus`（features 层），或拆独立 task |
| S3 | F1 | `transport.connect` `waitForConnected` 无超时，runtime 不可达时 Promise 永挂 | 联调阶段补超时（mock 阶段 200ms 不触发，可 defer 但需跟踪）|
| S4 | — | `index.html` Inter 字体走 Google Fonts CDN，打包离线场景降级 system-ui | 注释已标 TODO，但未进 DEFERRED 跟踪；建议纳入 P0/P6 字体本地化 task（P0 验收"冷蓝暗色画布"隐含 Inter 渲染）|

---

## NIT 清单（小问题）

| # | 位置 | 问题 |
|---|------|------|
| N1 | C1 | plan-frontend §2 chat `messages` 签名 `Ref<Message[]>` 与实际 `Ref<Map<string,Message[]>>` 不符（Edge case 支持 Map，实现更优，plan 描述滞后）|
| N2 | mock abort 时序 | `chat.send` 循环中 abort 后可能再 emit 1-2 个 text_delta 才检测到 `cancelled` 退出（D7 abort 流转 DEFERRED G-025，可接受）|
| N3 | mock/index.ts abort | abort emit 的 `message.complete` 缺 `id` 字段（其他 emit 均带 `id: messageId`），结构不一致 |
| N4 | session.derivedStatus | `void id` 忽略参数（ponytail 风格显式标记，意图清楚，可接受）|
| N5 | AsideRegion.vue | `width: 200px` 在 scoped style 硬编码（非 Tailwind 间距类，不违反 #9；但值来源应引用 shell/spec.md SSOT，注释已标注折叠态待 Wave 3）|
| N6 | tailwind.config | `borderRadius.md: '8px'` = DEFAULT，design-tokens 未定义 md（为 shadcn `rounded-md` 兼容补的映射，同值不违反 SSOT）|

---

## 整体评价

**优点**：
- 分层铁律（A1-A3）零违反，stores/api/lib 边界清晰
- 类型工程扎实：shared 协议引用全部真实（无臆造 StreamChunk 等历史问题重演），types.ts 复用而非重定义 PanelTree
- design-tokens 落地精确（D1-D3 逐值一致，无自造变量）
- 骨架→实现两步交付纪律好（G2 骨架真 throw，C 方案生效）
- 单测（F4）非装饰性，断言到字段级和时序级
- shell 组件 scoped style escape hatch 用法规范（box-shadow 双叠、width/padding-top 注释说明来源）

**主要短板**：
- 依赖声明纪律（G2 cva 遗漏）——这是 shadcn 装机流程的固有坑（`npx shadcn-vue add` 不总是自动补依赖），FG0 装机后未做"干净重装 + tsc"验证，导致假绿。后续 `dab8a4fa` 补救。建议装机 task 增加"删 node_modules 重装 + vue-tsc"自检步骤。
- mock timers 资源管理（F3）——短期可接受，但应在 mock 成熟时收敛。

**verdict: fail**（1 项 MUST_FIX）。该 MUST_FIX 已被后续 commit 修复，若以"当前 HEAD 状态"评估则为 pass；本报告按"Wave 2 交付状态（497de353）独立评估"如实记录为 fail。Wave 3-5 可在此基础上继续。
