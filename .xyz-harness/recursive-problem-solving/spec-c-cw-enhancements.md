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
  /** execute 后新建的子层 unit 信息（仅 execute action 返回，其他 action undefined）。
   * 含 unitId + dependsOn，供 workflow BFS 拓扑排序消费。 */
  children?: Array<{ unitId: string; dependsOn: string[] }>;
}
```

**改动 2**：各 execute handler 填入 children（含 dependsOn）

`epic/execute.ts`、`feature/execute.ts`、`slice/execute.ts` 的 return 语句。从 `unit.plan.split`（含 `dependsOn`）与 `unit.executeResult.childUnitIds` 关联：

```typescript
// 关联 plan.split 的 dependsOn 到 childUnitIds
const children = unit.plan.split.map((s, i) => ({
  unitId: unit.executeResult.childUnitIds[i],
  dependsOn: s.dependsOn?.map(d => {
    // split.dependsOn 存的是 slug，需映射到 childUnitId
    const depIdx = unit.plan.split.findIndex(ds => ds.slug === d);
    return unit.executeResult.childUnitIds[depIdx];
  }).filter(Boolean) ?? [],
}));

return {
  unitId: unit.id,
  status: unit.status,
  ok: true,
  children,  // 含 unitId + dependsOn
  nextAction: buildXxxNextAction(unit, "execute", { crossLayer }),
};
```

**为什么 children 含 dependsOn**（逻辑审查 X-1/一致性 3.4）：workflow BFS 的 topoSort 依赖 `node.dependsOn` 做拓扑排序（spec-f F3）。如果 execute 返回值只给 childUnitIds 不给 dependsOn，agent 要从 handoff 读 plan.split 获取依赖——但 handoff 的 split 渲染不含 dependsOn 字段（render.ts 只渲染 slug+description）。让 cw execute 直接在 ActionResult 里返回完整的 `{unitId, dependsOn}` 结构，agent 不需要解析——直接从 stdout JSON 拿到。

### 效果

agent 调 `cw execute --unitId X` 后，stdout JSON 含 `children: [{unitId:"feature:xxx::a", dependsOn:[]}, {unitId:"feature:xxx::b", dependsOn:["feature:xxx::a"]}]`。agent 直接拿来填 schema children，无需额外调 `cw tree`。

---

## 2. C2：frontier 命令（核心，含两遍扫描算法）

**改动 3**：新增 frontier 命令。

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
      "unitId": "wave:xxx::w1",
      "scope": "wave",
      "status": "executing",
      "nextAction": "test",
      "blocked": false,
      "dependsOn": [],
      "parentUnitId": "slice:xxx::s1"
    },
    {
      "unitId": "wave:xxx::w2",
      "scope": "wave",
      "status": "created",
      "nextAction": "clarify",
      "blocked": false,
      "dependsOn": ["wave:xxx::w1"],
      "parentUnitId": "slice:xxx::s1"
    },
    {
      "unitId": "slice:xxx::s1",
      "scope": "slice",
      "status": "executing",
      "nextAction": "retrospect",
      "blocked": true,
      "blockedReason": "子层有未终态节点: wave:xxx::w1, wave:xxx::w2",
      "dependsOn": [],
      "parentUnitId": "feature:xxx::a",
      "childUnitIds": ["wave:xxx::w1", "wave:xxx::w2"]
    }
  ]
}
```

**`dependsOn` 字段**（一致性审查 3.5）：从 cw 的 `plan.split.dependsOn`（slug 列表）映射到 childUnitId 列表。崩溃恢复时 workflow BFS 的 topoSort 依赖此字段做拓扑排序——否则重建的 queue 全是无依赖节点，有依赖的 wave 并发执行导致产出冲突。映射逻辑与 C1 改动 2 相同（slug → childUnitId）。

#### 两遍扫描算法

```
输入: rootUnitId
输出: 非终态节点列表（含 blocked 标记）

Pass 1: 收集节点 + 标记基础状态
  - 从 root 递归 findChildren，收集整棵树的 WorkUnitRecord
  - 过滤掉终态（closed/aborted）
  - 对每个非终态节点，用 status→action 映射（render.ts:497-521）算 nextAction

Pass 2: 计算 blocked 标记（两类阻塞）
  类型 A — planning 层等子层完成：
  - 对每个 planning 层节点（scope = epic/feature/slice）且 status = executing：
    - 查其所有 children（findChildren）
    - 若全部终态 → blocked = false（可推进，nextAction = retrospect）
    - 若有非终态 → blocked = true（等子层完成）

  类型 B — wave 层等依赖 wave 完成（v3 新增，致命缺陷 2 修复）：
  - **关键：wave 没有 plan.split（叶子，cw 自动填 split=[]）**。
    wave 的 dependsOn 信息只存在于**父 slice 的 plan.split[]** 里。
    frontier 必须做反向查找才能拿到 wave 的 dependsOn。
  - **反查方式（childDelivery 显式映射，v6 升级为主方案）**：用 `resolveChildDependsOn(splits, childDelivery)` 经父 slice 的 `evidence.childDelivery` 反查——cw 增强设计报告 §1.3 修正 3/4 确认此方式更鲁棒（不读 childStatus，天然处理 duplicate slug 边界）。调用链：
    1. findParentSlice(W) → 拿到父 slice S
    2. resolveChildDependsOn(S.plan.split, S.evidence.childDelivery) → 返回所有子的 `{childUnitId, dependsOn}` 数组
    3. 在返回数组里 find(item => item.childUnitId === W.id) → 取 W 的 dependsOn（childUnitId 列表）
    4. 查 dependsOn 里的每个 childUnitId 是否终态 → 有未终态则 W blocked=true
  - **旧 slug 匹配写法（v5 及之前，已废弃但仍能跑通）**：`<slice.slug>::<split.slug>` 字符串匹配 wave id 的 slug 部分 → 读 split.dependsOn（兄弟 slug）→ 映射回 wave unitId。childDelivery 反查取代它的原因：duplicate slug 会让字符串匹配错配，childDelivery 的 `{splitSlug, childUnitId}` 显式映射无歧义。
  - 查到 wave 的 dependsOn（wave unitId 列表）后：
    - 全部终态 → blocked = false
    - 有未终态 → blocked = true（blockedReason: "依赖 wave:X 未完成"）
  - wave 无 dependsOn（父 slice 的 split 里没声明）→ blocked = false

  planning 层非 executing 状态（created/clarifying/planning/design-reviewed）：blocked = false

返回: Pass 1 的节点列表，每个附带 Pass 2 的 blocked 标记
```

**类型 B（wave blocked）的必要性**（第三轮审查致命缺陷 2）：frontier 驱动模型下，wave B dependsOn A。若 frontier 只对 planning 标 blocked（类型 A），wave blocked 恒 false → B 在 A 未 closeout 前被标 !blocked → BFS 提前派发 B → B 的 execute 看不到 A 的代码（A 还没写或还没 closeout）。扩展 wave blocked 让 B 在 A closeout 前保持 blocked，A 终态后 B 才解除。

**反向查找的必要性**（第四轮审查高风险）：wave 是叶子，自身 plan.split 为空。dependsOn 只在父 slice 的 plan.split 里声明（split 项的 dependsOn 字段，存兄弟 slug）。不显式描述反向查找，实现者可能读 `wave.plan.split`（恒空）→ 类型 B 失效 → 致命缺陷 2 未修复。

**childDelivery 反查为主方案**（v6 升级，原第五轮审查的"非致命优化建议"已转正）：父 slice 的 `evidence.childDelivery: ChildDeliveryRecord[]` 存 `{splitSlug, childUnitId, childStatus}` 显式映射（execute 阶段写入）。类型 B 经 `resolveChildDependsOn(splits, childDelivery)` 反查（cw 增强设计报告 §1.3 修正 3/4）。显式声明：映射只用 `splitSlug + childUnitId` 两字段，**不读 childStatus**——execute 调用点刚 push 完 childDelivery 时 childStatus=pending，frontier 调用点 childStatus 反映终态，映射逻辑与 childStatus 无关。`resolveChildDependsOn` 封装在新建的 `core/hierarchy.ts`（跨父子 WorkUnit 关系的只读遍历工具），C1 的 execute handler 不调它（execute 循环里直接正向构建 children）。

**旁路发现**（第五轮审查）：cw 无 duplicate-slug gate——split 同 slug 会导致 child wave id 冲突覆盖（store 按 id save）。建议 cw 补 duplicate-slug 校验（design-review gate 层），非本 spec 范围。

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

**改动 4**：`render.ts` renderDecisionsSection 补渲染 FeatureSpec

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

**改动 5**：各层 `get{Scope}SchemaText("design-review")` 注入该层 LayerSpecific

查 `judgments.ts` 各层 LayerSpecific interface 的字段名：
- epic: strategicAlignment / featureSplitRationale / scopeBoundary / priorityRationale / resourceEstimate（5 字段）
- feature: specMeceNote / sliceSplitRationale / acVerifiabilityNote / consistencyNote / frAcCoverageNote / sliceSpecCoverageNote（6 字段）
- slice: techChoiceRationale / interfaceContractNote / dataModelSoundness / errorCoverage / testabilityNote / crossWaveContractNote（6 字段）
- wave: testCaseCoverageNote / boundaryConditionNote / mockStrategyNote / tddRedReadinessNote（4 字段，核实自 `WaveDesignReviewLayerSpecific` judgments.ts:53-58，全 optional）

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

## 5. C5：subagent-guidance 允许 planning + wave retrospect 委派

### 问题

`subagent-guidance.ts` 两层都有 retrospect=forbidden：
- `PLANNING_RULES`（:102-133）：`retrospect: { level: "forbidden" }`
- `WAVE_RULES`（:47-93）：`retrospect: { level: "forbidden" }`

递归方案里**每 action 一个 agent**（决策 A），planning 和 wave 的 retrospect 都由独立 agent 执行。cw 的 guidance 会在 agent 读 handoff 时显示"不建议委派给 subagent"——与"这个 agent 本身就是被委派来执行 retrospect 的"自相矛盾。

### 改动

**改动 6a**：`PLANNING_RULES.retrospect` 从 forbidden → optional

```typescript
retrospect: {
  level: "optional",
  reason: "planning retrospect 验收子层交付。递归模式下可委派，agent 读 cw handoff + 子层 session jsonl 做复盘",
},
```

**改动 6b**：`WAVE_RULES.retrospect` 从 forbidden → optional（覆盖度审查发现 C5 原版遗漏了 wave 层）

```typescript
retrospect: {
  level: "optional",
  reason: "wave retrospect 复盘本 wave 执行。递归模式下由独立 agent 执行",
},
```

**execute 保持 forbidden**（planning 层）：execute 是拆分+下沉的编排决策，不可卸载。

**mandatory 档位说明**（wave execute/design-review 等）：递归模式下每 action 都是委派的，mandatory（"建议委派"）自动满足，guidance 文案不阻断，可不改。

---

## 6. 改动清单总表

| # | 文件 | 改动 | 工作量 |
|---|------|------|--------|
| 1 | `handlers/types.ts` | ActionResult 加 `children: {unitId, dependsOn}[]` | 小 |
| 2 | `epic/execute.ts` + `feature/execute.ts` + `slice/execute.ts` | return 填 children（含 dependsOn 映射）| 小 |
| 3 | `readonly/frontier.ts`（新文件）或 `render.ts` | 新增 frontier 命令（两遍扫描 + dependsOn + blocked）| 中 |
| 4 | `readonly/render.ts` renderDecisionsSection | 补渲染 FeatureSpec FR/AC | 小 |
| 5 | `feature-internal.ts` / `slice-internal.ts` / `epic-internal.ts` / wave guidance | design-review schema 注入 layerSpecific 字段名 | 小 |
| 6a | `guidance/subagent-guidance.ts` PLANNING_RULES | retrospect → optional | 小 |
| 6b | `guidance/subagent-guidance.ts` WAVE_RULES | retrospect → optional | 小 |

**总工作量**：C2（frontier）是中等，其余都是小改动。可以一次 PR 完成。

---

## 7. 验证里程碑

### 里程碑 1：C1 验证

```bash
cw create slice --slug test --objective "..."
cw plan --unitId slice:test --input '{"split":[{"slug":"w1"}, {"slug":"w2"}]}'
cw design-review --unitId slice:test --input '...'
cw execute --unitId slice:test
# 验证 stdout JSON 含 children: [{unitId:"wave:test::w1", dependsOn:[]}, {unitId:"wave:test::w2", dependsOn:[]}]
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
