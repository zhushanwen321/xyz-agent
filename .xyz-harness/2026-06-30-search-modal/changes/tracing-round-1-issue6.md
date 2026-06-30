---
issue: "#6 跳转编排 — 方案 A（单 composable switch 分发)"
verdict: gap-found
converged: false
tracer: 正向追踪 subagent（视角1 副作用覆盖性 + 视角2 缓解可行性）
date: 2026-06-30
---

## 视角1 副作用覆盖性

### 七维度全评核查

| 维度 | 矩阵标 | 核查结论 |
|------|--------|---------|
| 安全 ✅ | 无风险 | ✅ 属实——跳转目标是受控 SearchItem（来自注册表/runtime 查询结果），非自由输入 URL/路径；file.read 走 runtime cwd 守门。无注入面。 |
| 数据 ✅ | 无风险 | ⚠️ **降级见 GAP-1**——recents 写入归 #3 的单 key 原子写属实，但「跳转成功 + recents 写入失败」的部分失败未评。 |
| 性能 ✅ | 无风险 | ✅ 属实——跳转是单次用户操作，无吞吐/延迟面。 |
| 并发 ✅ | 无风险 | ⚠️ **降级见 GAP-3**——⌘N 新建任务跳转是 async action，新 session 创建竞态（首次启动延迟 create 返回 null）未评。 |
| 稳定性 ⚠️ | 已缓解 | ⚠️ **缓解不充分见 GAP-2**——三类跳转失败场景识别了，但 file 跳转的失败冒泡路径被 useDetailPane 吞错层阻断，AC-6.5 的 toast「假性 PASS」风险（与 #4 AH-E1/E2 同构吞错层问题）。 |
| 兼容性 ✅ | 无风险 | ✅ 属实——复用现有 useDetailPane/selectSession 不破坏既有消费者。 |
| 可观测 ⚠️ | 已缓解 | ✅ **合理**——跳转失败 toast 充分（AC-6.5/6.6/6.8）；跳转成功路径无日志是默认期望（成功是常态，无需日志噪音），判断正确。 |

### 关键不变式识别核查

- **AC-6.7「先 await 成功再关浮层」**：✅ **被正确识别为关键不变式**。源码核查确认这是真实不变式——`selectSession`（useSidebar.ts:152-197）在 `await sessionApi.switchSession(id)` 抛错时**不更新 activeId**（注释明确「switchSession 失败抛错，UI 层捕获；不更新 activeId」），即 session.switch 失败时 active session 不变。若「先关浮层后跳」，失败后用户看不到浮层且 active session 未变，陷入「点选无效」死局。AC-6.7 的 await-then-close 顺序是唯一正确解。NFR #6 稳定性章节已显式标注「**关键**：AC-6.7 异常恢复」，识别到位。

- **session.switch 失效（pi 延迟写入，AGENTS.md 规则#6）**：✅ **不是稳定性新风险**。规则#6（AGENTS.md:87-94）说的是 pi `_persist()` 在首次 assistant 回复前**文件可能不存在**——影响的是**文件读取**（buildTreeFromFile/getHistoryFromFile 已降级处理），而 session.switch 跳转是 pi 进程内 session 激活（`switch_session` 命令，session-lifecycle.ts:159），**不依赖文件存在**。真正的 session.switch 失效是「session 进程已销毁/id 不存在」（mock switchSession 的 `exists` 检查），AC-6.6 已覆盖此场景。**故 NFR #6 数据 ✅ 判定不受 pi 延迟写入影响，判断正确**——延迟写入是文件层风险，session.switch 是进程激活层，两层正交。

## 视角2 缓解可行性

### MR-6.1（跳转失败 toast + 浮层保持打开）落地性核查

- **设计可行性**：✅ 可落地——toast（复用现有 toast 基建）+ 浮层保持打开（await 成功再 emit close）是标准前端模式。
- **AC 覆盖核查**：
  - AC-6.5（file.read 失败 toast）：⚠️ **覆盖但执行路径有缺陷，见 GAP-2**——AC 写了「file.read 失败→toast」，但 useDetailPane.openPreview 内部 try/catch **吞错**（设 status='error'，不抛出）。若 useSearchJump 文件跳转调 `useDetailPane.openPreview`，file.read 失败**不抛出**，useSearchJump 的 catch 永不触发→toast 永不显示→AC-6.5 假性 PASS。这是与 #4「file 源须直调 composer.getFileCandidates 不经 useFileSearch.load 吞错层」（AH-E1/E2）**完全同构的吞错层阻断失败冒泡**问题。
  - AC-6.6（session.switch 失败 toast + 刷新会话列表）：✅ 覆盖充分——`selectSession` 的 `await sessionApi.switchSession(id)` 会 reject（id 无效时 runtime/pending reject），错误能正常冒泡到 useSearchJump catch。
  - AC-6.7（异常恢复，await 成功再关浮层）：✅ 覆盖充分——不变式清晰，落地直接。
  - AC-6.8（应用命令 action 抛错 toast）：⚠️ **覆盖不完整，见 GAP-3**——AC 只覆盖「action 抛错」，未覆盖 async action 成功但产生**无目标 session**（如 ⌘N newSession 首次启动延迟 create 返回 null）的语义。

- **MR-6.1 标「已在③」是否属实**：⚠️ **部分属实**——AC-6.5/6.6/6.7/6.8 确实都登记在 issues.md #6（非 PHANTOM 指针），但 AC-6.5 的执行路径存在吞错层缺陷（GAP-2），AC-6.8 的覆盖面不全（GAP-3）。缓解方案在「AC 已登记」层面属实，在「AC 可正确执行」层面有缺陷。

## Gap 清单

### GAP-1 [D-数据/部分失败] 跳转成功 + recents 写入失败的部分失败未评估

**问题**：NFR #6 数据 ✅ 判定理由是「recents 写入归 #3 的数据一致性（单 key 原子写）」。但跳转编排的事务边界是「跳转成功 → 写 recents → 关浮层」三步，**recents 写入与跳转成功非原子**：
- 跳转成功（session 已切换 / DetailPane 已打开 / 命令已执行）+ recents 写入失败（localStorage 配额满）= **跳转生效但 recents 未记录**。
- 用户感知：跳转正常发生，但「最近找过」列表没更新；下次空查询看不到这次跳转。是**静默降级**（跳转已成功，用户不会觉得失败，但 recents 偏好丢失）。
- 严重性：低（recents 是偏好数据非业务数据，MR-3.1 catch 降级保证不崩溃），但 NFR #6 数据 ✅ 判定**未提及此部分失败**，与 MR-3.1 的「配额满 catch 降级」未在 #6 侧联动说明。

**建议**：#6 数据 ✅ 判定补一行——「recents 写入失败（MR-3.1 配额满场景）是静默降级，跳转已成功不受影响，recents 偏好丢失可接受」。或在 useSearchJump 内对 useRecents.write 做 try/catch 包裹（write 失败不影响跳转主路径）。无需新 AC（MR-3.1 已覆盖降级机制），仅需 NFR 文字补全判定的完整性。

---

### GAP-2 [F-事实性/吞错层阻断失败冒泡] file 跳转失败 toast 因 useDetailPane 吞错层无法触发（AC-6.5 假性 PASS 风险）

**问题**：这是与 #4 AH-E1/E2（「file 源须直调 composer.getFileCandidates 不经 useFileSearch.load 吞错层」）**完全同构的缺陷**，但在 #6 侧未被识别。

源码核查（useDetailPane.ts:70-93）：
```
async function openPreview(sid, path): Promise<void> {
  state.value = { ...status: 'loading'... }
  try {
    ... await fileApi.read(path, sid) ...
    state.value.status = 'content'
  } catch (e) {
    state.value.status = 'error'        // ← 吞错：设 error 态，不抛出
    state.value.error = (e as Error)?.message ?? '加载失败'
  }
}
```

`openPreview` **返回 `Promise<void>` 且内部 try/catch 吞错**（失败设 `status='error'`，不 rethrow）。若 useSearchJump 的 file 分支调 `useDetailPane.openPreview(sid, path)`：
```
async function confirm(item) {
  switch(item.type) {
    case 'file':
      await detailPane.openPreview(sid, path)  // ← file.read 失败时不 reject
      break
  }
  // ... useRecents.write + emit close（成功路径）
}
```
则 file.read 失败时 `openPreview` resolve（非 reject），useSearchJump 的 catch 永不触发，**AC-6.5「file.read 失败→toast」假性 PASS**——用户看不到 toast（除非额外 watch detailPane.state.status==='error'，但这是隐式耦合）。

**与 #4 的同构性**：#4 AC-4.5/AC-8.2 已明确「file 源须直调 composer.getFileCandidates 不经 useFileSearch.load 吞错层，否则 error 永不到 domain catch 致假性 PASS」。#6 file 跳转面临**同样的吞错层陷阱**，但 AC-6.5 只写了「file.read 失败→toast」，未约束「不经 useDetailPane.openPreview 吞错层」。

**建议**：补 AC 约束——useSearchJump 的 file 分支**不应依赖 useDetailPane.openPreview 的成功/失败语义**，而应：① 直调 `fileApi.read(path, sid)` 校验可读性后再 openPreview（失败 toast，不关浮层，AC-6.7）；或 ② useDetailPane 暴露不吞错的 `openPreview` 变体（throw on error）；或 ③ useSearchJump watch detailPane.state.status==='error' 触发 toast（耦合，不推荐）。推荐①（与 #4「直调不经吞错层」原则一致）。此为**事实性缺陷**，需补 AC 或在 useSearchJump 实现说明中约束。

---

### GAP-3 [K-可行性/竞态] ⌘N 新建任务跳转（async action）的新 session 就绪竞态未充分覆盖

**问题**：AC-6.8 只覆盖「应用命令 action 抛错→toast」，但 ⌘N（新建任务）是 **async action**（`newSession()`，useSidebar.ts:221-239），存在两类 AC-6.8 未覆盖的场景：

源码核查（useSidebar.ts:221-239）：
```
async function newSession(presetCwd?): Promise<string | null> {
  if (newTaskInFlight) return null           // ← 场景1：已在建，返回 null（非抛错）
  ...
  const created = flow.currentSession.value
  if (!created) {
    navigation.push({ view: 'chat' })        // ← 场景2：首次启动延迟 create，返回 null（非抛错）
    return null
  }
  await selectSession(created.id)            // ← 场景3：selectSession 内 switchSession 可能 reject（被 AC-6.6 覆盖）
  return created.id
}
```

未覆盖场景：
1. **场景1（newTaskInFlight 守卫）**：用户快速双击 ⌘N 命令项，第二次 `newSession()` 返回 null（非抛错）——useSearchJump 的 await resolve（成功语义），按 AC-6.7「await 成功就关浮层」**关闭浮层**，但实际没有新建 session（第二次被去重了）。用户感知：点了新建但没反应（浮层关了，无新 session）。这是**非异常的成功路径返回 null**，AC-6.7 的「await 成功」语义对「返回 null 的成功」处理不明。
2. **场景2（首次启动延迟 create）**：`newSession()` 返回 null（AC-1.7 延迟 create），useSearchJump await resolve，关浮层，但无新 session 文件（pi 规则#6 延迟写入的延伸）。用户进入 landing 空态而非新 session——这是预期行为（landing 是设计），但 AC-6.7「await 成功再关浮层」未说明「成功=返回 session id」vs「成功=action resolve（可能 null）」的判定。
3. **场景3（selectSession reject）**：被 AC-6.6 覆盖（session.switch 失败），✅ 已处理。

**竞态本质**：⌘N 跳转的「成功」语义模糊——async action resolve 不等于「新 session 已就绪」。AC-6.8 的「action 抛错」只覆盖 reject 路径，未覆盖「resolve 但返回 null」的中间态。

**严重性**：中——场景1（双击去重）是真实用户操作（浮层还在时连点命令项），场景2（首次启动）是边缘但设计明确（landing 是预期，不算失败）。两者都不致命，但 AC 覆盖面有缺口。

**建议**：AC-6.8 补充——明确 async action 的「成功」判定：① action reject→toast（已覆盖）；② action resolve 但返回 falsy（如 newSession 返回 null）→按设计预期处理（⌘N 场景关浮层进 landing 或保持去重静默，非异常不 toast）；③ 或在 useSearchJump 实现说明约束「async action 须 await 完成 + 检查返回值」。无需新 AC，但 AC-6.8 文字须澄清「抛错」是否含「resolve 但语义失败（null）」。

---

## 已确认无 gap 项（避免重复报告）

- **session.switch 目标文件不存在（pi 延迟写入）**：✅ 非风险——规则#6 是文件层延迟，session.switch 是进程激活层（switch_session 命令），两层正交。NFR #6 数据 ✅ 判定正确。
- **跳转成功路径无日志**：✅ 合理——成功是默认期望，无日志噪音是正确判断，非可观测 gap。
- **AC-6.7 关键不变式识别**：✅ 到位——NFR 已显式标注「关键」，源码核查确认 await-then-close 是唯一正确解。

## 汇总

| Gap | 类型 | 严重性 | 处置建议 |
|-----|------|--------|---------|
| GAP-1 | D-数据/部分失败 | 低 | NFR 文字补全（无需新 AC，MR-3.1 已覆盖降级机制） |
| GAP-2 | F-事实性/吞错层阻断失败冒泡 | 中-高 | 补 AC 约束（file 跳转不经 useDetailPane 吞错层，直调 fileApi.read 校验）——与 #4 AH-E1/E2 同构，是真实假性 PASS 风险 |
| GAP-3 | K-可行性/竞态 | 中 | AC-6.8 文字澄清（async action resolve 但返回 null 的语义，⌘N 双击去重 + 首次启动延迟 create） |

**收敛判定**：`converged: false`——GAP-2 是与 #4 同构的吞错层假性 PASS 风险（事实性缺陷，须补 AC 约束），GAP-3 是 AC 覆盖面缺口（须文字澄清）。GAP-1 为低优先级文字补全。需主 agent 仲裁 GAP-2/GAP-3 是否纳入 #6 AC 修订。
