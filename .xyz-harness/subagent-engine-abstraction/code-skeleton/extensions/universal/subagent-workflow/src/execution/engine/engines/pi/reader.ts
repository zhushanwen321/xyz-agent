// execution/engine/engines/pi/reader.ts
//
// PiEngine reader——session 历史读取（共享只读模块，D6 双端复用）。
// 回填锚点：pi 既有直读 JSONL 逻辑下沉为本模块（session-reconstructor
// reconstructFromFile / readIdentityHeader 既有函数群），行为不变（A1 / BC-5 守护）。
// 无状态纯函数、无 spawn/进程依赖、不 import 同包 launcher/preparer/parser——
// xyz-agent runtime 经 workspace 依赖引入本文件（AC-2 唯一例外通道）。

import { reconstructFromFile } from "@real/execution/session-reconstructor.ts";

import type { EngineHandleData, EngineReader, SessionView } from "../../types.ts";

export class PiReader implements EngineReader {
  /**
   * 第①级原生读取：直读子代理 pi session JSONL 重建 turns。
   * 失败返回 undefined（不 throw）——②③级降级由宿主 read() 编排（read-chain.ts）。
   */
  async readNative(handle: EngineHandleData): Promise<SessionView | undefined> {
    const sessionFile = handle.sessionRef["sessionFile"];
    if (!sessionFile) return undefined;
    const reconstructed = reconstructFromFile(sessionFile); // 真接线：与现有读取链同一函数
    if (!reconstructed) return undefined;
    return this.project(handle, reconstructed);
  }

  private project(handle: EngineHandleData, reconstructed: ReturnType<typeof reconstructFromFile>): SessionView {
    // ReconstructedRecord → SessionView（turns 派生 + usage 聚合 + source: "native"）。
    // 叶子逻辑（投影细节）；handle.sessionRef 形状 = { sessionFile }。
    void handle;
    void reconstructed;
    throw new Error("skeleton: pi native session view projection");
  }
}
