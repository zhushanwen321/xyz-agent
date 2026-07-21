/**
 * IShellRunner 的真实实现 —— `child_process.spawn` 流式执行（W1 worktree setup 钩子）。
 *
 * 🔒 三层架构：infra 层实现 services/ports/shell-runner.ts 的 IShellRunner port。
 * 真引 node:child_process 的 spawn（Tier 2 证伪：编译器对依赖声明验签）。
 *
 * 注入：构造函数 `{ spawn }`，production 由 index.ts 传真实 spawn，测试传 mock spawn。
 * 此模式让 ShellRunner 单测无需真 spawn —— vi.doMock('node:child_process') 后把 mock 注入。
 *
 * 关键时序处理（SR-3 timeout）：
 * - timeout 到期 → child.kill('SIGTERM') + 设 `timedOut=true` 标记 + 启动 reject。
 * - 之后 child 必然 emit 'close'（被 kill 的进程会发 exit+close）—— 若不标记，close handler
 *   会 resolve 一个已 reject 的 promise（无效但易混淆）。故 close handler 先判 timedOut，
 *   已超时则不 resolve（保留 timeout reject）。
 * - 同理 error handler 也判 timedOut（极端：kill 后子进程 error 而非 close）。
 *
 * 行切分策略：Buffer → utf8 → 按 \n split，丢弃尾空行（避免末尾 \n 产生空行回调）。
 * 累积 stdout/stderr 用原始字符串（含 \n），onOutput 收到的是单行（无 \n）。
 */
import { EventEmitter } from 'node:events'
import { ShellRunnerError } from '../services/ports/shell-runner.js'
import type { IShellRunner, ShellRunnerExecuteOptions, ShellRunnerResult, SpawnFn } from '../services/ports/shell-runner.js'

/** 默认超时 ms。setup-worktree.sh 通常含 npm install，给 2 分钟兜底。 */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * ShellRunner infra 适配器。spawn 经依赖注入，可替换为 mock 做单测。
 *
 * child 形状契约（与 node:child_process.ChildProcess 一致）：
 * - extends EventEmitter：emit 'close'(exitCode) / 'error'(Error)
 * - stdout/stderr: EventEmitter（emit 'data'(Buffer)）
 * - kill(signal): 终止子进程
 * - killed: boolean（kill 后置 true）
 */
export class ShellRunner implements IShellRunner {
  constructor(private deps: { spawn: SpawnFn }) {}

  execute(opts: ShellRunnerExecuteOptions): Promise<ShellRunnerResult> {
    const { scriptPath, args, cwd, onOutput } = opts
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS

    const child = this.deps.spawn(scriptPath, args ?? [], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: (signal?: string) => void
      killed: boolean
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timer: NodeJS.Timeout | undefined

    return new Promise<ShellRunnerResult>((resolve, reject) => {
      const onStdoutData = (chunk: Buffer | string): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        stdout += text
        if (onOutput) {
          for (const line of splitLines(text)) onOutput(line, 'stdout')
        }
      }
      const onStderrData = (chunk: Buffer | string): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        stderr += text
        if (onOutput) {
          for (const line of splitLines(text)) onOutput(line, 'stderr')
        }
      }
      const onClose = (exitCode: number | null): void => {
        if (timer) clearTimeout(timer)
        // timeout 路径已 reject；后续 close 不再 resolve（保留 timeout 语义，避免 SR-3 失败）。
        if (timedOut) return
        child.stdout.removeListener('data', onStdoutData)
        child.stderr.removeListener('data', onStderrData)
        resolve({ exitCode: exitCode ?? 0, stdout, stderr })
      }
      const onError = (err: NodeJS.ErrnoException): void => {
        if (timer) clearTimeout(timer)
        if (timedOut) return
        child.stdout.removeListener('data', onStdoutData)
        child.stderr.removeListener('data', onStderrData)
        // 脚本不存在（ENOENT）→ not_found；其余 errno 也归 not_found（语义上都是「找不到可执行文件」）
        if (err.code === 'ENOENT') {
          reject(new ShellRunnerError('not_found', `脚本不存在或不可执行: ${scriptPath}`))
        } else {
          reject(new ShellRunnerError('not_found', `脚本执行失败: ${err.message}`))
        }
      }

      child.stdout.on('data', onStdoutData)
      child.stderr.on('data', onStderrData)
      child.on('close', onClose)
      child.on('error', onError)

      if (timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          reject(new ShellRunnerError('timeout', `脚本执行超时（${timeout}ms）: ${scriptPath}`))
        }, timeout)
      }
    })
  }
}

/**
 * 把 chunk 文本切成行（去尾空行）。
 * 'a\nb\n' → ['a','b']；'a\nb' → ['a','b']；'' → []。
 * 末尾的 \n 不应产生空行回调，避免给 onOutput 多发一个无意义的空串。
 */
function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  // 末元素为空串（text 以 \n 结尾）则丢弃；非空则保留（text 不以 \n 结尾的尾行）。
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
