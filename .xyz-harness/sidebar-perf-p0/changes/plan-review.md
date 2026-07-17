# Plan Review：sidebar-perf-p0

**审查日期**：2026-07-16

## 审查范围

审查 dev-plan.json 的 6 个 Wave（W1-W6）的完整性、依赖链正确性、改动点可行性。

## 审查结论：通过，无 must-fix

### 依赖链验证（正确）

```
W1 (shallowRef) → W2 (computed Set) → W3 (statusOf 缓存)
  → W4 (runtime 写 session_end) → W5 (scanner 读终态) → W6 (前端去预 hydrate)
```

- W1→W2：shallowRef 先稳定，computed 派生 Set 才能验证在 shallowRef 下重算（AC-6）。正确。
- W2→W3：isGenerating O(1) 后，statusOf 缓存的单次重算才变 O(1)。正确。
- W3→W4：W4 是 runtime 改动，技术上不依赖前端 W3，但串行无害（第一波前端稳定后再动 runtime，降低跨层调试复杂度）。可接受。
- W4→W5：scanner 读终态依赖 persistSessionEnd 已实现。正确。
- W5→W6：前端去预 hydrate 依赖元数据 status 可用（W5 扩展 SessionStatus + scanner 读终态）。正确。

### 改动点可行性（均已在前置验证中确认）

| Wave | 关键风险 | 验证状态 |
|------|---------|---------|
| W1 | shallowRef 是否破坏深响应式消费 | ✅ 四项验证确认全部更新是不可变写法，无深响应式依赖 |
| W2 | computed 派生 Set 在 shallowRef 下重算 | ✅ 理论兼容（Map.set 触发），AC-6 覆盖 |
| W3 | cache 生命周期 + 清理 | ✅ deleteSession 清理路径明确 |
| W4 | 3 个终态点能否拿到 sessionFilePath + 规则 #6 竞态 | ⚠️ event-interpreter 的 sessionFilePath 获取需 dev 阶段确认；existsSync guard 复用 tryPersistLabel 模式 |
| W5 | SessionStatus 扩展不破坏现有消费 | ✅ 纯新增（末尾追加），isDead 仍只认 dead |
| W6 | 瞬态来源 + deriveStatus 签名变更 | ✅ 瞬态由 W2 Set 派生（不依赖历史）；签名变更所有调用点已列出 |

### FR-6 范围守门 warning（误报）

CW 报"FR-6 可能在 plan 中未覆盖"。实际 W6 的 goal 和 changes 明确覆盖了 FR-6（去全量预 hydrate + deriveStatus 兜底 + 瞬态来源）。CW 的 FR-Wave 文本匹配未命中，属误报，不阻断。

### nit（不进 issues）

- W4 event-interpreter 终态点取 sessionFilePath 的具体方式：dev 阶段需确认 event-interpreter 是否能访问 session 对象的 sessionFilePath 字段（或经注入的回调传递）。这是实现细节，不阻断 plan。
