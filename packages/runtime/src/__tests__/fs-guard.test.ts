/**
 * fs-guard 防线自测（2026-09-02 会话丢失事故）。
 *
 * 三视角：
 * - 构建者白盒：isRealDataDir / isDestructiveAllowed 判定边界（等值 / 前缀 / 前缀撞名
 *   如 ~/.xyz-agent-other 不得误拒）
 * - 使用者黑盒：端到端——本文件运行于已挂 fs-guard 的 worker，直接调 node:fs 的
 *   rmSync/writeFileSync 验证拦截真实生效（白名单内放行、真实目录抛错）
 * - 观察者形态：拦截错误信息必须可操作（含白名单与恢复指引）
 *
 * 写句柄入口（fd/流写路径防线）：openSync 写 flags / callback open / createWriteStream /
 * promises.open 的写 flags 校验 path——写 fd 只能经此产生，闭合 writeSync/ftruncate 等
 * fd 消费点（详见 test/fs-guard.ts「边界」注释）。
 */
import { describe, expect, it } from 'vitest'
import {
  closeSync,
  createWriteStream,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { open as fspOpen } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDestructiveAllowed, isRealDataDir } from '../../test/fs-guard-impl.js'

describe('fs-guard 判定（纯函数）', () => {
  it('真实数据目录等值与其内任意深度路径一律拒绝', () => {
    expect(isRealDataDir(join(homedir(), '.xyz-agent'))).toBe(true)
    expect(isRealDataDir(join(homedir(), '.xyz-agent', 'pi', 'sessions'))).toBe(true)
    expect(isDestructiveAllowed(join(homedir(), '.xyz-agent', 'pi', 'sessions', 'x.jsonl'))).toBe(false)
  })

  it('白名单成员（tmpdir / dev 数据目录）及其内路径放行', () => {
    expect(isDestructiveAllowed(tmpdir())).toBe(true)
    expect(isDestructiveAllowed(join(tmpdir(), 'some-fixture-abc', 'a.jsonl'))).toBe(true)
    expect(isDestructiveAllowed(join(homedir(), '.xyz-agent-dev'))).toBe(true)
    expect(isDestructiveAllowed(join(homedir(), '.xyz-agent-dev', 'pi', 'sessions', 'x.jsonl'))).toBe(true)
  })

  it('tmp 的 realpath 形式放行（macOS /var → /private/var symlink，fixture 路径经 realpathSync 后形态）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-guard-realpath-'))
    const realPath = realpathSync(dir)
    expect(isDestructiveAllowed(realPath)).toBe(true)
    expect(isDestructiveAllowed(join(realPath, 'nested', 'a.jsonl'))).toBe(true)
    rmSync(dir, { recursive: true })
  })

  it('其余目录一律拒绝（工作区 / 家目录普通文件 / 前缀撞名）', () => {
    expect(isDestructiveAllowed(join(homedir(), 'Code', 'proj', 'f.txt'))).toBe(false)
    expect(isDestructiveAllowed(join(homedir(), 'notes.txt'))).toBe(false)
    // 前缀撞名：.xyz-agent-other 不是 .xyz-agent 的子路径，不受真实目录无条件拒绝影响，
    // 但也不在白名单内 → 仍拒绝（结果一致，路径归因不同——保证判定语义清晰）。
    expect(isDestructiveAllowed(join(homedir(), '.xyz-agent-other', 'f.txt'))).toBe(false)
  })
})

describe('fs-guard 切面端到端（本文件 import 的 fs 已是 wrapper）', () => {
  it('白名单内写 / 删正常执行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-guard-e2e-'))
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')
    rmSync(file)
    rmSync(dir, { recursive: true })
  })

  it('真实目录的删除被拦截且错误信息可操作', () => {
    expect(() => rmSync(join(homedir(), '.xyz-agent'), { recursive: true })).toThrow(/vitest-fs-guard/)
    let caught: Error | undefined
    try {
      writeFileSync(join(homedir(), '.xyz-agent', 'pi', 'sessions', 'probe.txt'), 'x')
      expect.unreachable('expected fs-guard to block write into real data dir')
    } catch (e) {
      caught = e as Error
    }
    // 观察者视角：错误必须指向恢复动作（全局规则：错误信息可操作）
    expect(caught.message).toContain('~/.xyz-agent-dev')
    expect(caught.message).toContain('mkdtempSync')
  })
})

describe('fs-guard 写句柄入口（fd/流写路径防线）', () => {
  it('白名单内 openSync 写文件成功，fd 写入生效（tmp fixture 标准形态不误伤）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-guard-fdwrite-'))
    const file = join(dir, 'w.txt')
    const fd = openSync(file, 'w')
    writeSync(fd, 'x')
    closeSync(fd)
    expect(readFileSync(file, 'utf8')).toBe('x')
    rmSync(dir, { recursive: true })
  })

  it('真实数据目录 openSync("w") 被拦（绕道 fd 写不可达）', () => {
    expect(() =>
      openSync(join(homedir(), '.xyz-agent', 'pi', 'sessions', 'probe-fd.txt'), 'w'),
    ).toThrow(/vitest-fs-guard/)
  })

  it('真实数据目录 createWriteStream 被拦（打开发生在流构造时，wrapper 先校验）', () => {
    expect(() =>
      createWriteStream(join(homedir(), '.xyz-agent', 'pi', 'sessions', 'probe-stream.txt')),
    ).toThrow(/vitest-fs-guard/)
  })

  it('fs/promises open 写真实数据目录被拦（FileHandle 写句柄唯一入口）', () => {
    expect(() =>
      fspOpen(join(homedir(), '.xyz-agent', 'pi', 'sessions', 'probe-fh.txt'), 'w'),
    ).toThrow(/vitest-fs-guard/)
  })

  it('只读 openSync("r") 对任意路径不拦（读不在防护范围，含本仓库文件）', () => {
    const repoPkg = fileURLToPath(new URL('../../../../package.json', import.meta.url))
    const fd = openSync(repoPkg, 'r')
    closeSync(fd)
  })
})
