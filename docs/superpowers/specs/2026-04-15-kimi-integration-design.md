# Kimi AI Integration Design

**Date:** 2026-04-15  
**Status:** Approved  
**Approach:** Hybrid — Proxy (Lane A) + CLI Wrapper (Lane B) + VSCode Transcript Watcher (Lane C)

---

## Problem Statement

Kimi AI (Moonshot AI) is widely used as a coding assistant via its OpenAI-compatible API
(`api.moonshot.cn/v1`), a CLI tool, and VSCode extensions. claude-mem has no capture path
for Kimi sessions — tool usage, file edits, and AI responses go unrecorded and cannot
contribute to cross-session memory or context injection.

---

## Architecture Overview

Three independent capture lanes all converge on `platformSource: 'kimi'` in the worker.

```
┌─────────────────────────────────────────────────────────────┐
│                      CAPTURE LANES                          │
│                                                             │
│  Lane A: Proxy                Lane B: Wrapper               │
│  ─────────────────────        ─────────────────────         │
│  User SDK/script              User types `kimi` in terminal │
│    └─ KIMI_BASE_URL=          ~/.kimi-mem/bin/kimi (on      │
│       localhost:11451/v1        $PATH before real binary)   │
│         │                              │                    │
│    KimiProxyServer              Shell wrapper script        │
│    (Bun HTTP, port 11451)       injects env vars →          │
│         │                       delegates to proxy path     │
│  POST /api/hook/kimi/*                 │                    │
│                  └──────────┬──────────┘                    │
│                             │                               │
│                    Lane C: VSCode                           │
│                    ─────────────────────                    │
│                    TranscriptWatcher                        │
│                    glob: globalStorage/*kimi*/**/*.json     │
│                             │                               │
│                    TranscriptEventProcessor                 │
│                    (kimi-vscode schema)                     │
│                             │                               │
└─────────────────────────────┼───────────────────────────────┘
                              │
              ┌───────────────▼───────────────┐
              │      Worker (port 37777)       │
              │  sessionInitHandler            │
              │  observationHandler            │
              │  sessionCompleteHandler        │
              │  platformSource: 'kimi'        │
              └───────────────────────────────┘
                              │
              ┌───────────────▼───────────────┐
              │    Context Injection           │
              │  ~/.kimi/KIMI.md              │  ← Lanes A/B
              │  <workspace>/AGENTS.md        │  ← Lane C
              └───────────────────────────────┘
```

---

## New Files

| File | Purpose |
|------|---------|
| `src/cli/adapters/kimi.ts` | PlatformAdapter — normalises Kimi JSON to NormalizedHookInput |
| `src/services/integrations/KimiProxyServer.ts` | Bun HTTP reverse proxy (Lane A) |
| `src/services/integrations/KimiInstaller.ts` | Installer orchestrator for all three lanes |

## Modified Files

| File | Change |
|------|--------|
| `src/cli/adapters/index.ts` | Register `'kimi'` → `kimiAdapter` |
| `src/shared/platform-source.ts` | Normalise `'kimi'` source string |
| `src/services/integrations/index.ts` | Export `KimiInstaller` |
| `src/services/transcripts/config.ts` | Add `kimi-vscode` schema + watch entry to `SAMPLE_CONFIG` |
| `src/npx-cli/commands/ide-detection.ts` | Detect `~/.kimi` dir or `kimi` binary |
| `src/npx-cli/commands/install.ts` | Add `'kimi'` IDE case to `setupIDEs()` |

---

## Lane A: OpenAI-Compatible Reverse Proxy

### Rationale

Kimi's API is OpenAI-compatible. Any client — Python SDK, TypeScript SDK, curl scripts,
the official CLI — can be redirected to a local proxy by setting one env var. The proxy
has complete visibility into every request and response with no PATH manipulation and no
PTY complexity.

### Port

`11451` — chosen to avoid conflicts with Ollama (`11434`) and the claude-mem worker (`37777`).

### Request Flow

```
POST /v1/chat/completions  (from user client)
  1. Parse request body
  2. injectKimiMdContext() — prepend ~/.kimi/KIMI.md as system message if none present
  3. Forward to api.moonshot.cn/v1/chat/completions with original Authorization header
  4. Stream SSE chunks back to client unchanged (zero added latency)
  5. On stream close: assemble full response text, call notifyWorker() (async, fire-and-forget)
```

Non-chat endpoints (`/v1/models`, `/v1/files`, etc.) are forwarded transparently without
observation capture.

### Session ID Strategy

SHA-256 of the **first `role: user` message content** in the `messages` array.

- Moonshot's API is stateless but clients carry full message history on every call.
  The earliest user message is therefore the stable identity anchor across all turns.
- If the array contains no user message (edge case), fall back to a random UUID.
- No timestamp component — timestamps cause false session splits when the same
  conversation resumes after a pause.

### Context Injection

Before forwarding, the proxy reads `~/.kimi/KIMI.md`. If the file exists, is non-empty,
and the incoming request has no `system` role message, the proxy prepends:

```json
{ "role": "system", "content": "<contents of ~/.kimi/KIMI.md>" }
```

This is the same `<claude-mem-context>` tag pattern used by `CLAUDE.md` and `GEMINI.md`.

### Concurrency

The proxy uses Bun's native async I/O — each request is an independent async task. The
`notifyWorker()` call is fire-and-forget (`void notifyWorker(...)`) so it never blocks
the response stream. `KIMI.md` is read per-request (not cached) to pick up context
updates immediately after a session ends and the worker refreshes the file.

### `KimiProxyServer` interface

```typescript
export class KimiProxyServer {
  readonly port = 11451;

  start(): void;   // Bun.serve() — idempotent
  stop(): void;    // server.stop()

  private handleRequest(req: Request): Promise<Response>;
  private handleChatCompletions(req: Request): Promise<Response>;
  private buildSessionId(messages: Message[]): string;          // SHA-256
  private injectKimiMdContext(messages: Message[]): Message[];  // KIMI.md prepend
  private assembleStreamText(chunks: string[]): string;         // SSE → full text
  private async notifyWorker(event: string, payload: unknown): Promise<void>;
}
```

---

## Lane B: CLI Wrapper

### Rationale

When a user types `kimi` in their terminal, the wrapper intercepts the invocation,
injects `KIMI_BASE_URL=http://localhost:11451/v1` and `KIMI_CWD=$(pwd)`, then
delegates to the real binary. Because the proxy is already handling capture, the wrapper
itself does **no** JSON parsing or HTTP calls — it is purely an env-var injector.

### Installation

`KimiInstaller` resolves the real `kimi` binary path at install time (using `which kimi`)
and writes the wrapper to `~/.kimi-mem/bin/kimi`. It then prepends `~/.kimi-mem/bin` to
`PATH` in `~/.zshrc` and `~/.bashrc`.

### Wrapper script

```bash
#!/usr/bin/env bash
# claude-mem Kimi wrapper — auto-generated by `npx claude-mem install --ide kimi`
# Do not edit manually — re-run install to regenerate.
REAL_KIMI="__REAL_KIMI_PATH__"
export KIMI_BASE_URL="http://localhost:11451/v1"
export KIMI_CWD="$(pwd)"

if [ -x "$REAL_KIMI" ]; then
  exec "$REAL_KIMI" "$@"
else
  echo "[claude-mem] kimi binary not found at $REAL_KIMI — set KIMI_BASE_URL manually" >&2
  exec env KIMI_BASE_URL="$KIMI_BASE_URL" "${@}"
fi
```

`__REAL_KIMI_PATH__` is substituted by the installer with the absolute path resolved at
install time (e.g. `/usr/local/bin/kimi` or `/home/user/.bun/bin/kimi`).

### Non-interactive / API-only usage

If the user never types `kimi` directly but calls the Moonshot API from code, they can
skip the wrapper entirely and just set `KIMI_BASE_URL=http://localhost:11451/v1` in their
environment. The wrapper install step is optional; Lane A alone is sufficient for SDK usage.

---

## Lane C: VSCode Transcript Watcher

### VSCode Extension Storage Paths (macOS)

Kimi VSCode extensions write session data to VSCode's `globalStorage` directory:

| Host | Path |
|------|------|
| VS Code | `~/Library/Application Support/Code/User/globalStorage/` |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage/` |
| VSCodium | `~/.config/VSCodium/User/globalStorage/` |
| VS Code (Linux) | `~/.config/Code/User/globalStorage/` |

The watcher uses the glob:

```
~/Library/Application Support/{Code,Cursor}/User/globalStorage/*{kimi,moonshot}*/**/*.json
```

On Linux, an additional glob covers `~/.config/{Code,Cursor,VSCodium}`.

Since extension IDs vary by publisher and version, the glob intentionally matches any
extension folder whose name contains `kimi` or `moonshot`. The `kimi-vscode` schema
validates that matched files contain the expected Moonshot API message structure before
processing.

**JSON array → JSONL normalisation.** `TranscriptWatcher` processes JSONL (one object
per line). Kimi VSCode extensions write a JSON *array* to a single `.json` file.
`KimiInstaller` registers a `fs.watch` on each discovered source `.json` file that, on
every change, expands the array to JSONL and writes a sidecar file to
`~/.claude-mem/kimi-vscode-transcripts/<hash-of-source-path>.jsonl`. The transcript
watcher targets the sidecar directory, not the source files directly.

### `kimi-vscode` TranscriptSchema

Kimi VSCode extensions typically persist conversation history as a JSON array of
OpenAI-format message objects. The schema targets files whose top-level structure is
either an array of messages or a `{ messages: [...] }` envelope:

```typescript
const KIMI_VSCODE_SCHEMA: TranscriptSchema = {
  name: 'kimi-vscode',
  version: '0.1',
  description: 'Schema for Kimi VSCode extension session JSON files.',
  events: [
    {
      name: 'user-turn',
      match: { path: 'role', equals: 'user' },
      action: 'session_init',
      fields: { prompt: 'content' }
    },
    {
      name: 'assistant-turn',
      match: { path: 'role', equals: 'assistant' },
      action: 'assistant_message',
      fields: { message: 'content' }
    },
  ]
};
```

Context is injected into `<workspace>/AGENTS.md` on `session_end`, using the same
`updateContext()` flow as the Codex CLI integration.

---

## KimiInstaller

`installKimi()` runs three independent setup steps and reports each independently:

1. **Proxy** — emits instructions to set `KIMI_BASE_URL=http://localhost:11451/v1`; the
   proxy starts automatically with the worker, no per-install action needed beyond
   documentation.
2. **Wrapper** — resolves real `kimi` binary, writes `~/.kimi-mem/bin/kimi`, patches
   shell rc files.
3. **VSCode transcript watch** — merges `kimi-vscode` watch + schema into
   `~/.claude-mem/transcript-watch.json` (same merge strategy as `CodexCliInstaller`).
4. **KIMI.md** — creates `~/.kimi/KIMI.md` with placeholder `<claude-mem-context>` block.

Failure in any one step does not abort the others.

Public API mirrors existing installers:

```typescript
export async function installKimi(): Promise<number>
export function uninstallKimi(): number
export function checkKimiStatus(): number
export async function handleKimiCommand(subcommand: string, args: string[]): Promise<number>
```

---

## `KimiAdapter` Payload Contract

Both the proxy (Lane A) and any direct hook callers POST this shape to
`bun worker-service.cjs hook kimi <event>`:

```json
{
  "session_id": "<sha256-derived>",
  "cwd": "/Users/zoran/project",
  "model": "moonshot-v1-128k",
  "prompt": "first user message of the turn",
  "tool_name": "KimiCompletion",
  "tool_input": {
    "messages": [{ "role": "user", "content": "..." }],
    "model": "moonshot-v1-128k",
    "temperature": 0.3
  },
  "tool_response": {
    "content": "assistant response",
    "usage": { "prompt_tokens": 142, "completion_tokens": 88 }
  },
  "metadata": {
    "finish_reason": "stop",
    "kimi_request_id": "req_abc123"
  }
}
```

The adapter coalesces `prompt` from `tool_input.messages[role=user].content` when the
top-level `prompt` field is absent (handles both direct POST and proxy-assembled payloads).

---

## Context Injection Summary

| Lane | Injection Target | Update Trigger |
|------|-----------------|----------------|
| A (Proxy) | `~/.kimi/KIMI.md` | After every session summary via worker |
| B (Wrapper) | `~/.kimi/KIMI.md` | Same — wrapper delegates to proxy |
| C (VSCode) | `<workspace>/AGENTS.md` | `session_start` and `session_end` |

---

## platform-source.ts

Add `kimi` to `normalizePlatformSource()`:

```typescript
if (source.includes('kimi') || source.includes('moonshot')) return 'kimi';
```

And add `'kimi'` to the priority list in `sortPlatformSources()`.

---

## IDE Detection

```typescript
{
  id: 'kimi',
  label: 'Kimi (Moonshot AI)',
  detected: existsSync(join(home, '.kimi')) || isCommandInPath('kimi'),
  supported: true,
  hint: 'proxy + wrapper + VSCode transcript',
}
```

---

## Out of Scope

- Kimi web interface capture (requires browser extension, future work)
- Kimi mobile app
- Multi-user / shared API key setups
- Real-time streaming observation (observations fire after stream completes, not per-chunk)
