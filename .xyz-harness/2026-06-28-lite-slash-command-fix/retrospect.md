# Lite 复盘：slash-command-fix（2026-06-28）

## 概况
- Wave 数：2（W1 时序修复 / W2 Landing 预创建）| 失败循环轮数：诊断阶段 5+ 轮（选择器+输入方式试错），实现阶段 1 轮（Wave2 二次遇时序）| 覆盖率：增量核心逻辑（getCommands 拉取/预创建）全被 U1-U5 锁定
- 总体：⚠️ 功能交付正确且经真实环境验证，但诊断阶段浪费大量 turn（选择器盲信 + 输入方式试错），Wave 2 二次返工暴露根因归类抽象层级不足

## 清单结果

### 流程
- ✅ Wave 拆分准确（W1 时序 / W2 Landing 预创建），逻辑分离清晰
- ⚠️ TDD 执行但 Wave 2 实现期才发现同样时序问题（根因归类不足，见问题 2）
- ❌ 失败循环：诊断阶段 5+ 轮，根因是诊断脚本选择器假设未验证 + playwright 输入方式试错（问题 1）

### 测试质量
- ✅ 覆盖率：增量核心逻辑全被 U1-U5 锁定
- ⚠️ E2E 边界：playwright 真实验证是亮点，但选择器问题致前几轮误判"浮层没弹"
- ✅ 测试清单与实际一致，无静默跳过

### 文档
- ⚠️ plan.md 基本一致，但 Wave 2 没提前写明"预创建需同步主动拉取"（实现期才补）
- ❌ 架构影响未记录：预创建改变了"延迟 create"语义，landing 态 branch 链路变为可达——无 ADR/CLAUDE.md 更新

### skill/subagent
- N/A（主 agent 直接执行，无 subagent）

### 提示词/业务/架构
- ❌ 诊断脚本选择器盲信（"假设未验证"反复错误模式，同上轮 handoff 盲信）
- ⚠️ taste/no-silent-catch 来回改 3 次（没先看项目现有惯例）
- ❌ retrospect.md 混进代码 commit（git add -A 误加）
- ⚠️ contenteditable + Vue @input 的 playwright 测试手段不可靠（工具层）

## 根因深度分析

### 问题 1：诊断选择器盲信浪费 5+ turn
**症状**：用 `[data-radix-popper-content-wrapper]` 检测浮层，真实环境一直 false，误判"浮层没弹"，反复改实现逻辑排查
**why1**：选择器从 mock 环境 diag4.cjs 拿来，mock 环境巧合有效
**why2（根因）**：没验证选择器假设本身。在 mock 一次成功就当真理，真实环境只验证"浮层有没有"没验证"我的检测方法对不对"。直到 dump body 子元素才发现 z:1100 的 fixed div（浮层其实早弹了）
**层级**：认知层
**可证伪实验**：若诊断第一步是 `getComputedStyle + dump 实际 DOM 属性` 而非用预设选择器匹配，0 次误判

### 问题 2：根因归类抽象层级不足致 Wave 2 返工
**症状**：Wave 1 修了 selectSession 时序，Wave 2 预创建 session 又遇完全相同的 broadcast 时序问题，二次修复
**why1**：Wave 1 把根因归到"selectSession 这条路径"，只在这一处加主动拉取
**why2（根因）**：根因归类停在具体路径，没抽象到模式层——真实根因是"任何 broadcast commands 的时机早于订阅建立的路径都会丢"。所以 Wave 2 设计时没自动带上主动拉取，直到验证失败才补 precreateSessionAndLoadCommands
**层级**：认知层
**可证伪实验**：若 Wave 1 定位时根因写成"所有 session 建立/激活路径都需主动拉取"，Wave 2 实现期 0 次返工

### 问题 3：retrospect.md 混进代码 commit
**症状**：第一次 git reset 撤了 retrospect.md，第二次 git add -A 又加回，混进代码 commit
**why1**：add -A 是全量加，之前 reset 的文件又被加回
**why2（根因）**：reset 单文件后没在后续 add 时排除它，继续用 add -A 而非显式路径
**层级**：流程层
**可证伪实验**：若 reset 后用 `git add src-electron/ plan.md`（显式路径），0 次误加

### 问题 4：taste/no-silent-catch 来回改 3 次
**症状**：空 catch → console.warn（规则仍报）→ disable-next-line 位置错 → 移到正确行
**why1**：对 taste/no-silent-catch 的触发条件不熟
**why2（根因）**：没先 grep 项目现有惯例。runtime 的 fetchAndBroadcastCommands 早有同款 `eslint-disable-next-line taste/no-silent-catch`，照抄一次就过，但我自己想当然试了 console.warn
**层级**：认知层（CLAUDE.md「一致性 > 品味」原则未遵守）
**可证伪实验**：若改 catch 前先 `grep -rn "no-silent-catch"`，一次改对

### 亮点：三层 DIAG log 诊断法
- runtime push log → transport routeInbound log → CommandPopover recv log，三层精确定位"broadcast 发了但 routeInbound 没收到 session.commands"，直接锁定时序竞争根因
- 这是高质量根因定位，避免了在错误方向（如改 CommandPopover 订阅逻辑）空转
- 值得沉淀为"跨进程消息流诊断"的标准手法

## 改进项（按优先级）

1. **[P0]** 诊断选择器盲信 | 根因：症状(检测方法无效误判功能没生效)→why1(mock 成功当真理)→why2(没验证检测方法本身) | 认知层 | 归属：个人诊断习惯 | 追踪：待办 | 方向：诊断脚本第一步先 dump 实际 DOM 属性/computed style，再用选择器匹配
2. **[P0]** 根因归类抽象层级不足 | 根因：症状(Wave2 二次遇时序)→why1(根因归到单条路径)→why2(没抽象到模式层"所有同类路径") | 认知层 | 归属：lite-execute/个人思维习惯 | 追踪：待办 | 方向：定位根因时写"所有同类路径都需 X"而非"这条路径需 X"
3. **[P1]** git add -A 误加无关文件 | 根因：症状(retrospect 混进 commit)→why1(add -A 全量)→why2(reset 后没换显式路径) | 流程层 | 归属：个人 git 习惯 | 追踪：待办 | 方向：reset 单文件后用 `git add <显式路径>`
4. **[P1]** 架构影响未记录（预创建改变延迟 create 语义，branch 链路 landing 可达）| 根因：症状(语义变了无文档)→why1(只改代码没改文档)→why2(无"语义变更必更 ADR"规则) | 架构层 | 归属：项目 ADR/CLAUDE.md | 追踪：待办 | 方向：补一条 ADR 记录预创建决策 + branch 可达性变化
5. **[P2]** 改 catch 前没看现有惯例 | 根因：症状(规则改 3 次)→why1(规则不熟)→why2(没 grep 惯例) | 认知层 | 归属：CLAUDE.md 一致性原则 | 追踪：待办 | 方向：改 lint 相关代码前先 grep 现有 disable 写法

## 最值得改
**P0 #1（诊断选择器盲信）**——成本最低、收益最快、影响每次前端调试。诊断前先 dump 实际 DOM，杜绝"我的检测方法本身错了"这个隐蔽且高成本的失败模式。P0 #2（根因抽象层级）价值更高但属思维习惯，需长期训练。
