# Retrospect — fix-subagent-memory-leak

## 做了什么

修复 H3 LRU 的 M7 subagent/agentcall 虚拟 session 内存泄漏。原实现因虚拟 key 格式不一致（两段式 vs chat-lru 三段式假设）致 LRU 清理完全无效，且测试假绿（手写三段式 key 绕过工厂函数）。

## 关键修复

| 修复 | 内容 |
|------|------|
| W1 三段式 | subagentVirtualId 改 `subagent:<mainSid>:<subId>`，isSubagentVirtualId 三段结构校验排除旧两段式 |
| W2 立即清+tombstone | backToMain 立即清 messages[virtualId] + tombstone 防终态 fetchAndInject 复活；deleteSession 时序 evict 在 dispose 前 |
| W3 agentcall 映射 | agentcall 保持两段式，workflow store 维护 mainSessionId→Set 映射，deleteSession 经映射精确清理 |
| W4 测试修复 | chat-lru.test.ts 用真实工厂生成 key（防假绿），补旧两段式负向测试 |

## 过程问题（processIssues）

| 问题 | 根因 | 改进 |
|------|------|------|
| spec 初稿漏 streaming 竞态/deleteSession 时序/agentcall 归属 | 初稿只覆盖"格式不匹配"表层缺陷，禁读重建暴露 3 个深层交互 | spec_review 的禁读重建有效拦截，8 must-fix 全闭环 |
| R1 backToMain 误删主 session（review 自发现） | chatEvict 回调原调 evictSessionWithVirtual(mainSid) 会删整个主 session | review 阶段 design-consistency 审查抓到，新增 evictVirtualKey 修复 |
| "等终态再清"方案实现矛盾 | backToMain 已 stopStream，终态回调不触发，"等"的信号源不存在 | 澄清阶段及时识别矛盾，用户确认改立即清+tombstone |
| E1 e2e 无法自动跑 | tdd_plan 阶段把 requiresScreenshot=true 的 e2e 加入但环境无 Electron | knownRisk：E1 待手工验证。教训：real 层用例需确认环境可自动执行 |

## 全绿质量自检（U1-U9）

测试有防线，非覆盖率填充：
- U2/U4 测异常路径（旧两段式排除、多 subagent 全清）——防退化
- U7 测竞态（tombstone 防复活）——防 fire-and-forget Promise 复活
- 新增"backToMain 不删主 session"测试——防 R1 回归
- 故意改坏验证：若删 evictVirtualKey 改回 evictSessionWithVirtual，"不删主 session"测试立即红

## knownRisks

- **E1 e2e 待手工验证**：subagent overlay 进入→backToMain→确认 messages 释放无主 session 误删→重进重新加载。单测 U1-U9 全绿覆盖核心逻辑，但 overlay 视觉/交互链路需人工确认。
- **旧两段式 key 残留**（D8）：内存态一次性迁移，isSubagentVirtualId 三段校验排除旧 key，依赖刷新清理。接受泄漏。

## 结论

M7 内存泄漏修复完成。核心缺陷（格式不匹配+清理链路断裂+测试假绿）已闭环。review 阶段自发现 R1（误删主 session）是最高价值拦截——若进生产，用户 backToMain 后主会话消息全没。
