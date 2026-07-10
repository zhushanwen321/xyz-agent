/**
 * useComposerHistory 单测 —— shell 风格 ↑/↓ 输入历史导航状态机。
 *
 * 行为规格（用户确认）：
 * - ↑（edit 态 + history 非空）：保存草稿 → 回填 H[0]（最后一条）→ browsing
 * - ↑（edit 态 + history 空）：不响应（保持草稿）
 * - ↑（browsing 态 + 未到最老）：index++ → 回填 H[index]
 * - ↑（browsing 态 + 已在最老）：保持不动
 * - ↓（browsing 态 + 未到最近）：index-- → 回填 H[index]
 * - ↓（browsing 态 + 已在最近）：恢复草稿 → edit 态
 * - 重置逻辑：用户在 browsing 态修改了内容 → 退出 browsing，下次按上重新从最后一条开始
 *
 * mock 策略：deps 全 mock（记录 setText/clear 调用），history 从真实 chatStore.appendUser
 * 注入的 user 消息派生（验证方案 A：消息流是历史 SSOT）。
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

/** mock deps 工厂：记录所有 DOM 操作调用 */
function makeDeps(overrides: Partial<{
  getText: () => string
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
    },
  }
}

/** 构造 composable + 填充历史（按时间顺序 appendUser，参数即历史内容） */
function setup(historyTexts: string[], sessionId = 's1') {
  const store = useChatStore()
  historyTexts.forEach((t) => store.appendUser(sessionId, t))
  const sidRef = ref(sessionId)
  const { setTextCalls, clearCalls, deps } = makeDeps()
  const { handleArrowUp, handleArrowDown, resetBrowsing } = useComposerHistory(sidRef, deps)
  return { store, sidRef, setTextCalls, clearCalls, deps, handleArrowUp, handleArrowDown, resetBrowsing }
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

    it('空历史时 ArrowUp 不清空 composer（保持草稿）', () => {
      const { clearCalls, deps, handleArrowUp } = setup([])
      // 模拟 composer 有草稿
      deps.getText = () => '我的草稿'
      const consumed = handleArrowUp()
      // 空历史：不触发历史导航（返回 false），让 contenteditable 层正常处理 ↑ 键移动光标
      expect(consumed).toBe(false)
      // composer 内容不变（未调用 clear / setText）
      expect(clearCalls.length).toBe(0)
      // 草稿仍在
      expect(deps.getText()).toBe('我的草稿')
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
      handleArrowUp() // 越界 → 保持不动（去重后只有 1 条）
      // 证明只有 1 条历史：第一次 ↑ 回填 '重复'，第二次 ↑ 保持不动
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

  describe('用户输入内容后重置', () => {
    it('browsing 态用户修改内容后，按 ↑ 重新从最后一条开始', () => {
      const { setTextCalls, handleArrowUp, handleArrowDown, resetBrowsing } = setup(['最老', '中间', '最近'])
      handleArrowUp() // → '最近'
      handleArrowUp() // → '中间'
      // 用户修改了内容
      resetBrowsing()
      // 按 ↑ 应重新从最后一条开始
      handleArrowUp()
      expect(setTextCalls.at(-1)).toBe('最近')
    })

    it('browsing 态用户修改内容后，按 ↓ 不响应（已回到 edit 态）', () => {
      const { setTextCalls, handleArrowUp, handleArrowDown, resetBrowsing } = setup(['历史'])
      handleArrowUp() // → '历史'
      resetBrowsing()
      const before = setTextCalls.length
      const consumed = handleArrowDown()
      expect(consumed).toBe(false)
      expect(setTextCalls.length).toBe(before)
    })
  })

  // [测试缺口] edge-line-first 三阶段光标策略（moveCaretVertical / getCaretLineRect）
  // 依赖 Selection.modify API，jsdom/happy-dom 不支持，无法在单测环境验证。
  // 该逻辑通过 CDP 实测（开发时手动验证）覆盖，不在单测范围内。
  // 相关函数：useContenteditableInput.ts 的 handleArrowUp 内 moveCaretVertical 调用链。
})
