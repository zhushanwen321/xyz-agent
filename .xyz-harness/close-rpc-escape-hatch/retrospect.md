# Retrospect — close-rpc-escape-hatch

## 做了什么
关闭 RpcClient 逃生口，恢复 IPiEngine 作为 pi 命令语义面的唯一 seam。三件事：
- **sendCommand 内部归一**：resolve 前 `msg.data ??= msg.payload`，消除 readRpcData/readPiState/PiRpcResponse/PiStateResponse 四个 helper + 所有调用方的 `as PiRpcResponse` + `data ?? payload` 样板。
- **逃生口关闭**：IPiEngine 删 sendCommand/sendRaw，新增 switchSession/getState/sendExtensionUiResponse 三个语义方法。所有 pi 命令字面量关在 RpcClient 内。
- **修 bridge-handler 白等 60s bug**：pi 对 extension_ui_response 不回 RPC reply（pi 源码 rpc-mode.ts:742-756 确认），bridge-handler 7 处错误用 sendCommand（注册 pending 等永不来的 reply）→ 改用 sendExtensionUiResponse（sendRaw fire-and-forget）。每个 bridge 请求从白等 60s 超时变为立即返回。

## 决策记录
- **逃生口可以去掉**：用户判断正确——pi 新增命令时 xyz-agent 要消费必须改代码（加语义方法），不可能"不改代码暴露给用户"。逃生口只是省了"加方法"这一步，代价是字面量泄漏 + 响应未归一。实际使用中所有逃生口消费者调的都是固定命令固定字段，没有一次性探查。
- **去掉逃生口 → 归一问题自动解决**：两者是同一改动的两面。所有命令经语义方法 → sendCommand 归一收进内部 → 调用方不感知 data/payload 二选一。
- **不拆 transport/gateway 两个类**：原审查建议拆 PiProcessTransport + PiCommandGateway，但 grilling 后判断 RpcClient 内部代码不乱（sendCommand 干净通用 + 高层方法各一行委托），乱的是 interface 形状 + escape hatch 使用。收口逃生口 + 归一已解决核心问题，拆类是过度工程。
- **sendExtensionUiResponse 统一两种格式**：bridge 场景发 `{id, response}`（response 是对象包裹），extension UI 场景发 `{id, cancelled/confirmed/value}`（扁平字段）。方法签名 `(id, response, method?)` 按是否有 method 参数区分两种格式。bridge:event 的 response=null 走 cancelled 分支（非旧 response:null），经 pi bridge 扩展源码核验 void 丢弃响应，无功能影响。

## 做得好的
- **pi 源码核验**：grilling 阶段发现 bridge-handler 可能用错 API（sendCommand vs sendRaw），去 pi-mono 源码 rpc-mode.ts:742-756 确认 pi 对 extension_ui_response 不回 RPC reply，坐实了白等 60s bug。这把"可能的清晰度改进"变成了"确定性的 bug 修复"。
- **sendExtensionUiResponse 吸收 buildExtensionUiResponse**：method→payload 格式映射（confirm→{confirmed} / select→{value} / cancel→{cancelled}）从 transport 层的独立函数收进 RpcClient，成为 pi 协议适配的内部知识。
- **对抗性 review 发现 2 个 should_fix**：getHistory 残留死代码 + bridge:event 格式变化无标注，均已修。

## 做得不好的
- **plan 的 W1 要求 sendCommand/sendRaw 改 private 但实际没改**：reviewer 指出字面未落地。原因：W1 阶段 IPiEngine port 还声明 sendCommand/sendRaw（W2 才删），RpcClient implements IPiEngine 时 private 会 tsc 报错。W2 删 port 声明后，语义目标达成（外部类型层面无法访问），private 化变成可选的代码整洁度问题。应在 plan 阶段识别这个时序依赖，把 private 化放到 W2 或单独说明。
- **W2+W3 必须一起做才能编译**：port 删逃生口后调用方不迁移 → tsc 立即报错。plan 设成两个独立 Wave（dependsOn W2 的 W3），但实际执行必须合并。CW 的 commit 纪律（每 Wave 独立 commit）要求分两个 commit，W2 commit 单独 checkout 时 tsc 会报错——这是 W2→W3 过渡态的固有问题，plan 阶段应预判。

## 代码统计
- 4 commit（W1 d788b4ff + W2 6ffaca5c + W3 06684876 + W3 修正 7a6ef75d）
- 改动：rpc-client.ts（+66/-8）+ pi-engine.ts（删 ~40 行 helper/类型 + 加 3 方法签名）+ 4 调用方文件 + 8 测试文件适配
- 新建 1 测试文件（rpc-client.test.ts，306 行 12 测试）
- runtime 99 文件/1298 测试全绿，tsc EXIT 0
- 删除：readRpcData / readPiState / PiRpcResponse / PiStateResponse / buildExtensionUiResponse / bridge-handler 白等 60s bug
