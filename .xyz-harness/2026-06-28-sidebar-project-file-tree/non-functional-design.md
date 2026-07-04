---
verdict: pass
upstream: issues.md
downstream: code-architecture.md
backfed_from: []
---

# 非功能性设计 — 全项目文件树

> 承接 `issues.md`（③issues 定稿，verdict:pass + review APPROVED）。本阶段评估 Step 3 每个**已决策 issue 解决方案**对系统的非功能性副作用，并给缓解方案。
> 决策账本 D-001~D-020 全部 `confirmed`，**本阶段不重新确认已 confirmed 决策**；D 类新决策（取舍原则例外 / 残余风险接受）即时 append。

**分析范围说明**：本轮纳入 P0(#1/#2) + P1(#3/#4/#5/#6/#7/#8/#9/#10/#14/#16) 共 **11 个已决策 issue**。P3 迷雾（#11/#12/#13）实现未启动，副作用不可评估，列入「P3 延后项 NFR 待评估」登记，不进入 7 维度分析矩阵。

**写量规则**（反膨胀）：矩阵标 ✅ 的维度**只写一行理由**（为何不适用 / 无风险 / 已被 ③ AC 覆盖）；只有 ⚠️ 维度才按 `nfr-dimensions.md` 4 字段模板展开。

## 分析矩阵

| Issue | 方案 | 安全 | 数据 | 性能 | 并发 | 稳定性 | 兼容性 | 可观测 |
|-------|------|------|------|------|------|--------|--------|--------|
| #1 | 方案A shared 统一 | ⚠️ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #2 | 方案A 三层+port | ⚠️ | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | ⚠️ |
| #3 | 方案A 4facet 单store | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| #4 | 方案A 递归组件 | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| #5 | 方案A 扩白名单 | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |
| #6 | 方案A tab 硬编码扩 | ⚠️ | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ✅ |
| #7 | 方案A 白名单扩+下沉 | ⚠️ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| #8 | 方案A 注入cwd | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #9 | 方案A 还原字段 | ✅ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #10 | 方案A 统一FileNode | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #14 | 方案A 骨架抛NotImpl | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #16 | 方案A ignored+双模式 | ✅ | ⚠️ | ⚠️ | ✅ | ⚠️ | ✅ | ✅ |

（✅ 无风险 / ⚠️ 有风险已缓解 / 不可接受项应回 Step3 重选方案（本矩阵无此项） / — 不适用+理由）

> 矩阵判据：本主题是 **Electron 桌面单机单用户**应用（runtime 单实例 + 前端单写者）。NFR-dimensions 模板面向后端服务的「QPS/分布式锁/多实例」在本主题大量不适用（多用户越权 / 分布式并发 / 雪崩熔断 / 灰度发布均 N/A）——这些维度标 ✅ 并给一行理由（单机单用户无此风险），缓解精力聚焦在**真实存在的**风险（路径越权 / 渲染性能 / git 命令注入 / 预览 XSS / session 隔离 / 日志观测）。

## 详细分析

### Issue #1: shared 基础设施 + WS 协议类型 — 方案 A

#### ✅ 数据一致性 / 性能 / 并发 / 稳定性 / 可观测性
纯类型定义 + 无 IO 纯函数（ignore-parser/path-guard），无状态、无副作用、无并发。性能 = 常量级纯计算。③ AC-1.3（ignore-parser 无 node:fs）/ AC-1.5（shared 无 PiXxx）已 grep 验收。

#### ⚠️ 安全影响（isUnderOrEqual 是越界校验的根函数 — symlink 词法绕过）

**风险**: `isUnderOrEqual(cwd, path)`（现 `n`）是 #7 file.read / #2 file.tree 越界校验的核心。源码实证 `utils/path-utils.ts:14-17` 函数体只用 `relative(resolve(parent), resolve(child))`，**`path.resolve` 不解析 symlink**——是纯词法判定。两类风险：(a) **迁移回归**：从 utils 提升到 shared 时若函数体重写，路径规范化/`..` 穿越/末尾斜杠行为变化直接打开越权读；(b) **symlink 词法绕过**（[tracing K-1]）：cwd 子树内若存在指向 cwd 外的 symlink（如 `cwd/evil -> /etc`），`isUnderOrEqual(cwd, "cwd/evil")` 词法判 true（路径在 cwd 下）但实际读出 `/etc` 内容。对比 `extension-service.ts:321-340` 已知此向量并补 `realpathSync` 解析后校验。
**影响范围**: file.tree / file.tree.expand / file.read 三条路径 + git-service / extension-service（复用同一函数）。
**缓解方案**: (1) 迁移是**位置提升非逻辑重写**——函数体逐字搬移，仅改 import 路径；(2) ⑤骨架补**单元测试**覆盖词法边界：`..` 穿越 / 末尾斜杠 / 相对路径（AC-1.2 已要求行为等价）；(3) **symlink 防护需架构裁决**（⑤骨架验证）：FileService 是否在越界校验前补 `realpathSync` 解析（与 extension-service 范式对齐）——若补，则 symlink 指向 cwd 外的请求被拒；若不补（接受词法判定），需残余风险登记。⑤骨架验证后结论回写本节。
**残余风险**: (1) 平台特定行为（macOS 大小写不敏感）——⑤骨架跨平台单测；(2) **若⑤裁决不补 realpath**：cwd 内 symlink 指向 cwd 外可读——接受理由（用户对自己的 cwd 内容负责，恶意 symlink 需先被放进 cwd）+ 监控（⑤骨架裁决记录）。

#### ⚠️ 兼容性影响（path-guard import 迁移）

**API 变更**: `isUnderOrEqual` 的导出位置从 `runtime/src/utils/path-utils.ts` 改为 `shared/path-guard.ts`——**所有消费者**（git-service + extension-service + file-service）必须同步改 import。AC-1.2 已要求 `grep "from '.*path-utils'"` 无输出兜底。
**数据兼容**: 无（纯函数迁移，无数据格式变更）。
**客户端影响**: runtime 内部 import，无外部客户端。
**灰度/回滚**: 单机应用无灰度；回滚 = git revert（纯 import 路径变更，机械可逆）。
**缓解**: AC-1.2 grep 验收作为机械门禁；⑤骨架 tsc 编译验证所有消费者 import 已迁移（tsc 报错即漏改）。

### Issue #2: runtime FileService + fs-executor + file-message-handler — 方案 A

#### ✅ 数据一致性 / 并发
单用户交互、runtime 单实例；FileService 无状态编排，无跨请求共享可变状态，无并发竞争（前端单写者，同节点 loading 态去重见 #3）。AC-2.4（ignore 过滤）/ AC-3.8（loading 幂等去重）已覆盖。

#### ⚠️ 安全影响（fs-executor 读 cwd 子树 = 越界校验前置）

**风险**: `file.tree` / `file.tree.expand` 经 FileService 编排调 `listDir`。若 FileService **未对传入 path 做 cwd 越界校验**就调 executor，恶意 WS 消息（`file.tree.expand(sessionId, "/etc")`）可读 cwd 外目录。③ AC 未显式要求 file.tree.expand 的越界校验（只 file.read AC-7.4 有）。
**影响范围**: file.tree / file.tree.expand 两条路径。
**缓解方案**: **FileService 编排层统一守门**——所有接收 path 的方法（listDirForTree / expandDir / readFile）入口都调 `isUnderOrEqual(session.cwd, path)`，越界返回结构化 error（reason='out_of_cwd'）。与 file.read（#7）同源校验。
**残余风险**: 无（cwd 子树是唯一可读边界，越界即拒）。

#### ⚠️ 性能影响（listDir depth=1 编排 = 1+M 次，非 2 次）

**预期负载**: 单用户交互，无 QPS 压力。但**大目录**（如 monorepo root 含数千项 / node_modules 同级）`listDir` 单层 readdir 可能返回数千条目 → FileNode[] 序列化 + WS 传输 + 前端渲染压力。
**关键路径延迟**: [tracing F-1 修正] file.tree 首加载按架构 §6 GAP-S5 编排 = **1+M 次 listDir**（M = cwd 顶层目录数）：1 次 `listDir(cwd)` 拿顶层，再对其中每个 dir 调 `listDir` 拿一级子。monorepo 下 M 可达数十（如 50 个 package 目录）→ 51 次 readdir 串行。P99 目标：首加载 < 1s（懒加载缓解，非全量）。**⑤骨架验证**：M 大时是否需并行化（Promise.all 对顶层目录并行 listDir）。
**扩展性瓶颈**: 目录项数增长 → readdir 线性衰减 + FileNode[] 内存线性增长。万项目录前端递归渲染卡顿（见 #4 性能）。
**优化方案**: (1) 懒加载 depth=1（已定 D-009，仅顶层 + 一级子）；(2) ignore-parser 过滤移除 node_modules 等巨量目录（默认隐藏，#16）；(3) **⑤骨架标记**：是否需「单层返回上限 + 截断提示」（如单目录 >5000 项截断）+ 并行化 listDir —— 列入需⑤骨架验证（大项目实测）。
**残余风险**: 同 #2 稳定性截断权衡。

#### ⚠️ 稳定性影响（fs 异常 + 超时 + symlink 循环）

**故障场景**: cwd 无读权限 / 目录被删 / 磁盘 IO 错误 / symlink 循环（展开符号链接目录可能成无限树）。
**降级方案**: 返回结构化 error（AC-2.2 permission_denied / AC-2.5 timeout），前端 error 态可重试（D-011）。
**[tracing K-3] symlink 循环防护**：listDir 用 `readdir`（不 `lstat` 区分 symlink），FileNode DTO 无 symlink 标志（type 仅 dir/file）。用户可逐层展开 symlink 循环目录（a→b→a）成无限树（每次 expand 单层都「合法」）。**缓解**：⑤骨架约束 fs-executor listDir 对 symlink 目录标记（或拒绝展开），与 extension-service 的 symlink 防护范式对齐（联动 #1 symlink 词法绕过的 ⑤骨架裁决）。
**[tracing K-2] 超时机制**：AC-2.5 引 timeout（reason='timeout'）为已覆盖，但**新建 fs-executor 无现成超时范式**——node:fs/promises 无内建超时，git-executor 的 execFileSync 超时不可复用。**缓解**：⑤骨架约束 fs-executor listDir/readFile 超时机制（Promise.race + setTimeout 或 AbortController），与 AC-2.5 对齐。
**熔断/限流**: N/A（单用户，无雪崩场景）。
**重试策略**: 前端 error 态可重试（D-011）；runtime 不自动重试。
**SLA 影响**: 无（桌面应用无 SLA）。

#### ⚠️ 可观测性（FileService 缺日志）

**日志**: 新增 FileService 无现成日志。需⑤骨架约束：关键路径（file.tree / expand / read 失败）写结构化日志含 sessionId + path + reason。
**指标**: N/A（桌面应用无业务指标采集）。
**追踪**: N/A（无跨服务调用链，runtime 单进程）。
**告警**: N/A（单机应用无告警通道）。
**审计**: file.read 是敏感操作（读项目源码），需审计日志（见 #7 可观测性）—— 本 issue 仅 file.tree 结构读取（不读内容），审计需求低。
**缓解**: ⑤骨架约束 FileService 关键操作日志（含 sessionId/path/reason），列为骨架约束。

### Issue #3: 前端 fileTree store + useFileTree — 方案 A

#### ✅ 安全
纯前端状态管理，无外部输入进入危险 sink（path 字符串仅用于渲染 + WS 请求，WS 请求经 #2 FileService 越界校验）。

#### ⚠️ 数据一致性（多 session 展开态缓存 + 失效）

**事务边界**: 无跨表事务（前端 store 单写者）。但 **D-019 rehydrate**（展开态按 sessionId 缓存）引入多 session 缓存——切走 session A、切回 session A 时需 rehydrate A 的展开路径集。若 rehydrate 引用了**已被 agent 删除的目录路径**（展开态记录的 path 在 file.tree 快照中已不存在），rehydrate 会显示空展开态或报错。
**并发场景**: 单写者无并发，但**跨 store 订阅**（AC-3.11 fileTree subscribe chat 的 file_changes ready 事件）是异步时序——ready 帧到达时若 store 正在 rehydrate 中途，可能产生失效与 rehydrate 竞态。
**迁移方案**: 无（新 store）。
**回滚策略**: rehydrate 失败（路径不存在）graceful 降级——丢弃缺失路径，仅恢复仍存在的展开态（不报错）。
**缓解**: ⑤骨架约束 rehydrate 对路径做存在性校验（loadTree 后按缓存展开态逐项 check，不存在的跳过）—— 列入需⑤骨架验证。

#### ⚠️ 性能（深层嵌套递归渲染 → ④NFR-degraded）

**预期负载**: 单用户，但用户可手动展开 20+ 层目录 → FileTreeRow 自递归渲染深层树（③issues 已标「降级到 ④NFR」）。
**关键路径延迟**: 深层嵌套渲染性能 / 栈深约束。Vue 自递归组件在 20+ 层时可能触发「maximum call stack」或渲染卡顿（每层 = 一个组件实例 + 响应式追踪开销）。
**扩展性瓶颈**: 树深度无上限 → 栈深风险 + DOM 节点数爆炸（万节点全展开卡死）。
**优化方案**: (1) 懒加载限制单次渲染量（D-009，未展开的子树不渲染）；(2) **⑤骨架标记验证**：20 层递归渲染是否触发栈深告警 / 卡顿；若触发，⑤骨架约束「递归深度上限 + 超限提示」或改用虚拟滚动（架构 D-009 已否决全量虚拟滚动，但深层局部虚拟化可能需重新评估）。**路由到 ⑥独立 perf Wave**：深层嵌套渲染压测（20 层 × N 节点）作为 perf 类验收（性能混沌，非单测可断言）。
**残余风险**: 用户主动展开极深目录的体验卡顿——接受理由（懒加载下需用户主动逐层展开，非首加载问题）+ 监控方式（⑥perf Wave 验证）。

#### ⚠️ 并发（跨 store 异步时序竞态 + 架构约束）

**竞态场景**: ③ AC-3.7（expand 在途切 session 丢 stale 响应）/ AC-3.8（loading 幂等去重）/ AC-3.9（error 态折叠再展开触发重试，[tracing D-2 补登]）/ AC-3.10（overlay 先于 tree 到达）/ AC-3.11（ready 帧跨 store 失效）—— 五个异步时序场景已在 ③ AC 登记。
**[tracing K-9 架构约束冲突] AC-3.11 机制**：原 ③ 措辞「fileTree store subscribe chat store」**违反现有架构硬约束**（`stores/sidebar.ts:5` + `stores/chat.ts:3` 明文「stores 间禁止互相 import」；现有跨 store 编排在 composables 层，见 useSidebar.ts:101-106；file_changes 事件入口在 chat-chunk-processor.ts:347）。**已回灌 ③issues 修正 AC-3.11** 为「composable 层（useFileTree）编排跨 store 失效触发（watch chat store file_changes + 派发 fileTree store 的 invalidate 接口）」+ 回灌 ②architecture §7/§10 D-017。本 NFR 记录此约束冲突，⑤骨架实现须在 composable 层（非 store 层）做跨 store 编排。
**幂等策略**: sessionId 校验（响应回来比 sessionId，不匹配丢弃）+ loading 态去重（同节点 loading 不发新请求）+ error 重试不复用错误缓存（AC-3.9）。
**锁策略**: 无锁（前端单写者）；靠 sessionId 过滤 + 状态机守卫。
**分布式考虑**: N/A（单机）。
**缓解**: ③ AC-3.7/3.8/3.9/3.10/3.11 已显式登记，进⑤test-matrix（代码测试）。**AC-3.11 跨 store 失效（composable 层 watch + invalidate 派发）标记需⑤骨架验证**（订阅时序 + 路径定位失效节点的实现复杂度 + 架构约束合规）。

#### ⚠️ 稳定性（overlay 依赖降级）

**故障场景**: git.status 请求失败（AC-3.6）/ file.tree 请求失败（AC-3.4 error 态重试）。
**降级方案**: AC-3.6 已定（overlay 失败为空，树仍渲染仅缺角标）+ AC-3.4（error 可重试）。降级体验明确。
**熔断/限流**: N/A。
**重试策略**: error 态用户手动重试（D-011）。
**SLA 影响**: 无。

#### ⚠️ 可观测性（前端缺日志 + rehydrate 降级）

**日志**: 前端 store 操作无现成日志。异步竞态（stale 响应丢弃 / overlay 失败 / 失效转移）在 dev/debug 时难复现。**[tracing D-1]** rehydrate（D-019）静默跳过已删目录路径——大项目 agent 跑一轮删一批目录后切回，用户看到「展开态莫名丢失」却无任何日志。
**缓解**: ⑤骨架约束关键异步操作 console.debug 日志（sessionId + 操作 + 结果），便于 dev 排查；**rehydrate 跳过路径时额外 debug 日志**（跳过数 + 路径摘要）。列为骨架约束（dev 排查工具，不进生产测试）。
**指标/追踪/告警/审计**: N/A（前端无业务指标采集）。

### Issue #4: FileView.vue + FileTreeRow.vue 重写 — 方案 A

#### ✅ 安全 / 数据 / 并发 / 稳定性 / 兼容性 / 可观测性
纯渲染组件，无外部输入进危险 sink（路径/文件名经 store 派生，WS 请求经 #2/#5 校验）。无状态变更（props 驱动）。兼容性（BC-4 四子行为变更是有意为之，D-001 已裁决）。③ AC-4.1~4.14 已覆盖行为。Git 角标 M/A/D/U 全态（AC-4.2）+ error 态（AC-4.7）+ 空态（AC-4.8/4.9）。

#### ⚠️ 性能（递归组件渲染 + 深层嵌套 + 过滤叠加）

**预期负载**: 同 #3 性能——FileTreeRow 自递归在深层嵌套下的渲染开销。
**关键路径延迟**: 过滤框输入（AC-4.4）触发 store computed 派生 filteredTree → 整棵已展开树重渲染。大树下高频输入可能卡顿（每次 keydown 重算过滤 + 重渲染）。
**扩展性瓶颈**: 过滤范围 = 已加载节点（AC-4.4 语义），未展开子树不参与过滤 → 过滤量受懒加载约束（相对安全）。
**[tracing D-3 叠加放大]** 过滤 + 递归渲染叠加：用户已展开 15 层 + 过滤输入时，每次 debounce 后是「全树 diff + 递归组件重渲染」叠加，debounce 只压频不压量。深层展开 + 过滤叠加是 perf Wave 必测场景。
**优化方案**: (1) 过滤输入做 **debounce**（⑤骨架约束，~150ms）避免逐字符重算；(2) 深层嵌套递归渲染栈深 → 路由到 ⑥perf Wave（同 #3 性能，含「15 层展开 + 过滤输入」叠加场景）。
**残余风险**: 同 #3（用户主动展开深层卡顿）。

### Issue #5: git.diff 全链路 — 方案 A

#### ✅ 数据 / 性能 / 并发 / 兼容性
git 域独立链路，复用 IGitExecutor port（范式一致）。AC-5.1~5.6 已覆盖（diff 返回 / 空文件 / 二进制友好占位 / 越界复用 path-guard）。兼容性（扩白名单是标准扩展，不破坏 git.status）。性能（git diff CLI 调用，单用户无 QPS 压力）。

#### ⚠️ 安全（git 命令注入 + path 越界校验）

**风险**: `git.diff(sessionId, path)` 传 path 给 git CLI（`git diff -- <path>`）。若 path **未经转义直接拼进命令**，恶意 path（含 shell 元字符如 `;rm -rf /` 或 `$(cmd)`）= 命令注入。
**影响范围**: git.diff / 复用范式的 git.status / git-executor 所有传 path 的命令。
**[tracing F-2 源码实证]** 现有 git-executor.ts:33 用 `execFileSync('git', fullArgs, {...})` **数组形式不经 shell**（port 注释 ports/git-executor.ts:37-38 明文约束「必须用 execFileSync 数组形式，禁止 exec/spawn 拼接 shell 字符串」），命令注入根因层已正确。**但 #5 getFileDiff 是 git 域首次把 WS 传入的 path 喂给 diff 命令**（现有 diff 调用 git-service.ts:113 的 `diff --numstat HEAD` 不传外部 path），是真实攻击面。
**缓解方案**: (1) getFileDiff 必须经 IGitExecutor port 调用（`executor.exec(cwd, 'diff', args)` 数组形式），**禁止在 getFileDiff 函数体内直接 execFile/execSync**（[tracing F-2] NFR-AC-S3 增补断言）；(2) ⑤骨架约束 git-executor 所有 exec 用 execFileSync 数组形式，grep 禁 `exec(` / `execSync(` 字符串拼接；(3) path 仍经 path-guard 越界校验（双保险）。
**[tracing K-6 新增越界校验]** git-service.ts 现有越界校验 `resolveFilePaths`（L75-87）**只用于 stage/unstage/commit 写操作**，diff 路径无先例。getFileDiff 需**新写**一道越界校验（仿 resolveFilePaths：path resolvePath + isUnderOrEqual，越界抛 GitError('path_not_allowed')），非「复用」。新增 NFR-AC-S5（归属 #5，断言 `git.diff(sessionId,"/etc/passwd")` 返回 path_not_allowed，不触达 git CLI）。
**[tracing K-7 既有技术债]** `runtime/src/services/git-info.ts:59` 用 `execSync` 跑 `'git rev-parse --abbrev-ref HEAD'`（传 cwd 选项的字符串拼接形式）绕过 IGitExecutor port（cwd 来自 session 受信源，注入面低）。#5 grep 门禁口径需明确：若门禁范围 = 全 runtime，git-info.ts 需收编进 IGitExecutor port（⑤骨架约束）；若仅 git-executor.ts，需显式豁免 git-info.ts + 安全论证注释。
**残余风险**: 无（参数数组 + 越界校验双保险）。

#### ⚠️ 稳定性（git CLI 异常）

**故障场景**: 非 git 仓库（AC-5.3）/ 路径无效 / git 进程超时（AC-5.4）/ 二进制文件（AC-5.5）/ git 二进制不存在。
**降级方案**: AC-5.3（结构化 error 不 crash）/ AC-5.4（timeout 归 error 可重试）/ AC-5.5（二进制友好占位）。**git 二进制缺失**：runtime 启动时检测 git 可用性，缺失则 git 域全降级（file-tree 无角标但仍可浏览，同 AC-3.6 overlay 降级语义）。
**熔断/限流**: N/A。
**重试策略**: 前端 error 态重试（D-011）。
**SLA 影响**: 无。

#### ⚠️ 可观测性（git 失败缺日志）

**日志**: git CLI 失败（非零退出码）需记录 stderr 便于排查。⑤骨架约束 git-executor 失败时结构化日志（sessionId + path + exitCode + stderr 摘要）。
**指标/追踪/告警**: N/A。
**审计**: git.diff 读改动内容，非敏感写操作，审计需求低。
**缓解**: ⑤骨架约束 git-executor 失败日志。

### Issue #6: SideDrawer 改造 + DetailPane.vue — 方案 A

#### ✅ 数据 / 并发 / 稳定性 / 可观测性
SideDrawer tab 硬编码扩 detail（§10 已判 4 tab 无需 registry）。DetailPane 预览交互。AC-6.1~6.8 已覆盖（点文件 / diff / 未改动 / 错误态 / loading / 超大文件截断 AC-6.7 / 二进制占位 AC-6.8）。稳定性（tab 扩展不破坏 terminal/browser/git）。

#### ⚠️ 安全（文件内容预览 = XSS / 敏感数据）

**风险**: file.read（#7）返回的文件内容经 DetailPane 渲染。若文件内容**未经转义直接 v-html 渲染**，恶意文件（含 `<script>` 或 `<img onerror>`）= XSS（Electron renderer 进程执行任意 JS = 可经 IPC 访问主进程资源，严重）。即便不用 v-html，diff patch 渲染也需注意（diff 是文本，安全）。
**[tracing 源码实证]** 项目有 ESLint 规则 `vue/no-v-html`（error 级）全局禁 v-html，全 renderer 仅 MarkdownRenderer.vue:15 一处受控放开（shiki + markdown-it `html:false`，XSS 安全范式）。**draft-detail-pane.html:752-760 设计稿实证** cs-diff 用纯文本 `textContent` 渲染（非 v-html）。这是 #6 DetailPane 应复用的安全范式。
**影响范围**: DetailPane 文件内容预览（非 diff，diff 是 patch 文本相对安全）。
**缓解方案**: (1) **禁止 v-html 渲染文件内容**——用 Vue 文本插值（双花括号插值，默认 HTML 转义）或 `<pre>` 文本节点（XSS 安全）；(2) diff 渲染用文本（code-diff 组件按行渲染文本，不解析 HTML）；(3) ⑤骨架约束 DetailPane 文件内容渲染 grep 禁 `v-html`（仅 diff 语法高亮若需 HTML 则经严格 sanitize）；(4) **代码高亮复用 shiki 单例**（项目已有 XSS 安全范式，见 MarkdownRenderer）。
**残余风险**: 引第二套高亮库需重新评估 sanitize——⑤骨架约束「禁止引第二套高亮库」即可消除。

#### ⚠️ 性能（超大文件预览）

**预期负载**: 单用户预览。但**超大文件**（AC-6.7 >1MB）file.read 全量返回 → DetailPane 渲染卡死。
**关键路径延迟**: 大文件 DOM 渲染（万行代码全量渲染 = 浏览器卡死）。
**优化方案**: (1) AC-6.7 已定（file.read 截断 + 提示）；(2) **⑤骨架标记**：DetailPane 是否需虚拟滚动（如 monaco-editor / codemirror 的虚拟渲染）—— 截断后仍可能数千行，虚拟滚动可能是必要优化。列入需⑤骨架验证。
**残余风险**: 截断后用户看不到完整大文件——接受理由（预览非编辑，截断提示已给）。

#### ⚠️ 兼容性（diff 高亮库 + 虚拟滚动库依赖决策）

**[tracing D-6 源码实证]** renderer/package.json **无 diff 专用库（无 vue-diff/diff2html/diff），无 DOMPurify，无虚拟滚动库（monaco/codemirror）**。shiki 已有（^4.2.0，XSS 安全范式已在 MarkdownRenderer 验证）。
**API 变更**: 无协议变更（前端组件内部）。
**数据兼容**: 无。
**依赖决策（兼容性/供应链风险）**:
- DetailPane diff 语法高亮：决策「复用现有 shiki 单例（XSS 安全）vs 引新 diff 库」。**缓解**：⑤骨架约束「DetailPane 高亮复用 shiki 单例，禁止引第二套高亮库」——避免新增未审计的依赖（供应链 + XSS 风险）。
- 大文件虚拟滚动（若⑤判定必需）：等于引新依赖（monaco/codemirror/vue-virtual-scroller）。**缓解**：⑤骨架评估若需引库，触发⑤兼容性复审（新依赖的供应链/打包体积/维护性评估）。
**灰度/回滚**: 单机无灰度；回滚 = 移除新依赖（机械可逆）。
**缓解**: ⑤骨架约束高亮库统一 + 虚拟滚动依赖复审（见回灌表）。

### Issue #7: file.read 权限放开 + 三层重构 — 方案 A

#### ✅ 性能 / 并发 / 稳定性
file.read 单文件读取，无批量/并发问题。AC-7.1~7.5 已覆盖（cwd 子树可读 / 原 3 目录兼容 / 越界拒绝 / 校验在 service / transport 不碰 fs）。稳定性（错误态见 #2）。

#### ⚠️ 安全（file.read 权限放开 = 越界读扩大）

**风险**: 白名单从「3 目录」扩展为「3 目录 ∪ cwd 子树」——**读权限范围扩大**。若 isUnderOrEqual 实现有缺陷（见 #1 安全），或 cwd 被操纵（如 session.cwd 指向 `/`），可读任意文件。
**影响范围**: file.read 路径 + 所有 file.read 消费者（DetailPane 预览 / skill 加载 / npm 资源）。
**缓解方案**: (1) cwd 来自 session 创建时的可信源（用户选择的工作目录），非 WS 请求参数（不可被前端操纵）；(2) isUnderOrEqual 越界校验（#1 已缓解，含 symlink 词法绕过的⑤骨架裁决）；(3) AC-7.3 越界返回结构化 error。**[tracing K-4] session.cwd 信任边界需追溯源头**：⑤骨架补 grep 验收 `sessionService.create` 入参来源——确认 create 不接受前端可控的 cwd 参数（否则信任边界失效）。file.read handler 签名不含 cwd 参数（用 session 绑定的 cwd）。
**残余风险**: session 创建时若 cwd 设置不当（如指向系统目录），file.read 可读该子树——接受理由（cwd 是用户主动选择的工作目录，用户对自己的选择负责）。

#### ⚠️ 兼容性（白名单扩展不收紧 — 向后兼容验证）

**API 变更**: allowedPrefixes 从 3 目录扩展为 3 目录 ∪ cwd 子树。**non-breaking**（扩展不收紧，AC-7.2 原 3 目录仍可读）。
**数据兼容**: 无（权限配置，无数据格式）。
**客户端影响**: 现有 file.read 调用者（skill 加载 / npm 资源）行为不变（原 3 目录保留）。**[tracing K-5]** 原调用方路径形态（相对路径 / 末尾斜杠 / 绝对路径）须不变——原 server.ts 用 `resolve(filePath)` + `startsWith(prefix+'/')`，新方案用 `isUnderOrEqual`（relative 判定），两者对路径形态处理不同。
**灰度/回滚**: 单机无灰度；回滚 = 恢复原 3 目录白名单（机械可逆）。
**缓解**: NFR-AC-C1 显式回归测试（原 3 目录 file.read 仍成功）**+ 增加「相对路径 + 末尾斜杠形态」用例**—— 列为代码测试。

#### ⚠️ 可观测性（file.read 是敏感操作 — 审计日志）

**日志**: file.read 读项目源码，属敏感操作。需审计日志（谁/session 读了哪个文件）。
**指标**: N/A。
**追踪**: N/A。
**告警**: N/A。
**审计**: **⑤骨架约束** FileService.readFile 写审计日志（sessionId + path + timestamp），便于追溯文件读取行为。列为骨架约束（日志存在性，非功能测试）。
**缓解**: ⑤骨架约束 file.read 审计日志。

### Issue #8: 修 G1 — event-adapter cwd 丢失 — 方案 A

#### ✅ 全 7 维度
纯 bug 修复（补回丢失的闭包变量 session.cwd）。无新增功能、无新数据、无新权限。AC-8.1~8.3 已覆盖（ready 帧 cwd 正确 / accumulating 行为不变 / agent_end 清空不变）。bug 修复不引入新副作用，7 维度全 ✅（修 bug 提升数据准确性 = 数据一致性改善，非风险）。**[tracing D-9 提示]** 修复后 `reconcileFileChanges`（execSync git status，5s 超时）首次启用——agent_end 同步路径阻塞 `message.complete` 帧发送，reconciler 降级路径（非 git 仓库/超时返回 null）已有。AC-8.1 已含「非 git cwd ready 帧仍正常返回（降级回归）」要求覆盖此点，故稳定性仍 ✅。

### Issue #9: 修 G5 — convertPiHistory 不还原 fileChanges — 方案 A

#### ✅ 安全 / 性能 / 并发 / 稳定性 / 可观测性
历史路径还原字段，无新权限/无新输入 sink。AC-9.1~9.3 已覆盖。性能（历史还原一次性，无热路径）。可观测性（历史路径无敏感操作）。

#### ⚠️ 数据一致性（pi 历史数据结构不确定）

**事务边界**: 无跨步骤事务（历史消息还原）。
**并发场景**: 无（重开 session 时一次性还原）。
**迁移方案**: **关键不确定**——convertPiHistory 能否还原 fileChanges 依赖 **pi 历史数据是否存原始 fileChanges**（③issues 已标「待⑤验证」）。[tracing 源码实证] `PiHistoryMessage`（pi-protocol.ts:321-326）+ `PiHistoryToolCallPart`（L344-349）**无 fileChanges 字段**——实时路径的 fileChanges 来自 event-adapter 工具事件解析 + git 对账，pi 持久化的 JSONL 历史里根本没有等价信息。方案 A 大概率无法落地，⑤验证后回填「从 toolCall arguments 重建」。
**回滚策略**: AC-9.3 graceful 降级（pi 无数据时历史块空，不 crash）——极可能是常态而非边界。
**缓解**: ⑤骨架验证 pi 历史数据结构 → 若可还原则按方案 A；若不可还原则回填 #9 调整为「从消息体重建」（D 类决策待⑤）。列入需⑤骨架验证。

#### ⚠️ 兼容性（历史/实时数据源不一致）

**[tracing D-7]** 实时路径 fileChanges 经 `reconcileFileChanges`（git 对账真值）+ `mergeWithIncremental` 校正，**数据源是 git status**；历史路径（convertPiHistory 重建）**数据源是工具参数（无 git 对账）**。同一 Message.fileChanges 在「实时 session」与「重开 session 历史还原」可能给出不同 status（尤其 bash 改的文件，实时靠 git 对账补，历史完全捕不到）。
**API 变更**: 无（补字段 additive）。
**数据兼容**: 字段 additive，但**语义层历史/实时不对齐**。
**客户端影响**: ChangeSetCard 重开 session 后历史块标注可能与实时态不一致。
**灰度/回滚**: N/A。
**缓解**: 残余风险登记（历史/实时数据源不一致，见残余风险表）；⑤骨架 pi 数据探查后评估重建策略能否对齐实时语义。

### Issue #10: TreeNode → FileNode 统一迁移 — 方案 A

#### ✅ 安全 / 数据 / 性能 / 并发 / 可观测性
纯类型迁移（删本地定义 + 改 import）。无运行时行为变更。③ AC-10.1~10.3 已覆盖。

#### ⚠️ 兼容性（FileNode 字段集 ⊊ 现有 TreeNode — 渲染字段语义断裂）

**[tracing K-8 源码实证]** 现有 TreeNode（FileView.vue:63-74 / FileTreeRow.vue:58-68，两处定义相同）字段为 `key/name/type/children/change?/addLines?/delLines?/fileCount`，其中 **`change`(git status)、`addLines`/`delLines`(行数)、`fileCount`(目录计数) 是渲染必需字段**——FileTreeRow.vue 模板直接读 `node.change`(L45,108,118) / `node.addLines`(L40) / `node.delLines`(L42) / `node.fileCount`(L17)。而 shared FileNode（架构 §4，D-012 不含 gitStatus）**不含这些字段**。AC-10.2「迁移后渲染等价」**无法仅靠 import 替换达成**——迁到 FileNode 后这些字段必丢（编译失败或运行时丢角标/行数/计数）。
**API 变更**: 删除 2 处本地 TreeNode 定义，统一 import shared FileNode。**ChangeSetCard 用 FileChange 不在迁移范围**（③deep-review F1 实证）。
**数据兼容**: 无（类型迁移）。
**客户端影响**: #10→#4 依赖序下，#10 单独交付会产生 FileView 渲染断裂中间态（FileNode 无 change/addLines/fileCount）。
**灰度/回滚**: 单机无灰度；回滚 = 恢复本地定义（机械可逆）。
**缓解**: (1) #10 只负责 FileNode **结构**统一，change/addLines/fileCount 的**渲染字段去向须由 #3/#4 定义**（GitStatusOverlay join 或本地派生 VM）——AC-10.2「渲染等价」前置依赖 #3/#4；(2) AC-10.3 显式声明 ChangeSetCard 保持不变；(3) 回灌表补⑤骨架验证「FileNode 迁移后 FileTreeRow 渲染字段（change/addLines/fileCount）去向」（tsc 不足以覆盖运行时丢字段，需⑤骨架显式验证）。

### Issue #14: file 写协议骨架（NotImplemented）— 方案 A

#### ✅ 安全 / 数据 / 性能 / 并发 / 稳定性 / 可观测性
纯骨架（类型 + 签名就位，抛 NotImplemented）。无真实 fs 写、无新权限、无运行时价值（调用返回「待 G4 实现」）。AC-14.1~14.4 已覆盖。骨架不引入副作用（不执行真实操作）。

#### ⚠️ 兼容性（骨架响应契约 — 下游 G4 实现依赖）

**API 变更**: protocol.ts 加 file.write.create / rename / delete 类型；FileService 加方法签名抛 NotImplemented。**additive**（新消息类型，不破坏现有）。
**数据兼容**: 无（类型定义）。
**客户端影响**: 前端若调 file.write.* 收到 NotImplemented 响应（AC-14.4 结构化「待实现」，非 500）。
**灰度/回滚**: N/A（骨架无运行价值）。
**缓解**: **⑤骨架约束**：file.write.* 的 NotImplemented 响应是 **G4 实现的契约锚点**——G4 填实现时不得改契约（类型 + 签名固定）。列为骨架约束（保护契约稳定性）。

### Issue #16: 显示忽略项开关 + 灰斜体 — 方案 A

#### ✅ 安全 / 并发 / 兼容性 / 可观测性
FileNode 加可选字段 ignored + FileService 双模式编排 + 前端开关。AC-16.1~16.5 已覆盖。兼容性（可选字段 additive，showIgnored 默认 false 不破坏现有）。并发（单用户开关，无竞争）。

#### ⚠️ 数据一致性（matchPath 对 .gitignore negate/嵌套的判定一致性）

**[tracing D-4]** showIgnored=true 双模式返回的 `ignored=true` 标志依赖 matchPath 纯函数对每条路径的判定正确性。.gitignore 支持 negate（`!foo` 取消忽略）+ 嵌套 .gitignore（子目录自己的 .gitignore 优先级），matchPath 若未正确处理这些规则，部分节点 ignored 标志可能错标（应 ignored=false 的标 true，或反之）。AC-16.5（matchPath 无 node:fs）只验纯函数约束，未验双模式标志一致性。
**事务边界**: 无（纯函数判定）。
**并发场景**: 无。
**迁移方案**: N/A。
**回滚策略**: ignored 标志错标仅影响显示（灰斜体错位），不影响数据完整性。
**缓解**: ⑤骨架补 matchPath 的 negate（`!foo`）/嵌套 .gitignore 用例（验证 ignored 标志在复杂规则下正确）。列为骨架约束。

#### ⚠️ 性能（showIgnored=true 全量返回 node_modules）

**预期负载**: showIgnored=false（默认）= 过滤掉 node_modules/dist/.git，返回量小。**showIgnored=true = 保留被 .gitignore 匹配的节点**，node_modules（数千项）会全量返回 → 同 #2 性能（大目录 readdir，[tracing D-8] 与 #2 大目录截断本质同类，⑤骨架合并验证）。
**关键路径延迟**: showIgnored=true 时 file.tree 首加载可能返回数千 FileNode（node_modules 全量）→ WS 传输 + 前端渲染压力。
**扩展性瓶颈**: showIgnored=true 解除过滤保护，大项目性能衰减显著。
**优化方案**: (1) showIgnored 默认 false（AC-16.1，用户主动开启才承受性能代价）；(2) 开关切换时给 loading 提示（见稳定性）；(3) **⑤骨架标记**：showIgnored=true 下是否需分页/截断（同 #2 大目录）—— 列入需⑤骨架验证。
**残余风险**: 用户开启 showIgnored 在大项目卡顿——接受理由（用户主动选择查看忽略项，可随时关闭）+ 监控（⑤骨架验证）。

#### ⚠️ 稳定性（showIgnored 开关切换过渡态）

**[tracing D-5]** showIgnored 开关切换（AC-16.4）触发 file.tree 全量重拉（showIgnored 参数变更 → runtime 双模式重算）。大目录（node_modules 全量）重拉期间，前端看到的是 loading 还是 stale 树？AC-16.4 只说「树实时重渲染」，未定义切换中的过渡态。
**故障场景**: 开关切换中 WS 请求在途，用户看到旧树或空白。
**降级方案**: 切换期间保留 stale 树（不立即清空）+ loading 指示，响应回来后替换。
**熔断/限流**: N/A。
**重试策略**: 切换失败回退到原开关态。
**缓解**: ⑤骨架约束 showIgnored 切换过渡态（stale 树保留 + loading 提示）。列为骨架约束。

## 缓解项回灌登记（Mitigation Rollback）

> 每条缓解不能只留在本文档——必须落地为下游可执行项。
> **验收方式四选一**：代码测试 / 骨架约束 / 性能混沌 / 运维项。

| 缓解项 | 来源 Issue# | 维度 | 回灌去向 | 落地为 | 验收方式 | 状态 |
|--------|------------|------|---------|--------|---------|------|
| isUnderOrEqual 词法安全边界单测（`..` 穿越/末尾斜杠/相对路径） | #1 | 安全 | ⑤test-matrix | NFR-AC-S1（归属 #1，断言：恶意路径被 isUnderOrEqual 词法判 false） | 代码测试 | 待落 |
| isUnderOrEqual symlink 词法绕过防护（是否补 realpath 解析） | #1/#2/#7 | 安全 | ⑤骨架验证 | 架构裁决：FileService 越界校验前是否补 realpathSync（与 extension-service 对齐） | 骨架约束 | 待落 |
| path-guard import 迁移 grep 验收 | #1 | 兼容性 | ⑤骨架 | AC-1.2 已登记（grep path-utils 无输出）+ tsc 编译 | 骨架约束 | 待落 |
| FileService 越界校验统一守门（file.tree/expand 也校验） | #2 | 安全 | ⑤test-matrix | NFR-AC-S2（归属 #2，断言：file.tree.expand(sessionId,"/etc") 返回 out_of_cwd error） | 代码测试 | 待落 |
| FileService 关键操作结构化日志（sessionId/path/reason） | #2 | 可观测 | ⑤骨架 | FileService 关键路径日志（tsc 验证存在） | 骨架约束 | 待落 |
| fs-executor 超时机制（Promise.race/AbortController，对齐 AC-2.5） | #2 | 稳定性 | ⑤骨架 | fs-executor listDir/readFile 超时（tsc 验证，git-executor 超时范式不可复用） | 骨架约束 | 待落 |
| fs-executor listDir symlink 目录标记/拒绝（防循环展开） | #2 | 稳定性 | ⑤骨架 | listDir 对 symlink 目录标记或拒绝（联动 symlink 防护裁决） | 骨架约束 | 待落 |
| 大目录 listDir 截断 + 并行化（>5000 项；1+M 次 listDir 并行） | #2 | 性能 | ⑤骨架验证 | 标记需⑤验证大项目实测 + 并行化 | 骨架约束 | 待落 |
| git-executor 经 port 调用 + 参数数组防注入（execFileSync 非 exec 拼接） | #5 | 安全 | ⑤test-matrix | NFR-AC-S3（归属 #5，断言：getFileDiff 经 executor.exec() 调用 + path 含 `;rm` 不触发注入 + grep getFileDiff 函数体无 execFile/execSync 直接调用） | 代码测试 | 待落 |
| git.diff path 越界校验（新增非复用，仿 resolveFilePaths） | #5 | 安全 | ⑤test-matrix | NFR-AC-S5（归属 #5，断言：git.diff(sessionId,"/etc/passwd") 返回 path_not_allowed 不触达 git CLI） | 代码测试 | 待落 |
| git-executor 失败结构化日志（exitCode/stderr） | #5 | 可观测 | ⑤骨架 | git-executor 失败日志（tsc 验证） | 骨架约束 | 待落 |
| git-info.ts execSync 收编进 IGitExecutor port（grep 门禁口径） | #5 | 兼容性 | ⑤骨架 | 明确 grep 门禁范围；若全 runtime，git-info.ts 收编 port（或显式豁免+安全论证） | 骨架约束 | 待落 |
| DetailPane 禁 v-html 渲染文件内容（防 XSS，复用 vue/no-v-html lint） | #6 | 安全 | ⑤test-matrix | NFR-AC-S4（归属 #6，断言：含 `<script>` 的文件内容被转义不执行）+ grep 禁 v-html | 代码测试 | 待落 |
| DetailPane 高亮复用 shiki 单例（禁止引第二套高亮库） | #6 | 兼容性 | ⑤骨架 | 高亮库统一约束（shiki 已 XSS 安全验证，见 MarkdownRenderer） | 骨架约束 | 待落 |
| DetailPane 大文件虚拟滚动（截断后仍数千行） | #6 | 性能 | ⑤骨架验证 | 标记需⑤验证是否需虚拟滚动（若引库触发⑤兼容性复审） | 骨架约束 | 待落 |
| session.cwd 信任边界（file.read handler 不接受 cwd + sessionService.create 源追溯） | #7 | 安全 | ⑤骨架 | handler 签名不含 cwd + grep 验收 sessionService.create 入参不接前端 cwd | 骨架约束 | 待落 |
| file.read 原 3 目录回归测试（含相对路径/末尾斜杠形态） | #7 | 兼容性 | ⑤test-matrix | NFR-AC-C1（归属 #7，断言：~/.agents/skills 下文件 file.read 成功 + 相对路径/末尾斜杠形态不变） | 代码测试 | 待落 |
| FileService.readFile 审计日志（sessionId/path/timestamp） | #7 | 可观测 | ⑤骨架 | 审计日志存在性（tsc 验证）+ 日志轮转约束（防磁盘撑爆） | 骨架约束 | 待落 |
| 过滤框 debounce（~150ms） | #4 | 性能 | ⑤骨架 | 过滤输入 debounce（tsc/代码审查验证） | 骨架约束 | 待落 |
| 深层嵌套递归渲染压测（20 层 × N 节点 + 15 层展开+过滤叠加） | #3/#4 | 性能 | ⑥独立 perf Wave | perf 类验收（20 层渲染不卡顿/不栈溢出 + 过滤叠加场景） | 性能混沌 | 待落 |
| rehydrate 路径存在性校验（缺失路径 graceful 跳过） | #3 | 数据 | ⑤test-matrix | NFR-AC-D1（归属 #3，断言：rehydrate 时已删目录路径不报错） | 代码测试 | 待落 |
| rehydrate 跳过路径 debug 日志（跳过数 + 路径摘要） | #3 | 可观测 | ⑤骨架 | rehydrate 降级日志（tsc/审查验证） | 骨架约束 | 待落 |
| ready 帧跨 store 失效时序（AC-3.11，composable 层 watch + invalidate） | #3 | 并发 | ⑤骨架验证 | 标记需⑤验证 composable 层 watch 时序 + 路径定位（架构约束合规） | 骨架约束 | 待落 |
| 异步竞态 sessionId 校验（AC-3.7/3.8/3.9/3.10） | #3 | 并发 | ⑤test-matrix | ③ AC 已登记（stale 丢弃/幂等去重/overlay 时序/error 重试 AC-3.9） | 代码测试 | 待落 |
| 前端 store 异步操作 console.debug 日志 | #3 | 可观测 | ⑤骨架 | dev 排查日志（tsc/审查验证） | 骨架约束 | 待落 |
| #9 pi 历史数据结构验证（PiHistoryMessage 无 fileChanges，方案A 大概率不可行） | #9 | 数据 | ⑤骨架验证 | 标记需⑤验证 pi 是否存 fileChanges（源码已证无，⑤确认后回填重建策略） | 骨架约束 | 待落 |
| #10 FileNode 迁移后 FileTreeRow 渲染字段去向（change/addLines/fileCount） | #10 | 兼容性 | ⑤骨架 | 验证 change/addLines/fileCount 由 #3 overlay/#4 派生承载（tsc 不足以覆盖运行时丢字段） | 骨架约束 | 待落 |
| ChangeSetCard FileChange 隔离验证（AC-10.3） | #10 | 兼容性 | ⑤骨架 | tsc 验证 ChangeSetCard 不受 FileNode 迁移影响 | 骨架约束 | 待落 |
| file.write.* NotImplemented 契约锚点（G4 不改契约 + 响应形状定 ServerMessageType） | #14 | 兼容性 | ⑤骨架 | 类型+签名固定（G4 实现只填实现体）+ AC-14.4 响应形状显化 | 骨架约束 | 待落 |
| showIgnored=true 大项目分页/截断（与 #2 大目录合并验证） | #16 | 性能 | ⑤骨架验证 | 标记需⑤验证 showIgnored 全量性能（与 #2 同类合并） | 骨架约束 | 待落 |
| matchPath negate/嵌套 .gitignore 判定一致性（ignored 标志正确性） | #16 | 数据 | ⑤骨架 | 补 negate（`!foo`）/嵌套 .gitignore 用例（ignored 标志不错标） | 骨架约束 | 待落 |
| showIgnored 开关切换过渡态（stale 树保留 + loading 提示） | #16 | 稳定性 | ⑤骨架 | 切换中保留 stale 树 + loading（AC-16.4 过渡态显化） | 骨架约束 | 待落 |

> **回灌去向汇总**：⑤test-matrix（代码测试，7 条 NFR-AC：S1/S2/S3/S4/S5/C1/D1 + 1 条 AC 复用）/ ⑤骨架（骨架约束，含⑤骨架验证）/ ⑥独立 perf Wave（性能混沌，1 条）。**无 ③ 新 issue**（本主题 NFR 缓解均为已有 issue 的验收补强或骨架约束；K-9 已回灌 ③issues 修正 AC-3.11 措辞，非新 issue）。
> **③ 指针 PHANTOM 核对**：本表无「回灌去向=③issue」行，PHANTOM 检查 N/A（Step2 重建器确认：22→32 条缓解全去⑤/⑥，无 ③ 指针）。
> **[BACKFED K-9]** AC-3.11 跨 store 机制措辞已回灌 ③issues（修正为 composable 层编排）+ ②architecture §7/§10 D-017。本表「ready 帧跨 store 失效时序」缓解的去向为⑤骨架验证（composable 层实现位置）。

## 残余风险登记

| 风险 | 影响 | 接受理由 | 监控方式 |
|------|------|---------|---------|
| 平台特定路径行为（macOS 大小写不敏感） | isUnderOrEqual 在跨平台可能行为差异 | 本应用 macOS 优先（darwin 24.6），Linux/Win 行为⑤骨架验证 | ⑤骨架跨平台单测 |
| cwd 内 symlink 指向 cwd 外可读（若⑤裁决不补 realpath） | symlink 词法绕过越界校验 | 恶意 symlink 需先被放进 cwd（用户对自己的 cwd 内容负责） | ⑤骨架裁决记录（realpath 补/不补） |
| 用户主动展开极深目录卡顿 | 20+ 层渲染卡顿/栈深 | 懒加载下需用户主动逐层展开，非首加载；D-009 已否决全量虚拟滚动 | ⑥独立 perf Wave 压测 |
| showIgnored=true 大项目卡顿 | node_modules 全量返回卡顿 | 用户主动开启，可随时关闭；默认 false | ⑤骨架实测 |
| session.cwd 指向系统目录时 file.read 可读子树 | 可读非预期文件 | cwd 是用户主动选择的工作目录，用户负责 | 无（用户行为） |
| 截断后大文件看不到完整内容 | 预览不全 | 预览非编辑，截断提示已给 | 无 |
| #9 历史/实时数据源不一致 | 重开 session 历史改动标注与实时态可能不一致 | 历史数据源受限（pi 不存 git 对账结果），⑤骨架确认重建策略后评估 | ⑤骨架 pi 数据探查 |

## 需⑤骨架验证的副作用（标记登记）

> ④只标记，不产 prototype（stub 进⑤骨架，结论回写）。

| 副作用 | 验证什么 | 预期结论方向 | stub 落点 |
|--------|---------|-------------|----------|
| isUnderOrEqual symlink 词法绕过防护 | FileService 越界校验前是否补 realpathSync（与 extension-service 对齐） | 应补（防 cwd 内 symlink 指向外）；若不补须残余风险登记 | ⑤骨架 realpath 裁决 stub |
| isUnderOrEqual 跨平台行为 | macOS 大小写不敏感 vs Linux 敏感是否影响越界判断 | 应平台无关（路径规范化后比较） | ⑤骨架跨平台单测 stub |
| fs-executor 超时机制 | node:fs/promises 无内建超时，git-executor 范式不可复用 | 应补 Promise.race/AbortController 对齐 AC-2.5 | ⑤骨架 fs 超时 stub |
| fs-executor symlink 目录防护 | listDir 是否标记/拒绝 symlink 目录（防循环展开） | 应标记或拒绝 | ⑤骨架 listDir symlink stub |
| 大目录 listDir 截断 + 并行化 | 万项目录 readdir 实测 + 1+M 次并行化 | 可能需截断（>5000 项）+ 并行 | ⑤骨架截断/并行 stub |
| ready 帧跨 store 失效时序（AC-3.11） | useFileTree composable watch chat store ready 事件 + 派发 fileTree invalidate 的时序 + 路径定位 | 应正确失效相关节点（架构约束合规） | ⑤骨架 composable watch + invalidate stub |
| DetailPane 大文件虚拟滚动 | 截断后数千行渲染性能（无现成虚拟滚动库，引库需兼容性复审） | 可能需虚拟滚动 | ⑤骨架虚拟滚动评估 |
| #9 pi 历史数据 | pi 历史是否存 fileChanges（源码已证 PiHistoryMessage 无此字段） | 方案 A 大概率不可行，回填「从 toolCall arguments 重建」 | ⑤骨架 pi 数据探查 |
| showIgnored 全量性能 | node_modules 全量返回开销（与 #2 大目录同类） | 可能需分页 | ⑤骨架 showIgnored 性能 stub |
| #10 FileNode 渲染字段去向 | change/addLines/fileCount 由 #3 overlay 还是 #4 派生承载 | 应由 #3/#4 定义，#10 只统结构 | ⑤骨架字段去向验证 |

## P3 延后项 NFR 待评估（本轮不分析）

| Issue | 延后理由 | NFR 待评估点 |
|-------|---------|-------------|
| #11 文件操作实现 | 实现延后 P3（依赖 G4） | fs 写的原子性/并发/权限/审计 → 待 G4 启动时评估 |
| #12 message-stream 联动 | 架构标可选，待用户确认 | 联动的时序/性能 → 待确认是否实现 |
| #13 SideDrawer tab registry | 当前 4 tab 无需 | registry 的扩展性/兼容性 → 待 tab 膨胀触发 |

---

## Step 6b 反哺记录

本轮 ④NFR 分析**触发 1 处上游反哺（K-9）**：

- **[BACKFED K-9 → ③issues + ②architecture]**：AC-3.11「跨 store 失效触发」机制措辞违反现有架构硬约束（`stores/sidebar.ts:5` + `stores/chat.ts:3` 明文「stores 间禁止互相 import」；现有跨 store 编排在 composables 层 useSidebar.ts:101-106；file_changes 事件入口 chat-chunk-processor.ts:347）。正向追踪 fresh subagent 源码实证发现。
  - **③issues.md AC-3.11 措辞修正**：「fileTree store subscribe chat store」→「composable 层（useFileTree）编排跨 store 失效触发（watch chat store file_changes + 派发 fileTree store 的 invalidate 接口）」。③frontmatter `backfed_from: [nfr]` 已标。
  - **②architecture §7/§10 D-017 同步**：`stores/fileTree.ts` 改为暴露 `invalidate` 接口（不自行监听）；`composables/useFileTree.ts` 增加「编排跨 store 失效触发」职责。②frontmatter `backfed_from: [issues, nfr]` 已标。
  - **非 D-不可逆**（K-9 是措辞/位置修正，非决策推翻），无需 ask_user。

其余副作用均可在⑤/⑥消化（NFR-AC 进⑤test-matrix、骨架约束进⑤骨架、perf 进⑥Wave）。D-001~D-020 全部 confirmed 决策无下游证据推翻。
