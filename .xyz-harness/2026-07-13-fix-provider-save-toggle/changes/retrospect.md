# Retrospect — fix-provider-save-toggle

## 做了什么

修复 Settings 中 Provider 修改不生效的 4 个根因，拆 4 Wave + 1 review 修正 commit：

| Wave | 修复 | commit |
|------|------|--------|
| W1 | 数据模型 + 契约：PiProviderConfig/PiModelDefinition/ConfigProviderConfig/ConfigModelDefinition 加 enabled 字段；删除 mapTypeToApi 死别名表，applyTypeTranslation 改透传；新增 PROVIDER_API_TYPES SSOT | 65836ca8 |
| W2 | enabled 读写链路：setProvider 补 enabled 处理；listProviders 补 api 回填 + enabled 读取（替代硬编码 true）；toModelInfo 透传 enabled；aggregateModels 双层过滤 | 014dfdb6 |
| W3 | 默认模型持久化：新增 config.setDefaultModel 消息 + handler + 广播 + 前端 api 函数 | 75c1b718 |
| W4 | 前端接线：ProviderEditModal 删 ollama 选项；useProviderEdit save 补 api/baseUrl/enabled；ModelSelectPopover 过滤禁用模型；ProviderPage 默认模型改从 store 派生 + 调 runtime | b8f439f6 |
| review | must_fix：setProvider model 合并补写 api/baseUrl/enabled（原循环只写 4 字段，前端回传的被丢）；should_fix：pi-config-store 复用 KNOWN_PI_API_TYPES SSOT | c3e17d7d |

E1-E3 real 验证测试（1f60321a）。

## 做得好的

### 1. subagent 并行 + 依赖链串行执行正确
W1 地基串行先做，W2/W3 无互相依赖并行派发，W4 依赖前三个串行收尾。4 Wave + review 修正共 5 个实现 commit，总耗时约 2 小时（含 review）。并行时文件范围核对严格（W2 改 shared/provider.ts，W3 改 shared/protocol.ts，不重叠）。

### 2. 独立对抗性 review 抓出了真 bug
reviewer 发现的 must_fix #1 是硬伤：setProvider 的 model 合并循环只显式写 name/contextWindow/input/thinkingLevelMap，前端回传的 api/baseUrl/enabled 被丢弃。这正是本次要修的"保存不生效"在同一条链路上的延续——provider 级修好了，model 级还在丢。**如果跳过 review 直接 test，U3 用手构数据喂 aggregateModels 会全绿，bug 溜进生产**。这印证了 plan 提示的"mock/手构数据掩盖 real bug"陷阱。

补的 U3b 测试走 setProvider 真实写路径（而非 writeModels 直写），堵住了盲区。

### 3. real 层验证用 dev 数据副本，不污染环境
E1-E3 没有启动完整 Electron，而是复制 `~/.xyz-agent-dev/pi/agent/` 的 models.json + settings.json 到临时目录，用真实 ConfigService + PiConfigStore 调 setProvider/setDefaultModel 后读盘验证。既验证了真实持久化链路，又不修改 dev 数据。

## 做得不好的

### 1. W2 实现时漏了 model 级写路径，靠 review 兜底
W2 的 changes[0] 原文写了"save 映射里若 model 含 enabled 则写入"，但 W2 subagent 只补了 provider 级（`merged.enabled = data.enabled`），model 级合并循环没动。根因是 W2 task prompt 引用了 plan changes 但没逐行强调"model 合并循环也要补"。

教训：plan changes 的每个分句都要在 subagent task prompt 里具化为确切代码位置和改动，不能假设 subagent 会逐字对照 plan。

### 2. CW test gate 的 actual.text 匹配机制浪费了 2 轮
第一次提交 U1-U7 时，actual 填了"测试通过的报告"（含 "— xxx.test.ts N passed" 后缀），CW 机器重算严格比对 expected.text，全 fail。第二次直接复制 expected 文本才 passed。

教训：CW 的 actual.text 不是给人看的"测试报告"，而是给机器比对 expected 的判定值。应直接填 expected 里断言的关键值，不要加额外说明。这一点 CW guidance 没讲清楚，是工具的 UX 问题。

### 3. should_fix #7（autoDiscover 丢字段）是 review 误判
review 说 autoDiscover 合并新模型时丢 api/baseUrl/enabled。实际查 DiscoveredModelsResult 类型（config.ts:50），discover 返回的 model 只有 `{ id, name?, contextWindow? }`，不含这些字段。reviewer 没确认返回类型就报了 should_fix。

教训：reviewer 也要遵守"先说假设、有歧义就问、不猜"——报 should_fix 前应先读 DiscoveredModelsResult 定义确认 discover 是否真返回这些字段。

## 流程改进

### CW test actual.text 应支持"语义匹配"
当前 CW 按 expected.text === actual.text 严格字符串比对，导致 agent 必须"抄"expected 才能过。更合理的做法是 CW 做"关键判定词匹配"或让 agent 填 actual 时声明 pass/fail + 证据，engine 校验证据合理性。现在的机制既不可靠（agent 抄 expected 就能过）又浪费往返（多加说明就 fail）。

### real 层验证的 executor 标注
E1-E3 的 executor 标"手动"，实际用 vitest + dev 数据副本可以半自动化（ConfigService 直调，非完整 WS 链路）。后续 plan 设计 E* 时，如果断言是文件字段值（非 UI 可见状态），应优先设计成 vitest real 集成测试而非纯手动。

## 遗留（不在本 topic 范围）

- review nit #4：provider 全禁用时 Composer 模型列表空，无 UI 引导。后续 topic 处理。
- review nit #5：config.defaults 广播的 source 字段类型未在 protocol 声明。后续 topic 收紧。
- review nit #6：W4 删 ollama 项（而非 plan 说的改 value 保留项）。实现更干净，接受偏差。
- Topic 2（System 主题实装）、Topic 3（Skill/Agent 扫描导入 + LoadPaths）尚未启动。
