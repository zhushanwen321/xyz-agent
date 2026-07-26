/**
 * RenameSessionDialog regex 校验单测。
 * 验证 session 重命名的符号限制：只禁止 \r\n，允许所有可打印字符。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect）。
 * 运行：cd packages/renderer && npx vitest run src/components/sidebar/__tests__/RenameSessionDialog.test.ts
 */
import { describe, it, expect } from 'vitest'
import * as z from 'zod'

// 复制 RenameSessionDialog.vue 中的 schema 定义，保持同步
const MAX_LABEL_LENGTH = 60
const sessionNameSchema = z.object({
  label: z.string()
    .min(1, 'required')
    .max(MAX_LABEL_LENGTH, 'too long')
    .regex(/^[^\r\n]+$/, 'invalid chars'),
})

describe('session 重命名 regex 校验', () => {
  // TC1: 允许 emoji、标点等可打印字符
  describe('TC1: 允许 emoji、标点等可打印字符', () => {
    const validCases = [
      { input: 'hello🎉', desc: 'emoji' },
      { input: 'test.name', desc: '点号' },
      { input: '用户(1)', desc: '括号' },
      { input: 'task@home', desc: '@符号' },
      { input: '100% 完成', desc: '百分号' },
      { input: 'bug #123', desc: '井号' },
      { input: '价格 $99', desc: '美元符号' },
      { input: '路径/a/b', desc: '斜杠' },
      { input: 'C:\\Users', desc: '反斜杠' },
      { input: '<html>', desc: '尖括号' },
      { input: 'a+b=c', desc: '加号等号' },
      { input: '问号?感叹号!', desc: '问号感叹号' },
      { input: '引号"单引号\'', desc: '引号' },
      { input: '波浪号~', desc: '波浪号' },
      { input: '管道|符', desc: '管道符' },
      { input: '👨‍👩‍👧 家庭', desc: 'emoji 组合字符' },
      { input: '中文测试', desc: '中文' },
      { input: '日本語テスト', desc: '日文' },
      { input: '한국어 테스트', desc: '韩文' },
      { input: 'Ñoño', desc: '西班牙文' },
    ]

    validCases.forEach(({ input, desc }) => {
      it(`允许: "${input}" (${desc})`, () => {
        const result = sessionNameSchema.safeParse({ label: input })
        expect(result.success).toBe(true)
      })
    })
  })

  // TC2: 拒绝 \r\n 控制字符
  describe('TC2: 拒绝 \\r\\n 控制字符', () => {
    const invalidCases = [
      { input: 'hello\nworld', desc: '含 \\n' },
      { input: 'hello\rworld', desc: '含 \\r' },
      { input: 'hello\r\nworld', desc: '含 \\r\\n' },
      { input: 'hello\n\rworld', desc: '含 \\n\\r' },
      { input: '\n开头', desc: '\\n 开头' },
      { input: '结尾\n', desc: '\\n 结尾' },
      { input: '\r开头', desc: '\\r 开头' },
      { input: '结尾\r', desc: '\\r 结尾' },
    ]

    invalidCases.forEach(({ input, desc }) => {
      it(`拒绝: ${desc}`, () => {
        const result = sessionNameSchema.safeParse({ label: input })
        expect(result.success).toBe(false)
      })
    })
  })

  // TC3: 最大长度 60 仍生效
  describe('TC3: 最大长度限制', () => {
    it('60 字符应通过', () => {
      const input = 'a'.repeat(60)
      const result = sessionNameSchema.safeParse({ label: input })
      expect(result.success).toBe(true)
    })

    it('61 字符应失败', () => {
      const input = 'a'.repeat(61)
      const result = sessionNameSchema.safeParse({ label: input })
      expect(result.success).toBe(false)
    })

    it('空字符串应失败', () => {
      const result = sessionNameSchema.safeParse({ label: '' })
      expect(result.success).toBe(false)
    })
  })
})
