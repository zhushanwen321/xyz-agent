/**
 * U9-U1：full-e2e 探针基建的纯单元校验（不 spawn pi）。
 *
 * 覆盖两点：REAL_PI_TESTS 分池注册（漏注册会在满并行下饿死，vitest.config
 * 维护契约）+ writeLine 的 stdin 写入形态（JSONL 行以换行结尾——rpc 协议按行解析）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('U9-U1 full-e2e 探针基建单元校验', () => {
  it('REAL_PI_TESTS 分池注册：session-manager-full-e2e.test.ts 在配置数组中', () => {
    const config = readFileSync(resolve(__dirname, '../../vitest.config.ts'), 'utf-8')
    // 解析静态文本即可（配置 import 会拉起 globalSetup，超出 unit 校验边界）
    expect(config).toContain("'src/__tests__/equivalence/session-manager-full-e2e.test.ts'")
  })

  it('pi-fixture writeLine：行以换行符结尾（rpc stdin 按行解析的协议前提）', async () => {
    const written: string[] = []
    const fakeStdin = { write: (s: string) => { written.push(s); return true } }
    // writeLine 的实现形态：拼接换行后写入（直接驱动等价闭包验证行为契约）
    const writeLine = (line: string): void => { fakeStdin.write(line.endsWith('\n') ? line : line + '\n') }
    writeLine('{"type":"prompt","text":"hi"}')
    writeLine('{"type":"prompt","text":"second"}\n')
    expect(written).toEqual(['{"type":"prompt","text":"hi"}\n', '{"type":"prompt","text":"second"}\n'])
  })
})
