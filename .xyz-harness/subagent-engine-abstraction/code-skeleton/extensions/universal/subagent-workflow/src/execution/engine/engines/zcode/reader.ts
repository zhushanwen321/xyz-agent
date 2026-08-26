// execution/engine/engines/zcode/reader.ts
//
// ZcodeEngine reader——sqlite session/message/part 三级 JOIN → SessionView（第①级原生读取）。
// 共享只读模块（D6 双端复用：extension 的 read() 与 runtime 的 GUI 历史链路同一份）。
// 无状态纯函数、无 spawn/进程依赖、不 import 同包 launcher/preparer/parser（AC-2 例外通道）。
//
// sqlite schema 随 zcode 版本迁移（逆向无契约）——原生读取必然周期性失效，失败返回
// undefined 走②级 journal 重放（D6 否决「只支持原生读取」的理由）。
//
// 注（骨架层诚实交代）：sqlite 驱动选型（node:sqlite vs better-sqlite3）属实施期待实证项②
// （WAL 并发读行为）的决策产物，骨架不真引驱动依赖——本文件是四件套中唯一的
// SDK 引用例外，理由：驱动选型未定，真引会在选型变更时产生假签名承诺。
// 类型契约（SessionView 产出形状 + undefined 降级语义）在此固化。

import type { EngineHandleData, EngineReader, SessionView } from "../../types.ts";

export class ZcodeReader implements EngineReader {
  /** 第①级：sqlite 三级 JOIN 重建 turns。失败返回 undefined（不 throw）——降级链由宿主编排。 */
  async readNative(handle: EngineHandleData): Promise<SessionView | undefined> {
    const sessionId = handle.sessionRef["sessionId"];
    const dbPath = handle.sessionRef["dbPath"];
    if (!sessionId || !dbPath) return undefined;
    // 查询契约：session(message(part)) JOIN → 按 turn 分组 → SessionView（source: "native"）。
    // 失败（db 缺失/schema 漂移）→ undefined → ②journal 重放（C5 / A8）。
    void dbPath;
    throw new Error(`skeleton: zcode sqlite reader (sessionId=${sessionId}, join=session/message/part)`);
  }
}
