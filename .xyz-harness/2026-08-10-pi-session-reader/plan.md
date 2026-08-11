# M1 实现计划：core 纯逻辑核

> **一句话结论**：M1 交付 5 个零 pi 依赖的纯函数文件（parser/turns/tree/render/family），每个带单测，对真实 session `019e6c96` 跑 outline 必须复现 design.md 的 ~500 token / 26 turn。

**层声明**：当前层 = 实现计划；上一层的 SSOT = [design.md](./design.md)（§3.4 接口规格、§3.5 核心算法）。本计划只拆 M1；M2-M5 待 M1 接口冻结后各自出 plan（接口先行，避免一次性规划过远）。

**M1 范围**：`extensions/session-reader/src/core/` 下 5 文件 + 5 测试。零 pi 依赖（只依赖 `node:fs`/`node:path` + `typebox` 类型）。不写 tool-adapter（M3）、不写 discovery 的 IO（M2 的 roots/find/subagents 只留 family.ts 的纯逻辑部分）。

---

## 文件依赖图

```
parser.ts  (Entry/ParseResult, 零依赖)
   │
   ├── tree.ts     (Entry → TreeView, 依赖 parser 类型)
   ├── turns.ts    (Entry + leafSet → Turn[], 依赖 parser + tree 类型)
   │      │
   │      └── render.ts  (Turn[] + TreeView → OutlineResult, 依赖 turns + tree)
   │
   └── family.ts   (首行 Entry → FamilyIndex, 依赖 parser 类型；独立于 turns/tree/render)
```

时序：parser 先行 → tree/turns 可并行 → render 收口；family 全程独立。

---

## 任务拆分

### T1.1 parser.ts

**接口**：

```ts
export interface Entry {
  type: string                 // session | message | compaction | custom | model_change | thinking_level_change | branch_summary
  id: string
  parentId: string | null
  timestamp?: string
  // payload（按 type，可选）：
  message?: { role: 'user' | 'assistant' | 'toolResult'; content: unknown; toolCalls?: unknown[] }
  customType?: string
  data?: unknown
  parentSession?: string       // 仅 type=session 的 fork header
  cwd?: string                 // 仅 type=session
  summary?: unknown            // 仅 type=compaction
}

export interface ParseResult {
  entries: Entry[]
  skippedLines: number         // JSON 解析失败的行数
  totalBytes: number
  lastLinePartial: boolean     // 最后一行疑似半行（活跃 session 写入中，design §3.5 风险 3）
}

export function parseSessionContent(content: string): ParseResult
export async function parseSessionFile(filePath: string): Promise<ParseResult>
```

**实现要点**：
- 逐行 `JSON.parse`，失败计 `skippedLines++` 继续（design §2 坏 session 容错）
- `lastLinePartial`：最后一行 parse 失败时置 true（区别于中间坏行），供 render 标注 `[最后 1 行可能正在写入，已跳过]`
- 保留所有 entry type 的原始 payload 字段（不提前裁剪，裁剪在 render 层）

**单测基线**（`parser.test.ts`）：
- 正常多类型 entry 全解析，字段完整
- 中间夹坏行 → skippedLines 正确，坏行前后 entry 保留
- 空文件 / 只有 header → entries 非空（header 计入）或空（无 header）
- 最后一行半 JSON → lastLinePartial=true
- 真实文件：`parseSessionFile(019e6c96)` → entries.length === 1204，skippedLines === 0

**验收**：`npx vitest run core/parser.test.ts` 全绿 + 真实文件 entry 数断言通过。

---

### T1.2 tree.ts

**接口**：

```ts
export interface TreeView {
  leafPath: string[]           // root → leaf 的 id 序列
  branches: Map<string, number>   // forkPointId(=parentId) → 旁支 entry 数
  orphans: string[]            // parentId 指向不存在 entry 的 id
}

export function buildTreeView(entries: Entry[]): TreeView
```

**实现要点**：严格按 design §3.5 算法 2。leafId = entries 最后一条的 id（D-2）。

**单测基线**（`tree.test.ts`）：
- 线性链（无分叉）→ leafPath 含全部 id，branches 空
- 单分叉：旁支正确归到 forkPointId，计数正确
- 多级分叉
- 孤儿（parentId 不在索引）→ orphans 收集，leafPath 在断点停
- 真实：`buildTreeView(parse(019e6c96).entries)` → leafPath 非空，或phans 可验

---

### T1.3 turns.ts

**接口**：

```ts
export interface Turn {
  index: number
  startTime?: string
  entries: Entry[]             // 该 turn 的全部 entry（含 user + 后续）
  userEntry?: Entry            // turn 起点（compaction turn 无 userEntry）
  isCompaction: boolean
}

export function segmentTurns(entries: Entry[], leafSet: Set<string>): Turn[]
```

**实现要点**：严格按 design §3.5 算法 3 的 5 条优先级。`leafSet` 来自 tree.ts 的 leafPath（branch 边界规则 5）。

**单测基线**（`turns.test.ts`）：
- user 开 turn，后续 assistant/toolResult 并入
- compaction 开新 turn，isCompaction=true
- model_change/thinking_level_change 并入当前 turn
- branch entry（不在 leafSet）不计入
- 孤儿 assistant（首个 entry 是 assistant 无前置 user）→ 并入 turn 0
- 真实：`segmentTurns(parse(019e6c96).entries, leafSet)` → 26 turn（与 design P-outline 一致）

---

### T1.4 render.ts

**接口**：

```ts
export interface TurnBrief {
  index: number
  startTime?: string
  userBrief: string
  toolSummary: string
  assistantBrief: string
  omittedBytes: number
  branch?: string              // forkPointId（allBranches 时）
}

export interface OutlineResult {
  turns: TurnBrief[]
  stats: { totalTurns: number; totalEntries: number; totalBytes: number; parsedBytes: number }
  tokenEstimate: number
  truncated?: number           // 被截断的 turn 数
}

export interface OutlineOptions {
  budget?: number              // 默认 2000（token）
  allBranches?: boolean        // 默认 false
  granularity?: 'turn' | 'entry'   // 默认 turn
}

export function renderOutline(turns: Turn[], tree: TreeView, options?: OutlineOptions): OutlineResult
export function renderExpand(turn: Turn): EntryBrief[]
export function renderDetail(turns: Turn[], opts: { includeToolResult?: boolean; includeThinking?: boolean }): Entry[]
```

**实现要点**：严格按 design §3.5 算法 1 的预算分配 + 降级序。token 估算用 `chars / 4` 近似（与 design P-outline 口径一致）。`toolSummary` 聚合 toolCall.name 计数（`bash×2,read×2`）。

**单测基线**（`render.test.ts`）：
- 预算充足 → 全部 turn 完整渲染，各字段正确
- 单 turn 巨大 → 降级序触发（先砍 assistantBrief → 再 toolSummary → 骨架）
- 总超预算 → truncated 计数 + 追加提示行
- toolSummary 聚合正确（多 toolCall 同名计数）
- omittedBytes = toolResult + thinking 字节和
- granularity:entry → 不聚合 turn
- 真实：`renderOutline(turns(019e6c96), tree)` → tokenEstimate ≈ 500，turns.length === 26

---

### T1.5 family.ts

**接口**：

```ts
export interface SessionRef {
  sessionId: string
  fileName: string
  mtime: number
  sizeBytes: number
  cwd: string
  parentSession?: string
  name?: string
}

export interface SubagentRef extends SessionRef {
  rootSessionId: string
  slug: string
  cleanedUp?: boolean
}

export interface WorkflowRef {
  runId: string
  stateFile: string
  calls: SessionRef[]
}

export interface Family {
  root: SessionRef
  parents: SessionRef[]
  forks: SessionRef[]
  subagents: SubagentRef[]
  workflows: WorkflowRef[]
}

// 家族索引（design D-5 缓存层）
export interface FamilyIndex {
  byId: Map<string, SessionRef>
  childrenOf: Map<string, SessionRef[]>      // parentSession → fork 子代
  subagentsByRoot: Map<string, SubagentRef[]>  // rootSessionId → subagent（含隔代，design §3.3 D-7 Q1）
  fileStats: Map<string, { mtime: number; size: number }>  // 缓存失效依据
}

export function buildFamilyIndex(headers: Entry[], subagentIdentities: Entry[], fileStats: Map<string, {mtime:number;size:number}>): FamilyIndex
export function isStale(index: FamilyIndex, currentStats: Map<string, {mtime:number;size:number}>): boolean
export function resolveFamily(sessionId: string, index: FamilyIndex): Family
```

**注意**：M1 只写**纯逻辑**（buildFamilyIndex 接收已读入的 headers/identities，不做文件 IO）。IO（扫目录、读首行/尾行）归 M2 的 `subagents.ts`/`roots.ts`。

**实现要点**：
- `buildFamilyIndex`：headers 建 byId + childrenOf（反查表），subagentIdentities 建 subagentsByRoot
- `resolveFamily` 的隔代规则（design §3.3 D-7 Q1）：先建 fork 链（parents + forks），再对链上**每个**节点 id 查 subagentsByRoot（不只查 root 本身）
- `isStale`：对比 fileStats 的 (mtime, size)，任一变化即 stale

**单测基线**（`family.test.ts`）：
- 线性 fork 链：parents/forks 正确
- 隔代 subagent：rootSessionId 指向 fork 中间节点，从家族根 resolve 仍能关联（design §3.3 D-7 Q1 核心断言）
- GC subagent（identity 在但文件不在 fileStats）→ cleanedUp=true
- stale 检测：mtime/size 变 → true；不变 → false
- 构造 fixture：用 019fe620(根)/019fe632(fork子代)/019fe635(subagent, rootSessionId=019fe632) 的 header + identity entry

---

### T1.6 集成 + 真实验证

**任务**：组装 5 文件跑真实 session，验证 design §3.5 算法链路贯通。

**验证脚本**（`core/__integration__/smoke.ts`，不入正式测试套件但纳入 CI smoke）：

```ts
// 对 019e6c96 跑全链路
const parsed = await parseSessionFile('<019e6c96 path>')
const tree = buildTreeView(parsed.entries)
const turns = segmentTurns(parsed.entries, new Set(tree.leafPath))
const outline = renderOutline(turns, tree, { budget: 2000 })

assert(outline.turns.length === 26)
assert(outline.tokenEstimate <= 600)        // design V3 < 600 token
assert(outline.stats.totalEntries === 1204)
```

**family 验证**（用 019fe620/019fe632/019fe635 真实 header/identity）：

```ts
const family = resolveFamily('019fe620', index)
assert(family.forks.some(f => f.sessionId.startsWith('019fe632')))
assert(family.subagents.some(s => s.sessionId.startsWith('019fe635')))  // 隔代关联（Q1）
```

---

## DoD（Definition of Done）

1. **5 文件 + 5 测试全绿**：`cd extensions/session-reader && npx vitest run core/` 全部通过
2. **零 pi 依赖**：`grep -r "@earendil-works\|@zhushanwen/pi-" src/core/` 无命中（只允许 node: 内建 + typebox）
3. **真实数据复现**：T1.6 smoke 脚本对 019e6c96 跑通，outline 26 turn / tokenEstimate ≤600（与 design §4 V2/V3 基线一致）
4. **隔代 family**：T1.6 family 验证通过（019fe620 → 关联到隔代 subagent 019fe635）
5. **接口冻结**：本计划的接口签名作为 M2-M5 的契约，冻结后变更需同步 design.md

## 验收映射

| M1 产出 | 映射 design 验收 |
|---|---|
| render.ts outline | V2（26 turn / ≤2K token）、V3（< 600 token） |
| turns.ts 分段（含 compaction/branch 边界） | V2「两步内定位」的 turn 索引正确性 |
| tree.ts leaf 重建 | design D-2 / P-leaf-view（半验证收口） |
| family.ts 隔代关联 | V4「从家族根关联隔代 subagent」 |

## 不在 M1 范围（推后）

- 文件 IO / 目录扫描（M2 roots.ts/find.ts/subagents.ts）
- tool-adapter / TypeBox schema 注册（M3）
- TUI hash-provider / `/session` 命令（M4）
- export 物化（M5）
- search action 的检索逻辑（render 有 expand/detail，search 可在 M3 或独立小任务补；非 M1 核心）
