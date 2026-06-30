---
tracer: independent-forward
scope: batch-low（#1 匹配引擎 / #2 命令注册表 / #5 api 接线 / #8 loading+error / #9 Tab 切类 / #10 搭便车 2 项）
matrix_claim: NFR 初稿矩阵对这 6 个 issue 全标 ✅（无风险）
verdict: 大部分 ✅ 属实；发现 2 个低烈度 gap（F/K 混合），均为可在③issues/⑤骨架吸收的小补强，不推翻现有决策
converged: false
---

# 正向追踪 · 低风险批 issue（#1/#2/#5/#8/#9/#10）

> 任务：验证 NFR 初稿矩阵对这 6 个 issue 的「全 ✅」判定是否属实。
> 决策账本纪律：已 confirmed 决策（D-001~D-022）不当 gap 重报；下列 gap 均为新发现、无已决策覆盖。
> 源码核查：`stores/command.ts` / `api/index.ts` / `api/mock/search-data.ts` / `api/domains/{session,composer}.ts` / `composables/features/{useFileSearch,useDetailPane,useSidebar,useGitStatus}.ts` / `composables/useConnection.ts` / `shared/{file-tree,session,errors}.ts` / `components/overlays/SearchModal.vue` / `components/sidebar/Sidebar.vue`。

## 视角1 副作用覆盖性（按 issue 分小节）

### #1 匹配引擎提取 — ✅ 属实（无 gap）

**矩阵全 ✅ 核查**: 纯函数提取，无 I/O、无状态、无外部依赖。
- 源码核查 `SearchModal.vue:141-155` 现 segments 是线性 indexOf 切分（非 O(text×q) 嵌套），提取为 `lib/match-engine.ts` 后两消费者（#7 渲染 / #4 过滤）共用，DRY 成立。
- AC-1.2 grep ref/reactive/api/transport 无输出，强制纯函数边界。
- 性能 ✅ 属实：AH-B5 已降级删除（>200 字符场景），线性复杂度，无性能面。
- 结论：**✅ 判定属实，无新 gap。**

### #2 命令注册表 — ✅ 基本属实，1 个 K 级补强点

**矩阵全 ✅ 核查**:
- 源码核查 `stores/command.ts`：现有 store 仅管 slash 命令（`commandsBySession` Map），扩展点为新增 `appCommands` ref（D-016 物理隔离）。`applyCommands`/`clearCommands`/`getCommands` 签名不变 → **不破坏现有 SessionCommand 消费者**（CommandPopover/useSidebar/useNewTaskFlow），兼容性 ✅ 判定属实。
- 安全 ✅：NFR 称「应用命令 action 是编译期静态注册，无注入面」——核查成立。AppCommand.action 是闭包（非运行时外部字符串），无 eval/Function 注入面。

**K 级补强点（不标为推翻 ✅ 的 gap，仅记录欠细）**:
- NFR #2 称「无新增故障面」，但 **应用命令 action 执行**（AC-6.1 pi 注入或应用动作 / AC-6.8 action 抛错）是真实副作用面。issue #6 AC-6.8 已覆盖「action 抛错→toast」，但 #2 的 store 扩展侧未单独声明 action 执行的稳定性边界。`useCommandRegistry` 聚合后，`confirm(item)` 取 action 同步调用——若 action 抛同步异常（非 Promise reject），须确认 #6 的 try/catch 同步包裹（不仅 await）。此点已在 #6 AC-6.8 + MR-6.1 隐式覆盖，不另立 gap，但建议 #2 NFR 补一行「action 执行稳定性归 #6」的交叉指针，避免⑤实现时遗漏同步异常路径。

### #5 api 接线 — ⚠️ F 级 gap（数据兼容性判定不属实）

**矩阵全 ✅ 核查（重点是兼容性 ✅）**:
- NFR #5 称「mock→real 切换无数据兼容问题，mock search-data 的 SearchItem 结构与 real domain 输出一致」——**此判定与源码事实不符**。
- **源码事实**:
  - mock `SearchItem`（`api/mock/search-data.ts:9-13`）= `{type: SearchType, title: string, sub: string}` ——扁平 3 字符串字段。
  - real 数据源返回的是**异构 DTO**，非 SearchItem：
    - 文件源：`composer.getFileCandidates` → `FileNode[]`（`shared/file-tree.ts:21-34`）= `{path, name, type:'dir'|'file', children?, size?, ignored?}` ——树形结构，无 title/sub。
    - 会话源：`session.list` → `SessionGroup[]` 内含 `SessionSummary`（`shared/session.ts:3-14`）= `{id, label, cwd, gitBranch?, status, lastActiveAt, modelId, ...}` ——多字段，无 title/sub。
    - 命令源：`command store` 的 `SessionCommand` = `{id, name, kind, icon, description?}` ——字段名不同（name≠title, description≠sub）。
- **requirements.md:137 + :192 已明确会话显示规则**：session sub 需组装 `label + cwd + gitBranch`（3 字段拼 1 字符串），且 gitBranch 缺失时降级仅匹配 label/cwd。这是**非平凡的 DTO 映射**（类似 `lib/file-candidates.ts` 对 composer FileNode 的 DTO 映射），不是「结构一致」。
- **结论**：real domain 必须在 `api/domains/search.ts` 内做 FileNode/SessionSummary/SessionCommand → SearchItem 的 DTO 映射（title←label/name/path, sub←组装串）。NFR #5「✅ 无数据兼容问题」**低估了此映射步骤的存在**，判 F 级事实性 gap。

**为何是 F 级而非 K/D**：这不是新增风险面（映射本身是确定性转换，无 I/O/并发/安全面），但 NFR 对「兼容性 ✅」的论据（结构一致）是事实性错误，会让⑤实现者误以为 domain 直接透传即可、跳过 DTO 映射，导致 SearchItem.title/sub 为 undefined 渲染空白行。须 NFR #5 修订论据为「real 源是异构 DTO，domain 内须做 FileNode/SessionSummary/SessionCommand → SearchItem 映射（参考 lib/file-candidates.ts 模式）」。

**与 AC 的关系**：AC-5.3 仅要求「SearchItem 类型 re-export 路径从 mock/search-data 改为 domains/search 或 shared 类型源」——**未要求 AC 覆盖映射正确性**（query('commit') 命中 /commit 的 AC-4.1 在 #4，会话 sub 组装正确性无 AC）。建议映射正确性由 #4 的 AC-4.1/4.2/4.3（query 命中四类）间接兜底，⑤test-matrix 落 session sub 组装（含 gitBranch 缺失降级）用例。

### #8 loading+error 态 — ⚠️ K 级 gap（catch 后错误内容未审视）

**矩阵全 ✅ 核查**:
- AC-8.4 loading setTimeout clearTimeout 清理——**AC 覆盖充分**（查询返回 + 组件卸载双清理点），MR-8.1 同步，视角2 见下。✅ 属实。
- AH-S2 对齐（查询单源失败=分组空态非全局 error，跳转失败=全局 error toast）——AC-8.6 充分。✅ 属实。
- 稳定性 ✅「error 态补齐提升稳定性」——成立，no-silent-catch lint 强制消除静默吞错。

**K 级 gap（catch 后错误内容泄漏面未审视，安全/可观测维度）**:
- NFR #8 称「安全 ✅ / 可观测 ✅」，但未审视 **catch 后 toast 的错误文本来源**。
- **源码事实**：错误冒泡链是 `runtime reject` → `routeInbound`（`useConnection.ts:41-48`）→ `pending.reject(msg.id, Object.assign(new Error(payload.message), {code}))` → domain catch → toast。
- **关键**：`payload.message` 是 runtime error envelope 的**原始 message 字符串**（`useConnection.ts:46`：`const message = typeof payload.message === 'string' ? payload.message : 'request failed'`），**原样透传**到 Error.message，再由 domain catch（按 useDetailPane:91 / useGitStatus:98 既有模式 `(e as Error)?.message ?? '加载失败'`）原样进 toast。
- **泄漏面**：runtime 侧 file.read/session.switch/file.search 失败时，message 可能含**完整绝对路径**（如 `/Users/xxx/secret-project/...`）、错误堆栈片段、内部 code（`out_of_cwd`/`permission_denied`/`TIMEOUT`/`AUTH_ERROR` 等，见 `shared/errors.ts:1-9` AppErrorCode）。这些原样 toast 给用户，属于**可观测/安全维度的信息暴露**（虽是单用户桌面应用，敏感度低，但 message 可能含 cwd 绝对路径暴露用户目录结构）。
- **现有 codebase 无错误文本脱敏约定**（useDetailPane/useGitSettings/useChat 全部 `(e as Error)?.message` 原样），故 #8 复用既有模式不算新引入违规，但 NFR 对「安全 ✅」的论据未触及此点。
- **结论**：判 K 级（设计欠细），非 F（不是事实错误）非 D（不推翻）。建议 NFR #8 安全/可观测维度补一行「toast 错误文本沿用 codebase 既有模式（原样 Error.message），桌面单用户场景敏感度低，接受残余风险」，与 #3 localStorage 同模式登记残余风险表即可。无需新增 AC（不阻断⑤）。

### #9 Tab 切类 — ✅ 属实（无 gap）

**矩阵全 ✅ 核查**:
- activeType ref 是 computed 过滤的派生态（D-014 松散状态机），无 I/O / 无并发 / 无外部依赖。源码核查 SearchModal 现 `sections`/`flatItems`/`total` 均是 computed，加 activeType 过滤层是纯派生叠加，✅ 属实。
- AC-9.3（selIdx 重置/clamp）+ AC-9.4（recents 与 type_filtered 正交）覆盖边界，充分。
- 结论：**✅ 判定属实，无新 gap。**

### #10 搭便车 2 项 — ✅ 基本属实（1 个极低优先实现注记，不立 gap）

**矩阵全 ✅ 核查**:
- #10.1 Sidebar keydown 接命令注册表 + ⌘K toggle（AH-C5 变更）：源码核查 `Sidebar.vue:228-241` 现 keydown 是硬编码 if/else（⌘N/⌘K/⌘B），`searchOpen.value = true`（:236 非 toggle）。改读命令注册表 + toggle 是行为变更，AC-10.1 覆盖，✅ 属实。稳定性面无（纯前端键盘事件路由）。
- #10.2 scrollIntoView→scrollIntoViewIfNeeded：`SearchModal.vue:167` 现 `scrollIntoView({ block: 'nearest' })`，改 IfNeeded 是 spec 合规（BC-7），✅ 属实。

**极低优先实现注记（不立 gap）**：`Element.scrollIntoViewIfNeeded` 是非标准 API（Chromium/WebKit 支持，Firefox 不支持）。Electron 渲染进程跑 Chromium，运行时可用，但 tsc/dom-lib 类型可能未声明（须 `as any` 或类型扩展）。⑤骨架 tsc 验证时若报类型错，记为 D-019「待⑤验证」的预期内工作量，不构成设计 gap。建议 AC-10.2 验收注一句「scrollIntoViewIfNeeded 非 web 标准，Electron Chromium 可用，⑤骨架确认 tsc 类型兼容」。

## 视角2 缓解可行性（「已在③」的缓解项 AC 覆盖核查）

逐一核查 NFR 缓解项回灌表中标注「已在③issues」的 4 条（MR-4.3/MR-6.1/MR-7.1/MR-8.1）+ 批内相关项，验证 AC 是否真覆盖：

| 缓解项 | 回灌去向声明 | AC 核查结果 | 判定 |
|--------|------------|-----------|------|
| MR-4.3 文件截断提示 | ③ #4 AC-4.7 | AC-4.7「文件数超 MAX_SEARCH_RESULTS 时分组显示截断提示」——覆盖截断提示 UI，✅。**注**：AC-4.7 正文仍写 `MAX_SEARCH_RESULTS=500`，但 D-021 已 confirmed 校正为 5000（file-service.ts:59）。issues.md AC-4.7 文本尚未同步 D-021 修订（仍标 500），属文档漂移，非缓解缺口。 | 覆盖（文本漂移见下） |
| MR-6.1 跳转失败 toast + 浮层保持打开 | ③ #6 AC-6.5/6.6/6.7/6.8 | AC-6.5（file.read 失败 toast）/6.6（session.switch 失败 toast+刷新列表）/6.7（先 await 成功再关浮层）/6.8（应用命令 action 抛错 toast）——四条对称覆盖三类跳转失败 + 异常恢复，✅ 覆盖充分。 | ✅ |
| MR-7.1 debounce setTimeout 在 close 时 clearTimeout | ③ #7 AC-7.14/7.15 | AC-7.14「open/close 副作用不残留 pending 定时器」+ AC-7.15「watch query 改 debounce(120ms)」——**显式覆盖 clearTimeout**，✅ 充分。 | ✅ |
| MR-8.1 loading setTimeout 资源清理 | ③ #8 AC-8.4 | AC-8.4「loading 的 setTimeout 在查询返回/组件卸载时 clearTimeout 清理（防泄漏）」——**双清理点（返回+卸载）显式声明**，✅ 充分。 | ✅ |

**视角2 结论**：「已在③」的 4 条缓解项均有真实存在且语义匹配的 AC 覆盖，无 PHANTOM 指针（与 NFR §回灌登记末尾的自核查结论一致）。**缓解可行性 ✅，无新 gap。**

**附带文档漂移（非 gap，登记提示）**：issues.md #4 AC-4.7 正文 `MAX_SEARCH_RESULTS=500` 与 D-021 confirmed 的 5000 不一致（NFR 详细分析已用 5000，但 issues 源文件未同步）。属 ③issues 文档待同步，不影响缓解可行性，建议 issues.md AC-4.7 文本同步 D-021（500→5000）。

## Gap 清单

> 类型图例：F=事实错误 / K=设计欠细（未审视某面）/ D=决策需重审。下列均为低烈度，不推翻现有 confirmed 决策。

### GAP-BL-1 [F] #5 兼容性 ✅ 判定的论据不属实 — real 源是异构 DTO，须 DTO 映射

- **Issue**: #5 api 接线（波及 #4 search domain 实现）
- **问题**: NFR #5 称「mock search-data 的 SearchItem 结构与 real domain 输出一致，无数据兼容问题」——源码核查 real 数据源返回 FileNode/SessionSummary/SessionCommand（异构 DTO，字段名/结构均不同），**非 SearchItem 形态**。domain 必须做 DTO→SearchItem 映射（如 session sub = label+cwd+gitBranch 组装，见 requirements.md:137/192）。NFR 论据是事实性错误。
- **影响**: ⑤实现者若照 NFR「结构一致」直传，SearchItem.title/sub 渲染 undefined 空白行。
- **建议处置**: NFR #5 兼容性维度论据修订为「real 源是异构 DTO（FileNode/SessionSummary/SessionCommand），domain 内须做 → SearchItem 映射（参考 lib/file-candidates.ts DTO 映射模式）；映射是确定性转换，无 I/O/并发/安全面」。映射正确性由 #4 AC-4.1/4.2/4.3 间接兜底，建议 ⑤test-matrix 补 session sub 组装（含 gitBranch 缺失降级）用例。**不另立新 AC 于 #5**（#5 仅 5 LOC 接线，映射归 #4 domain）。

### GAP-BL-2 [K] #8 catch 后 toast 错误文本未审视 — 原样透传 runtime error envelope

- **Issue**: #8 loading+error 态（波及 #6 跳转 toast）
- **问题**: NFR #8 安全/可观测维度标 ✅，但未审视 catch 后 toast 的错误文本来源。源码核查错误冒泡链 `routeInbound`（useConnection.ts:46）原样透传 runtime `payload.message` 到 Error.message → domain catch（沿用 useDetailPane:91 / useGitStatus:98 既有 `(e as Error)?.message` 模式）原样进 toast。message 可能含**绝对路径**（用户目录结构）、内部 code（out_of_cwd/permission_denied/TIMEOUT/AUTH_ERROR，见 shared/errors.ts:1-9）。
- **影响**: 桌面单用户场景敏感度低，但 NFR「安全 ✅」论据未触及此点，可观测维度的错误内容暴露面欠审视。
- **建议处置**: NFR #8 安全/可观测维度补一行残余风险登记（与 #3 localStorage 同模式）——「toast 错误文本沿用 codebase 既有模式（原样 Error.message），桌面单用户场景敏感度低，接受残余风险；未来若引入多用户/远程场景须加脱敏层」。**无需新增 AC，不阻断⑤**。

### 非 Gap（登记但不上清单）

- **#2 action 执行稳定性交叉指针欠细**（K 级，已被 #6 AC-6.8 + MR-6.1 隐式覆盖）：建议 #2 NFR 补「action 执行稳定性归 #6」交叉指针，提示⑤实现 confirm() 须同步 try/catch 包裹 action 调用（非仅 await）。不单独立 gap。
- **issues.md AC-4.7 文本漂移**（MAX_SEARCH_RESULTS 500 vs D-021 confirmed 5000）：文档同步问题，非缓解可行性 gap。建议 issues.md 同步 D-021。
- **#10.2 scrollIntoViewIfNeeded 非标准 API**（tsc 类型兼容）：D-019「待⑤验证」预期内，非设计 gap。

## 收敛判断

- **converged: false** — 发现 2 个低烈度 gap（GAP-BL-1 F 级 / GAP-BL-2 K 级），均可在 NFR 文档侧吸收（修订论据 + 补残余风险登记），不推翻任何 confirmed 决策，不阻断⑤骨架。
- 批内 6 个 issue 的「全 ✅」矩阵判定：**#1/#9 完全属实；#2/#10 基本属实（仅交叉指针/实现注记）；#5 兼容性论据事实错误（GAP-BL-1）；#8 安全/可观测欠审视（GAP-BL-2）**。
- 视角2 缓解可行性：4 条「已在③」缓解项 AC 覆盖充分，无 PHANTOM，✅。
- 反哺建议：GAP-BL-1 若修订涉及 AC 增补（session sub 组装用例），走反哺至 #4 AC；GAP-BL-2 走 NFR 残余风险登记，不触发 issues 反哺。
