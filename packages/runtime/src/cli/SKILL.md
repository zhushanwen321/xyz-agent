---
name: xyz-settings
description: "operate xyz-agent app settings (providers, models, thinking level) via CLI"
---

# xyz-settings

CLI tool to read and modify xyz-agent's own settings via the running runtime WebSocket.

## Commands

```bash
# List configured providers (name, apiKey status, models)
xyz-settings list-providers [--json]

# Get current default model
xyz-settings get-default-model

# Set default model
xyz-settings set-default-model --provider <name> --model <modelId>

# Override model for a specific session
xyz-settings switch-session-model --session <sessionId> --provider <name> --model <modelId>

# Set thinking level for a session
xyz-settings set-thinking --session <sessionId> --level <off|minimal|low|medium|high|xhigh>
```

## Path Resolution

The CLI binary path depends on environment:

- **Packaged app**: `<resourcesPath>/bin/xyz-settings`
- **Dev mode**: `<repo>/apps/electron/dist/runtime/cli.cjs`

Use `node <path-to-cli.cjs>` to execute. For packaged app, use the binary directly.

## Error Handling

- **Runtime not running**: CLI exits 1 with "runtime not running" message. Tell user to start the app first.
- **Invalid arguments**: CLI exits 1 with usage hint.
- **WS connection failed**: CLI exits 1 with connection error.

## Notes

- CLI reads port from `$XYZ_AGENT_DATA_DIR/runtime.port` (default `~/.xyz-agent/runtime.port`)
- All settings persist to `settings.json` — changes survive app restart
- `set-default-model` and `set-thinking` are live-updated (no restart needed)
- Providers with `apiKeySet: false` need the user to set apiKey via the Settings UI
