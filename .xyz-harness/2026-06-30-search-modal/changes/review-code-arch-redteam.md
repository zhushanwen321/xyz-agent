---
verdict: APPROVED
machine_check: PASS
dimension: redteam
---

# 红队审查 — code-architecture.md（⌘K 全局搜索浮层）

> fresh context 红队。维度：必要性与比例性（deletion test / 过度设计 / 纸面正确但骨架证伪的签名）。
> **纪律**：decisions.md status=confirmed 的决策不当审查意见重报。D-026（编排归 useSearch.ts）已 confirmed，本组不要求改回 domain 编排。

## Verdict

**APPROVED**

无过度设计达到「建议降级」阈值；新建模块均有 2+ 真实消费者或单消费者但编排量足以独立成轴（delete test 通过）。骨架证伪预测见下（最高优先级是 AC-6.9 useDetailPane 注入方法缺口——纸面「直调 fileApi.read + useDetailPane 渲染」听似成立，但 useDetailPane 现状无 public 注入方法，骨架生成时首当其冲被证伪）。

## 过度设计发现

### 1. useRecents 计数器兜底（AC-3.6）— 轻微过度，不阻断

**对象**：`RecentEntry.timestamp = Math.max(stored)+1`（AC-3.6，避免同毫秒连续 write 的 FIFO 排序不确定）。

**Deletion test**：删掉计数器兜底改用裸 `Date.now()` 会怎样？useRecents.write 的连续两次调用同毫秒命中，仅在「程序化双确认」时发生——用户手敲 Enter 触发 confirm 是串行的，两次 write 跨毫秒的概率近乎 100%。桌面单实例无并发写者。

**结论**：对单实例桌面应用的纯前端偏好，同毫秒并发 write 是假设性场景。**但代价极小**（2 行 `Math.max(stored)+1`，可测），属防御性编码品味而非架构性过度设计。**不建议降级**，仅记录：若骨架发现 write 路径无第二个调用源（useSearchJump 单点写），可保留计数器但不必为其单设并发测试用例（T1.18 可降为可选）。轻量观察项，非阻断。

### 2. #17 WS 超时 race（方案 A）— 技术债，scope 合理

**对象**：useSearch.query 内对 file/session WS 源包 `Promise.race([wsCall, timeout(10s)])`（#17 方案 A）。

**红队质询**：根因在 transport 层（ws-client.ts:101-106 `onclose` 不 reject in-flight pending，pending.ts 无 clear/flush——已源码核实）。方案 A 是「每消费者自带超时」的局部兜底，不是根因修复；若未来新增第二个 WS 阻塞型 UI 消费者，需复制 race 包装。

**结论**：**不过度设计，是必要的 UX 阻断级缓解**。已核实 ws-client.ts onclose 确实只 scheduleReconnect 不 reject pending，allSettled 会永久 await——#17 根因属实且严重。方案 B（transport 层 onclose reject）是更彻底的修复但超本期 topic（影响所有 ws 调用者，需全量回归）。code-arch 正确将方案 B 标「另开 topic」，D-023 已登记为长期方案。**判定：scope 取舍合理，非过度设计**。提醒：10s 阈值是经验值（file.search 全量递归大仓库 <5s），骨架应留可配置常量，勿硬编码。

### 3. useSearchJump type switch（vs 策略 Map）— 已合理，无需动

**对象**：confirm 内 type switch 分发 4 类（3 真实 + symbol 占位）。

**结论**：issues #6 已弃方案 C（策略 Map），switch 对编译期固定 4 类型直白可读。**无过度设计**。骨架无需担心此处。

### 4. match-engine 提取 — DRY 成立（2 真实消费者已核实）

**对象**：lib/match-engine.ts（matchFilter + segments）。

**Deletion test**：删掉→SearchModal 重写 segments（高亮）+ useSearch 重写 matchFilter（过滤）。已核实现有 SearchModal.vue:141-155 segments 是私有函数，useSearch.query 需 matchFilter 做前端过滤。两消费者驱动 DRY 成立，非假设性复用。**保留**。

> 注：lib/ 已有 `file-match.ts`（composer `#` 候选的匹配度分级）。match-engine 与 file-match 同属 lib 纯函数子串匹配族，存在「相似算法两处」的轻微味道。但两者语义不同（match-engine=子串切分驱动高亮，file-match=basename/path 匹配度分级排序），不构成合并理由。骨架可选注释互引，非阻断。

## 骨架证伪预测（🔴 = Step 7 重点验证对象）

### 🔴 P0：AC-6.9「直调 fileApi.read 不经 openPreview」— useDetailPane 无注入方法，骨架最可能证伪点

**纸面**（code-arch §3 useSearchJump file 分支 + AC-6.9 注）：
> file 分支**直调 `fileApi.read`** 校验文件可读，**不经 `useDetailPane.openPreview`**（后者 try/catch 吞错设 status='error' 不抛）。read 成功后再调 useDetailPane 渲染内容（**或用独立 setPreview 方法绕过其加载态**）。

**源码核实**（useDetailPane.ts:145）：
```ts
return { state, openPreview, toggleView, clearPreview }
```
- **没有 `setPreview`，没有 `renderContent`，没有「绕过加载态」的 public 注入方法。**
- `openPreview(sid, path)`（:70-93）是完整闭包：自定 viewMode → 调 git.getDiff/file.read → try/catch 吞错设 status='error'（**永不抛**）。调用它=重新走完整加载链（含重复 file.read WS 往返 + git-overlay 判定），既浪费又可能闪加载态。

**证伪路径**：Step 7 实现 useSearchJump.confirm 的 file 分支时，骨架会卡在「read 成功后怎么把内容塞进 DetailPane 而不重读/不闪态」。三个出路全部有问题：
- (a) 新增 useDetailPane 方法（如 `renderFromRead(sid, path, {content, truncated})`）→ **code-arch §3 API 契约未声明此方法，§1 工程目录未列 useDetailPane 为改造目标，§7 现有代码映射把 useDetailPane 当「被调现有基建」非改造对象**。骨架要么自己发明签名（违反「签名表写了才实现」），要么回填设计（本应 Step 6b 捕获）。
- (b) useSearchJump 直调 fileApi.read 后再调 openPreview(sid,path)（openPreview 内部再 read 一次）→ 冗余双 read WS，且 AC-6.9「绕过加载态」落空。
- (c) useSearchJump 直接 mutate `useDetailPane.state.value` → 破封装，且 state 形态（含 hasGitChange/viewMode 等）由 openPreview 协调，外部突变易致不一致。

**建议（必须，但属骨架前回填，不阻断 APPROVED）**：Step 7 前在 code-arch §3 补 useDetailPane 的注入方法契约（明确签名如 `renderFromRead(sid, path, content): void`，语义=「已校验可读，直接渲染 content 不重读不设 loading」），并在 §1/§7 把 useDetailPane 列为【扩展】改造目标。这是 AC-6.9（D-024 confirmed）落地的前置——纸面正确但骨架会证伪的典型签名，**最高优先级 Step 7 验证对象**。

### 🟠 P1：useSearch.query 的 VITE_MOCK 接线 — mock 轨 import 路径未声明

**纸面**（code-arch §3 api/index.ts 改造 + §1）：
> 删除 search 导出；**mock 轨由 useSearch 内部判 VITE_MOCK 走 mockApi.search**，real 轨走真实聚合。

**源码核实**：
- 现有 composables（useFileSearch/useDetailPane/useSidebar）统一 `import { composer } from '@/api'`，**从不直接 import `@/api/mock`**（mock/index.ts 是 api/index 内部结构）。
- D-026 删 search 门面后，useSearch 要判 VITE_MOCK 走 mockApi.search，必须 `import * as mockApi from '@/api/mock'` 或 `import { search as mockSearch } from '@/api/mock'`——**这是 composables 层首次直接 import mock 内部**，偏离现有「composable 只 import @/api 门面」模式。

**证伪预测**：骨架生成时 useSearch 的 mock/real 分支 import 会是首处破例；若实现者按现有 composable 惯例只 import `@/api`，会发现 `@/api` 已无 search 导出（D-026 删了）→ tsc 报错 → 被迫 import mock 内部。**不阻断**（可行），但建议 code-arch §3 useSearch 边界表补一行「mock 轨：`import.meta.env.VITE_MOCK` ? mockApi.search.query : 真实聚合」，明示 import 来源，避免骨架自由发挥。

### 🟠 P1：loadSeq「模块级 vs composable 内部」二义未消

**纸面**（code-arch §3 内部不变式）：
> `let loadSeq = 0  // 模块级或 composable 内部自增序列号`

**证伪预测**：二选一未定。若模块级（文件作用域 let）且 useSearch() 被多实例调用（未来第二消费者），共享计数器可能错乱；若 composable 内部闭包，每实例独立（当前单消费者安全）。code-arch §9 骨架覆盖核验列了 useSearch.query（#3）但**未把 loadSeq 归属列为待定签名**。**建议**：Step 7 统一定为「composable 内部闭包变量」（与「useSearch 单例」假设解耦，更鲁棒），code-arch §3 去掉「或」二义。轻量，非阻断。

### 🟡 P2：useSearch 单例假设未在骨架验证

**假设**：close 孤儿查询守卫（MR-7.1）依赖「open flag」+ loadSeq，隐含 useSearch 与 SearchModal 1:1 绑定（单例）。当前唯一消费者是 SearchModal（已核实无其他 import），假设成立。但 code-arch 未显式声明「useSearch 设计为 SearchModal 单例 composable」。

**证伪预测**：低概率——本期无第二消费者。**仅记录**：若 Step 7 骨架把 useSearch 写成可复用工厂但 open flag 守卫假设单例，未来复用会踩坑。非本期阻断。

### 🟡 P2：useSearch 复用 fileSearchStore 缓存的读写双写点

**纸面**（code-arch §3 useSearch file 源 + AC-4.10）：
> useSearch 内部读 fileSearchStore 缓存或调 composer.getFileCandidates（缓存未命中写入）；AC-4.10：search 须自绑 `useFileSearch.setupInvalidation` watch。

**源码核实**（useFileSearch.ts:32-44）：`load()` 是「缓存命中直返 / 未命中调 composer.getFileCandidates + store.set」的闭包，**且 catch 吞错返空数组**（AC-4.5 要求 useSearch 不经此吞错层）。

**证伪预测**：useSearch 要「复用缓存但绕过 load() 吞错层」→ 必须自己写 `store.get(sid) ?? composer.getFileCandidates(sid) then store.set`，**缓存读写逻辑与 useFileSearch.load 重复一处**；同时又要调 `useFileSearch().setupInvalidation()` 复用失效 watch。骨架会出现「缓存读写在 useSearch、缓存失效 watch 在 useFileSearch」的跨 composable 缓存协调，tsc 能过但行为耦合点易出错（如 useSearch 写缓存 vs useFileSearch 失效时序）。**建议**：Step 7 骨架明确 useSearch 与 useFileSearch 的缓存职责边界（useSearch 只读 store + 自写未命中，setupInvalidation 复用 useFileSearch），或抽 store 层的「读或拉」原子方法供两者共享。非阻断，骨架验证项。

## [CROSS-VALIDATED] 与对齐组冲突

无预期冲突。本组红队维（必要性/比例性）未发现与对齐组「上游对齐/可执行性」维相冲的对象——AC-6.9 useDetailPane 缺口是「可执行性」红队侧的佐证（纸面签名骨架证伪），方向一致，非冲突。D-026 编排归 composable 为 confirmed 决策，两组均不应质疑归属。

## 必须修改

无强制阻断项。以下为 Step 7 骨架生成前建议回填（非阻断 APPROVED，但 P0 强烈建议处理以免骨架返工）：

1. **【强烈建议】AC-6.9 useDetailPane 注入方法契约**：code-arch §3 补 useDetailPane 扩展方法签名（如 `renderFromRead(sid, path, content): void`，语义=已校验可读直接渲染不重读不设 loading），§1/§7 将 useDetailPane 列为【扩展】改造目标。否则骨架 file 分支无 public API 可用，必然证伪。（对应骨架证伪预测 P0）
2. **【建议】useSearch VITE_MOCK import 来源明示**：§3 useSearch 边界表补 mock 轨 import `@/api/mock` 的说明（首次 composable 直 import mock 内部，偏离门面惯例）。
3. **【建议】loadSeq 归属消二义**：§3 内部不变式去掉「模块级或 composable 内部」的「或」，定为 composable 内部闭包。

## 可选改进

- useRecents 计数器兜底（AC-3.6）保留但 T1.18 并发用例可标记为「可选」（单实例桌面无并发写者，见过度设计发现 #1）。
- match-engine.ts 与 lib/file-match.ts 在骨架注释互引，避免未来 lib 子串匹配族分裂。
- #17 方案 A 的 10s 超时阈值抽常量（勿硬编码），便于大仓库调参。

---

**红队诚实结论**：code-arch 整体无架构性过度设计——新建模块均过 deletion test，#17 方案 A 与 useSearchJump switch 是合理的 scope/品味取舍（非过度），D-026 编排归位正确（confirmed，不质疑）。**APPROVED**。主要价值在「骨架证伪预测」清单：AC-6.9 useDetailPane 注入方法缺口是头号 Step 7 验证对象（纸面正确、骨架会证伪），建议 Step 7 前回填契约避免返工；其余为骨架接线细节（mock import / loadSeq 归属 / 缓存双写点），tsc 能兜住，非阻断。
