# 主题 6：归位卫生批量收尾（收尾 7）

## 6 项独立低风险，可批量执行

---

## 7.1：normalizeSubagentStatus 下沉 runtime

### 现状

`normalizeSubagentStatus`（纯字符串映射：`'completed'→'done'` / `'error'→'failed'` / 兜底 `'running'`）定义在 `packages/shared/src/subagent.ts:76`。

**消费者**仅 runtime 2 文件（renderer/core 零调用）：
- `runtime/src/services/session/event-interpreter.ts:37,484`
- `runtime/src/services/session/subagent-extractor.ts:29,222`

### 问题

按 §0.1 归位判据（消费者驱动），单 runtime 消费的非跨端函数应归 runtime，不应留 shared。

**注意**：§0.1 判据表把它归入「OS/外部资源 → runtime」不准确（它是纯字符串映射，不访问 OS）。真正归 runtime 理由是「单一消费者驱动」。

### 修复

1. `mv` normalizeSubagentStatus 定义到 `packages/runtime/src/services/session/subagent-status.ts`（或 infra/）
2. runtime 2 文件改 import（从 `@xyz-agent/shared` → 本地相对路径）
3. shared 保留 re-export 一段时间（向后兼容），或直接删除（grep 确认无其他消费方后）
4. shared `__tests__/subagent.test.ts` 对应测试迁 runtime

### 收益

shared 纯净（只留真正跨端复用的类型/常量）；归位判据一致。

---

## 7.2：findNodeByPath 落点 — 归位判据统一（全迁或不迁）

### 现状

findNodeByPath 已抽纯函数（语义层倒置已消除），落点 `packages/renderer/src/composables/logic/file-tree-utils.ts`（37 行，零状态）。审计推荐落点 `lib/`。

**关键事实**：`composables/logic/` 目录有 **13 个同性质零状态纯函数文件**（file-tree-utils/file-type/formatTime/guiComponent/markdown/mermaid/messageFormat/messageTurns/parseDiff/popover-styles/session-file-format/sessionStatus/summarizeTurn），不只 file-tree-utils 一个。

消费方：
- `stores/fileTree.ts:21` `import { findNodeByPath } from '@/composables/logic/file-tree-utils'`
- `composables/features/useFileTree.ts:19` 同源 import

### 问题

若只迁 file-tree-utils 一个到 lib/，是「为通过审计验收 grep 而移动文件」，不是为架构一致性——13 个同性质文件还在 composables/logic/，审计 grep 仍命中其他文件。两头不沾。

### 修复（二选一，不可只迁一个）

**方案 A（推荐）：承认 composables/logic/ 是合法落点，改审计判据**
- 13 个零状态纯函数文件已在 composables/logic/，这是既成事实且语义自洽（renderer 本地的逻辑工具函数）
- findNodeByPath 留在 composables/logic/file-tree-utils.ts（零改动）
- 更新审计 §11.3 验收命令：从「grep 不命中 @/composables」改为「stores 不 import 有状态 composable」（findNodeByPath 是纯函数无状态，不违反倒置精神）
- 成本：零代码改动，只改审计文档判据

**方案 B：13 个文件全迁 lib/**
- `mv composables/logic/*.ts lib/`（除 __tests__）
- 所有消费方改 import 路径（数十处）
- 删除 composables/logic/ 目录
- 成本：高（大量 import 改动），一致性最高

**推荐方案 A**：架构一致性已达成（13 个纯函数同性质聚集），审计判据不准确（把「stores 不 import 有状态 composable」误设为「stores 不 import @/composables」），应修正判据而非为迎合错误判据搬迁。

---

## 7.3：lib/ file-basename/utils 部分分叉（re-export shim 模式）

### 现状

| 文件 | renderer 版 | ui 版 | 差异 |
|---|---|---|---|
| file-basename.ts | 71 行 | 40 行 | renderer 多 `collectFilePaths` + 详细 JSDoc；公共函数（findByBasename/collectBasenames）逐字重复 |
| utils.ts | 47 行 | 12 行 | ui 仅 `cn()`（注释「从 renderer 迁入」）；renderer 多 `rebuildSegmentsWithEditedText`（Turn.vue 专用） |

### 修复（对齐 slashIcons re-export shim 模式，跨主题优化 2）

**file-basename.ts**：
1. renderer 多出的 `collectFilePaths` 评估：ui 是否需要？
   - 需要：一并迁 ui
   - 不需要：renderer 版改 `export { findByBasename, collectBasenames } from '@xyz-agent/ui'` + 本地补 collectFilePaths
2. 消除公共部分双份

**utils.ts**：
1. renderer 的 `cn()` 改 `export { cn } from '@xyz-agent/ui'`
2. `rebuildSegmentsWithEditedText` 留 renderer 本地（Turn.vue 专用）

### 收益

消除公共部分双份，SSOT 统一到 ui。

---

## 7.4：composables/features 按域分组

### 现状

`packages/renderer/src/composables/features/` 含 `sidebar/` 子目录（1 个），平铺 .ts 文件 43 个。已迁 core 的域（composer/session/new-task-search）在 renderer 无对应子目录桶。

### 修复

按域建子目录：
```
composables/features/
├── chat/         ← useChat.ts 等
├── sidebar/      ← (已有)
├── search/       ← useSearch.ts 等
├── new-task/     ← useNewTaskFlow.ts 等
├── fork-handoff/ ← fork/handoff 相关
└── ...（按实际文件归类）
```

### 性质

低优先级，不影响功能。属「迁移卫生」收尾。

---

## 7.5：顶层 3 文件下沉

### 现状

`packages/renderer/src/composables/` 顶层 4 文件，slashIcons 已解决（re-export shim），其余 3 个仍在顶层：

| 文件 | 审计建议 | 当前 |
|---|---|---|
| useCompletionNotify.ts | 移 effects/ | ❌ 顶层 |
| useCompletionSound.ts | 移 effects/ | ❌ 顶层 |
| sound-defaults.ts | 改名 sound-platform 留 renderer | ❌ 原名顶层 |

### 修复

1. `mv useCompletionNotify.ts useCompletionSound.ts` → `composables/effects/`
2. `sound-defaults.ts` 改名 `sound-platform.ts`（语义更准，留 renderer 顶层或移 platform/）

**基础设施已就位**：`effects/` 目录已存在（含 useMessageEffects.ts / useForkNoticeEffect.ts）。

---

## 7.6：文档同步

### 现状

`docs/architecture/renderer-target-architecture.md` §2 未补三层包演进（shared/core/dom-core/ui/renderer）+ headless core 决策。

### 修复

文档更新：
1. §2 补「三层独立 npm 包 + dom-core」演进（ADR-0058 裁定后）
2. 补 headless 边界（core 真 headless / dom-core DOM-bound）
3. 补 composer 容器组件留 renderer 的设计说明（headless core + shell 范式）

### 依赖

依赖决策 1（dom-core ADR 裁定）完成。

---

## 批量执行建议

6 项均为低风险独立项，建议**一个波次批量做**（与决策 1 之后）：

| 修复 | 文件改动 | 风险 |
|---|---|---|
| 7.1 normalizeSubagentStatus | 1 mv + 2 import + 测试迁 | 零 |
| 7.2 findNodeByPath 落点 | **方案 A 零代码改动**（改审计判据）/ 方案 B 13 文件全迁 | 零 |
| 7.3 lib 分叉 | 2 文件 re-export 改造 | 零 |
| 7.4 composables 分组 | 多 mv | 零 |
| 7.5 顶层下沉 | 2 mv + 1 改名 | 零 |
| 7.6 文档 | 1 md 更新（与决策 1 同 commit 波次） | 零（依赖决策 1） |

总改动量小，无逻辑变更，可并行。

## 主题 6 验收

- shared 只留真跨端复用
- renderer 归位卫生一致（composables/lib/effects 分层清晰）
- 文档反映 dom-core 分层
