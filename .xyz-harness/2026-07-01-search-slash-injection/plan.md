---
slug: 2026-07-01-search-slash-injection
title: 搜索浮层 slash 命令注入修复
type: lite
scope_ensemble_overlap: "high（范围守门：主 agent 判定命中 4 条判据但属接线修复非架构变更，用户已确认架构方向，未派 ensemble）"
reuse_ensemble_overlap: "n/a（改动点明确指向已有 useSearchJump.injectSlash 断链 + 项目惯用 store 驱动模式，无需多路搜索复用候选）"
test_ensemble_overlap: "n/a（未启用 4b，单路反向自检）"
reconstruct_blind_spot: "high（5b 禁读重建发现 8 MISSING + 2 PHANTOM + 5 MISMATCH，主 agent 同源盲区大：单实例心智模型致 split 竞争/卸载泄漏全漏、正向断言偏好致负向断言弱、测试数据强相关致 icon 路径不可区分；已合并补入 U7/U8/U9/U12/U13/U16/U18 + 实现步骤接口改写约束）"
---

# 搜索浮层 slash 命令注入修复 实现计划

## 业务目标

修复 SearchModal 点击 slash 命令（如 `/goal`）后报错「slash 命令注入未接线」、chip 未注入 composer 的 bug。成功标准：搜索结果中点击任意 slash 命令，chip 正确注入到当前活跃 panel 的 ComposerInput，图标与 CommandPopover 选中的 chip 一致，浮层正常关闭。

约束：注入目标仅活跃 panel（单 panel 唯一 Composer；split 模式注入 activePanelId 指向侧；landing 态注入 landing composer）；落地形态用 store 驱动（commandStore 新增 pendingSlash 状态，Composer 订阅消费），符合项目「store 驱动 + 响应式跟随」惯用模式。不做：不处理 split 两侧显示同一 session 的双注入边界；不引入 mitt/前端事件总线（与项目惯例不符）。

## 技术改动点

- 修改 `src-electron/renderer/src/stores/command.ts` — 新增 `pendingSlash` ref + `requestSlashInjection(payload)` 写入方法 + `clearPendingSlash()` 消费清除方法 + `PendingSlash` 类型导出。store 作为一次性消息通道（写→消费→清），与现有 retryState/queueState 瞬时状态同构。
- 修改 `src-electron/renderer/src/lib/search-types.ts` — `SearchItem` 加可选 `icon?: string` 字段。DTO 扩展（非破坏性），让 slash 命令的 icon key（star/terminal/wrench）从 SessionCommand 透传到注入侧，保证 chip 图标与 CommandPopover 一致。**纯类型定义文件，无可独立单测的行为——由 U5/U6（useSearch.ts DTO 映射测试）覆盖 SearchItem.icon 的读写契约**。
- 修改 `src-electron/renderer/src/composables/features/useSearch.ts` — `toCommandItem` 映射 SessionCommand 时带 `icon: c.icon` 进 SearchItem（AppCommand 无 icon，保持 undefined）。
- 修改 `src-electron/renderer/src/composables/features/useSearchJump.ts` — `confirmCommand` slash 分支：删 `options.injectSlash` 回调依赖，改写 `commandStore.requestSlashInjection({command, icon, sessionId})`；landing 态（activeSessionId=null）放行注入（不再返「无活动会话」错误）；icon 从 `item.icon` 透传。
- 修改 `src-electron/renderer/src/components/panel/Composer.vue` — 新增 `watch(commandStore.pendingSlash)`：sessionId 匹配（含双方 null 的 landing 态）时调 `inputRef.value?.insertSlashChip(command, icon)` + 调 `clearPendingSlash()`。watch 非 immediate（防 Composer 后挂载时读到旧 pendingSlash 残留值误注入）。
- 修改 `src-electron/renderer/src/components/overlays/SearchModal.vue` — `useSearchJump()` 调用去掉对 injectSlash 的依赖（现状已未传，清理注释/接口期望）。
- 修改 `src-electron/renderer/src/api/mock/search-data.ts` — `SEARCH_MOCK.command` 追加 slash 命令 fixture（如 `{type:'command', title:'/commit', sub:'提交改动', icon:'terminal'}`、`/review` icon:star）。E2E 前置：mock 模式搜索需能搜到 slash 命令，否则无法 E2E 验证「搜到→点击→注入」链路（现有 mock command 只有 3 个应用命令无 slash）。**mock fixture 数据文件，无可独立单测的行为——由 E2E SM-E2E-7~10 覆盖 fixture 的消费契约**。

> 复用检查结论：项目无前端事件总线（events.ts 是 WS 分发器，无 emit；无 mitt；provide/inject 仅 AppShell('openSettings') 一处回调先例）。跨组件协调惯用模式 = Pinia store + composable 模块单例 ref（useSidebar 写 store / useNewTaskFlow 模块单例 ref / panel store 驱动 Composer 渲染）。store 驱动是该惯用模式的自然延伸，无可复用的现成注入通道。

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1 | command.ts, search-types.ts, useSearch.ts | - | - | Prefactor：store 状态字段 + DTO 扩展（被 W2/W3 依赖，必须先落地） |
| W2 | useSearchJump.ts, SearchModal.vue | W1 | G1 | 写入侧：confirmCommand 改写 store + 清理 SearchModal 注释 |
| W3 | Composer.vue | W1 | G1 | 消费侧：watch pendingSlash 注入 chip。与 W2 改动文件无交集、无调用依赖（W2 写 store / W3 读 store），可同组并行 |
| W4 | search-data.ts, e2e/search-modal.spec.ts | W2, W3 | - | mock fixture 追加 slash 命令 + 新增 Playwright E2E（SM-E2E-7~10 验证完整注入链路） |
| W5 | 验收 Wave | W4 | - | 跑全量单测 + Playwright E2E + 覆盖率，对照测试清单全绿 + 手工 dev 冒烟 |

> W2/W3 同并行组判定：W2 改 useSearchJump.ts + SearchModal.vue；W3 改 Composer.vue。文件无交集。W2 写 commandStore.pendingSlash，W3 读 commandStore.pendingSlash——W3 依赖的是 W1 落地的 store 字段（不是 W2 的写入逻辑），故 W2/W3 可并行（都 blocked_by W1）。

## 单测用例清单（AC 级）

> 测试框架：vitest（从 vitest 导入 describe/it/expect/vi），运行 `cd src-electron/renderer && npx vitest run <file>`。环境 happy-dom + pinia。fixture 已读进上下文（mock SEARCH_SUGGESTED_COMMAND_COUNT=3、command store applyCommands/registerApp 模式、现有 T2.3 用 `/commit` + injectSlash 断言）。

### W1 — command store（command-store.test.ts）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | command.ts:requestSlashInjection | `requestSlashInjection({command:'/goal', icon:'star', sessionId:'s1'})` | `pendingSlash` ref 值为 `{command:'/goal', icon:'star', sessionId:'s1', ts:<number>}`，ts 为调 `Date.now` 时刻 | 正常 |
| U2 | command.ts:clearPendingSlash | 先 requestSlashInjection 再 clearPendingSlash() | `pendingSlash` ref 为 null | 正常 |
| U3 | command.ts:requestSlashInjection 覆盖 | 连续两次 requestSlashInjection（不同 command） | `pendingSlash` 为第二次值（覆盖非累加，与 registerApp 幂等覆盖语义一致）；两次 ts 均 `typeof === 'number'` | 边界 |
| U4 | command.ts:pendingSlash 初值 | 新建 pinia + useCommandStore() 未调任何方法 | `pendingSlash` 初值为 null | 边界 |

### W1 — DTO 映射（useSearch.test.ts，已有文件追加）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U5 | useSearch.ts:toCommandItem(SessionCommand) | SessionCommand `{id:'/goal', name:'/goal', kind:'skill', icon:'star', description:'目标驱动'}` | SearchItem `{type:'command', title:'/goal', sub:'目标驱动', icon:'star'}` | 正常 |
| U6 | useSearch.ts:toCommandItem(AppCommand) | AppCommand `{id:'new', name:'新建', action:fn}` | SearchItem `{type:'command', title:'新建', sub:'new'}`（无 icon 字段 / icon undefined） | 正常 |

### W2 — useSearchJump（useSearchJump.test.ts，改写现有 T2.3 + 新增）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U7 | useSearchJump.ts:confirmCommand slash 分支（改写 T2.3） | `confirm({type:'command', title:'/commit', sub:'', icon:'wrench'}, {activeSessionId:'s1'})`（icon 故意用与 /commit 常规图标 terminal **不同**的 wrench，锁定数据来自 item.icon 而非按 name 重查） | `{ok:true}`；`commandStore.pendingSlash.icon === 'wrench'`（非 terminal，证明从 item.icon 透传）；recentsWrite 被调 | 正常 |
| U8 | useSearchJump.ts:landing 态放行（新增，修现有 bug） | `confirm({type:'command', title:'/goal', icon:'star'}, {activeSessionId:null})` | `{ok:true}`；`pendingSlash.sessionId === null`（不再返「无活动会话」错误）；**recentsWrite 被调**（放行走 ok 路径，与原返错不写 recents 的行为变化需锁定） | 正常 |
| U9 | useSearchJump.ts:icon undefined 透传（新增，改写原 icon 透传用例为缺省态） | `confirm({type:'command', title:'/goal' /* 无 icon */}, {activeSessionId:'s1'})` | `{ok:true}`；`pendingSlash.icon === undefined`（透传 undefined，不兜底默认值，不报错） | 异常 |
| U10 | useSearchJump.ts:injectSlash 回调不再依赖（新增） | `useSearchJump()` 不传 options + slash confirm | `{ok:true}`（不再因 injectSlash undefined 返错）；不依赖回调被调 | 边界 |
| U11 | useSearchJump.ts:应用命令分支不受影响（回归） | `confirm({type:'command', title:'新建', sub:''}, {activeSessionId:'s1'})`，store 已 registerApp | `{ok:true}`；action 被调；`pendingSlash` 未被写入（仍 null） | 回归 |

> **改写约束（MM5）**：现有 T2.3 的 `useSearchJump` 调用（传入 injectSlash 选项）随接口签名变更（injectSlash 字段废弃/删除）需同步改写为不传选项的 `useSearchJump()`，否则 TS 编译报错。此为 W2 实现步骤的强制项，非新增用例。injectSlash 字段保留在 interface 但标 deprecated（向后兼容，避免破坏其他潜在调用），或彻底删除（需确认无其他调用方——已 grep 确认仅 SearchModal.vue:173 一处，可安全删除）。

### W3 — Composer.vue（新增 Composer 集成测，新建 `__tests__/panel/composer-slash-injection.test.ts`）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U12 | Composer.vue:watch pendingSlash 匹配（含注入顺序） | mount Composer(sessionId='s1') + mock inputRef.insertSlashChip；set `commandStore.requestSlashInjection({command:'/goal', icon:'star', sessionId:'s1', ts:1})` | insertSlashChip 被调且参数 `('/goal','star')`；clearPendingSlash 被调；**且 insertSlashChip 在 clearPendingSlash 之前调用**（`toHaveBeenCalledAfter`，防先清后注入的 bug——清后 pendingSlash 已 null，注入读到空） | 正常 |
| U13 | Composer.vue:watch pendingSlash 不匹配（显式断言不误清） | mount Composer(sessionId='s1')；set `requestSlashInjection({command:'/x', sessionId:'s2', ts:1})` | insertSlashChip **不**被调；**clearPendingSlash mock 调用次数 === 0**（显式断言，防错误实现「无论匹配都 clear」误清留给 s2 的 pendingSlash） | 异常 |
| U14 | Composer.vue:landing 态匹配 | mount Composer(sessionId=null, variant='landing')；set `requestSlashInjection({command:'/goal', sessionId:null, ts:1})` | insertSlashChip 被调（双方 null 命中） | 正常 |
| U15 | Composer.vue:watch 非 immediate（残留值不误注入） | mount Composer(sessionId='s1') 后 pendingSlash 初值已为非 null 残留（手动预设 store） | insertSlashChip **不**被调（非 immediate，初始值不触发） | 边界 |
| U16 | Composer.vue:重复点击同命令触发（ts 变化） | 连续两次 `requestSlashInjection({command:'/goal', sessionId:'s1', icon:'star'})`（不同时刻 ts 不同） | insertSlashChip 被调 2 次（第二次 watch 触发：第一次已清→null，第二次写入非 null→引用变化触发） | 边界 |
| U18 | Composer.vue:split 双 Composer 竞争消费（高风险盲区） | 同时 mount 两个 Composer（sessionId='s1' + sessionId='s2'），各自 mock inputRef；set `requestSlashInjection({command:'/goal', sessionId:'s1', ts:1})` | **全局 insertSlashChip 调用总次数 === 1**（仅 sid=s1 的 Composer）；sid=s2 的 Composer 的 insertSlashChip 不被调；pendingSlash 最终为 null（被消费方清一次） | 边界 |

### search-modal 集成测（search-modal.test.ts，新增）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U17 | SearchModal.vue:点击 slash 项 → 关浮层 | mock query 返含 slash 项分组；mock confirm 返 `{ok:true}`；点击 search-item-0 | emit update:open false（浮层关闭） | 正常 |

## E2E 用例清单

> E2E 栈探测（已实测）：项目根**已有完整 Playwright E2E harness**——`playwright.config.ts` + `@playwright/test` 依赖 + `e2e/fixtures/launch-app.ts`（`_electron.launch` + VITE_MOCK/XYZ_MOCK 注入）+ `e2e/search-modal.spec.ts`（6 用例 SM-E2E-1~6）+ `e2e/composer.spec.ts`（6 用例）+ `e2e/file-tree.spec.ts`。运行 `npx playwright test e2e/search-modal.spec.ts`，改 renderer 代码后 `npm run build:e2e` 重建产物。docs/testing/06 §7 写的「未落地」是过时信息（harness 已在后续提交落地）。
>
> **mock 数据缺口（E2E 设计约束）**：`api/mock/search-data.ts` 的 `SEARCH_MOCK.command` 只有 3 个应用命令（新建任务/收起侧栏/概览），**无 slash 命令**。而本次 bug 核心正是「搜到 slash 命令 → 点击 → 注入 chip」。E2E 前需往 `SEARCH_MOCK.command` 追加 slash 命令 fixture（如 `/commit`、`/review`），否则 mock 轨搜不到 slash 命令，E2E 无从验证注入链路。slash 命令的 icon 也要进 fixture（验证 chip 图标一致性，对应单测 U7 的 icon 透传）。
>
> **现有覆盖缺口**：`e2e/search-modal.spec.ts` 的 SM-E2E-4 只测键盘导航（↑↓ 选中态），**未测 slash 命令 confirm 后的 chip 注入**（SearchModal → commandStore.pendingSlash → Composer）；SM-E2E-6 测了 file confirm，slash confirm 链路完全空白。本次新增 E2E 补此缺口。

| 用例ID | 场景 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|------|------|------|---------|
| E1 | 搜索 slash 命令 → chip 注入活跃 composer（核心 bug 回归） | SEARCH_MOCK.command 追加 `/commit`（icon:terminal）；激活 session（panel composer 可见） | 点「搜索」按钮唤起 → 输入 `commit` → 显命令分组含 `/commit` 项 → Enter/click confirm | 搜索浮层关闭；panel composer 输入区（role=textbox）含 `/commit` chip 文本 | `npx playwright test e2e/search-modal.spec.ts --grep SM-E2E-7` |
| E2 | slash chip 图标正确（星标/终端，对应单测 U7 icon 透传） | SEARCH_MOCK.command 追加 `/review`（icon:star）；激活 session | 唤起搜索 → 输入 `review` → 选中 `/review` | composer 出现 `/review` chip；chip 内含星标 svg 图标（star icon class/元素存在） | `npx playwright test e2e/search-modal.spec.ts --grep SM-E2E-8` |
| E3 | landing 态搜索 slash → 注入 landing composer（对应单测 U8/U14 landing 放行） | SEARCH_MOCK.command 追加 slash 项；未激活 session（landing 态，landing composer 可见） | 唤起搜索 → 输入 slash 命令名 → 选中 | landing composer（role=textbox）出现对应 chip | `npx playwright test e2e/search-modal.spec.ts --grep SM-E2E-9` |
| E4 | 回归：应用命令 confirm 不注入 chip（对应单测 U11） | 现有 SEARCH_MOCK.command 的应用命令 | 唤起搜索 → 输入「新建」→ 选中应用命令 | 应用命令 action 执行（不崩）；composer **不**出现 chip 文本（应用命令走 action 非 chip 注入） | `npx playwright test e2e/search-modal.spec.ts --grep SM-E2E-10` |
| E5 | 手工 dev 冒烟（非 MOCK 轨，堵 MOCK 盲区，TEST-STRATEGY §1.3 铁律） | `npm run dev` 真实 runtime + pi | 激活真实 session → ⌘K → 搜 pi 真实 slash 命令（如 `/goal`）→ 选中 | composer 注入 `/goal` chip；dev console 无模块加载错误 | 手动 |

> E1-E4 是 Playwright 自动化（MOCK 轨），E5 是手工 dev 冒烟（非 MOCK 轨，验证模块加载健康 + pi 真实命令）。三视角：构建者（单测 U1-U18）+ 使用者（E1-E4 黑盒用户旅程）+ 观察者（E2 chip 图标形态）。

## 覆盖率 gate

- 单测 gate 命令：`cd src-electron/renderer && npx vitest run src/__tests__/ --coverage`（vitest 原生 coverage，项目 vitest.config.ts 已配 happy-dom + @ alias）
- E2E gate 命令：`npm run build:e2e && npx playwright test e2e/search-modal.spec.ts`（仓库根执行；改 renderer 代码后必须 build:e2e 重建产物）
- 增量算法：vitest coverage 报告关注本次改动文件（command.ts / useSearchJump.ts / useSearch.ts / Composer.vue / SearchModal.vue / search-types.ts / search-data.ts）的行覆盖与分支覆盖
- 阈值：改动文件增量覆盖率 ≥ 80%（项目 search 模块现有测试密度高，86 测基线，就高不就低）；Playwright E2E SM-E2E-7~10 全绿

## 实现步骤

1. [W1] 写 U1/U2/U3/U4 失败测试（command-store.test.ts）→ 实现 command.ts 的 pendingSlash ref + requestSlashInjection + clearPendingSlash + PendingSlash 类型 → 测试通过 → 写 U5/U6（useSearch.test.ts）→ 实现 search-types.ts 的 SearchItem.icon + useSearch.ts toCommandItem 映射 → 测试通过 → 提交
2. [W2] 改写 U7（替换现有 T2.3 的 injectSlash 断言为 pendingSlash 断言；现有 T2.3 传入 injectSlash 选项的 useSearchJump 调用随接口变更改为不传选项，否则 TS 编译报错——这是接口签名变更的强制回归项）→ 写 U8/U9/U10/U11 失败测试 → 实现 useSearchJump.ts confirmCommand slash 分支改写 store + landing 放行 + icon 从 item.icon 透传 → 测试通过 → 清理 SearchModal.vue 注释 → 写 U17（search-modal.test.ts）→ 提交
3. [W3] 写 U12/U13/U14/U15/U16/U18 失败测试（新建 composer-slash-injection.test.ts 或追加现有 composer 测试；**U18 需同时 mount 两个 Composer 模拟 split 竞争消费**）→ 实现 Composer.vue watch pendingSlash + clearPendingSlash（watch 非 immediate；注入顺序：先 insertSlashChip 后 clearPendingSlash；不匹配分支不 clear）→ 测试通过 → 提交
4. [W4] 改 mock fixture：`search-data.ts` 的 SEARCH_MOCK.command 追加 `/commit`(icon:terminal) + `/review`(icon:star) → 写 Playwright E2E SM-E2E-7~10（e2e/search-modal.spec.ts 追加用例，复用现有 openSearch helper + composer.spec.ts 的 activateSession/contenteditable 模式；E1 激活 session→搜 commit→confirm→断言 composer 含 chip；E2 验 chip 星标图标；E3 landing 态；E4 应用命令不注入 chip 回归）→ `npm run build:e2e && npx playwright test e2e/search-modal.spec.ts` 通过 → 提交
5. [W5] 验收 Wave：跑全量单测（`cd src-electron/renderer && npx vitest run src/__tests__/`）+ Playwright 全量（`npx playwright test`）+ 覆盖率 gate + 手工 dev 冒烟（E5 非 MOCK 轨），全绿才算完成

## Constraints（约束记录）

- 测试框架：vitest，禁止 node:test / tsx --test（项目规范 [HISTORICAL]）
- 测试运行目录：`cd src-electron/renderer && npx vitest run`（@ alias 只在该子包 vitest.config.ts 定义，cwd 敏感）
- Emit 单 payload 对象 / Event bus listener refCount / 错误重置状态（AGENTS.md 关键规则 1/2/3）
- Session 隔离：pendingSlash 是全局单例 ref（非 per-session Map），但消费侧靠 sessionId 过滤保证只注入目标 Composer，不广播（规则 7 精神）
- Composer.vue 行数上限：现 `<script setup>` 约 270 行，加 watch 约 280 行，未超 300 行红线
- 不引入 mitt/前端事件总线（与项目惯例不符，store 驱动是惯用模式）
