# 子 Spec C：cw 增强

> **父文档**：[spec.md](./spec.md) §13（第二轮审查发现）
> **范围**：C1（execute 返回 childUnitIds）+ C2（frontier 命令）+ C3（handoff 渲染 FR/AC）+ C4（schema 注入 layerSpecific）+ C5（subagent-guidance）
> **依赖**：无（cw 改动互相独立），但 C2 被 workflow 脚本和崩溃恢复消费

---

## 0. 问题回顾

两轮审查发现 cw 侧 5 个缺口：
- **C1**：cw execute 返回值不含全部子 unit id（只有 crossLayer 第一个）
- **C2**：frontier 命令不存在 + 层语义未定义（崩溃恢复 + 状态查询必需）
- **C3**：handoff 不渲染 FeatureSpec（FR/AC），design-review agent 填 frAcCoverageNote 时看不到
- **C4**：design-review schema 注入基类，不暴露 layerSpecific 字段名，agent 靠 gate fail 试错
- **C5**：subagent-guidance 禁止 planning retrospect 委派，与递归方案冲突

---

## 1. C1：execute 返回 childUnitIds

### 问题

`ActionResult`（`handlers/types.ts:87-111`）没有 `executeResult`/`childUnitIds`。cw execute 的 JSON 只返回 `nextAction.crossLayer.targetUnitId`（第一个 child）。

### 改动

**改动 1**：`handlers/types.ts` ActionResult 加字段

```typescript
export interface ActionResult {
  // ...现有字段...
  /** execute 后新建的子层 unit id 列表（仅 execute action 返回，其他 action undefined） */
  childUnitIds?: string[];
}
```

**改动 2**：各 execute handler 填入 childUnitIds

`epic/execute.ts`、`feature/execute.ts`、`slice/execute.ts` 的 return 语句：

```typescript
return {
  unitId: unit.id,
  status: unit.status,
  ok: true,
  childUnitIds: [...unit.executeResult.childUnitIds],  // 新增
  nextAction: buildXxxNextAction(unit, "execute", { crossLayer }),
};
```

### 效果

agent 调 `cw execute --unitId X` 后，stdout JSON 含 `childUnitIds: ["feature:xxx::a", "feature:xxx::b"]`。agent 直接拿来填 schema children，无需额外调 `cw tree`。

---

## 2. C2：frontier 命令（核心，含两遍扫描算法）

### 问题

frontier 命令不存在。它是 workflow BFS 崩溃恢复 + 状态查询的基础。

### 设计

#### 命令接口

```bash
cw frontier --root <unitId> [--format json]
```

输出所有非终态节点 + 各自 nextAction + 是否阻塞（等子层）。

#### 输出格式

```json
{
  "rootUnitId": "epic:xxx",
  "nodes": [
    {
      "unitId": "feature:xxx::a",
      "scope": "feature",
      "status": "executing",
      "nextAction": "retrospect",
      "blocked": false,
      "parentUnitId": "epic:xxx",
      "childUnitIds": ["slice:xxx::a::s1", "slice:xxx::a::s2"]
    },
    {
      "unitId": "slice:xxx::a::s1",
      "scope": "slice",
      "status": "executing",
      "nextAction": "retrospect",
      "blocked": true,
      "blockedReason": "子层有未终态节点: wave:xxx::a::s1::w1",
      "parentUnitId": "feature:xxx::a",
      "childUnitIds": ["wave:xxx::a::s1::w1"]
    }
  ]
}
```

#### 两遍扫描算法

```
输入: rootUnitId
输出: 非终态节点列表（含 blocked 标记）

Pass 1: 收集节点 + 标记基础状态
  - 从 root 递归 findChildren，收集整棵树的 WorkUnitRecord
  - 过滤掉终态（closed/aborted）
  - 对每个非终态节点，用 status→action 映射（render.ts:497-521）算 nextAction

Pass 2: 计算 blocked 标记
  - 对每个 planning 层节点（scope = epic/feature/slice）且 status = executing：
    - 查其所有 children（findChildren）
    - 若全部终态 → blocked = false（可推进，nextAction = retrospect）
    - 若有非终态 → blocked = true（等子层完成）
  - wave 节点：blocked 恒 false（wave 是叶子，不依赖子层）
  - planning 层非 executing 状态（created/clarifying/planning/design-reviewed）：blocked = false

返回: Pass 1 的节点列表，每个附带 Pass 2 的 blocked 标记
```

#### 边界情况

| 情况 | 处理 |
|------|------|
| planning executing 且 children 列表为空（execute 没建子层？）| blocked = false（异常情况，agent 调 retrospect 会 fail all-waves-closed gate，但 frontier 不拦）|
| 节点正在被某个 agent 处理（status 没变，还在跑）| frontier 无法知道"正在跑"（cw status 是最后写入的状态）。依赖 workflow 脚本的内存态（BFS queue）避免重复派发 |
| 嵌套阻塞（slice blocked 等 wave，feature blocked 等 slice）| 两遍扫描足够——Pass 2 只看直接子层。feature blocked 与否取决于直接子 slice 是否全终态，不递归到 wave |

#### 实现位置

`src/readonly/render.ts` 新增 `renderFrontier(unit, store)`，或新建 `src/readonly/frontier.ts`。注册到 cli.ts 的 READONLY_QUERIES。

---

## 3. C3：handoff 渲染 FeatureSpec（FR/AC）

### 问题

`render.ts:840-899` renderDecisionsSection 只渲染 `clarifications[].resolution`，丢弃 spec 容器。feature 的 FeatureSpec（FR/AC/UC）存在 `unit.clarifications.spec`，但 handoff 不渲染它。

design-review agent 填 `frAcCoverageNote` 时看不到 FR/AC，被迫编造。

### 改动

**改动 3**：`render.ts` renderDecisionsSection 补渲染 FeatureSpec

在 feature 层（unit.scope === "feature"）时，额外渲染 spec 段：

```typescript
// renderDecisionsSection 内，feature 层特判
if (unit.scope === "feature" && unit.clarifications?.spec) {
  const spec = unit.clarifications.spec;
  lines.push("### 功能需求与验收条件");
  for (const fr of spec.functionalRequirements ?? []) {
    lines.push(`- FR ${fr.id}: ${fr.title} (验收: ${(fr.ac ?? []).join(", ")})`);
  }
  for (const ac of spec.acceptanceCriteria ?? []) {
    lines.push(`- AC ${ac.id}: ${ac.condition}`);
  }
}
```

### 效果

feature 的 plan/design-review agent 读 handoff 时能看到 FR/AC 的 id 和内容，正确填 `inheritedItemIds` 和 `frAcCoverageNote`。

---

## 4. C4：design-review schema 注入 layerSpecific 字段名

### 问题

`feature-internal.ts:75` 等注入的是基类 `DesignReviewJudgment`（`layerSpecific: Record<string,string>`），不暴露各层具名字段（FeatureDesignReviewLayerSpecific 6 字段等）。agent 不知道该填哪些 key。

### 改动

**改动 4**：各层 `get{Scope}SchemaText("design-review")` 注入该层 LayerSpecific

查 `judgments.ts` 各层 LayerSpecific interface 的字段名：
- epic: strategicAlignment / featureSplitRationale / scopeBoundary / priorityRationale / resourceEstimate（5 字段）
- feature: specMeceNote / sliceSplitRationale / acVerifiabilityNote / consistencyNote / frAcCoverageNote / sliceSpecCoverageNote（6 字段）
- slice: techChoiceRationale / interfaceContractNote / dataModelSoundness / errorCoverage / testabilityNote / crossWaveContractNote（6 字段）
- wave: implApproachNote / testDesignNote / riskMitigationNote / qualityGateNote（4 字段）

改 `get{Scope}SchemaText` 或对应的 guidance 模板，在 design-review 阶段的 schema 文本里列出该层字段名：

```typescript
// 示例：feature design-review schema 文本
const FEATURE_LAYER_SPECIFIC_FIELDS = [
  "specMeceNote", "sliceSplitRationale", "acVerifiabilityNote",
  "consistencyNote", "frAcCoverageNote", "sliceSpecCoverageNote"
];
// guidance 里加一行：
// layerSpecific 必须包含以下 key: ${FEATURE_LAYER_SPECIFIC_FIELDS.join(", ")}
```

### 效果

design-review agent 从 guidance 知道该填哪些 key，不再靠 gate fail 试错。

---

## 5. C5：subagent-guidance 允许 planning retrospect 委派

### 问题

`subagent-guidance.ts:102-133` PLANNING_RULES：`retrospect: { level: "forbidden", reason: "..." }`。递归方案里 planning retrospect 必须委派给 agent。

### 改动

**改动 5**：`subagent-guidance.ts` PLANNING_RULES retrospect 从 forbidden 改为 optional

```typescript
retrospect: {
  level: "optional",  // 从 forbidden 改
  reason: "planning retrospect 验收子层交付。递归模式下可委派，agent 读 cw handoff + 子层 session jsonl 做复盘",
},
```

execute 保持 forbidden（execute 是拆分+下沉的编排决策，不可卸载）。

---

## 6. 改动清单总表

| # | 文件 | 改动 | 工作量 |
|---|------|------|--------|
| 1 | `handlers/types.ts` | ActionResult 加 childUnitIds | 小 |
| 2 | `epic/execute.ts` + `feature/execute.ts` + `slice/execute.ts` | return 填 childUnitIds | 小 |
| 3 | `readonly/render.ts` 或 `readonly/frontier.ts` | 新增 frontier 命令（两遍扫描）| 中 |
| 4 | `readonly/render.ts` renderDecisionsSection | 补渲染 FeatureSpec FR/AC | 小 |
| 5 | `feature-internal.ts` / `slice-internal.ts` / `epic-internal.ts` / wave guidance | design-review schema 注入 layerSpecific 字段名 | 小 |
| 6 | `guidance/subagent-guidance.ts` | PLANNING_RULES retrospect → optional | 小 |

**总工作量**：C2（frontier）是中等，其余都是小改动。可以一次 PR 完成。

---

## 7. 验证里程碑

### 里程碑 1：C1 验证

```bash
cw create slice --slug test --objective "..."
cw plan --unitId slice:test --input '{"split":[{"slug":"w1"}, {"slug":"w2"}]}'
cw design-review --unitId slice:test --input '...'
cw execute --unitId slice:test
# 验证 stdout JSON 含 childUnitIds: ["wave:test::w1", "wave:test::w2"]
```

### 里程碑 2：C2 验证

```bash
# 建一棵部分完成的树，验证 frontier 的 blocked 标记
cw frontier --root epic:test --format json
# 验证：executing 且子层未完成的 planning 节点 blocked=true
```

### 里程碑 3：C3/C4 验证

```bash
cw create feature --slug test --objective "..."
cw clarify --unitId feature:test --input '{"spec":{"functionalRequirements":[{"id":"FR1","title":"...","ac":["AC1"]}],"acceptanceCriteria":[{"id":"AC1","condition":"..."}]}}'
cw handoff --unitId feature:test
# 验证：handoff 输出含 FR1/AC1
cw plan --unitId feature:test --input '...'
cw handoff --unitId feature:test
# 验证：design-review guidance 含 layerSpecific 字段名列表
```
