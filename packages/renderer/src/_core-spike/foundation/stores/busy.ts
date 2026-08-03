/**
 * spike 临时占位 store —— busyStore（全局，DM3）。
 *
 * PoC 验证链路用，非业务逻辑（D6）。core 包建立后由继任者结构替换。
 * IF6 签名：{ busySessions: Set<string>, setBusy, clearBusy }
 */
import { defineStore } from 'pinia'
import { reactive } from 'vue'

export const useBusyStore = defineStore('core-spike/busy', () => {
  const busySessions = reactive(new Set<string>())

  function setBusy(id: string): void {
    busySessions.add(id)
  }

  function clearBusy(id: string): void {
    busySessions.delete(id)
  }

  return { busySessions, setBusy, clearBusy }
})
