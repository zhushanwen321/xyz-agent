# Infrastructure Scan: Package pi into xyz-agent

## 1. Project Structure

```
feat-package-pi/                          # Root (bare repo worktree)
├── package.json                          # Root workspace orchestrator (v0.2.1)
├── src-electron/                         # Independent npm project (v0.2.2)
│   ├── package.json                      # Electron + electron-builder deps
│   ├── electron-builder.yml              # Packaging config (3 platforms)
│   ├── main/                             # Electron main process
│   │   ├── main.ts                       # App lifecycle, runtime startup
│   │   ├── runtime-manager.ts            # Sidecar process lifecycle (port 3210-3220)
│   │   ├── window-manager.ts             # BrowserWindow management
│   │   ├── ipc-handlers.ts              # IPC bridge (runtime-port, windows)
│   │   └── shortcuts.ts                  # Global keyboard shortcuts
│   ├── preload/
│   │   └── preload.ts                    # contextBridge → electronAPI
│   ├── renderer/                         # Vue 3 frontend (Vite)
│   │   ├── src/
│   │   │   ├── lib/ws-client.ts          # WebSocket client → sidecar
│   │   │   ├── composables/useChat.ts    # Chat event routing
│   │   │   └── stores/chat.ts            # ChatSession partitioned state
│   │   └── vite.config.ts               # Vite dev server (port 1420, strictPort)
│   ├── runtime/                          # Sidecar process (tsup → CJS)
│   │   ├── src/
│   │   │   ├── index.ts                  # Sidecar entry: parses --port, wires DI
│   │   │   ├── server.ts                 # WebSocket server (transport layer)
│   │   │   ├── process-manager.ts        # pi subprocess lifecycle
│   │   │   ├── rpc-client.ts             # JSONL stdin/stdout RPC to pi
│   │   │   ├── event-adapter.ts          # pi events → WS protocol messages
│   │   │   ├── config-store.ts           # Provider config (reads ~/.pi/config.json)
│   │   │   ├── types.ts                  # Full pi RPC protocol types
│   │   │   ├── interfaces.ts             # DI interfaces (IRpcClient, IProcessManager, etc.)
│   │   │   ├── services/
│   │   │   │   ├── session-service.ts    # Session CRUD, messaging, history
│   │   │   │   ├── config-service.ts     # Provider/skill/agent CRUD
│   │   │   │   └── model-service.ts      # Model aggregation & API discovery
│   │   │   └── model-db.ts              # Local model metadata (reads ~/.xyz-agent/model-db.json)
│   │   └── tsup.config.ts               # Bundles to dist/runtime/index.cjs
│   ├── shared/                           # Shared types (npm workspace)
│   │   └── src/protocol.ts              # ClientMessage/ServerMessage protocol
│   └── scripts/dev-cleanup.mjs
├── .github/workflows/
│   ├── ci.yml                           # lint + typecheck + test (ubuntu)
│   └── release.yml                      # 3-platform build + GitHub Release
└── docs/
```

### Key Entry Points

| Layer | Entry | How Started |
|-------|-------|-------------|
| Electron main | `main/main.ts` → `dist/main/main.cjs` | `electron .` |
| Sidecar (runtime) | `runtime/src/index.ts` → `dist/runtime/index.cjs` | Spawned by RuntimeManager with `ELECTRON_RUN_AS_NODE=1` |
| Preload | `preload/preload.ts` → `dist/preload/preload.cjs` | BrowserWindow `webPreferences.preload` |
| Renderer | `renderer/src/main.ts` | Vite dev server or `file://` in production |
| pi subprocess | External binary `pi` | Spawned by RpcClient via `spawn('pi', ['--mode', 'rpc'])` |

### No `resources/` directory exists yet. No `extraResources` or `extraFiles` in electron-builder.yml.

---

## 2. Existing APIs Related to pi

### ProcessManager (`runtime/src/process-manager.ts`)

**Binary discovery** — `findPiExecutable()` search order:
1. `which pi` / `where pi` (PATH)
2. nvm directories (`~/.nvm/versions/node/*/bin/pi` or `%APPDATA%\nvm\*\pi.cmd`)
3. Common locations (`/usr/local/bin/pi`, `~/bin/pi`)
4. Fallback: bare `'pi'` (will fail with clear error message)

**Key method**: `createSession(sessionId, cwd, options?)` → spawns `pi --mode rpc [--model X] [--skill Y] [--session-dir ~/.xyz-agent/sessions]`

**Current pi binary**: symlink at `~/.nvm/versions/node/v24.11.1/bin/pi` → `../lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js` (v0.70.5)

### RpcClient (`runtime/src/rpc-client.ts`)

**Communication**: JSONL over stdin/stdout via `spawn(piCommand, ['--mode', 'rpc', ...])`

**RPC protocol**:
- Client sends: `{"id":"rpc_N_TIMESTAMP", "type":"prompt", "message":"..."}\n`
- Pi responds: `{"id":"rpc_N", "type":"response", "success":true, "data":{...}}\n`
- Pi emits events: `{"type":"message_update","assistantMessageEvent":{...}}\n`

**High-level API**: `prompt()`, `abort()`, `setModel()`, `getAvailableModels()`, `getHistory()`, `compact()`, `clear()`

**Options**: `piCommand` (custom binary path), `cwd`, `provider`, `model`, `env` (API keys), `skillPaths`

### EventAdapter (`runtime/src/event-adapter.ts`)

Translates pi events → `ServerMessage` for WS protocol. Key translations:
- `message_update.text_delta` → `message.text_delta`
- `tool_execution_start/end` → `message.tool_call_start/end`
- `agent_end` → `message.complete`
- `extension_ui_request` (confirm/select) → `message.tool_call_pending`

### Config Store (`runtime/src/config-store.ts`)

- Reads `~/.xyz-agent/config.json` for providers
- Falls back to `~/.pi/config.json` providers
- Reads `~/.pi/agent/models.json` for default model
- Builds env vars like `PROVIDER_API_KEY` / `PROVIDER_BASE_URL` for pi subprocess

---

## 3. Type Definitions

### pi RPC types (`runtime/src/types.ts`)

| Type | Purpose |
|------|---------|
| `PiInputMessage` | Union of commands sent to pi stdin |
| `PiResponse` | pi RPC response with `success`/`error`/`data` |
| `PiEvent` | Union of all unsolicited pi events (agent_start, message_update, tool_execution_*, etc.) |
| `PiMessage` | Broad shape used by listeners (both response and event) |
| `PiHistoryMessage` | Message shape in `get_messages` response |
| `PiToolExecutionResult` | `{content: [{type:'text', text:'...'}]}` |

### DI Interfaces (`runtime/src/interfaces.ts`)

| Interface | Implementation |
|-----------|----------------|
| `IRpcClient` | `RpcClient` |
| `IProcessManager` | `ProcessManager` |
| `IMessageBroker` | `SidecarServer` |
| `IEventAdapter` | `EventAdapter` |
| `ISessionService` | `SessionService` |
| `IConfigService` | `ConfigService` |
| `IModelService` | `ModelService` |

### WS Protocol (`shared/src/protocol.ts`)

| Type | Direction |
|------|-----------|
| `ClientMessage` (25 types) | Renderer → Sidecar |
| `ServerMessage` (33 types) | Sidecar → Renderer |

---

## 4. Patterns in Use

### Packaging Pipeline

```
npm run build (in src-electron/)
  1. npm -w @xyz-agent/runtime run build    # tsup → dist/runtime/index.cjs
  2. npm -w @xyz-agent/frontend run build   # Vite → renderer/dist/
  3. vite build --config vite.config.main   # → dist/main/main.cjs
  4. vite build --config vite.config.preload # → dist/preload/preload.cjs
  5. electron-builder --publish never       # Packages everything
```

### electron-builder.yml Key Config

| Setting | Value |
|---------|-------|
| `appId` | `com.xyz-agent.app` |
| `asar` | `true` |
| `asarUnpack` | `dist/runtime/**/*` (Node child processes can't read from asar) |
| `mac.target` | dmg+zip, arm64 only |
| `win.target` | nsis+zip, x64 |
| `linux.target` | AppImage+deb, x64 |
| `output` | `dist/builder-output` |

### Sidecar Startup Pattern (RuntimeManager)

1. `findAvailablePort()` (3210-3220 range)
2. `spawn(node, [runtimeDist/index.cjs, --port=N])` with `ELECTRON_RUN_AS_NODE=1`
3. `healthCheck()` via TCP (30 retries × 200ms)
4. Write port to `~/.xyz-agent/runtime.port`

### pi Process Startup Pattern (ProcessManager → RpcClient)

1. `findPiExecutable()` resolves binary
2. `spawn(piPath, ['--mode', 'rpc', '--model', X, '--session-dir', '~/.xyz-agent/sessions'])`
3. Wait 100ms for process to not exit immediately
4. Parse stdout JSONL via readline

### CI/CD

| Workflow | Trigger | Jobs |
|----------|---------|------|
| `ci.yml` | push/PR to main | lint, typecheck, test (ubuntu, Node 20) |
| `release.yml` | tag `v*` or manual | 3-platform parallel build → draft GitHub Release |

---

## 5. Dependencies

### Root `package.json`

| Package | Version | Role |
|---------|---------|------|
| eslint | ^10.3.0 | Linting |
| typescript | ^5.8 | Type checking |

### `src-electron/package.json`

| Package | Version | Role |
|---------|---------|---------|
| electron | 33.4.11 | Runtime |
| electron-builder | ^25 | Packaging |
| electron-store | ^10 | Main process key-value store |
| vite | ^8.0.11 | Build tool |
| tsx | ^4 | Dev runtime for TS |
| vitest | ^4.1.6 | Testing |

### `src-electron/runtime/package.json`

| Package | Version | Role |
|---------|---------||---------|
| ws | ^8 | WebSocket server in sidecar |
| tsup | ^8.5.1 | Bundler (CJS output) |

### pi package (`@mariozechner/pi-coding-agent`)

| Item | Value |
|------|-------|
| Version | 0.70.5 |
| dist/ size | 8.1 MB |
| Total install size | 179 MB |
| Binary | `dist/cli.js` (Node.js shebang) |
| Key deps | `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, `chalk`, `diff`, `undici`, `glob`, `ignore`, `marked` |
| Optional | `@mariozechner/clipboard` |
| Config dir | `~/.pi/agent/` (env: `PI_CODING_AGENT_DIR`) |

---

## 6. Current pi Integration — End-to-End Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ Electron Main Process                                               │
│  RuntimeManager.start()                                             │
│    spawn(node, [dist/runtime/index.cjs, --port=3210])              │
│    ELECTRON_RUN_AS_NODE=1                                           │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ TCP WebSocket (port 3210-3220)
┌───────────────────────────▼─────────────────────────────────────────┐
│ Sidecar Process (runtime)                                           │
│  SidecarServer ←── ws://localhost:3210                              │
│    ├─ SessionService                                                │
│    │    └─ ProcessManager                                           │
│    │         └─ RpcClient.spawn(pi, [--mode rpc])                   │
│    │              stdin ──► JSONL commands                          │
│    │              stdout ◄── JSONL events                           │
│    │    └─ EventAdapter (pi events → ServerMessages)                │
│    ├─ ConfigService (reads ~/.xyz-agent + ~/.pi)                    │
│    └─ ModelService                                                  │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ child_process.spawn
┌───────────────────────────▼─────────────────────────────────────────┐
│ pi subprocess (external binary from PATH/nvm)                      │
│  --mode rpc --model X --session-dir ~/.xyz-agent/sessions          │
│  Reads: ~/.pi/agent/models.json, ~/.pi/agent/settings.json         │
│  Reads: ~/.pi/agent/skills/*, ~/.pi/agent/extensions/*             │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow: User Message

1. Renderer → `ws-client.send({type:'message.send', payload:{sessionId, content}})`
2. Sidecar `server.ts` → `SessionService.sendMessage()`
3. `SessionService` → `RpcClient.prompt(content)` → writes JSONL to pi stdin
4. pi emits `message_update.text_delta` events on stdout
5. `EventAdapter.translate()` → `ServerMessage{type:'message.text_delta'}`
6. `SidecarServer.broadcast()` → all connected WS clients
7. Renderer `event-bus` → `useChat` → `chatStore.appendDelta()`

### pi Configuration Sources

| File | Read By | Purpose |
|------|---------|---------|
| `~/.pi/config.json` | `config-store.ts` | Fallback provider config |
| `~/.pi/agent/models.json` | `config-store.ts`, `model-db.ts` | Default model + provider mapping |
| `~/.pi/agent/settings.json` | pi internally | pi settings (sessionDir, etc.) |
| `~/.pi/agent/skills/*` | pi internally | Skill loading |
| `~/.pi/agent/extensions/*` | pi internally | Extension loading |
| `~/.xyz-agent/config.json` | `config-store.ts` | Primary provider config |
| `~/.xyz-agent/sessions/` | `RpcClient` via `--session-dir` | Session storage |
| `~/.xyz-agent/model-db.json` | `model-db.ts` | Model metadata |

### Critical Environment Variables for pi

| Variable | Source | Purpose |
|----------|--------|---------|
| `PI_CODING_AGENT_DIR` | pi `config.ts` | Override `~/.pi/agent/` path |
| `<PROVIDER>_API_KEY` | `config-store.ts` → `buildProviderEnv()` | API key injection |
| `<PROVIDER>_BASE_URL` | `config-store.ts` → `buildProviderEnv()` | Custom API endpoint |
| `ELECTRON_RUN_AS_NODE` | `runtime-manager.ts` | Use Electron binary as Node |

### Touch Points for Packaging pi

**What needs to change to bundle pi inside the Electron app:**

1. **Binary location**: `findPiExecutable()` in `process-manager.ts` — currently searches PATH/nvm. Needs to find pi from `process.resourcesPath` or `app.asar.unpacked`
2. **RpcClient.spawn()**: `piCommand` option already exists — just needs correct path
3. **electron-builder.yml**: Needs `extraResources` or `asarUnpack` entry for pi dist
4. **pi's config dir**: `PI_CODING_AGENT_DIR` env var can redirect `~/.pi/agent/` reads
5. **pi's node_modules**: pi has 179MB of dependencies — need to bundle its `dist/` + `node_modules/` or use a Bun-compiled binary
