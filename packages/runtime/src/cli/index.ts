#!/usr/bin/env node
/**
 * xyz-settings CLI — 操作 xyz-agent 自身的设置。
 * 通过 WS 复用 runtime 的 config.* 消息，逻辑单一真值源在 ConfigService。
 *
 * Usage:
 *   xyz-settings list-providers [--json]
 *   xyz-settings get-default-model
 *   xyz-settings set-default-model --provider <p> --model <m>
 *   xyz-settings switch-session-model --session <id> --provider <p> --model <m>
 *   xyz-settings set-thinking --session <id> --level <level>
 */
import { parseArgs, executeCommand } from './commands.js'

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!args.command || args.command === '--help' || args.command === '-h') {
    console.log(`xyz-settings — operate xyz-agent settings via CLI

Read commands:
  list-providers [--json]          List configured providers
  get-default-model                Get current default model
  discover-models --name <id>      Fetch models from provider API

Write commands:
  set-default-model --provider <p> --model <m>
  switch-session-model --session <id> --provider <p> --model <m>
  set-thinking --session <id> --level <off|minimal|low|medium|high|xhigh>
  set-provider --name <id> --provider <type> [--api-key-stdin]
  set-skill-dirs --skill-dirs <path1,path2,...>
  set-agent-dirs --agent-dirs <path1,path2,...>
  delete-provider --name <id>

Options:
  --json              Output as JSON
  --api-key-stdin     Read apiKey from stdin (never from CLI args)
  --help              Show this help`
    process.exit(0)
  }

  try {
    const output = await executeCommand(args)
    console.log(output)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${message}`)
    process.exit(1)
  }
}

main()
