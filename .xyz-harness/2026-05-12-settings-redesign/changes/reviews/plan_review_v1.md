# 计划评审 v1

## 评审记录
- 评审时间：2026-05-13 14:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-12-settings-redesign/plan-model-toggle.md`
- 参考文档：`spec.md`（同目录），`CLAUDE.md`（项目根）

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan Task 4 `useProvider.ts` | **前端乐观更新缺失**：toggle 发出后到 `model.list` 广播回来之间有 RTT 延迟，UI 不会立即变化（toggle switch 不翻转），用户会感觉点击无响应然后突然变化。对比 Skill/Agent toggle：前端 store 立即修改本地 `enabled` 状态（`setSkill({ ...s, enabled: !s.enabled })`），UI 即时响应，WS 广播到达后覆盖为服务端状态。Model toggle 缺少这一步。 | ProviderPane.toggleModel 中，发 WS 前先乐观更新 `models.value`（`providerStore` 没有 `updateModel` 方法，需新增，或直接 mutate `models.value` 中对应项的 `enabled`）。 |
| 2 | MUST FIX | plan Task 3c `server.ts` | **`toggleModelEnabled` 失败时（model not found）只回复发送者，不广播**。但如果失败原因是 model 确实不存在（被其他客户端删除了），前端 models 列表中仍然有这个 model 的 stale 数据，不会自动清理。 | 失败时也调用 `this.broadcastProviderList()`（让前端拿到最新的 providers + models），或在 `model.toggled` 回复中加 `reason: 'not_found'`，前端收到后主动刷新 provider 列表。 |
| 3 | MUST FIX | plan Task 6d `ProviderModal.vue` | **discoverModels handler 的 merge 逻辑位置不对**。Plan 写"约第 224 行"，但实际代码中这个 handler 是在 `discoverHandler` 闭包内（ProviderModal.vue 约 L218-235），是一个匿名函数，不是独立函数。Plan 中的代码片段 `modalModels.value = models.map(m => { const existing = ... })` 需要替换 handler 中的 `modalModels.value = models.map(m => ({ id: m.id, name: m.name, ctx: m.ctx, tags: [] }))`。执行 agent 如果直接按 plan 片段查找会找不到匹配位置。 | 给出精确的 oldText（当前代码）和 newText（替换后代码），或至少指出这个 handler 在 `discoverHandler` 变量赋值处（L218-228），不是独立函数。 |
| 4 | MUST FIX | plan Task 3c `server.ts` | **`provider-store.ts` 描述为"新增 toggleModel 函数"（文件变更清单第 4 行），但 plan 正文 Task 3a 中只有 setProvider 的类型修改，没有 toggleModel 函数的实现。** 实际上 server.ts 直接调用 config-store 的 `toggleModelEnabled` + `providerStore.reload()`，不需要 provider-store 层再包一层。文件变更清单与正文不一致。 | 二选一：(A) 从文件变更清单中删除"新增 toggleModel 函数"，只保留 setProvider 类型修改；(B) 如果确实要在 provider-store 中加 toggleModel 封装，在 Task 3a 中补上实现。推荐 A。 |
| 5 | LOW | plan Task 2b `config-store.ts` | **string model 升级为对象时丢失 name/ctx/tags**：`{ id: m, enabled }` 只有 id 和 enabled，但 aggregateModels 在 string 分支通过 `lookupModel(entry)` 查询得到 name 和 contextWindow。升级后的对象 `{ id: "glm-5.1", enabled: false }` 在下次 aggregateModels 走 object 分支时，没有 name 字段，会 fallback 到 `String(meta.name ?? meta.id)` = `"glm-5.1"`。name 如果和 lookupModel 结果不一致就会显示差异。实际上 `lookupModel` 返回的 name 可能是友好名（如 "GLM-5 Turbo"），升级后丢失了这个友好名。 | string 升级时保留 lookupModel 查询结果：`{ id: m, name: dbRecord?.name, ctx: dbRecord?.context, enabled }`。这样下次 aggregateModels 走 object 分支时数据完整。 |
| 6 | LOW | plan Task 3c `server.ts` | **import 路径缺少 `.js` 后缀说明**。Plan 写 `import { toggleModelEnabled } from './config-store.js'`，但这是 ESM import。项目其他 import（如 `import { updateToolPermissions, ... } from './config-store.js'`）已经用 `.js` 后缀，所以没问题，但 plan 应该说明这一点让执行 agent 知道这不是错误。 | 在 Task 3c 中加注：项目使用 ESM，import 必须带 `.js` 后缀（见 server.ts 顶部已有 import 的模式）。 |
| 7 | INFO | plan 整体 | **验收标准没有明确量化**。Spec 中 ProviderSection 的 toggle 行为在 7.2 CRUD 操作表中只有"无 toast（视觉 toggle 即反馈）"，没有说"toggle 后 opacity 变化"或"config.json 中 model.enabled 字段更新"。Plan 的 Task 7 验证步骤是手动的，没有可自动化的断言。 | 这不是 plan 的问题——是 spec 的验收标准本身模糊。记录即可，不阻塞 plan 评审。 |

### 检查维度逐项结论

#### 1. spec 覆盖完整性

Spec 的数据流图（4.1 节）中 ProviderSection 部分只写了 `→ config.setProvider / config.deleteProvider / model.switch`，没有 model toggle 的明确协议。但 spec 7.2 CRUD 表中没有 Model Row 的 toggle 行（只有 Skill/Agent 的 toggle），说明 spec 本身可能遗漏了 model toggle 的需求描述。

Plan 的设计（新增 `model.toggle`）超出了 spec 4.1 数据流图中 `model.switch` 的描述，但这是合理的——spec 写的是已有逻辑，而 model toggle enabled 是 E2E 测试发现的新需求。Plan 在"问题"章节说明了这个 gap。

**结论**：plan 覆盖了 spec 中 ProviderSection 的 toggle 需求（隐含在 `ModelRow.vue` 的 `toggle-enabled` emit 和 `ModelInfo.enabled` 字段中），且合理扩展了协议。

#### 2. plan 可行性

- **任务拆分**：7 个 task，依赖关系清晰（Task 1 → 2 → 3 → 4/5 并行 → 6 → 7），粒度适中
- **工作量**：总计 ~70 行代码改动 + 类型定义，现实
- **遗漏**：
  - 乐观更新（Issue #1）是一个功能性遗漏，不补会导致 UX 回归
  - provider-store.ts 描述与正文不一致（Issue #4）

#### 3. spec 与 plan 一致性

- plan 超出 spec 的部分：新增 `model.toggle` / `model.toggled` 协议消息。这是 spec 遗漏，plan 合理补充
- plan 的 Task 6（ProviderModal 保留 enabled）是防御性修复，spec 未明确要求但确实需要
- plan 没有遗漏 spec 中 Provider 相关的需求

### 结论

需修改后重审。4 条 MUST FIX：

1. **乐观更新**（功能性缺失，UX 回归）
2. **失败时 stale data 清理**（数据一致性问题）
3. **discoverModels handler 定位不精确**（执行 agent 会找不到代码位置）
4. **文件变更清单与正文不一致**（provider-store toggleModel 描述）

### Summary

计划评审完成，第1轮需重审，4条MUST FIX（乐观更新缺失、失败路径数据清理、代码定位不精确、清单不一致），2条LOW，1条INFO。
