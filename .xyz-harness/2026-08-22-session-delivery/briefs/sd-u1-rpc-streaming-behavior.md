# sd-u1：RpcClient.prompt 补 streamingBehavior 透传

## 背景

design.md（`.xyz-harness/2026-08-22-session-delivery/design.md`）§5 U1 / §2.2：pi 0.84.1 的 RPC `prompt` 命令支持 `streamingBehavior` 参数（`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:302` 透传给 `session.prompt`；streaming 时不带该参数会 throw `"Agent is already processing..."`，带 `'steer'|'followUp'` 则入队不抛错——已真机探针实测，见 design.md §3.3 实测记录 P1）。但本仓 runtime 的 RPC 客户端端口没有暴露这个参数，runtime 通路无法在目标 session streaming 时投递消息。

## 目标

`packages/runtime` 的 prompt 调用链补 `streamingBehavior?: 'steer' | 'followUp'` 透传：

1. **端口签名**：`packages/runtime/src/services/ports/pi-engine.ts` 中 prompt 相关接口（现约 :142 附近，`prompt(...)` 无 streamingBehavior——以当前代码为准定位）加可选参数。
2. **实现**：`packages/runtime/src/infra/pi/rpc-client.ts` 的 prompt 实现（现约 :557-562，同样没有该参数）把参数透传进 RPC 命令 JSON。
3. **类型**：如有独立命令类型定义（RpcCommand / PromptCommand 之类）同步补字段；类型放 runtime 包内（不 import pi 类型——runtime 与 pi 的类型隔离是既有约定，参照现有字段的做法，如 images/text 的定义方式）。
4. **不改动调用方行为**：MessageDispatcher 等现有调用点不传新参数（缺省 undefined = 行为不变）。U5 才消费它。本 unit 只开通能力。

## 验收要求（建议，designer 可细化）

- unit 级（vitest，fullName 含验收 id）：
  - 透传正确性：mock RPC 连接层，断言 prompt 带 streamingBehavior 时发出的 JSONL 命令含该字段；不带时字段缺省（不出现 undefined 字段）。
  - 端口签名类型测试（既有 rpc-client 测试模式扩展；参考 `packages/runtime/src/infra/pi/__tests__/` 现有测试怎么 mock 传输层）。
- 从 `packages/runtime` 目录跑：`cd packages/runtime && npx vitest run`。

## 约束

- 遵守 root brief 全局约束（特别是 1/6/9）。
- 不改 pi、不动 extension、不动 MessageDispatcher 调用点。
- 完成即提交（commit 英文 conventional，如 `feat(runtime): pass through streamingBehavior in RpcClient.prompt`）。
