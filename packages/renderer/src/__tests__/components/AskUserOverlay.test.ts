/**
 * AskUserOverlay 测试（W3: U9-U13）。
 *
 * 验证 ask-user 富交互组件的渲染和交互：
 * - U9: 首屏渲染（问题文本 + 选项列表存在于 DOM）
 * - U10: 单选交互（点击 → Submit → answers 包含 value）
 * - U11: 多选交互（点击多个 → Submit → answers 含 JSON 数组）
 * - U12: Other 输入 + comment
 * - U13: Cancel 取消
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/components/AskUserOverlay.test.ts
 */
import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import AskUserOverlay from '@/components/extension/ask-user/AskUserOverlay.vue'
import type { AskUserQuestion } from '@xyz-agent/extension-protocol'

// 带描述的选项（验证 opt-desc 字号）
const optWithDescQ: AskUserQuestion = {
  header: 'db',
  question: '使用哪种数据库?',
  options: [
    { label: 'PostgreSQL', value: 'pg', description: '生产环境主流' },
    { label: 'MySQL', value: 'mysql', description: '兼容性广' },
  ],
}

// ── 测试数据 ──
const singleSelectQ: AskUserQuestion = {
  header: 'db',
  question: '选哪个数据库?',
  options: [
    { label: 'Postgres', value: 'pg' },
    { label: 'MySQL', value: 'mysql' },
  ],
}

const multiSelectQ: AskUserQuestion = {
  header: 'lang',
  question: '选哪些语言?',
  multiSelect: true,
  options: [
    { label: 'TypeScript', value: 'ts' },
    { label: 'Python', value: 'py' },
    { label: 'Rust', value: 'rs' },
  ],
}

const freeTextQ: AskUserQuestion = {
  header: 'note',
  question: '补充说明',
  allowComment: true,
}

function mountOverlay(questions: AskUserQuestion[], allowCancel = true) {
  return mount(AskUserOverlay, {
    props: { questions, allowCancel },
    attachTo: document.body,
  })
}

describe('AskUserOverlay', () => {
  it('U9: 首屏渲染——DOM 含问题文本 + 选项列表', () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 问题文本存在
    expect(wrapper.find('[data-testid="ask-user-question-text"]').text()).toContain('选哪个数据库?')
    // 选项存在
    expect(wrapper.find('[data-testid="ask-user-option-pg"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ask-user-option-mysql"]').exists()).toBe(true)
    // Submit 按钮存在
    expect(wrapper.find('[data-testid="ask-user-submit"]').exists()).toBe(true)
  })

  it('U10: 单选——点击选项 → Submit → answers 包含 value', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 点击 Postgres 选项
    await wrapper.find('[data-testid="ask-user-option-pg"]').trigger('click')
    // Submit
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')

    // emit submit 事件，payload 是 JSON string
    const submitEvents = wrapper.emitted('submit')
    expect(submitEvents).toHaveLength(1)
    const answers = JSON.parse(submitEvents![0][0] as string)
    expect(answers.db).toBe('pg')
  })

  it('U11: 多选——点击多个 → Submit → answers 含 JSON 数组', async () => {
    const wrapper = mountOverlay([multiSelectQ])

    // 点击 TS 和 Python
    await wrapper.find('[data-testid="ask-user-option-ts"]').trigger('click')
    await wrapper.find('[data-testid="ask-user-option-py"]').trigger('click')
    // Submit
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')

    const submitEvents = wrapper.emitted('submit')
    expect(submitEvents).toHaveLength(1)
    const answers = JSON.parse(submitEvents![0][0] as string)
    // 多选 → JSON.stringify(value[])
    expect(JSON.parse(answers.lang)).toEqual(['ts', 'py'])
  })

  it('U12: Other 自由文本 + comment', async () => {
    const wrapper = mountOverlay([freeTextQ])

    // 无 options → 渲染自由文本 Textarea
    expect(wrapper.find('[data-testid="ask-user-free-text"]').exists()).toBe(true)
    // 填入自由文本
    await wrapper.find('[data-testid="ask-user-free-text"]').setValue('需要加索引')
    // 填入评论
    await wrapper.find('[data-testid="ask-user-comment-note"]').setValue('prod 环境注意')
    // Submit
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')

    const submitEvents = wrapper.emitted('submit')
    expect(submitEvents).toHaveLength(1)
    const answers = JSON.parse(submitEvents![0][0] as string)
    // 无 options 的纯自由文本问题：输入文本作为主答案（key=header）
    expect(answers.note).toBe('需要加索引')
    // 评论存到独立 key
    expect(answers['note__comment']).toBe('prod 环境注意')
  })

  it('U13: Cancel → emit cancel 事件', async () => {
    const wrapper = mountOverlay([singleSelectQ], true)

    await wrapper.find('[data-testid="ask-user-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })

  it('U9 补充: 多问题 tab 切换', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 初始显示第一个问题（多问题用 question-text-multi）
    expect(wrapper.find('[data-testid="ask-user-question-text-multi"]').text()).toContain('选哪个数据库?')
    // tab 存在
    expect(wrapper.find('[data-testid="ask-user-tab-1"]').exists()).toBe(true)
    // 切换到第二个
    await wrapper.find('[data-testid="ask-user-tab-1"]').trigger('click')
    expect(wrapper.find('[data-testid="ask-user-question-text-multi"]').text()).toContain('选哪些语言?')
  })

  it('U14: 单选自动前进——选完第一题后 activeIdx 前进到第二题', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 初始显示第一题
    expect(wrapper.find('[data-testid="ask-user-question-text-multi"]').text()).toContain('选哪个数据库?')
    // 选中第一题的 Postgres（单选）
    await wrapper.find('[data-testid="ask-user-option-pg"]').trigger('click')
    // 应自动前进到第二题
    expect(wrapper.find('[data-testid="ask-user-question-text-multi"]').text()).toContain('选哪些语言?')
  })

  it('U15: 单选最后一题不自动前进（Submit 常驻 action bar）', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 只有一题，选中后不应前进（无处可去）
    await wrapper.find('[data-testid="ask-user-option-pg"]').trigger('click')
    // 仍然显示同一题
    expect(wrapper.find('[data-testid="ask-user-question-text"]').text()).toContain('选哪个数据库?')
  })

  it('U16: 非最后一题显示"下一题"按钮，最后一题显示"提交"', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 初始在第一题（非最后）→ 显示"下一题"，当前题未答 → disabled
    const nextBtn = wrapper.find('[data-testid="ask-user-next"]')
    expect(nextBtn.exists()).toBe(true)
    expect(nextBtn.attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="ask-user-submit"]').exists()).toBe(false)

    // 答第一题后 auto-advance 到第二题（最后一题）→ 显示"提交"
    await wrapper.find('[data-testid="ask-user-option-pg"]').trigger('click')
    const submit = wrapper.find('[data-testid="ask-user-submit"]')
    expect(submit.exists()).toBe(true)
    // 第二题还没答 → 提交 disabled
    expect(submit.attributes('disabled')).toBeDefined()
    expect(submit.attributes('title')).toContain('1 题未答')
  })

  it('U17: 全答后提交 enabled', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 答第一题（单选，auto-advance 到第二题）
    await wrapper.find('[data-testid="ask-user-option-pg"]').trigger('click')
    // 答第二题（多选）
    await wrapper.find('[data-testid="ask-user-option-ts"]').trigger('click')

    const submit = wrapper.find('[data-testid="ask-user-submit"]')
    expect(submit.attributes('disabled')).toBeUndefined()
  })

  it('U18: 已答 tab 绿点——作答后 tab 显示 answered 标记', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 初始无绿点
    expect(wrapper.find('[data-testid="ask-user-tab-answered"]').exists()).toBe(false)
    // 答第一题（单选 auto-advance）
    await wrapper.find('[data-testid="ask-user-option-pg"]').trigger('click')
    // tab-0 应有已答绿点
    const tab0 = wrapper.find('[data-testid="ask-user-tab-0"]')
    expect(tab0.find('[data-testid="ask-user-tab-answered"]').exists()).toBe(true)
  })

  it('U19: Other 卡片化——点选 Other 展开输入框，输入文本', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 初始 Other input 不显示（未选中）
    expect(wrapper.find('[data-testid="ask-user-other-db"]').exists()).toBe(false)
    // 点选 Other 卡片
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    // Other input 展开
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    expect(otherInput.exists()).toBe(true)
    // 输入文本
    await otherInput.setValue('自定义数据库')
    // 提交
    await wrapper.find('[data-testid="ask-user-submit"]').trigger('click')
    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    // Other 文本作为主答案值
    expect(answers.db).toBe('自定义数据库')
  })

  it('U20: Other/选项互斥——选普通选项取消 Other 选中', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 先选 Other 卡片
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    // 输入文本
    await wrapper.find('[data-testid="ask-user-other-db"]').setValue('自定义')
    // Other input 存在
    expect(wrapper.find('[data-testid="ask-user-other-db"]').exists()).toBe(true)
    // 选 Postgres（单选互斥）→ Other 取消选中，input 消失
    await wrapper.find('[data-testid="ask-user-option-pg"]').trigger('click')
    expect(wrapper.find('[data-testid="ask-user-other-db"]').exists()).toBe(false)
  })

  it('U21: Other 选中后自动聚焦 input', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 点选 Other 卡片
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    await nextTick()

    // input 应存在
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    expect(otherInput.exists()).toBe(true)
    // ref focus 生效：input 获得焦点
    expect(otherInput.element).toBe(document.activeElement)
  })

  it('U22: Other input 内 enter/space 不冒泡取消选中', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 点选 Other + 输入文本
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    await otherInput.setValue('自定义答案')
    // input 内按 enter
    await otherInput.trigger('keydown', { key: 'Enter' })
    // Other 仍选中、input 仍存在、文本不丢
    expect(wrapper.find('[data-testid="ask-user-other-db"]').exists()).toBe(true)
    expect(otherInput.element.value).toBe('自定义答案')
  })

  it('U23: Other input Enter 前进到下一题（多问题场景）', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 选第一题的 Other
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    await otherInput.setValue('自定义数据库')
    // Enter 前进到第二题
    await otherInput.trigger('keydown', { key: 'Enter' })
    // 切到了第二题
    expect(wrapper.find('[data-testid="ask-user-question-text-multi"]').text()).toContain('选哪些语言?')
  })

  it('U24: "下一题"按钮点击前进到下一题', async () => {
    const wrapper = mountOverlay([singleSelectQ, multiSelectQ])

    // 答第一题（单选 auto-advance 到第二题），但手动测"下一题"按钮——先回到第一题
    await wrapper.find('[data-testid="ask-user-option-pg"]').trigger('click')
    // auto-advance 到第二题了，手动切回第一题
    await wrapper.find('[data-testid="ask-user-tab-0"]').trigger('click')
    // 此时在第一题（已答），显示"下一题"按钮
    const nextBtn = wrapper.find('[data-testid="ask-user-next"]')
    expect(nextBtn.exists()).toBe(true)
    expect(nextBtn.attributes('disabled')).toBeUndefined() // 第一题已答 → enabled
    // 点击前进
    await nextBtn.trigger('click')
    expect(wrapper.find('[data-testid="ask-user-question-text-multi"]').text()).toContain('选哪些语言?')
  })

  it('U25: 最后一题 Other Enter 直接提交', async () => {
    const wrapper = mountOverlay([singleSelectQ])

    // 选 Other + 输入文本
    await wrapper.find('[data-testid="ask-user-option-__other__"]').trigger('click')
    const otherInput = wrapper.find('[data-testid="ask-user-other-db"]')
    await otherInput.setValue('自定义数据库')
    // Enter 直接提交（最后一题 + allAnswered）
    await otherInput.trigger('keydown', { key: 'Enter' })
    const answers = JSON.parse(wrapper.emitted('submit')![0][0] as string)
    expect(answers.db).toBe('自定义数据库')
  })
})

describe('AskUserOverlay · v3 样式对齐 demo v3', () => {
  it('U6: 倒计时显示——[data-testid="ask-user-countdown"] 文本匹配 mm:ss，初值 04:59-05:00', () => {
    // startedAt = 当前时间，倒计时 300s，刚 mount 剩余接近 300s（05:00）
    const wrapper = mount(AskUserOverlay, {
      props: { questions: [singleSelectQ], allowCancel: true, startedAt: Date.now() },
    })

    const timer = wrapper.find('[data-testid="ask-user-countdown"]')
    expect(timer.exists()).toBe(true)
    const text = timer.text()
    // mm:ss 格式
    expect(text).toMatch(/^\d{2}:\d{2}$/)
    const [mm, ss] = text.split(':').map(Number)
    const totalSec = mm * 60 + ss
    // 初值在 04:59-05:00 区间（刚 mount，剩余 299-300s）
    expect(totalSec).toBeGreaterThanOrEqual(299)
    expect(totalSec).toBeLessThanOrEqual(300)
  })

  it('U6 补充: startedAt 可选——缺省也能渲染倒计时', () => {
    const wrapper = mountOverlay([singleSelectQ])
    const timer = wrapper.find('[data-testid="ask-user-countdown"]')
    expect(timer.exists()).toBe(true)
    expect(timer.text()).toMatch(/^\d{2}:\d{2}$/)
  })

  it('U7: 字体——tab 12px / 单问题标题 13px / opt-label 13px', () => {
    // 多问题 + 带选项（含 description）
    const wrapper = mountOverlay([optWithDescQ, singleSelectQ])

    // tab 含 text-[12px]
    const tab1 = wrapper.find('[data-testid="ask-user-tab-1"]')
    expect(tab1.exists()).toBe(true)
    expect(tab1.attributes('class')).toContain('text-[12px]')

    // 多问题文本含 text-[13px]
    const qText = wrapper.find('[data-testid="ask-user-question-text-multi"]')
    expect(qText.attributes('class')).toContain('text-[13px]')

    // 选项 label 含 text-[13px]
    const optPg = wrapper.find('[data-testid="ask-user-option-pg"]')
    expect(optPg.exists()).toBe(true)
    const optLabel = optPg.find('[data-testid="ask-user-option-label"]')
    expect(optLabel.exists()).toBe(true)
    expect(optLabel.attributes('class')).toContain('text-[13px]')
  })

  it('U7 补充: opt-desc 字号 12px（subtle 色弱化）', () => {
    const wrapper = mountOverlay([optWithDescQ])
    const optPg = wrapper.find('[data-testid="ask-user-option-pg"]')
    const optDesc = optPg.find('[data-testid="ask-user-option-desc"]')
    expect(optDesc.exists()).toBe(true)
    expect(optDesc.attributes('class')).toContain('text-[12px]')
    // 弱化：subtle 色
    expect(optDesc.attributes('class')).toContain('text-subtle')
  })

  it('U7 补充: 请求头存在——单问题标题提到 head 行', () => {
    const wrapper = mountOverlay([singleSelectQ])
    const head = wrapper.find('[data-testid="ask-user-head"]')
    expect(head.exists()).toBe(true)
    // 单问题：标题在 head 行
    const headTitle = head.find('[data-testid="ask-user-question-text"]')
    expect(headTitle.exists()).toBe(true)
    expect(headTitle.text()).toContain('选哪个数据库?')
    // head 含倒计时
    expect(head.find('[data-testid="ask-user-countdown"]').exists()).toBe(true)
  })
})
