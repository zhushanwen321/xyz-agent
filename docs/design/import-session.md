# 导入 pi 会话 · 技术设计（方案 A 居中对话框）

> **一句话结论**：把外部 pi session（默认 `~/.pi/agent/sessions/`）经「复制文件 + 写 project sidecar」纳入太极管理——runtime 新增 `session.importCandidates` / `session.import` 两个 RPC，renderer 新增侧边栏「导入会话」入口与居中对话框（UI 形态已由 demo 定稿，见 `docs/page-design/import-session-demo.html` 方案 A）；导入后的会话被现有扫描/归组/恢复链路自动接住，可继续对话。

- **层级声明**：本文是功能级技术方案设计。当前层 = 导入功能的接口与机制设计；下一层 = 具体实现任务（RPC 契约落地、Vue 组件、测试用例，见 §5）。不跨层到函数级实现细节。
- **层敏感判定**：涉及运行时行为、数据流、错误处理 → 准则 5（物理数据流图）/ 6（错误配恢复指引）/ 7（运行时断言附探针）全部 P0 适用。

## §1 背景目标

**SCQA**：

- **S（情境）**：太极（Electron + Vue3 + Node runtime 的 AI Agent 桌面工作台）用 pi 做引擎，所有会话以 JSONL 文件持久化。用户同时也直接用 pi CLI 干活——CLI 的 session 存在 `~/.pi/agent/sessions/`（本机实测 4,615 个文件，按 `<--编码后的工作目录-->/<ISO时间戳>_<uuid>.jsonl` 组织）。
- **C（冲突）**：太极按 ADR-0009 数据隔离约定，session 目录是独立的 `~/.xyz-agent/pi/sessions/`。pi CLI 产生的 session 物理上不在太极扫描范围内——用户在 CLI 里聊了一半的任务，打开太极完全看不到。
- **Q（问题）**：怎么让用户把磁盘上已有的 pi session 纳入某个 project 的会话列表，可见、可继续对话？
- **A（答案）**：侧边栏新增「导入会话」入口，弹居中对话框（方案 A，demo 已定稿）浏览/搜索外部 session；导入动作 = 复制文件进太极 session 目录 + 写 `.project.json` sidecar；此后现有链路（扫描 → 按 project 归组 → 点击恢复续聊）零改动接住。

**系统是什么**（给不熟悉太极的读者）：太极渲染进程（Vue 3）经 WebSocket 调 runtime（Node 子进程）的 RPC；runtime 管理 pi 子进程的生命周期并代理对话。一个「会话（session）」= 一个 JSONL 文件，首行是 header（`{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"..."}`），后续每行一条 entry（消息/工具调用/压缩记录等）。太极侧边栏按 project 分组展示会话；project 归属不是 JSONL 内容，而是旁边的 `<sessionFile>.project.json` sidecar 文件（写 `projectId`）。

**设计目标**（从使用者体验倒推）：

1. **能找到**：用户能按名称、完整/短 Session ID（uuid 前 6 位，即 pi TUI 里的 `72cd03` 式短标识）、或 `.jsonl` 绝对路径，在外部 session 里定位到目标；也能按目录（对应原工作目录）浏览。
2. **能导入**：选中后选目标 project（默认当前激活 project，可改），一键导入；导入完成侧边栏该 project 分组立即出现此会话。
3. **能续聊**：点开导入的会话能看到完整历史，直接发消息能继续对话（真 pi attach，非只读）。**降级类（显式声明）**：原工作目录（header.cwd）已不存在的会话（已删目录 / worktree 清理 / 他机拷贝树），按 runtime 既有 F3 兜底在 `~` 续聊，UI 必须标注该事实（详见 §2.4-3 与 MF-2 修复）——「能续聊」对这类会话以「在 ~ 续聊且用户知情」为成立标准。
4. **不重复、不出错时知道怎么办**：已导入的 session 在候选列表显示「已导入」不可重复导入；失败场景（文件损坏、目录不可读等）给出可操作的恢复指引。

**In-scope**：方案 A 模态的完整实现（入口按钮 + ⌘I + 对话框 + 两个 RPC + 复制导入 + 去重）；默认扫描根 = `~/.pi/agent/sessions/`，支持「选择其他目录」（系统目录选择对话框）。

**Out-of-scope**（显式不做，防 scope creep）：

- 自动发现/持续同步外部 session（导入是一次性手动动作；用户每次在 CLI 干完活想纳入时手动导）
- 批量多选导入（一次导一个；列表多选留作后续增量）
- 方案 B 命令面板（⌘I 直达面板）与方案 C 预览视图——demo 阶段已裁掉，后续可叠加
- 移动（搬走源文件）语义——本设计是复制，源目录不受影响

## §2 现状与问题分析

**结论：外部 pi session 与太极是两个物理隔离的存储，太极没有任何既有通路读到它们；而「纳入管理」所需的全部下游能力（扫描、归组、恢复续聊）都已存在，缺口只在「把文件放进太极目录 + 写归属」这一步。**

### 2.1 使用者视角的现状（真实例子）

用户今天在 pi CLI 里做了一次代码调研：

```bash
$ cd ~/Stock && pi
> 帮我把日线数据从 sqlite 迁到 clickhouse...
# ……聊了 214 轮，退出
```

磁盘上留下 `~/.pi/agent/sessions/--Users-zhushanwen-Stock--/2026-08-27T09-11-xx_xxx.jsonl`（8.1 MB）。

用户打开太极，想在 Stock project 里继续这个任务：侧边栏 Stock 分组下只有太极里开的会话，这次 CLI 会话**不存在**。太极也没有任何入口能找到它——只能去终端 `pi --resume` 继续，太极的 project 归组、多面板工作台对这次会话全部不可用。

### 2.2 物理数据流（现状）

```
[pi CLI] ~/.pi/agent/sessions/<--encoded-cwd-->/<ts>_<uuid>.jsonl   ← 4,615 个文件，太极不扫这里
                ✗ 无任何通路

[太极 runtime] getSessionsDir() = ~/.xyz-agent/pi/sessions/         ← ADR-0009 数据隔离
    scanPiSessions()（1s TTL 目录缓存）→ scanSessionMeta(每文件: header+name尾读+outcome, mtime+size 缓存)
    → ScannedSessionMeta { id, filePath, cwd, timestamp, name, outcome, lastModified, size, projectId? }
    → scannedToSummary → session.list RPC → renderer SessionStore
    → SessionList 按 activeProject 过滤（projectId = .project.json sidecar 读回）
    用户点击 → session.restore RPC → sessionService.restoreSession(id)
    → pi switchSession(filePath) 附着（I1 不变量：登记路径 ≡ pi 写路径，attach 断言比对）
    → 可继续对话
```

关键代码锚点（实现依据）：

| 事实 | 位置 |
|---|---|
| 太极 session 目录独立 | `packages/runtime/src/infra/pi/pi-paths.ts:105`（`getSessionsDir()` = `~/.xyz-agent/pi/sessions`） |
| 目录扫描已参数化（未导出） | `session-file-utils.ts:1047` `scanPiSessionsFromDisk(sessionsDir)`：顶层 `.jsonl` + 一层子目录，按内容（首行 header）识别，不依赖目录名 |
| 每文件元信息提取（含缓存） | `session-file-utils.ts` `scanSessionMeta`（W3 三读合一，缓存键 filePath+mtime+size） |
| project 归属 sidecar | `session-file-utils.ts:325` `persistProjectBinding(filePath, projectId)`（写 `<file>.project.json`，含双缓存失效；空 projectId = 删 sidecar） |
| 归组生效链路 | `transport/session-message-handler.ts:459` `session.setProject` → sidecar + `broadcastSessionList()`（现有 RPC，手动归类已在用） |
| 恢复续聊 | `services/session/session-lifecycle.ts` `restoreSession(sessionId)` → `switchSession(sessionPath)`；attach 断言 `infra/pi/session-attach-assert.ts`（期望文件须为磁盘真实文件） |
| pi 目录编码规则 | pi 实装 `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:240-246`：`--${cwd.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--` |
| RPC 添加模式 | renderer `api/domains/session.ts`（sendCommand）↔ runtime `transport/session-message-handler.ts`（case 分发 → service 方法 → reply + broadcast） |

### 2.3 根因分析

- **症状**：太极里看不到 pi CLI 的会话。
- **根因**：不是「缺展示」，是**存储物理隔离**（ADR-0009 有意为之，不能靠让 runtime 去扫 `~/.pi` 解决——那会破坏隔离边界）。session 归属（projectId）是太极自有概念，CLI 侧文件没有 sidecar。
- **缺口收窄**：把外部文件复制进 `getSessionsDir()` 的正确子目录 + 写 `.project.json`，下游（扫描→归组→恢复→续聊）**全部复用现有代码**，一行不用改。导入的本体就是这两个动作，外加找到目标的 UI。

### 2.4 兼容性风险（导入的文件能不能被完整消费）

pi CLI 与太极跑的是同一个 pi 引擎，JSONL 格式同源（version 3 header）。差异点：

1. **custom entries**：CLI 侧装了太极没有的 extension（如旧 `unified-hooks`），会写入 `{"type":"custom","customType":"unified-hooks:loaded",...}` 等 entry。太极的 entry→UI reducer 已做全类型支持（不丢弃任何 pi entry 类型，live ≡ reload 等价性由 `apply-entry-equivalence` 测试守卫），未知 custom 类型按现有约定跳过渲染不崩。**这是运行时断言，需真实文件探针**（见 §3.4 P-custom）。
2. **模型配置**：CLI 侧用的 provider/model 在太极 `models.json` 里可能未配置。恢复后发消息时模型解析失败应有可切换出口（太极本来就有模型切换 UI）。**运行时断言，探针验证**（P-model）。
3. **原工作目录死路径（最强续聊攻击面，审查 MF-2 补入）**：pi 0.84.1 的 `switchSession` 内部 `assertSessionCwdExists` 对不存在的 header.cwd **硬拒绝**（`MissingSessionCwdError`），且现有 RPC 不透传 cwdOverride；runtime 既有 F3 兑底管线（`session-lifecycle.ts:459-461`、`applyHeaderCwdFallback`）会把 header.cwd **静默改写为 homedir() 落盘再附着**。触发场景全是真实高频：已删项目目录、worktree 清理（codebase 注释明示常见）、外接盘、「选择其他目录」指向他机拷贝树（in-scope 功能，cwd 几乎必然不存在）。后果：导入成功、点击续聊表面正常，但 pi 实际在 `~` 执行工具，仅 console.warn 无用户可见提示——语义漂移。本设计必须在候选列表就暴露 `cwdExists=false` 并标注，而非依赖静默兑底。

## §3 解决方案

**结论：导入本体 = 「复制文件 + 写 project sidecar」两个动作，外加两个新 RPC 和一个对话框；关键取舍是复制而非引用（保隔离）、搜索在 runtime 而非 renderer（保数据量扩展性）。**

### 3.1 终态（使用者视角）

**成功路径**（交互样例，UI 细节以 demo 方案 A 为准）：

```
[用户] 点击侧边栏「新建任务」下方的「导入会话」（或按 ⌘I）
[系统] 弹出居中对话框：顶部搜索框（placeholder：搜索名称或 Session ID（支持 01a044 式短 ID），
       或粘贴 .jsonl 绝对路径）；目录 chip「全部目录 ▾」+「选择其他目录」按钮；
       列表按日期分组（今天/昨天/本周/更早），每条目两行：
         行1 = 会话名称（session_info.name，无标题回退目录名）
         行2 = 短 ID（mono）· 原工作目录 · 大小
         （2026-09-02 一致性审查裁决：删「N 条消息」——scanSessionMeta 无此字段，
          补字段需全文件读与 P-scan-perf 性能约束冲突；消息数非导入决策必需）
       底部：导入到 [project 下拉，默认当前激活]  [取消] [导入]
[用户] 在搜索框输入 "01a020"（uuid 前 6 位）
[系统] 列表实时过滤出 1 条：「日线数据管道迁移到 clickhouse」01a020 · ~/Stock · 8.1 MB
[用户] 点选该条目，project 下拉确认是「Stock」，点「导入」
[系统] 按钮短暂 loading → 对话框关闭 → toast「已导入「日线数据管道迁移到 clickhouse」到 Stock · 可继续对话」
       → 侧边栏 Stock 分组顶部出现该会话（带「导入」fresh 徽标，数秒后淡出）
[用户] 点击该会话
[系统] 主面板加载完整 214 轮历史；输入框发消息「继续，把分区键那步做完」
[系统] pi 附着复制后的文件继续对话，新消息写入太极 session 目录
```

**终态物理数据流**（从源磁盘到用户眼前，标注每步归属）：

```
[源磁盘] ~/.pi/agent/sessions/<--cwd-->/<ts>_<uuid>.jsonl（4,615 文件）
    │ ① session.importCandidates { rootDir?, query, limit }（打开/搜索/切目录时，renderer debounce 250ms）
    ▼
[runtime U1+U2] 扫描外部目录（readdir 一层子目录 + scanSessionMeta 每文件 header/尾读，
    sessionMetaCache 按 filePath+mtime+size 复用；外部根独立 TTL 缓存）
    → 标记 alreadyImported（对比太极 scanPiSessions() 的 id 集合）
    │ ② WS reply：items[] + dirs[]（不传全量，limit 截断）
    ▼
[renderer U5] ImportSessionDialog：搜索框/目录 chip/日期分组列表；用户选中 + 选 project
    │ ③ session.import { sourcePath, projectId }
    ▼
[runtime U2] 进入全局导入互斥（单条 Promise 链，一次一条）→ 互斥区内依次：
    header 字段校验 + 文件名标记校验
    + 去重双检（scanPiSessions({force:true}) id 集合 ∪ existsSync(targetPath)，
      id 命中→already_imported；仅 target 命中→target_conflict）
    → mkdir(recursive) 目标子目录
    → 异步 copyFile（fs/promises）到同目录临时名 <target>.tmp-import-<ts>.jsonl
    → rename 原子替换到 <sessionsDir>/<encodeCwd(resolve(header.cwd))>/<原文件名>
    → persistProjectBinding(targetPath, projectId) + readback 校验（不符→warning 降级）
    → invalidateScanDirCache() + 广播 session.list
    （临时名被 isScannableSessionFile 的 .tmp-import- 过滤规则挡在扫描外；
     复制失败/中途 crash 不产生 final 名半成品，重试不被去重拦截）
    │ ④ 现有链路零改动接手：scanPiSessions 重扫 → scannedToSummary（projectId 生效）
    ▼
[renderer 侧边栏] 目标 project 分组顶部出现新会话（fresh 徽标）
    │ ⑤ 用户点击 → session.restore（现有 RPC）
    ▼
[runtime] restoreSession → pi switchSession(副本路径) → attach 断言 I1 → 可继续对话
    （此后新消息全部写入太极副本，源文件不再被触碰）
```

**成功路径变体（原目录不存在，MF-2）**：若所选会话的原工作目录已删除（候选条目会带「原目录不存在，续聊将在主目录执行」标注），导入 toast 追加同款预警；打开续聊时 runtime 既有 F3 兜底把 cwd 改写到 `~` 后附着——用户知情，无静默语义漂移（V9 验收）。

**失败路径**（每个错误配恢复指引，详见 §3.3 错误规格；`import_invalid_session` 的 UI 可达路径 = stale 竞态——非 session 文件不进候选（scanner 按首行 header 识别）、路径模式 no-hit 时导入按钮禁用，见 V6 修正）：

```
[用户] 候选列表 stale 后源文件被替换为非 session 内容 → 路径模式粘贴该文件 → 点「导入此文件」
[系统] 路径行显示错误态：不是有效的 pi session 文件（首行缺少合法 session header）：<path>
       👉 确认选择的是 pi 产生的 .jsonl 会话文件；可用「选择其他目录」定位 sessions 目录
```

### 3.2 多方案对比

**对比一：导入机制**

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A1 复制进太极目录**（选定） | 数据自包含，符合 ADR-0009 隔离；scanner/restore/I1 断言零改动；源目录不受影响，CLI 侧历史保留 | 复制 + sidecar 两个动作，都是现成工具（`copyFile` + `persistProjectBinding`） | 磁盘双份占用（单文件 MB 级，可忽略）；源与副本后续各自演化（见 D6 声明） | ✅ |
| A2 原地引用 + scanner 扩扫外部目录 | 破坏数据隔离边界；scanner 要维护双根与优先级；「删除太极条目」语义纠缠（删不删源文件？）；pi CLI 继续写该文件时太极侧 mtime 缓存与归属语义漂移 | scanner 改动 + 大量边界用例 | 数据丢失级语义歧义（误删源文件） | ❌ |
| A3 移动（move） | 源目录被掏空，pi CLI 侧 `--resume` 历史消失，用户没要求搬走 | 与 A1 相同 | 不可逆，误操作无兜底 | ❌ |

被否方案回放：若用 A2，§3.1 的成功路径会在「点击会话」一步翻车——restore 链路的 attach 断言与 scanner 的单根假设都要动，且「Stock 分组删除该会话」会变成「要不要删 `~/.pi` 下的源文件」的伦理题。A1 下删除只删太极自己的副本，源永远安全。

**对比二：搜索/过滤发生在哪**

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **B1 runtime 侧查询**（选定）：`importCandidates { rootDir, query, limit }`，renderer 每次按键 debounce 后发 RPC | 数据量增长（10k+ 文件）不推大 payload 过 WS；alreadyImported 判定贴着扫描缓存，语义单一 | 外部目录扫描需要独立 TTL 缓存（`scanDirCache` 是单条目缓存、dir 作等值校验字段，不能直接复用）；首次全 miss 扫描的耗时与执行模型由 D3 的异步分批控制 | 按键 → RPC 往返延迟（本地 WS <50ms，debounce 250ms 吸收；往返延迟 ≠ 扫描耗时，后者见 D3/P-scan-perf） | ✅ |
| B2 renderer 全量接收后本地过滤 | 一次性 1MB payload（4615 × ~200B）当下可用 | 传输与内存随数据线性涨；导入后 alreadyImported 集合要在前端维护失效 | 数据量增长后卡顿与内存压力 | ❌ |

### 3.3 关键决策（四件套）

**D1：导入 = 原子复制 + 写 project sidecar（选定，r2 修订：tmp+rename 原子化 + 异步执行模型）**
- **采用**：校验源文件（存在 + 首行 header 字段清单合法【header 读取用 `fs/promises` 异步读，不沿用 scanSessionMeta 系 sync 原语——NFS 源的 sync 读会阻塞事件循环（r4-S2）】+ 源文件名不含 `.tmp-migrate-` / `.tmp-import-` 标记【r2-S1：含标记 → `import_marker_filename`，防导入管线自己的过滤器吞掉自己的产物】+ 去重校验见 D4）→ **确保目标子目录存在**（`mkdir(recursive)`，r2-S5：外部 cwd 对应的 encodeCwd 子目录在太极 sessions 下几乎必然不存在，主路径必经）→ **异步** `fs/promises.copyFile` 先写同目录**临时名** `<targetPath>.tmp-import-<ts>.jsonl` → 成功后 `rename` **原子替换**到正式名 `<getSessionsDir()>/<encodeCwd(resolve(header.cwd))>/<原文件名>` → `persistProjectBinding(targetPath, projectId)` → **readback 校验**（`readProjectBinding(targetPath) === projectId`，该函数 :362 模块私有需连带导出（U1）；r2-S2：`persistBindingSidecar` 对写失败是吞错不抛的 best-effort 语义，不校验会假成功 + 静默误归组到默认项目。校验不符 → RPC 返回 `warning: 'sidecar_failed'`，renderer 降级 toast——文件已落地不回滚，引导手动归类）→ `invalidateScanDirCache()` + `broadcastSessionList()`。失败路径（copy/rename 抛错）主动 `unlink` 临时名；进程中途 crash 残留的 `.tmp-import-` 由启动清扫覆盖（`cleanupTmpMigrateResidue` 家族扩展同一过滤规则，`isScannableSessionFile` 同步扩展 `.tmp-import-` 前缀过滤——扫描器从机制上看不到任何非 final 名文件）。
- **header 合法性字段清单（MF-1/S6）**：`type === 'session'` 且 `id` 为非空字符串且 `cwd` 为非空字符串；任一不满足 → `import_invalid_session`（缺 cwd 不容忍——`encodeCwd(undefined)` 会 TypeError 且空 cwd 编码为病态目录名）。
- **被否**：直接 `copyFile` 到正式名（审查 MF-1 反例：header 最先落盘 → 半成品被 scanner 收录 → 用户按恢复指引重试反被去重拦下，恢复指引与去重自相矛盾；tmp+rename 后重演：失败 → 临时名被清理/被过滤 → 正式名从未落地 → 重试去重校验通过 → 成功，反例消灭）；原地引用（A2）；移动（A3）；同步 `copyFileSync`（50MB 级文件阻塞 WS 事件循环数百 ms~秒级，殃及多面板其他会话）。
- **证据**：`normalizeSessionFileInPlace` 的 tmp+rename 先例 + `isScannableSessionFile` 的 `.tmp-migrate-` 文件名过滤先例（session-file-utils.ts:1038-1045，同一模式扩展）；`pi-paths.ts:105`（目录隔离）；attach 断言（session-attach-assert.ts）；`persistProjectBinding` 自带缓存失效。
- **效果**：§1 目标 2/3 成立；错误规格表 `import_copy_failed` 的「重试」指引真正可达（与 D4 去重不再互斥）。

**D2：目标子目录按 resolve 后的 header.cwd 用 pi 同款编码生成，文件名保留原名（r2 修订：补 resolvePath 归一步）**
- **采用**：`<sessionsDir>/<encodeCwd(path.resolve(header.cwd))>/<原文件名>`，其中 `encodeCwd` 复用 `pi-paths.ts:122` 既有导出（不重抄公式）。pi 实装的 `getDefaultSessionDirPath`（session-manager.js:242-246）是**先 `resolvePath(cwd)` 再 replace**——漏掉 resolve 会使尾斜杠 cwd 产出 `--Users-x-proj---` 与 pi 自生 `--Users-x-proj--` 分叉，恰违背本决策「不产生分叉视图」的目标。scanner 按内容识别不依赖目录名，但保持结构一致让 pi 原生行为（同 cwd 新会话落同目录）不分叉。
- **被否**：平铺到 sessions 根（顶层 `.jsonl` 虽能被扫到，但破坏「按 cwd 分组」组织约定，后续 `session.deleteByCwd` 等按目录语义的既有能力错位）；直接 replace 不 resolve（尾斜杠/相对形态分叉，审查 S5）。
- **证据**：`scanPiSessionsFromDisk` 顶层+一层子目录双路径（session-file-utils.ts:1047-1098）；`encodeCwd` 存在于 pi-paths.ts:122（r2 核正：:119 为轻微行号偏移）；pi resolvePath 前置步（session-manager.js:242）。
- **效果**：导入体与太极自产 session 在文件系统层面不可区分，§3.1 续聊步骤（pi 写回同文件）自然成立。

**D3：候选列表与搜索走 runtime RPC（B1），外部扫描异步分批 + 独立 TTL 缓存（r2 修订：显式执行模型；2026-09-02 Gate B 实测后二次修订：提取管线换外部侧专用轻量版）**
- **采用**：新增 `session.importCandidates`（契约见 D5）。执行模型（MF-3）：外部目录遍历用 `fs/promises.readdir`，每文件 meta 提取**不复用 `scanSessionMeta`，走外部侧专用轻量提取**（async：stat + header 首行 + name 三级定位）——**分批执行**，每批 N=100 文件后 `await setImmediate` 让出事件循环，4,616 文件首扫被切为数十个短批，WS 消息与流式广播在批间照常处理。**为何不复用 scanSessionMeta（Gate B P-scan-perf 实测回填，2026-09-02）**：scanSessionMeta 六读合一（header/name/outcome/handoff/preset/project sidecar），外部候选仅消费 header+name+stat 三项，其余四读零消费；且 `findLastEntryField` 尾读未命中即 fallback 全量 `readFileSync`——未 rename 的 session 其 session_info 在文件头部，触发整文件读（本机实测 4,616 文件/2.1GB：23.3s 首扫 + maxBlock 1,947ms 双超标，设计原假设「单文件 <1ms」不成立于平均 0.5MB 的真实数据集）。**name 三级定位**：尾块找最后 session_info（覆盖 rename append 尾部）→ 头块找第一个 session_info（覆盖创建期写入）→ 均未命中返回 null（UI 回退目录名显示；两块各 64KB 预算，覆盖绝大多数真实分布）。缓存：外部根扫描结果独立 TTL 缓存（1s，对齐惯例；`scanDirCache` 为单条目缓存、dir 作等值校验字段，故独立存放）；`sessionMetaCache` 按 filePath+mtime+size 天然跨根复用（同文件二次扫描零 IO）。导入成功后失效太极根扫描缓存（`invalidateScanDirCache`——alreadyImported 标记由 listCandidates 每次对太极根扫描重算，翻转由此生效；外部根缓存只含源文件元数据、复制不动源，无需失效。2026-09-02 一致性审查修正因果表述）。扫描深度 = 顶层 + 一层子目录（与太极根同构；更深层静默跳过，UI 目录 chip tooltip 声明此假设）。候选列表同样**不收录文件名含 `.tmp-migrate-` / `.tmp-import-` 标记的文件**（isScannableSessionFile 同一规则；此类文件是迁移残留的概率远高于合法 session，路径模式导入会得到 `import_marker_filename` 明确错误而非 limbo——r2-S1）。
- **被否**：renderer 全量过滤（B2）；每次查询强制全扫（无缓存不可接受）；纯 sync 一把梭（万级阻塞操作殃及多面板其他会话，「渐进返回」降级在 sync 模型下不可实现——审查 MF-3 反例）；worker thread 隔离（进程开销与复杂度，分批让出已够用，减法优先）。
- **证据**：`session-file-utils.ts` 全 sync IO 现状（import 列表 L8）；`scanPiSessions` 缓存分层（:956-1045）；`scanSessionMeta` 单文件成本（header 首读+尾读）；message-broker.ts:92 大 payload 敏感性。
- **效果**：§1 目标 1 成立且数据量增长不退化；P-scan-perf 探针补「事件循环单次连续阻塞 <100ms」指标后可真实验证。

**D4：去重 = sessionId 集合比对（force 读）+ 全局单条导入互斥，导入幂等且并发安全（r4 修订：全局互斥取代键式队列）**
- **采用**：`importCandidates` 用默认 TTL 读打 `alreadyImported` 标记（列表展示允许秒级 stale）。`session.import` 执行流：**进入模块级全局导入互斥**（单条 Promise 链，一次只执行一条导入——低频用户动作，串行化无感知；无 Map、无键选择、无回收问题。**链实现必须异常安全（r4-S1）**：前序失败不得阻断后续——`then(work, work)` 或 gate+finally 释放模式，错误在 work 内部捕获转 error envelope 不泄入链，否则一次 copy_failed 使后续全部导入永久挂起、「重试」指引在机制层失效。**互斥不设超时（r4-S2，显式接受）**：copyFile 不可真取消，超时释放会让旧 copy 的 rename 在后续导入双检之后落地、重开本互斥要消灭的并发窗口；copy 挂起（NFS 源/坏道）接受「导入功能阻塞至 runtime 重启」的权衡——互斥只覆盖 session.import，candidates/聊天/扫描不经互斥不受影响）→ **互斥区内**依次执行：header 字段校验、源文件名标记校验、去重双检（`scanPiSessions({ force: true })` 的 id 集合 ∪ `existsSync(targetPath)`，force 绕过 1s TTL）、mkdir、tmp+rename、sidecar+readback。双检语义分工：force id 集合防「同 id 任意 target」（命中 → `import_already_imported`）；existsSync 防「同 target」（命中但 id 不在集合 → `import_target_conflict`，目标路径已被另一会话占用，r4 新码）。rename-over 降级为防御纵深而非正确性依赖。
- **反例重演**：① 同 id 异名两源（r2 类）→ 全局互斥串行 → #2 双检 force 集合见 #1 → 拒绝；② 同 target 异 id 两源（r3 类，v3 键式队列的镜像漏斗）→ 全局互斥串行 → #2 的 existsSync 见 #1 已落地且 id 不同 → `import_target_conflict`（不再静默覆盖已成功导入）；③ 双击连点 → 同互斥串行 → #2 拒绝。全部闭合。
- **被否**：按文件路径或内容 hash 去重（跨机器路径不同；hash 全文件成本高；sessionId 是 header 权威标识）；默认 TTL 读做导入校验（r1 MF-4：pre-import 快照放行并发双写）；**targetPath 键队列（r2 MF 击穿：同 id 异 target 并行绕过）；sessionId 键队列（r3 MF 击穿：同 target 异 id 并行 → rename-over 静默覆盖先落者，RPC 已报成功 + 重试 limbo）**——键式队列在「id × target」二维并发空间里总有一维漏斗，全局互斥一维不漏。
- **证据**：ScannedSessionMeta.id 来自 header（scanner 按内容识别）；太极按 id 定位 session（`restoreSession(sessionId)`）是既有约定。注：scanner 本身**不做** id 级去重（`.tmp-migrate-` 靠文件名过滤规避同 id 双条目），导入侧 id 校验是新语义、由本设计自担。
- **效果**：§1 目标 4 的「不重复」对全部并发形态闭合（无维度遗漏）；负面行为（同 id 二次导入被拒、绕过 UI 直发 RPC 被拒、同 target 异 id 被明确冲突码拒绝）在 §4 V5 有反向验收。

**D5：RPC 契约（接口先行）**

```ts
// renderer → runtime（ws-client sendCommand 模式，与 session.list 同族）

// 1) 候选列表（打开对话框 / 搜索 / 切目录时调用，debounce 250ms）
'session.importCandidates': {
  payload: { rootDir?: string; query?: string; limit?: number }
  // rootDir 缺省 = 外部 pi 全局 agent 目录下的 sessions（~/.pi/agent/sessions），
  //   动态推导复用/导出 pi-maintenance.ts:151 getPiGlobalAgentDir() 同款逻辑（从 getPiAgentDir()
  //   向上三层推导）——禁止硬编码字面量（pre-commit check_path_whitelist 会拦，S9）
  // query 匹配语义（S7，runtime 与 renderer 共同遵守，防止两端裁量漂移）：
  //   字段集 = name ∪ full sessionId ∪ uuid 前 6 位短 ID ∪ sourcePath ∪ dirLabel，全部
  //   case-insensitive includes；query.trim() 以 '/' 或 '~' 开头时 renderer 切换「路径模式」
  //   （runtime 无需特殊分支——sourcePath 的 includes 匹配天然覆盖）
  reply: {
    total: number                                                  // 过滤前总数
    items: Array<{                                                 // 按 lastModified 降序，截 limit（默认 100）
      sessionId: string; name: string | null; cwd: string;
      sourcePath: string; lastModified: number; size: number;
      dirLabel: string;                                            // 所属子目录名（目录 chip 分组用）
      alreadyImported: boolean;
      cwdExists: boolean;                                          // existsSync(header.cwd)；false 时 UI 条目标注
                                                                   // 「原目录不存在，续聊将在主目录执行」（MF-2）
    }>
    dirs: Array<{ label: string; count: number }>                  // 该根下全部一层子目录（chip 下拉）；
                                                                   // 扫描深度 = 顶层 + 一层子目录（与太极根同构，
                                                                   // 更深层静默跳过，S8——UI tooltip 声明此假设）
  }
}

// 2) 执行导入（点「导入」）
'session.import': {
  payload: { sourcePath: string; projectId: string }
  reply: { sessionId: string; targetPath: string; warning?: 'sidecar_failed' }
  // 成功副作用：复制 + sidecar（readback 不符→warning，见错误规格表）+ invalidateScanDirCache + broadcastSessionList
  // 失败：error envelope（码见错误规格表，含 import_marker_filename）
}
```

- **被否**：单 RPC 返回搜索+目录+详情大包（职责混杂，搜索高频而目录低频）；路径导入单独 RPC（同一校验逻辑，`import.sourcePath` 直接复用 `session.import`）。
- **证据**：现有 case 分发模式（session-message-handler.ts）；renderer domain 先例（api/domains/session.ts）。
- **效果**：§5 拆分的 runtime 单元有明确接口边界；前端对话框三区（搜索/目录/列表）各自取数。

**D6：导入后源与副本独立演化（显式声明，不做同步）**
- **采用**：复制语义下，导入后在 pi CLI 里继续该会话，产生的新内容不会出现在太极副本里（反之亦然）。需要再同步 = 重新导入（会因 sessionId 已存在被去重拦下 → 设计如此，防止双份同 id 条目）。
- **被否**：双向同步/文件监控（新机制、新断言源，违反减法准则；用户诉求是一次性纳入）。
- **效果**：scope 收敛，§1 out-of-scope 的「持续同步」显式关闭。

**错误规格表**（每个错误配恢复指引；renderer 统一在对话框内联展示，不弹系统对话框）：

| 错误码 | 触发 | 用户看到 | 恢复指引（内联） |
|---|---|---|---|
| `import_source_missing` | 源文件不存在/不可读 | 「文件不存在或不可读：<path>」 | 「检查路径是否正确，或用『选择其他目录』重新定位 sessions 目录」 |
| `import_invalid_session` | 首行无 session header，或 header 字段清单不合法（`type !== 'session'` / `id` 非非空字符串 / `cwd` 非非空字符串，见 D1 清单） | 「不是有效的 pi session 文件（首行缺少合法 session header）：<path>」 | 「确认选择的是 pi 产生的 .jsonl 会话文件」 |
| `import_dir_unreadable` | rootDir readdir EACCES 等 | 「无法读取该目录：<dir>」 | 「检查目录权限后重试，或『选择其他目录』重新指定」 |
| `import_already_imported` | sessionId 已在太极扫描集 | 列表条目「已导入」徽标（导入按钮禁用）；stale 列表点导入时对话框内联展示同款引导文案（2026-09-02 一致性审查统一：与全部其他码同走内联通道，不单设 toast 分支） | 「该会话已在太极中，侧边栏可直接打开」（标记文件名的 limbo 场景已被 `import_marker_filename` 前置拦截，此文案不会再指向不可见条目） |
| `import_marker_filename` | 源文件名含 `.tmp-migrate-` / `.tmp-import-` 标记（r2-S1：疑似迁移残留副本；导入落地后会被自家扫描过滤器永久挡在侧边栏外形成 limbo） | 「文件名包含临时标记，疑似迁移残留副本：<name>」 | 「请使用原始文件名（无标记）的 session 文件导入」 |
| `import_sidecar_failed` | rename 落地后 sidecar 写失败（readback 不符；`persistBindingSidecar` 吞错语义） | **warning 通道、非 error envelope（r4-INFO）**：RPC 成功但带 `warning: 'sidecar_failed'`；toast「已导入，但未能自动归入项目」 | 「会话已出现在默认分组；在侧边栏右键『归入项目』手动归类（setProject）」——文件不回滚 |
| `import_target_conflict` | existsSync(targetPath) 命中但 sessionId 不在 force 集合（同目标路径已被另一会话占用，如源文件被手工改过名；r4 新增） | 「目标路径已被另一个会话占用：<targetPath>」 | 「检查源文件是否被手工改名/复制过；请改用原始文件名的 session 文件导入」 |
| `import_copy_failed` | 磁盘满/目标权限（**mkdir**/copy/rename 抛错，r4-INFO） | 「导入失败（写入目标目录出错）：<原因>」 | 「检查磁盘空间与 ~/.xyz-agent 写权限后重试」。**原子性（r2）：临时名写入 + rename 原子替换；失败自动清理临时文件，正式名从未落地，重试不会被去重拦截；进程 crash 残留由启动清扫（`.tmp-import-` 家族）回收** |
| `import_project_invalid` | projectId 不存在或为空串（空串会使 readback 假阳性——`persistProjectBinding` 空串语义是「删 sidecar 归默认」，导入流程不容忍，r3-INFO） | 「目标项目不存在」 | 刷新 project 列表后重选（下拉数据实时来自 project store） |
| `import_unsupported` | 导入服务未装配（组合根遗漏注入；handler 可选服务缺席兜底惯例，理论不可达） | 「导入功能不可用」 | 「重启应用后重试」 |
| `import_failed` | runtime 意外内部错误（非 ImportServiceError 的无 code 异常兜底） | 「导入失败（内部错误）」 | 「重试；若持续复现请重启应用」 |

> 表外兜底码说明（2026-09-02 一致性审查补登，实现既有）：上两行为 handler 层兜底码，不在 `ImportErrorCode` 联合内；renderer 错误分支实现须含 default 兜底，勿按表穷举 switch。

### 3.4 运行时断言探针清单

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P-isolation | 太极 session 目录与外部目录隔离（导入不改源） | 实现后 `ls ~/.pi/agent/sessions` 前后对比 + 源文件 mtime 不变 | ⛔ M2 | —（结构保证，copyFile 不触源） |
| P-custom | 含 CLI 侧 custom entries（`unified-hooks:*` 等）的真实 session 导入后打开，对话流渲染无异常、reload 后一致（live ≡ reload 不被破坏）；附带验证：正被 pi CLI 活跃写入的文件复制（末行半写）副本可解析（INFO-2） | 用本机真实含 custom entry 的 jsonl 走完整导入→打开→reload；另取一个 pi CLI 正在写的 session 复制导入 | ⛔ M2 | 若崩：entry reducer 补该 customType 的跳过规则（仍守「不丢弃」约定，只是不渲染）；末行残缺若 parseJsonl 不容忍：导入校验放宽为「首行 header 合法即接受」，尾部半行由现有 parse 容忍语义兜底；文档同步更新兼容性声明 |
| P-cwd-fallback | header.cwd 不存在的会话：候选列表条目带「原目录不存在」标注（cwdExists=false）；导入 toast 有预警；打开后续聊发生 F3 兜底（cwd 改写 homedir）且无静默漂移 | fixture 同 V9 确定性构造（临时目录真实跑 pi 后删目录；机器上恰有的已删 worktree 会话可作补充样本但非必需）走：查询→看标注→导入→打开→发消息，核对 console.warn 的 cwdFellBack 与 UI 标注同时存在 | ⛔ M2 | 若 UI 标注缺失：candidates 响应补字段即为修复点（结构已定）；若续聊直接报错无兜底：确认 F3 管线对导入体同样生效（restoreSession 走同一入口，预期不动） |
| P-model | 源 session 的 model 在太极未配置时，恢复后发消息的行为可接受（可切换出口存在） | 构造/挑选 model 未配置的 session：导入→打开→发消息 | ⛔ M2 | 若直接报错无出口：导入成功 toast 追加「原模型不可用，已切换默认模型」或打开时预检提示切换——以实测行为为准回填本表 |
| P-scan-perf | 4,615 文件外部目录首次扫描（全 miss）：端到端延迟 <5s **且事件循环单次连续阻塞 <100ms**（分批让出生效）；二次查询（全 hit）<50ms | 实现 M1 后对真实 `~/.pi/agent/sessions` 计时 + `monitorEventLoopDelay` 采样 | ✅ 2026-09-02 Gate B 实测（轻量提取修复后）：首扫 1,624ms / maxBlock 37ms / 二次（TTL 命中）<1ms，items 3,689 与修复前一致零回退；修复前基线 23,284ms/1,947ms 双超标——根因 findLastEntryField 全量 fallback + 无消费四读，D3 已二次修订 | 阻塞超标：减小批 N 或改 worker thread 隔离；端到端 >5s：candidates 加 `scanPending` 渐进返回（分批模型下天然可做：每批 append）+ limit 截断提示精确搜索 |
| P-dedup | 同 sessionId 二次导入被拒（幂等） | 导入→再次查询候选→断言 alreadyImported；绕过 UI 直发 import RPC→断言 `import_already_imported` | ⛔ M1（单测）+ M2（真实） | —（纯逻辑，结构保证） |
| P-reload | 导入的会话重启 runtime 后仍在目标 project 分组（持久化闭环） | 导入→重启 dev app→侧边栏断言 | ⛔ M2 | 若丢：sidecar 写入点/缓存失效链排查（persistProjectBinding 已有失效逻辑，预期不动） |
| P-broadcast | 导入成功后侧边栏**立即**出现新会话（broadcastSessionList 触达，不等 1s TTL） | 导入后即时断言 renderer 收到 session.list 广播且含新条目 | ⛔ M1 | 若靠 TTL 兜底：import RPC 内显式 `invalidateScanDirCache()`（D1 已含）再 broadcast，实测确认顺序 |

已实证事实（✅，代码锚点见 §2.2 表）：目录隔离、扫描参数化、sidecar 工具、attach 断言、RPC 模式、pi 目录编码规则。

## §4 验收（真实场景，非单测）

**结论：9 个验收场景（V1-V9）全部跑真实环境（真实磁盘文件/真实 runtime/真 pi attach），覆盖三通道搜索、导入归组、续聊、重启持久、去重负面、错误恢复、custom entry 兼容、目录切换、死 cwd 降级类；单测仅作回归辅助。**

改动规模：**大**（新功能：2 个 RPC + 复制机制 + 完整 UI）。多场景真实验证，全部用真实依赖（真实磁盘文件、真实 runtime、真 pi attach），单元测试仅作回归辅助不计入验收。

| # | 场景（回溯 §1 目标） | 步骤 | 通过标准 |
|---|---|---|---|
| V1 找到+导入+归组（目标 1/2） | 在真实机器上：打开导入对话框 → 搜索框输入真实短 ID（取自 `~/.pi/agent/sessions` 某文件的 uuid 前 6 位）→ 选中 → project 选「Stock」→ 导入 | 候选列表过滤出唯一条目且名称/目录/大小与文件内容一致；导入后 toast 正确；**侧边栏 Stock 分组顶部出现该会话**；`~/.pi/agent/sessions` 源文件 mtime 与内容不变（P-isolation） |
| V2 续聊（目标 3） | V1 后点击该会话 → 等历史加载 → 发送「接着上次的结论，用一句话总结」 | 完整历史渲染（含工具调用块）；收到模型回复；新消息写入 `~/.xyz-agent/pi/sessions` 副本而非源文件 |
| V3 重启持久（目标 2/3） | V1 后重启 `pnpm dev` → 看 Stock 分组 | 导入的会话仍在 Stock 分组，点击可再续聊（P-reload） |
| V4 三通道搜索（目标 1） | 分别用：①会话名称关键词 ②完整 uuid ③`.jsonl` 绝对路径粘贴 | 前两者列表过滤命中目标条目；路径输入切换路径模式，展示文件元信息，导入成功 |
| V5 去重与冲突（目标 4，负面） | V1 导入后再次打开对话框搜索同一 session；用 stale 前端绕过（直发 RPC）；**再取另一 session 文件手工改名为已占用目标名后直发 RPC（r4-S3）** | 列表条目显示「已导入」且禁用；直发 RPC 返回 `import_already_imported`，UI 对话框内联引导而非报错弹窗（2026-09-02 一致性审查统一：与全部其他码同走内联）；改名 fixture 返回 `import_target_conflict` 且含恢复指引文案 |
| V6 错误恢复（目标 4） | `import_invalid_session` 用 stale 竞态构造（2026-09-02 一致性审查修正可达性——非 session 文件不进候选、路径模式 no-hit 按钮禁用，直接粘贴非 session 路径不可达）：先让合法 session 进入候选，再把该文件内容替换为手写两行普通 JSON，随后路径粘贴该文件导入；`import_dir_unreadable` 把 rootDir 指向无权限目录 | 分别得到 `import_invalid_session` / `import_dir_unreadable` 的内联错误 + 对应恢复指引文案；对话框不崩、可继续操作。**稳健序列提示（复审补）**：按字面顺序（先替换内容后粘贴）受外部根缓存 1s TTL 约束，人工操作窗口约 0.75s；更稳等价序列 = 先粘贴路径（pathHit 命中内存 items、按钮可用）→ 再替换文件内容 → 点击导入（点击不重读候选） |
| V7 custom entries 兼容（目标 3） | 挑一个含 `unified-hooks:*` custom entry 的真实 CLI session（本机存在）导入并打开 | 对话流渲染正常；重开（reload）后与实时视图一致（P-custom） |
| V8 目录切换 | 点「选择其他目录」选一个只有少量 session 的目录 | 目录 chip 更新、列表/ dirs 重新加载、计数正确 |
| V9 死 cwd 续聊（目标 3 降级类，MF-2 补入；r2-S3 改确定性构造） | **确定性 fixture**：`mktemp -d` 建临时目录 → 在其中真实跑 pi（`pi --mode rpc` 发一条消息，产生 header.cwd 指向该临时目录的 session 文件）→ `rm -rf` 该目录 → 该 session 即为真实死 cwd 会话。用「选择其他目录」指向其所属 sessions 根（或路径粘贴该文件）→ 搜索 → 确认条目有「原目录不存在，续聊将在主目录执行」标注 → 导入（toast 含预警）→ 打开发消息 | 续聊在 `~` 执行且成功收到回复（F3 兜底生效）；用户全程可见知情提示，无静默语义漂移；新消息写入太极副本。**注：不可用「拷贝 session 到临时 rootDir」构造——复制不改变 header.cwd，cwd 是否失效与该操作无因果关系** |

依赖说明：V1-V8 全部真实环境（本机 `~/.pi/agent/sessions` 4,615 文件即真实数据集），无 mock。pi attach 为真实子进程。

## §5 下一层拆分

**结论：三阶段交付（M1 runtime RPC 面 → M2 renderer UI 面 → M3 视觉对齐），七个单元各自挂验收探针；scanner/restore/project-store 主干零改动。**

**实施路径**（每阶段独立可验证/可回滚）：

1. **M1 runtime 层**：`scanExternalSessions` 异步分批导出（含 `.tmp-import-` 过滤扩展）+ ImportService（candidates/import + 全局导入互斥 + 互斥区内 header/标记/双检 + mkdir + tmp+rename 原子复制 + sidecar readback）+ 2 个 RPC case + 单测 → 可用 ws-client 脚本直调验证（对应 V4/V5/V6/V9 的 RPC 面）
2. **M2 renderer 层**：api domain + ImportSessionDialog 组件 + 侧边栏入口/⌘I/i18n → 真实场景验收全量跑（V1-V8 + 探针 P-*）
3. **M3 打磨**：fresh 徽标淡出、空态/骨架、demo 对齐走查（视觉与 `import-session-demo.html` 方案 A 对照）。成功 toast 为 V1/V9 验收依赖，不属打磨，已随补入的 u7-polish 单元提前至 M2 交付面（2026-09-02 一致性审查裁决：消除「M2 验收含 toast 但 toast 列在 M3」的阶段空档）。**注：M3 全部内容（含 fresh 徽标/空态引导/骨架屏/chip 下拉形态/demo 走查）已随 u7-polish 于 2026-09-02 阶段 4 一并交付，M3 状态 = 完成（impl-plan §6 u7 行）**

**单元拆分清单**：

| 单元 | 内容 | justification（为什么这么拆） | 验证挂钩 |
|---|---|---|---|
| U1 `session-file-utils.ts` | export `scanExternalSessions(dir)`（异步分批包装：`fs/promises.readdir` + 复用 `scanSessionMeta` 每批 100 文件后 setImmediate 让出）；外部根独立 TTL 缓存；`isScannableSessionFile`/`cleanupTmpMigrateResidue` 扩展 `.tmp-import-` 家族（候选侧与清扫侧同规则，D3 声明）；**export `readProjectBinding`（:362 模块私有 → 导出，readback 步骤的连带改动，r3-S5）** | 扫描原语已存在，异步分批是执行模型要求（D3）；`.tmp-import-` 过滤是 D1 原子性的机制一半，必须与 tmp 写入同批落地 | 单测：外部目录结构样本 + tmp/标记文件不可见性；P-scan-perf |
| U2 `ImportService`（runtime 新 service） | `listCandidates`（query 语义按 D5 注释、cwdExists 标记）+ `importSession`：**进入全局导入互斥（r3-MF）→ 互斥区内依次：header 字段校验 + 文件名标记校验（r2-S1）→ D4 双检（force id 集合 ∪ existsSync；id 命中→already_imported，仅 target 命中→target_conflict）→ mkdir(recursive)（r2-S5）→ 异步 tmp+rename 复制（D1）→ persistProjectBinding + readback（r2-S2，不符→warning 降级）→ 失效双缓存 → 触发广播** | 导入是独立领域动作，不塞进 session-service（其 2k+ 行已是主干）；原子性/幂等/缓存失效集中在一点，探针全部挂此单元 | 单测：幂等（含同 id 异名并发双写竞争、双击连点、**同 targetPath 异 sessionId（并发与顺序两型）→ import_target_conflict（r4-S3）**）/原子性（模拟 copy 中途失败无残留；**copy_failed 后紧接一次导入成功执行——链异常安全第二跳用例（r4-S1）**）/错误码矩阵含 marker 与 sidecar warning（P-dedup、P-cwd-fallback 的字段面） |
| U3 `session-message-handler.ts` | 两个 case（D5 契约），import 成功走既有 `broadcastSessionList()` | RPC 分发已有模式，纯增量 | P-broadcast |
| U4 renderer `api/domains/session.ts` | `importCandidates` / `importSession` 两个方法 | domain 层薄封装惯例 | — |
| U5 `ImportSessionDialog.vue` + `useImportSession.ts` | 模态 UI（搜索/目录 chip/分组列表/底部导入选 project/路径模式/已导入态/错误内联）+ composable（debounce 查询、project 默认当前、导入动作） | UI 形态 demo 已定稿；composable 抽状态便于测试（项目 ADR-0049：无 per-session 状态，普通 composable 即可，不涉 session 隔离） | 组件测试（三视角）+ V1-V8 |
| U6 `Sidebar.vue` + `useGlobalShortcuts.ts` + i18n | 「导入会话」ghost 按钮（新建任务下方）+ ⌘I + zh-CN/en-US 文案 | 入口三件套改动极小，与 U5 解耦 | V1 入口可见性 |
| U7 测试 | runtime 单测（U2 矩阵）+ renderer 组件测试 + TEST-STRATEGY 三视角 | 测试分层按项目 SSOT | 全量 |

**文件改动地图**：

- 改：`packages/runtime/src/infra/pi/session-file-utils.ts`（U1）、`packages/runtime/src/transport/session-message-handler.ts`（U3）、`packages/renderer/src/api/domains/session.ts`（U4）、`packages/renderer/src/components/sidebar/Sidebar.vue`（U6）、`packages/renderer/src/composables/shell/useGlobalShortcuts.ts`（U6）、`packages/renderer/src/i18n/locales/zh-CN|en-US/*`（U6）
- 新：`packages/runtime/src/services/session/import-service.ts`（U2）、`packages/renderer/src/components/sidebar/ImportSessionDialog.vue` + `packages/renderer/src/composables/features/sidebar/useImportSession.ts`（U5）、对应 `__tests__`
- 不动：scanner 主干、restore/attach 链路、session-service、project-store（D1 的核心收益）

**待验证检查点**（设计阶段无法确定，诚实留给实施期）：

- P-model 的具体行为（回填 D5/错误规格是否需要 `import_model_unavailable` 提示）
- P-scan-perf 实测数字（决定是否需要 M2 渐进返回）
- pi CLI 侧未来版本若改目录编码规则（升级 pi 时 `check-pi-semantics` 探针族是否需要补 import 相关断言——本期不做，登记为后续维护点）

---

## 附录：审查与修订历史

- v1（2026-09-02）：初稿。
- v2（2026-09-02）：对抗式审查 r1（4 must-fix / 6 suggestion / 3 info，报告 `.review/design-review-import-session-r1.md`）后全量修复：
  - MF-1 原子性：复制改 tmp+rename（`.tmp-import-` 家族过滤/清扫），错误表恢复指引与去重不再互斥（D1、错误规格表）
  - MF-2 死 cwd：§1 目标 3 补降级类、§2.4-3 补机制（pi assertSessionCwdExists + F3 静默改写 homedir）、D5 加 `cwdExists` 字段、新增探针 P-cwd-fallback 与验收 V9
  - MF-3 执行模型：D3 显式「异步分批 + setImmediate 让出」，P-scan-perf 补事件循环阻塞指标与可行降级路径
  - MF-4 幂等时序：D4 改 `scanPiSessions({force:true}) ∪ existsSync(targetPath)` 双检 + targetPath 级串行化
  - S5-S10 全修：encodeCwd(resolve()) 复用 pi-paths 导出（D2）、header 字段清单（D1）、query 匹配语义注释（D5）、一层子目录假设声明（D3/D5）、rootDir 动态推导 getPiGlobalAgentDir（D5）、去重证据修正（D4）、scanDirCache 措辞（B1/D3）、INFO-2 并入 P-custom
- v3（2026-09-02）：r2 聚焦复审（1 must-fix / 5 suggestion / 1 info，报告 `.review/design-review-import-session-r2.md`）后全量修复：
  - r2-MF：D4 串行化键 targetPath → **sessionId**，双检移入取得队列槽位后的**临界区内**（同 id 异名并发、双击连点全部闭合；rename-over 降为防御纵深）
  - r2-S1：源文件名含 `.tmp-migrate-`/`.tmp-import-` 标记 → 新错误码 `import_marker_filename`（消灭「自家过滤器吞掉自家产物」的永久 limbo）；D3 声明候选侧同规则过滤
  - r2-S2：sidecar 写后 **readback 校验**（`persistBindingSidecar` 吞错语义已核实）→ 不符时 `warning: 'sidecar_failed'` 降级 toast + 错误表新行（文件不回滚，引导 setProject 手动归类）
  - r2-S3：V9/P-cwd-fallback 改**确定性 fixture**（临时目录真实跑 pi 后删目录；废弃「拷贝使 cwd 失效」这一机制上不成立的构造）
  - r2-S4：encodeCwd 行号 :119→:122；r2-S5：D1/数据流/U2 补 mkdir(recursive)；INFO：短 ID 示例改 6 字符
- v4（2026-09-02）：r3 聚焦复审（1 must-fix / 5 suggestion / 2 info，报告 `.review/design-review-import-session-r3.md`）后全量修复：
  - r3-MF：sessionId 键队列被「同 targetPath 异 sessionId」镜像反例击穿（rename-over 静默覆盖已成功导入）→ 改**全局单条导入互斥**（单 Promise 链，无键选择即无维度遗漏；Map 回收 S 一并消失）；新增 `import_target_conflict` 错误码（仅 target 命中时明确拒绝，不再误报 already_imported）
  - r3-S 全修：错误表 import_copy_failed 行格式修复（v3 插行损坏）、数据流③/U2 队内外校验边界统一为「全部在互斥区内」、§4 结论 8→9 场景（V9 漏同步）、export readProjectBinding（:362 连带改动）、INFO-2 projectId 空串并入 import_project_invalid 触发条件（防 readback 假阳性）
- v5（2026-09-02）：r4 聚焦复审（**0 must-fix** / 3 suggestion / 2 info，报告 `.review/design-review-import-session-r4.md`）后全量修复，设计就绪：
  - r4-S1：D4 补互斥链**异常安全**规格（then(work, work) / gate+finally；错误转 envelope 不泄入链）；U2 补「copy_failed 后紧接导入成功」第二跳用例
  - r4-S2：D4 补**互斥不设超时**显式接受声明（copyFile 不可取消、超时释放重开并发窗口；挂起爆炸半径仅导入功能）；D1 header 校验改 fs/promises 异步读（消 NFS sync 读的事件循环阻塞面）
  - r4-S3：`import_target_conflict` 补齐验证挂钩——U2 矩阵（同 target 异 id 并发/顺序两型）、V5 改名 fixture 负面向量
  - r4-INFO：copy_failed 触发列补 mkdir；sidecar_failed 标注 warning 通道非 error envelope
