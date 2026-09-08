// src/error-message.ts
//
// toErrorMessage 的引擎包自持副本（core src/core/error-message.ts 逐字等价——
// 引擎包禁止 import core，SDK 亦未导出该符号，见 SDK kill-chain.ts 同款处置）。

export function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
