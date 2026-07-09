/**
 * useComposerHistory 单测 —— shell 风格 ↑/↓ 输入历史导航状态机。
 *
 * 行为规格（bash 风格，用户确认）：
 * - ↑（光标在第一行）：edit→browsing 回填 H[0]；browsing 内继续翻更老；越最老清空回 edit
 * - ↓（光标在最后一行）：browsing 内翻更新；越最近恢复草稿回 edit；edit 态不响应
 * - 连续相同文本去重；session 切换重置；pending 消息不进历史
 *
 * mock 策略：deps 全 mock（记录 setText/clear 调用），history 从真实 chatStore.appendUser
 * 注入的 user 消息派生（验证方案 A：消息流是历史 SSOT）。moveCaretUpVisualLine 默认 'first-line'
 * （测试状态机本身；光标行判定逻辑在 useContenteditableInput 单测覆盖）。
 *
 * 运行：npx vitest run src/__tests__/panel/use-composer-history.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { useComposerHistory } from '@/composables/panel/useComposerHistory'

beforeEach(() => {
  setActivePinia(createPinia())
})

/** mock deps 工厂：记录所有 DOM 操作调用，便于断言回填/清空内容 */
function makeDeps(overrides: Partial<{
  getText: () => string
  moveCaretUpVisualLine: () => 'first-line' | 'moved' | 'noop'
}> = {}) {
  const setTextCalls: string[] = []
  const clearCalls: number[] = []
  let currentText = ''
  return {
    setTextCalls,
    clearCalls,
    deps: {
      getText: overrides.getText ?? (() => currentText),
      setText: vi.fn((text: string) => {
        setTextCalls.push(text)
        currentText = text
      }),
      clear: vi.fn(() => {
        clearCalls.push(clearCalls.length)
        currentText = ''
      }),
      // 默认 'first-line'：模拟光标已在首行，↑ 直接翻历史（多数单行场景）
      moveCaretUpVisualLine: overrides.moveCaretUpVisualLine ?? (() => 'first-line' as const),
    },
  }
}

/** 构造 composable + 填充历史（按时间顺序 appendUser，参数即历史内容） */
function setup(historyTexts: string[], sessionId = 's1') {
  const store = useChatStore()
  historyTexts.forEach((t) => store.appendUser(sessionId, t))
  const sidRef = ref(sessionId)
  const { setTextCalls, clearCalls, deps } = makeDeps()
  const { handleArrowUp, handleArrowDown } = useComposerHistory(sidRef, deps)
  return { store, sidRef, setTextCalls, clearCalls, deps, handleArrowUp, handleArrowDown }
}

describe('useComposerHistory（↑/↓ 输入历史导航）', () => {
  describe('↑ 翻历史', () => {
    it('edit 态按 ↑：回填最近一条历史 H[0]', () => {
      const { setTextCalls, handleArrowUp } = setup(['第一条', '第二条'])
      handleArrowUp()
      // H[0] = 最近一条 = '第二条'
      expect(setTextCalls).toEqual(['第二条'])
    })

    it('browsing 内连续按 ↑：依次回填更老的历史', () => {
      const { setTextCalls, handleArrowUp } = setup(['最老', '中间', '最近'])
      handleArrowUp() // → '最近'
      handleArrowUp() // → '中间'
      handleArrowUp() // → '最老'
      expect(setTextCalls).toEqual(['最近', '中间', '最老'])
    })

    it('越过最老一条后按 ↑：保持不动（不循环、不清空、不退回 edit）', () => {
      const { setTextCalls, clearCalls, handleArrowUp, handleArrowDown } = setup(['最老', '最近'])
      handleArrowUp() // → '最近'
      handleArrowUp() // → '最老'
      const beforeText = setTextCalls.at(-1)
      const beforeClear = clearCalls.length
      handleArrowUp() // 已在最老，保持不动
      expect(setTextCalls.length).toBe(2) // 未新增回填
      expect(setTextCalls.at(-1)).toBe(beforeText) // 仍是最老一条
      expect(clearCalls.length).toBe(beforeClear) // 未清空
      // ↓ 仍能往回走
      handleArrowDown()
      expect(setTextCalls.at(-1)).toBe('最近')
    })

    it('edit 态无历史时按 ↑：清空 composer（无历史可翻语义）', () => {
      const { clearCalls, handleArrowUp } = setup([])
      handleArrowUp()
      expect(clearCalls.length).toBe(1)
    })

    it('edit 态 moveCaretUpVisualLine 返回 moved（上移一行）：消费事件但不翻历史', () => {
      const { setTextCalls, clearCalls, deps, handleArrowUp } = setup(['历史'])
      deps.moveCaretUpVisualLine = () => 'moved'
      const consumed = handleArrowUp()
      expect(consumed).toBe(true) // 消费事件（防止浏览器再默认上移一次）
      expect(setTextCalls.length).toBe(0) // 未翻历史
      expect(clearCalls.length).toBe(0)
    })

    it('edit 态 moveCaretUpVisualLine 返回 noop（探测失败）：不消费，交给浏览器默认处理', () => {
      const { setTextCalls, clearCalls, deps, handleArrowUp } = setup(['历史'])
      deps.moveCaretUpVisualLine = () => 'noop'
      const consumed = handleArrowUp()
      expect(consumed).toBe(false) // 不消费，浏览器默认 ↑ 生效
      expect(setTextCalls.length).toBe(0)
      expect(clearCalls.length).toBe(0)
    })
  })

  describe('↓ 翻历史', () => {
    it('browsing 内按 ↓：回填更新的历史', () => {
      const { setTextCalls, handleArrowUp, handleArrowDown } = setup(['最老', '中间', '最近'])
      handleArrowUp() // '最近'
      handleArrowUp() // '中间'
      handleArrowDown() // → '最近'
      expect(setTextCalls.at(-1)).toBe('最近')
    })

    it('越过最近一条后按 ↓：恢复进 browsing 前保存的草稿，回到 edit 态', () => {
      const { setTextCalls, deps, handleArrowUp, handleArrowDown } = setup(['历史'])
      // 模拟用户正在打字，草稿 = '我在编辑'
      deps.getText = () => '我在编辑'
      handleArrowUp() // → '历史'，savedDraft = '我在编辑'
      handleArrowDown() // 越界 → 恢复 '我在编辑'
      expect(setTextCalls.at(-1)).toBe('我在编辑')
    })

    it('恢复草稿后再按 ↓：不响应（已回到 edit 态）', () => {
      const { setTextCalls, handleArrowUp, handleArrowDown } = setup(['历史'])
      handleArrowUp()
      handleArrowDown() // 恢复草稿
      const before = setTextCalls.length
      handleArrowDown()
      expect(setTextCalls.length).toBe(before)
    })

    it('edit 态按 ↓：不响应（edit 态 ↓ 是正常光标移动）', () => {
      const { setTextCalls, handleArrowDown } = setup(['历史'])
      const consumed = handleArrowDown()
      expect(consumed).toBe(false)
      expect(setTextCalls.length).toBe(0)
    })

    it('browsing 态按 ↓ 总是响应翻历史（不再要求光标在末行，避免行判定失效导致 ↓ 不可用）', () => {
      const { setTextCalls, handleArrowUp, handleArrowDown } = setup(['最老', '最近'])
      handleArrowUp() // 进入 browsing，回填 '最近'
      handleArrowUp() // '最老'
      handleArrowDown() // → '最近'
      expect(setTextCalls.at(-1)).toBe('最近')
    })
  })

  describe('去重', () => {
    it('连续相同文本只留一条历史', () => {
      const { setTextCalls, handleArrowUp } = setup(['重复', '重复', '重复'])
      handleArrowUp() // → '重复'
      handleArrowUp() // 越界 → 清空（去重后只有 1 条）
      // 证明只有 1 条历史：第一次 ↑ 回填 '重复'，第二次 ↑ 越界清空
      expect(setTextCalls).toEqual(['重复'])
    })

    it('非连续相同文本都保留', () => {
      const { setTextCalls, handleArrowUp } = setup(['A', 'B', 'A'])
      handleArrowUp() // → 'A'（最近）
      handleArrowUp() // → 'B'
      handleArrowUp() // → 'A'（最老）
      expect(setTextCalls).toEqual(['A', 'B', 'A'])
    })
  })

  describe('pending 消息过滤', () => {
    it('仅 status===complete 的 user 消息进入历史', () => {
      const sid = 's2'
      const store = useChatStore()
      store.appendUser(sid, '已确认投递')
      store.appendPending(sid, '待投递', 'steer')
      const sidRef = ref(sid)
      const { setTextCalls, clearCalls, deps } = makeDeps()
      const { handleArrowUp } = useComposerHistory(sidRef, deps)
      void deps
      // 历史只有 1 条（'已确认投递'），pending 的 '待投递' 被过滤
      handleArrowUp()
      expect(setTextCalls).toEqual(['已确认投递'])
      // 再次 ↑ 已在最老，保持不动（证明只有 1 条历史，未翻到 pending 那条）
      handleArrowUp()
      expect(setTextCalls).toEqual(['已确认投递'])
      expect(clearCalls.length).toBe(0)
    })
  })

  describe('session 切换重置', () => {
    it('切换 session 后 browsing 指针归位，按 ↓ 不响应', () => {
      const store = useChatStore()
      const sid1 = 's1'
      const sid2 = 's2'
      store.appendUser(sid1, 'session1 的历史')
      store.appendUser(sid2, 'session2 的历史')
      const sidRef = ref(sid1)
      const { setTextCalls, deps } = makeDeps()
      const { handleArrowUp, handleArrowDown } = useComposerHistory(sidRef, deps)
      void deps
      // session1 翻到历史
      handleArrowUp()
      expect(setTextCalls.at(-1)).toBe('session1 的历史')
      // 切到 session2
      sidRef.value = sid2
      // 切换后按 ↓ 应不响应（已重置回 edit 态）
      const before = setTextCalls.length
      const consumed = handleArrowDown()
      expect(consumed).toBe(false)
      expect(setTextCalls.length).toBe(before)
      // 按 ↑ 应翻 session2 的历史
      handleArrowUp()
      expect(setTextCalls.at(-1)).toBe('session2 的历史')
    })
  })
})
