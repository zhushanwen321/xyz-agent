# 对抗式审查报告（第 2 轮聚焦复审）：bash-running-stream-output.md

> 主审（tech-design-review）第 2 轮报告。范围：上轮 4 条 suggestion 修复验证 + 新引入 D4 尾窗截断机制对抗攻击 + 五处交叉引用一致性终检。P0-12/19/20 归影响面审，本文仅 INFO 交接。不重查上轮已确认项（事实核实 9/9 通过项、P0 结构/问题定义/方案对比/验收通过项）。
> 审查日期：2026-09-08。本轮新读源码：`normalize-tool-result.ts`（全文）、`Block.vue:300-380`（displayContent / parsedJsonOutput / copyContent / toolTailLines / filteredMetaItems / outputRaw）。

## Summary

**1 must-fix, 2 suggestions.** 上轮 4 条 suggestion 的修复全部成立（S1/S2/S3/S4 逐条验证通过，见下）。新机制 D4 尾窗截断在「无换行长输出」场景存在规格空洞：截断规则「从截断点后首个换行起保留」依赖换行存在，而设计自己的验收场景 S5（`yes … | head -c 2000000`）恰好是一条无换行的单行输出——该场景下截断行为未定义，且两种合理解读各击穿一处（不截断 → ring 有界量化失效；硬切 → 「避免半行/半字符」承诺失效）。其余攻击点（normalize 实现序不变式、首帧 detail 分支自洽性、JSON.parse 开销）均未被击穿。

## 上轮 suggestion 修复验证

| 上轮项 | 修复声明 | 验证结论 |
|---|---|---|
| S1（U2 vs §4 矛盾） | detail 保持现状无条件 spread | ✅ 成立。§4 图 L153「写入行为与现状逐字一致：无条件覆盖」、§7 U2 代码 L303 `{ ...c, detail, ...(output !== undefined && { output }), ... }` 与 registry 现状（上轮核实 registry.ts:676 无条件 spread）逐字一致，矛盾消除 |
| S2（useToolMeta 遗漏） | 源码重演声明「可见面无变化」 | ✅ 成立。本轮独立重读 Block.vue `filteredMetaItems`：`!item.text.endsWith('行')` 对 bash 恒过滤行数项，与文档声明吻合；耗时项需 endTime（running 不存在）成立——readers 只在 end 写入。§7 回归面表 + S1 观察点均已落位（§8.2 S1 L338） |
| S3（displayContent 引用） | 改逐字 | ✅ 成立。§3.3 L101 现为 `displayContent = result.value || (isFailed ? tool.error : '')`（result = computed(() => props.tool?.output)，Block.vue:315-317），与实装逐字一致（本轮 read Block.vue:317-318 核对） |
| S4/S5（措辞） | 可观察项 + 内存由 D4 背书 | ✅ 成立。S5 通过标准（§8.2 L342）全部可证伪（不卡顿/不白屏/尾窗 ≤8KB/end 完整快照/重连恢复），并显式声明「内存有界性……不作为手测项」；断连重连步骤并入 S5（P0-21） |

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §6.4 D4（L234）+ §7 U1 要点（L290）+ §8.2 S5（L342） | P0-11 对抗 | **尾窗截断规则在「无换行输出」下未定义，且验收场景 S5 自身就是该场景**。规则为「原文超 8KB 时从截断点后首个换行起保留尾窗」，但未定义截断点之后不存在换行时的行为（单行 >8KB：base64 / minified JSON / `yes` 输出）。两种合理解读各击穿一处：① 若解读为「无换行则不截断」→ S5 的 `yes xyz-agent-stream-check \| head -c 2000000`（`yes` 不输出换行，2MB 单行）永不截断，D4 的「ring 满载 ≤8MB」量化失效（实际 1000 × 50KB ≈ 50MB），§2 目标 3 与 §6.5 方案 A 风险列声明同时被击穿；② 若解读为「无换行则硬切在截断点」→ JS 字符串 UTF-16 码元硬切可能劈开代理对（emoji/中文边界），D4 声称的「避免半行/半字符」承诺在该分支不成立（换行推进只避免半行，本就不避免半字符）。规格必须二选一并写明 | D4/U1 补充无换行分支的显式定义，推荐：无换行时在截断点硬切，但回退到**码点边界**（`charCodeAt(idx) >= 0xD800 && <= 0xDBFF` 则前移一位）保证不劈代理对；并在 §8.2 S5 通过标准中注明该命令即无换行场景，用作该分支的验收 |
| SUGGESTION | §7 U1 要点（L290）+ §8.2 单测职责（L344） | P1-8 内部一致性 | 「不变式 `output = stripAnsi(outputRaw)`」的表述无条件化，但实装语义（normalize-tool-result.ts:19-20、60）与文档 §4 图（L146「outputRaw( 含 ANSI 时 )」）都是 **outputRaw 仅在含 ANSI 时存在**——无 ANSI 时 outputRaw 为 undefined，不变式无载体。§7 单测断言若按字面写（对 undefined 断言 stripAnsi 等值）会写不出或写成恒真 | 不变式表述补条件：「当 outputRaw 存在时 output === stripAnsi(outputRaw)」；截断发生在 stripAnsi 之前的原文上、二者同源派生，这一点已在 U1 要点写明，不变式由构造保证，仅需措辞收紧 |
| SUGGESTION | §5.1（L191）+ §6.4 效果（L245） | P1-1 例子/UX | running 态输出超过 8KB 后展开区静默切换为尾窗，用户无任何「上文已截断」的视觉线索（§5.1 仅文字说明「显示为尾窗预览」，未定义界面呈现）。对长构建日志，用户可能误以为开头输出丢失。end 时刻恢复完整快照可缓解，但 running 期 10s+ 的观察窗内是纯静默截断 | 在尾窗首行加一行轻量截断标记（如「…已截断，完整输出以结束结果为准」），或显式登记为已接受代价（量级：仅 running 期、展开态可见；恢复路径：end 全量快照）——二选一，属 U3 局部 |

### 其余攻击点验证记录（未被击穿）

- **② normalize 实现序**：通过。U1 明确「截断发生在 stripAnsi 之前的原文上，output/outputRaw 从同一截断后原文派生」（L290），先截后 strip 与先 strip 后截的差异（strip 后变短可能落入 8KB 内）被构造性消除——cap 施加于原文，派生字段必然 ≤8KB，不变式由同源派生成立（措辞条件化见上条 suggestion）。
- **③ 首帧分支自洽性**：通过。bash 初始 `onUpdate({content:[], details:undefined})`（上轮核实 bash.js:280）→ `details ?? 整个对象` 命中后者，detail = `{content:[]}` 整对象（既有行为，§6.1 被否项三已声明该占用）；content 空数组 → U1 显式 `output:''` 下发 → U2 无条件 detail 覆盖 + output 空串条件写入；`displayContent = ''` 为 falsy → D2 的 isBashTool 分支兜底渲染命令块，`toolTailLines` 对 `''` falsy 返回 `[]`（Block.vue:359-360 `if (!raw) return []` 核实）。三处路径自洽，无残留冲突。
- **④ parsedJsonOutput 开销**：通过，无发现。实装有双重护栏（Block.vue:333-344）：trim 后首字符非 `{`/`[` 直接返回 null（普通 bash 输出不触发 parse）；即使命中（JSON 输出被截断成非法片段），≤8KB 的 `JSON.parse` 失败是微秒级，@100ms 帧率可忽略，且 computed 有缓存。§9.3 已登记 AnsiText 渲染成本检查点（有降级路径），JSON 侧无需额外声明。
- **交叉引用五处联动**（§4 图 ↔ §6 D4 ↔ §7 U1/U2/U3 ↔ §8 ↔ §9）：除上表两处外全部一致——§4 后图 L151「帧经 U1 瘦身后有界，见 D4」↔ D4 四要素 ↔ U1 `STREAM_OUTPUT_CAP_BYTES = 8*1024` ↔ S5 ②「≤8KB 量级」↔ §9.2 U1 测试「截断不变式」编号语义对应；U3 三项（L311-313）与 §4 后图渲染序、D3 取数 `outputRaw ?? displayContent`、D2 v-if 逐条对齐；回归面表 8 行与 §9.3 检查点闭环。

## 结论

D4 无换行分支补定义（MUST_FIX，一句话规格 + S5 注记）后设计即就绪；两条 suggestion 可随实施 PR 消化。上轮全部修复项经验证成立，无回退。

```json
{ "report_file": "docs/design/bash-running-stream-output.review-r2.md", "must_fix": 1, "suggestion": 2 }
```
