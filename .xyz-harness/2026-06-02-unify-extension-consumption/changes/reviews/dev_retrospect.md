---
phase: dev
verdict: pass
absorbed: false
topic: "2026-06-02-unify-extension-consumption"
harness_issues:
  - "五步审查的 Batch 1 并行 dispatch 中，Standards 和 Taste 审查用了专用 agent（review-standards、review-taste）但 task prompt 构造方式不一致——Standards 用 general-purpose + 手动指定 read skill，Taste 用 review-taste agent。应统一为一种模式"
  - "Integration Review 依赖 BLR 产出，但实际执行中 Batch 1 的 BLR 发现 MUST_FIX 需要代码修复，修复后 BLR v2 才能通过。这意味着 Batch 2 不能在 Batch 1 完成后立即执行——需要等代码修复完成。Skill 应明确这个时序约束"
  - "gate check 对 review 文件名的匹配逻辑（taste_review* glob）会匹配到 ts_taste_review_v1.md 和 v2 两个文件，但没有校验是否都是 pass。如果 v1 是 fail v2 是 pass，gate 仍然通过——这可能是预期行为（最终通过即可），但应明确"
---

# Phase 3 Retrospect: Dev

## 1. Phase Execution Review

### Summary

按复杂路径（5+ tasks，跨前后端，3 Execution Groups）执行，通过 subagent dispatch 完成 6 个 Task（Task 1/2/3a/3b/4/5）。产出 10 个源文件变更 + 15 个测试 + 10 个审查报告（5 个 v1 + 5 个 v2）。两轮审查循环：v1 发现 8 个 MUST_FIX（BLR 2 + Standards 2 + Taste 1 + Robustness 3），全部修复后 v2 通过。

### Problems Encountered

1. **piExtension 字段不存在（BLR #1）**。BG1 subagent 假设 pi-ext 包有 `piExtension` 字段并据此过滤，但实际所有 12 个包都没有这个字段。导致 npm 源始终返回空 Map——UC-1/UC-3/UC-5 全部阻断。根因：subagent 按计划代码实现，没有先验证实际包的 package.json 结构。修复：移除 piExtension 检查，改为 `pi-` 前缀匹配。

2. **去重 key 语义不一致（BLR #2）**。npm 源用 `pkg.name`（`@zhushanwen/pi-goal`）作 key，其他源用目录名（`pi-goal`）。同名 extension 在不同源中 key 不同，去重失效。根因：subagent 按计划中的 `extName = pkg.name ?? entry` 实现，没有意识到 scoped package name 和目录名的差异。修复：`replace(/^@[^/]+\//, '')` 提取短名。

3. **文件型 extension 被过滤（Integration #1）**。ExtensionResolver 的 `scanUserExtensions` 对所有路径做 `isDirectory()` 校验，但 xyz-agent 的 navigate extension 是单个 JS 文件（`xyz-agent-extension.js`），被静默跳过。这是引入 ExtensionResolver 后的回归——旧代码直接追加文件路径。修复：在 `session-service.getExtensionPaths()` 中检测文件型 extension 并直接追加。

4. **ExtensionStatusBar.vue 死代码（Standards #1）**。FG1 subagent 创建了 ExtensionStatusBar 组件，但 ChatPanel 已经内联渲染了 status 条目。无人引用这个组件。根因：plan 中指定创建此组件，但 subagent 没有检查它是否被实际使用。修复：删除。

5. **EXTENSION_EVENTS 常量未引用（Taste #1）**。shared/extension.ts 定义了 `EXTENSION_EVENTS` 常量，但 event-adapter 和 composable 都硬编码了 `'extension.widget'`/`'extension.status'` 字符串。常量成为死代码。修复：改为引用常量。但引入了一个语法问题——`as ServerMessageType` 在对象字面量中不被 oxc 解析，需要用中间变量解决。

6. **ExtensionResolver 零日志 + 注释矛盾（Robustness #1/#3）**。所有 catch 块静默吞异常，生产环境 extension 消失无从排查。resolve() 注释说"高优先级后写覆盖"但实际由 deduplicate 独立排序。修复：添加 console.log/warn 日志，修正注释。

7. **replace_text 工具的残留文本问题**。用 `replace_text` 替换 event-adapter.ts 中的字符串时，工具行为不如预期——留下了重复的 `type: type:` 前缀和尾部逗号。需要用 `sed` 清理。这提示在有多处相同字符串替换时，应优先用 `read` + `edit`（hashline）而非 `replace_text`。

### What Would You Do Differently

- **先验证外部假设再编码**。piExtension 字段、去重 key 格式、文件型 extension——这三个问题的根因都是"按假设编码，未先验证实际数据"。正确做法：编码前先 `cat node_modules/@zhushanwen/pi-goal/package.json` 确认字段结构。
- **subagent task prompt 应包含"先验证"步骤**。对于涉及外部系统（npm 包结构、pi 启动参数格式）的 Task，应在 prompt 中要求 subagent 先读取实际数据再编码。
- **死代码检测应自动化**。ExtensionStatusBar.vue 的创建和删除是纯浪费。如果 eslint 或 pre-commit hook 有"未引用组件"检测，可以在 CI 阶段拦截。

### Key Risks for Later Phases

1. **pi-ext 包以 TS 源码发布**（无 `dist/index.js`）。当前 jiti 能编译 TS，但性能较差（每次 session 创建都要编译 12 个包）。FR-4（编译产物）仍为 postponed。
2. **`@zhushanwen/pi-vision` 不存在于 npm**。已跳过，但 spec 中列出了 12 个包。需要在 pi-ext 仓库中发布或从 spec 中移除。
3. **传递依赖列表可能不完整**。electron-builder.yml 的 extraResources 配置基于静态扫描，但 npm install 后的传递依赖可能随版本变化。preflight-check.sh 的动态检查应该能拦截。
4. **前端 widget/status 集成尚未做视觉验证**。vue-tsc 和 vite build 通过，但 ExtensionWidgetPanel 的实际渲染效果需要在 `npm run dev` 中手动确认。

## 2. Harness Usability Review

### Flow Friction

- **五步审查的并行/串行编排复杂**。Batch 1（4 个并行）+ Batch 2（1 个串行，依赖 BLR）的模型在理论上合理，但实际执行中 BLR v1 发现 MUST_FIX → 修复代码 → BLR v2 → Integration v2，这意味着 Batch 2 需要等 Batch 1 的修复完成。这个时序约束在 skill 中没有明确说明。
- **v1→v2 的审查循环是手动的**。需要主 agent 手动检查每个 v1 报告的 must_fix，修复代码，重新 dispatch v2 审查。5 个审查 × 2 轮 = 10 次 dispatch。如果自动检测 must_fix > 0 就触发修复循环，效率会更高。

### Gate Quality

- Phase 3 gate 从 Phase 2 的 10 项增加到 18 项，新增了 5 步审查的 verdict + must_fix 检查 + test_results 的 all_passing 检查。覆盖全面，无误报。
- **taste_review 的文件名匹配**：gate 用 glob `taste_review*.md` 匹配，也匹配到 `ts_taste_review_v1.md` 和 `ts_taste_review_v2.md`。如果未来添加了 `taste_review_v1.md`（Python 项目），可能产生冲突。

### Prompt Clarity

- Phase 3 skill 的步骤定义清晰：防护预检 → TDD/编码 → 测试 → 五步审查 → 复盘 → Gate。每步有明确的输入/输出。
- **防护预检步骤有价值**。发现了 pre-commit hook 未安装的问题，通过 `bash .githooks/install-hooks.sh` 修复。如果没有这个步骤，后续 commit 会缺少 lint/typecheck 检查。

### Automation Gaps

- **subagent 产出验证仍是手动的**。BG1 subagent 报告"554 tests passed"，但实际有 4 个测试文件失败（renderer 侧的 .vue 解析问题）。需要主 agent 手动运行测试确认。
- **审查报告的 verdict/must_fix 提取**。gate check 脚本能自动解析，但主 agent 在 dispatch 审查后需要手动 grep 结果文件确认 verdict。可以考虑让 subagent 在完成时输出结构化摘要。

### Time Sinks

- **replace_text 工具的残留问题**。event-adapter.ts 的字符串替换花了 3 轮修复（残留文本 → oxc 解析错误 → 中间变量）。总共约 15 分钟浪费在工具行为问题上。
- **ExtensionStatusBar.vue 的创建和删除**。FG1 subagent 创建了一个无人使用的组件，Standards 审查发现后删除。约 10 分钟浪费。
