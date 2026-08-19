# W1b 验收报告：provider-repair 八字段有效性对齐（verifier 对抗式独立验收）

> 验收人：verifier（独立于 builder）。基线 = `w1b-acceptance.md`（C1-C4 + 边界）。
> 验收对象 = 工作区未提交改动（基线 commit `5481b2e9d` 之后的 builder 改动）。
> 日期：2026-08-20。

## 总结论：**PASS**

C1-C4 全过，红性验证过，破坏面核查过，builder 全部声称逐项证实。无 must-fix。
2 条建议级测试覆盖缺口（不影响结论，见 §7）。

---

## 1. 防篡改

- `git diff 5481b2e9d -- .xyz-harness/2026-08-20-pi-assumption-remediation/acceptance/w1b-acceptance.md` → 空（exit 0）。
- shasum-256（工作区 vs 基线 commit 内同值）：
  `c7921355488681bb08a47cceb79ccdbe14f4af5bcf886339a2c89742962e982f`

## 2. 越界扫描

工作区未提交改动逐文件核对豁免名单：

| 文件 | 归属 |
|------|------|
| `packages/runtime/src/infra/pi/pi-provider-repair.ts` | W1b（本次验收） |
| `packages/runtime/src/infra/pi/pi-provider-store.ts` | W1b（本次验收） |
| `packages/runtime/src/__tests__/sanitize-invalid-providers.test.ts` | W1b（本次验收） |
| `packages/runtime/src/__tests__/equivalence/attach-lifecycle.test.ts` | 豁免（并行会话） |
| `packages/runtime/src/infra/pi/session-file-utils.ts` | 豁免（并行会话） |
| `packages/runtime/src/services/startup-background-init.ts` | 豁免（并行会话） |
| `packages/runtime/src/__tests__/session-file-utils-tmp-migrate.test.ts`（??） | 豁免（并行会话） |
| `chat-app/`（??） | 豁免（并行会话） |
| `extensions/model-switch/src/index.ts`、`extensions/model-switch/tests/switch-model.test.ts`（??） | 豁免（W1a 领地，另一 verifier） |

**零越界**。基线与 HEAD 之间的 `docs/architecture/pi-assumption-remediation*.md` 改动来自已提交 commit `3af2baa71`（coordinator 文档），非 builder 工作区改动，不评。

`pi-provider-store.ts` 「仅注释」核实：diff 共 3 hunks，全部 +/- 行为 `//` 注释或 JSDoc ` * ` 行，**无任何代码行变更**（`sanitizeInvalidProviders` 函数体仅上下文行）。

## 3. 命令实跑（C3 / C4）

| 命令 | 结果 |
|------|------|
| `cd packages/runtime && pnpm typecheck` | exit 0，零错误 |
| `cd packages/runtime && pnpm exec vitest run`（全量） | **Test Files 286 passed (286) / Tests 3204 passed (3204)**，Duration 43.66s |
| `python3 .githooks/check_pi_direct_write.py` | exit 0（`[OK] R1 ... 扫描 240 文件，allowlist 命中 0 处`） |

attach-lifecycle 本次一次通过（4 tests, 27.4s），**未复现** builder 所称环境性 flaky——其复跑说法无法证伪，但「全量绿」结论独立成立。

## 4. 同构性独立复核（C1，核心）

pi 侧原文（实读 `node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js:75-93`）：

```js
function applyModelsJson(providerId, baseModels, config) {
    if (!config) return [...baseModels];
    if (config.oauth && !config.baseUrl) {
        throw new Error(`Provider ${providerId}: "baseUrl" is required when "oauth" is set.`);
    }
    const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
    if (!config.models?.length &&
        !config.baseUrl &&
        !config.headers &&
        !config.compat &&
        !hasOverrides &&
        !config.apiKey &&
        !config.oauth &&
        config.authHeader === undefined) {
        throw new Error(`Provider ${providerId}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`);
    }
```

调用点核实：`composeModelProvider`（:293）与 `validateExtensionProvider`（:282）均经 `applyModelsJson`（:345 第三处调用为 override 合并路径）。builder 注释锚点（:86-93 / :285/:293）与实际行号一致。

zod 层原文核实（`model-config.js` ProviderConfigSchema，约 :164-176）：`baseUrl/apiKey: Type.String({minLength:1})`、`oauth: Type.Literal("radius")`、`authHeader: Type.Boolean()`、`models: Type.Array`、`modelOverrides/headers: Type.Record`——builder 注释声称（model-config.js:168/:171）属实。

### 逐字段对照表（pi 抛错条件 ↔ xyz isInvalidProvider）

| 字段 | pi 判定（must-specify 触发） | xyz 判定（无效） | 同构 | 攻击边界实测 |
|------|------------------------------|------------------|------|--------------|
| models | `!config.models?.length` | `Array.isArray && length>0` 取反 | 同构 | `[]` 双方均无效；`"xx"` 见下 |
| baseUrl | falsiness | `!raw.baseUrl` | 同构 | `''` 双方未 specify |
| headers | falsiness | `!raw.headers` | 同构 | `{}`、`[]` 均为 truthy → 双方在场合法 |
| compat | falsiness | `!raw.compat` | 同构 | `{}` truthy → 双方在场合法 |
| modelOverrides | `Object.keys().length > 0` | 同左（+typeof object guard） | 同构 | `{}` 双方无效 |
| apiKey | falsiness | `!raw.apiKey` | 同构（W1b 新增） | `''` 双方未 specify |
| oauth | falsiness | `!raw.oauth` | 同构（W1b 新增） | `''` 双方未 specify |
| authHeader | `=== undefined` | `raw.authHeader === undefined` | 同构（W1b 新增） | **`false` / `null` / `''` 双方均算在场合法**——builder「pi 侧 `=== undefined` 检查使 false 算在场」声称经原文核实属实，xyz 未误用 falsiness |
| 非对象值 | zod ProviderConfigSchema 拒绝 | `typeof !== 'object' || null → true` | 等效拒绝 | null/string 探针过 |

### 探针实测（16 形态，/tmp 脚本，不改仓库）

与 pi must-specify 判定 **14/16 完全一致**。2 处差异均为 **zod 先拒绝的类型非法形态**：

- `models: "xx"`（非数组）：pi must-specify 不抛（`"xx"?.length`=2 truthy）但 zod `Type.Array` 拒绝；xyz 判无效 → sanitize 删除。终态一致（provider 不可用），路径不同（xyz 静默自愈 vs pi 报 schema 错）。
- `modelOverrides: "xx"`：同上（`Object.keys("xx")` 长度 2 → pi hasOverrides true 但 zod Record 拒绝；xyz 判无效删除）。

判定：同构性成立。差异仅存在于「pi 组合层判定与 zod schema 判定的缝隙形态」，xyz 一律取更保守的自愈路径，不产生「xyz 判合法而 pi 拒绝」的新空隙（除 §5.2 已声明的 zod 层职责边界）。

## 5. 「刻意不纳入」两项对抗评估

### 5.1 `oauth && !baseUrl`（留给 pi 组合层）

- **xyz 现行为**：oauth 在场 → 八字段判定合法 → sanitize 保留（数据零丢失）。
- **pi 呈现路径**（实读核实）：`applyModelsJson:82-84` 抛 `Provider <id>: "baseUrl" is required when "oauth" is set.` → `model-runtime.js:151-152` 捕获 → `compositionErrors.set(providerId, msg)` → `getError()` 汇总输出 `Provider "<id>": <message>`。**单 provider 粒度**，不拖垮其他 provider。
- **比静默删除好在哪**：① 配置不丢（可逆——补 baseUrl 即恢复，删除不可逆）；② 错误指名 provider 与修法；③ 与 pi 语义一致（pi 本来就允许该配置进入组合层再报错）。
- **坏在/残留风险**：错误呈现依赖 xyz 上层消费 pi `getError()`（本次未验证 xyz UI 是否透传，属 W1b 边界外）；若不透传则用户只见 provider 不可用而无原因。现实性：xyz `PiProviderConfig` 不声明 oauth（仅 `authMethod` 认证方式字段），renderer/runtime 无写入路径——该形态只能来自手改 models.json / pi 生态工具（radius oauth 是 pi 0.84.1 合法场景），低频但真实。
- **结论**：取舍正确。sanitize 若纳入该条件会重回「误删合法配置」老路（oauth+baseUrl 完整条目被误删只需一个条件写错）。

### 5.2 zod schema 层校验（如 `baseUrl: ""`）

- **xyz 现行为**：`baseUrl: ""` + `apiKey` 在场 → 合法保留（WTC13 明确锁定 + 注释声明 schema 层职责）。
- **pi 呈现路径**（实读核实）：`model-config.js` loadModels → `validateModelsConfig.Check` 失败 → 返回 `ModelConfig(new Map(), "Invalid models.json schema:\n  - providers.<id>.<field>: <message>\n\nFile: <path>")` → **所有 provider 均不加载**（空 Map）。
- **权衡如实评估**：爆炸半径大于静默删单条（一坏全坏 vs 单条失效）；但可见性远好于静默删除（错误带具体 path、schema 原因、文件路径，用户可直接修文件）。且 renderer/runtime 无 `baseUrl: ''` 写入路径（grep 核实零命中），该形态仅手改文件可产生——现实性低。
- **结论**：合理的职责边界。sanitize 不做 schema 校验避免重复实现 zod（两套判定漂移正是本 bug 的根因模式）；代价（整文件失效）有明确错误消息兜底。

## 6. 红性验证

1. 备份 + shasum：`3634e267fc1efd68aeffc93ad1100bbf4d0237af9b556e449bf7771c4d76377b`。
2. 临时退回旧五字段判定（删除 `!raw.apiKey && !raw.oauth && raw.authHeader === undefined` 三条件）。
3. 跑 `vitest run src/__tests__/sanitize-invalid-providers.test.ts -t "W1b-V2"` → **1 failed**：`expect(result.removed).toEqual(['empty-shell'])` 失败，removed 实际含 `key-only` / `authheader-only` 等被误删条目——测试确实锁定新语义，非恒真断言。
4. 字节还原（cp 备份回），shasum 复核一致，`git diff --stat` 恢复 71 行 diff 原状，临时文件清理。

## 7. 破坏面核查

- **sanitize 调用点**：生产代码唯一调用 = `packages/runtime/src/index.ts:165`（启动序列）。无其他消费方受判定变更影响。
- **MF-5 回归（WTC17b）**：fixture 从 `{apiKey, name}` 改为无 apiKey 纯空壳后，仍完整锁定修复路径（authMethod 保留 / catalog models 合并 / `isInvalidProvider(repaired)===false` / 幂等）。MF-5 原本保护的用户价值（QuickSetup 条目不被删）由新增 WTC17a 以更强形态锁定（`toEqual(fixture)` 原样保留，含 apiKey 逐字段断言）。**语义未稀释，覆盖反而增强**。
- **MF-6 回归（WTC18）**：fixture 去 apiKey 后仍锁定「catalog models 全空 baseUrl → 维持删除不合并」（removed=[azure]、repaired=[opencode]、修复条目 `every(m => !!m.baseUrl)`、幂等）。防毒化回归完好。
- **其余改写 fixture（WTC8/11/12/16）**：均从「key-only 误判空壳」改为真空壳 `{name}`，删除/幂等/null 容错语义保留，6 处均标 `[W1b 语义变更]`。真实文件系统（`mkdtempSync`/`writeFileSync`/`rmSync`，无 mock fs）符合基线要求。

## 8. builder 声称逐项核实表

| 声称 | 核实结果 |
|------|----------|
| isInvalidProvider 八字段重写，条件顺序对齐 dist :86-93 | 属实（逐字段 + 探针） |
| pi-provider-store.ts 仅注释更新（4 处 + [W1b 语义变更]，代码零改动） | 属实（3 hunks 全注释行，4 处标注计数属实） |
| 新增 W1b-T1~T5 + W1b-V2（三例保留 + 空壳被清，真实 fs） | 属实（T1-T5 + V2 齐全） |
| 既有 fixture 按新语义改写并标注 | 属实（6 处标注） |
| 两处刻意不纳入（oauth&&!BaseUrl / zod 层） | 属实且评估合理（§5） |
| runtime 全量 3204 绿 | 属实（独立复跑一次通过） |
| R1 exit 0 | 属实 |
| attach-lifecycle 一次环境性 flaky 复跑过 | 无法证伪（本次未复现），不影响结论 |

## 9. 建议级发现（不阻塞 PASS）

1. 测试缺口：`headers: {}` 空对象合法态（探针验证行为正确但无回归锁定，WTC5 仅带键形态）、`authHeader: null` 形态（T3 仅 true/false）。若 pi 未来改 headers 判定为键计数，现行测试不会红。
2. `models: "xx"` / `modelOverrides: "xx"` 等 zod 缝隙形态的 xyz 删除行为无显式测试与注释声明（注释只覆盖非对象值整体形态）。行为合理（保守自愈），建议补一行注释或用例固化意图。

## 10. 验收条款结论

| 条款 | 结果 |
|------|------|
| C1 同构（逐字段对照） | PASS（§4，含 zod 层与调用点原文核实） |
| C2 防误删三例 + 空壳清理全绿 | PASS（W1b-V2 实跑 + 红性证明） |
| C3 typecheck + vitest 全量 | PASS（286 files / 3204 tests） |
| C4 R1 exit 0 | PASS |

**最终：PASS。**
