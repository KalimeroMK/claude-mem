# Kimi AI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Kimi AI (Moonshot AI) as a first-class claude-mem provider via a three-lane hybrid: OpenAI-compatible reverse proxy (Lane A), CLI wrapper env-var injector (Lane B), and VSCode extension transcript watcher (Lane C).

**Architecture:** `KimiProxyServer` (Bun HTTP, port 11451) intercepts Moonshot API calls, injects `~/.kimi/KIMI.md` context, forwards to `api.moonshot.cn/v1`, and notifies the worker after each completion. A shell wrapper injects `KIMI_BASE_URL` so terminal `kimi` invocations route through the proxy. A `TranscriptWatcher` + JSON→JSONL normaliser captures VSCode extension session files independently.

**Tech Stack:** Bun runtime, TypeScript/ESM, `bun:test`, existing `observationHandler`/`sessionInitHandler`/`sessionCompleteHandler` pipeline, `TranscriptWatcher` + `TranscriptEventProcessor`, `injectContextIntoMarkdownFile` utility.

**Spec:** `docs/superpowers/specs/2026-04-15-kimi-integration-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| **Create** | `src/cli/adapters/kimi.ts` | `PlatformAdapter` — normalises Kimi JSON to `NormalizedHookInput` |
| **Create** | `src/services/integrations/KimiProxyServer.ts` | Bun HTTP reverse proxy on port 11451 |
| **Create** | `src/services/integrations/KimiVscodeNormalizer.ts` | JSON array → JSONL sidecar for VSCode extension files |
| **Create** | `src/services/integrations/KimiInstaller.ts` | Installer: wrapper, KIMI.md, transcript config merge |
| **Create** | `tests/kimi-adapter.test.ts` | Unit tests for `kimiAdapter` |
| **Create** | `tests/kimi-proxy-pure.test.ts` | Unit tests for pure proxy methods |
| **Create** | `tests/kimi-vscode-normalizer.test.ts` | Unit tests for JSON→JSONL normaliser |
| **Create** | `tests/kimi-installer.test.ts` | Unit tests for installer |
| **Modify** | `src/cli/adapters/index.ts` | Register `'kimi'` → `kimiAdapter` |
| **Modify** | `src/shared/platform-source.ts` | Normalise `'kimi'`/`'moonshot'` source strings |
| **Modify** | `src/services/integrations/index.ts` | Export `KimiInstaller` |
| **Modify** | `src/services/transcripts/config.ts` | Add `kimi-vscode` schema to `SAMPLE_CONFIG` |
| **Modify** | `src/services/worker-service.ts` | Start/stop `KimiProxyServer`; add `kimi` subcommand |
| **Modify** | `src/npx-cli/commands/ide-detection.ts` | Detect `~/.kimi` dir or `kimi` binary |
| **Modify** | `src/npx-cli/commands/install.ts` | Add `'kimi'` case to `setupIDEs()` |

---

## Task 1: KimiAdapter + platform-source normalisation

**Files:**
- Create: `src/cli/adapters/kimi.ts`
- Modify: `src/shared/platform-source.ts`
- Modify: `src/cli/adapters/index.ts`
- Test: `tests/kimi-adapter.test.ts`

- [ ] **Step 1.1 — Write failing tests**

```typescript
// tests/kimi-adapter.test.ts
import { describe, it, expect } from 'bun:test';
import { kimiAdapter } from '../src/cli/adapters/kimi.js';
import { normalizePlatformSource } from '../src/shared/platform-source.js';

describe('kimiAdapter.normalizeInput', () => {
  it('maps top-level fields directly', () => {
    const result = kimiAdapter.normalizeInput({
      session_id: 'abc123',
      cwd: '/home/user/project',
      model: 'moonshot-v1-128k',
      prompt: 'Hello',
      tool_name: 'KimiCompletion',
      tool_input: { messages: [{ role: 'user', content: 'Hello' }] },
      tool_response: { content: 'Hi', usage: { prompt_tokens: 5, completion_tokens: 2 } },
      metadata: { finish_reason: 'stop', kimi_request_id: 'req_001' },
    });

    expect(result.sessionId).toBe('abc123');
    expect(result.cwd).toBe('/home/user/project');
    expect(result.prompt).toBe('Hello');
    expect(result.toolName).toBe('KimiCompletion');
    expect(result.metadata).toEqual({ model: 'moonshot-v1-128k', finish_reason: 'stop', kimi_request_id: 'req_001' });
  });

  it('coalesces prompt from tool_input.messages when top-level prompt is absent', () => {
    const result = kimiAdapter.normalizeInput({
      session_id: 'abc123',
      cwd: '/project',
      tool_input: { messages: [{ role: 'user', content: 'Coalesced prompt' }] },
    });
    expect(result.prompt).toBe('Coalesced prompt');
  });

  it('defaults toolName to KimiCompletion when absent', () => {
    const result = kimiAdapter.normalizeInput({ session_id: 's1', cwd: '/p' });
    expect(result.toolName).toBe('KimiCompletion');
  });

  it('falls back to process.cwd() when cwd absent and KIMI_CWD unset', () => {
    delete process.env.KIMI_CWD;
    const result = kimiAdapter.normalizeInput({ session_id: 's1' });
    expect(result.cwd).toBe(process.cwd());
  });

  it('uses KIMI_CWD env var when cwd field absent', () => {
    process.env.KIMI_CWD = '/env/project';
    const result = kimiAdapter.normalizeInput({ session_id: 's1' });
    expect(result.cwd).toBe('/env/project');
    delete process.env.KIMI_CWD;
  });

  it('handles null/undefined raw gracefully', () => {
    expect(() => kimiAdapter.normalizeInput(null)).not.toThrow();
    expect(() => kimiAdapter.normalizeInput(undefined)).not.toThrow();
  });

  it('omits metadata when no metadata fields present', () => {
    const result = kimiAdapter.normalizeInput({ session_id: 's1', cwd: '/p' });
    expect(result.metadata).toBeUndefined();
  });
});

describe('kimiAdapter.formatOutput', () => {
  it('returns { continue: true } by default', () => {
    expect(kimiAdapter.formatOutput({})).toEqual({ continue: true });
  });

  it('respects explicit continue: false', () => {
    expect(kimiAdapter.formatOutput({ continue: false })).toEqual({ continue: false });
  });
});

describe('normalizePlatformSource — kimi', () => {
  it('normalises "kimi" to "kimi"', () => {
    expect(normalizePlatformSource('kimi')).toBe('kimi');
  });
  it('normalises "moonshot" to "kimi"', () => {
    expect(normalizePlatformSource('moonshot')).toBe('kimi');
  });
  it('normalises "kimi-cli" to "kimi"', () => {
    expect(normalizePlatformSource('kimi-cli')).toBe('kimi');
  });
});
```

- [ ] **Step 1.2 — Run tests to confirm they fail**

```bash
cd /Users/zoran/PhpstormProjects/claude-mem
bun test tests/kimi-adapter.test.ts
```

Expected: `Cannot find module '../src/cli/adapters/kimi.js'`

- [ ] **Step 1.3 — Create `src/cli/adapters/kimi.ts`**

```typescript
import type { PlatformAdapter } from '../types.js';

export const kimiAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as Record<string, any>;

    const messages: Array<{ role: string; content: string }> =
      r.tool_input?.messages ?? [];
    const prompt: string | undefined =
      r.prompt ?? messages.find((m) => m.role === 'user')?.content;

    const metadata: Record<string, unknown> = {};
    if (r.model)                          metadata.model = r.model;
    if (r.metadata?.finish_reason)        metadata.finish_reason = r.metadata.finish_reason;
    if (r.metadata?.kimi_request_id)      metadata.kimi_request_id = r.metadata.kimi_request_id;

    return {
      sessionId:    r.session_id ?? r.sessionId ?? '',
      cwd:          r.cwd ?? process.env.KIMI_CWD ?? process.cwd(),
      prompt,
      toolName:     r.tool_name ?? 'KimiCompletion',
      toolInput:    r.tool_input,
      toolResponse: r.tool_response,
      metadata:     Object.keys(metadata).length ? metadata : undefined,
    };
  },

  formatOutput(result) {
    return { continue: result.continue ?? true };
  },
};
```

- [ ] **Step 1.4 — Add `kimi` to `normalizePlatformSource` in `src/shared/platform-source.ts`**

Find the block of `if (source.includes(...))` guards and add before the final `return source`:

```typescript
  if (source.includes('kimi') || source.includes('moonshot')) return 'kimi';
```

Also add `'kimi'` to the `priority` array in `sortPlatformSources`:

```typescript
  const priority = ['claude', 'codex', 'cursor', 'kimi'];
```

- [ ] **Step 1.5 — Register adapter in `src/cli/adapters/index.ts`**

Add import at top:
```typescript
import { kimiAdapter } from './kimi.js';
```

Add case in `getPlatformAdapter`:
```typescript
    case 'kimi': return kimiAdapter;
```

Add to final export line:
```typescript
export { claudeCodeAdapter, cursorAdapter, geminiCliAdapter, kimiAdapter, rawAdapter, windsurfAdapter };
```

- [ ] **Step 1.6 — Run tests to confirm they pass**

```bash
bun test tests/kimi-adapter.test.ts
```

Expected: all 10 tests pass.

- [ ] **Step 1.7 — Commit**

```bash
git add src/cli/adapters/kimi.ts src/cli/adapters/index.ts src/shared/platform-source.ts tests/kimi-adapter.test.ts
git commit -m "feat(kimi): add KimiAdapter and platform-source normalisation"
```

---

## Task 2: KimiProxyServer — pure methods

**Files:**
- Create: `src/services/integrations/KimiProxyServer.ts` (class + pure methods only, no Bun.serve yet)
- Test: `tests/kimi-proxy-pure.test.ts`

- [ ] **Step 2.1 — Write failing tests**

```typescript
// tests/kimi-proxy-pure.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// We test the exported pure-method helpers; the class is imported for its public API.
import { KimiProxyServer } from '../src/services/integrations/KimiProxyServer.js';

describe('KimiProxyServer.buildSessionId', () => {
  const proxy = new KimiProxyServer();

  it('returns stable hash for same first user message', () => {
    const msgs = [{ role: 'user', content: 'Hello Kimi' }];
    expect(proxy.buildSessionId(msgs)).toBe(proxy.buildSessionId(msgs));
  });

  it('returns different hashes for different first user messages', () => {
    const a = proxy.buildSessionId([{ role: 'user', content: 'Hello' }]);
    const b = proxy.buildSessionId([{ role: 'user', content: 'World' }]);
    expect(a).not.toBe(b);
  });

  it('uses first user message when assistant appears before user', () => {
    const msgs = [
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Anchor' },
    ];
    const expected = proxy.buildSessionId([{ role: 'user', content: 'Anchor' }]);
    expect(proxy.buildSessionId(msgs)).toBe(expected);
  });

  it('returns a UUID-like string when no user message present', () => {
    const id = proxy.buildSessionId([{ role: 'system', content: 'Context' }]);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is stable across multi-turn history (uses earliest user msg)', () => {
    const firstTurn = [{ role: 'user', content: 'Start' }];
    const secondTurn = [
      { role: 'user', content: 'Start' },
      { role: 'assistant', content: 'Reply' },
      { role: 'user', content: 'Follow-up' },
    ];
    expect(proxy.buildSessionId(firstTurn)).toBe(proxy.buildSessionId(secondTurn));
  });
});

describe('KimiProxyServer.injectKimiMdContext', () => {
  const proxy = new KimiProxyServer();
  let tmpKimiDir: string;
  let tmpKimiMd: string;

  beforeEach(() => {
    tmpKimiDir = join(tmpdir(), `kimi-test-${Date.now()}`);
    mkdirSync(tmpKimiDir, { recursive: true });
    // Override the KIMI.md path by temporarily setting an env var the proxy reads
    process.env.KIMI_MD_PATH_OVERRIDE = join(tmpKimiDir, 'KIMI.md');
    tmpKimiMd = process.env.KIMI_MD_PATH_OVERRIDE;
  });

  afterEach(() => {
    delete process.env.KIMI_MD_PATH_OVERRIDE;
    rmSync(tmpKimiDir, { recursive: true, force: true });
  });

  it('prepends system message from KIMI.md when no system message in messages', () => {
    writeFileSync(tmpKimiMd, 'You are a helpful assistant.', 'utf-8');
    const result = proxy.injectKimiMdContext([{ role: 'user', content: 'Hi' }]);
    expect(result[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    expect(result[1]).toEqual({ role: 'user', content: 'Hi' });
  });

  it('does not inject when system message already present', () => {
    writeFileSync(tmpKimiMd, 'Override context', 'utf-8');
    const msgs = [
      { role: 'system', content: 'Existing system' },
      { role: 'user', content: 'Hi' },
    ];
    const result = proxy.injectKimiMdContext(msgs);
    expect(result).toEqual(msgs);
  });

  it('does not inject when KIMI.md does not exist', () => {
    const msgs = [{ role: 'user', content: 'Hi' }];
    const result = proxy.injectKimiMdContext(msgs);
    expect(result).toEqual(msgs);
  });

  it('does not inject when KIMI.md is empty', () => {
    writeFileSync(tmpKimiMd, '   \n  ', 'utf-8');
    const msgs = [{ role: 'user', content: 'Hi' }];
    const result = proxy.injectKimiMdContext(msgs);
    expect(result).toEqual(msgs);
  });
});

describe('KimiProxyServer.assembleStreamText', () => {
  const proxy = new KimiProxyServer();

  it('extracts content from SSE chunks', () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n',
      'data: [DONE]\n',
    ].join('');
    expect(proxy.assembleStreamText(raw)).toBe('Hello world');
  });

  it('ignores non-data lines', () => {
    const raw = 'event: message\ndata: {"choices":[{"delta":{"content":"Hi"}}]}\n\n';
    expect(proxy.assembleStreamText(raw)).toBe('Hi');
  });

  it('returns empty string for empty input', () => {
    expect(proxy.assembleStreamText('')).toBe('');
  });

  it('handles chunks with no content delta', () => {
    const raw = 'data: {"choices":[{"delta":{}}]}\ndata: [DONE]\n';
    expect(proxy.assembleStreamText(raw)).toBe('');
  });
});
```

- [ ] **Step 2.2 — Run tests to confirm they fail**

```bash
bun test tests/kimi-proxy-pure.test.ts
```

Expected: `Cannot find module '../src/services/integrations/KimiProxyServer.js'`

- [ ] **Step 2.3 — Create `src/services/integrations/KimiProxyServer.ts` with pure methods**

```typescript
import { createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../../utils/logger.js';
import { sessionInitHandler } from '../../cli/handlers/session-init.js';
import { observationHandler } from '../../cli/handlers/observation.js';
import { sessionCompleteHandler } from '../../cli/handlers/session-complete.js';
import { workerHttpRequest } from '../../shared/worker-utils.js';
import { injectContextIntoMarkdownFile } from '../../utils/context-injection.js';
import { getProjectContext } from '../../utils/project-name.js';

export interface KimiMessage {
  role: string;
  content: string;
}

const MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1';
const KIMI_PROXY_PORT = 11451;

function resolveKimiMdPath(): string {
  return process.env.KIMI_MD_PATH_OVERRIDE
    ?? join(homedir(), '.kimi', 'KIMI.md');
}

export class KimiProxyServer {
  readonly port = KIMI_PROXY_PORT;
  private server: ReturnType<typeof Bun.serve> | null = null;

  // ─── Pure helpers (public for testability) ───────────────────────────────

  buildSessionId(messages: KimiMessage[]): string {
    const firstUser = messages.find((m) => m.role === 'user');
    if (!firstUser) return randomUUID();
    return createHash('sha256').update(firstUser.content).digest('hex').slice(0, 16);
  }

  injectKimiMdContext(messages: KimiMessage[]): KimiMessage[] {
    if (messages.some((m) => m.role === 'system')) return messages;
    const kimiMdPath = resolveKimiMdPath();
    if (!existsSync(kimiMdPath)) return messages;
    const content = readFileSync(kimiMdPath, 'utf-8').trim();
    if (!content) return messages;
    return [{ role: 'system', content }, ...messages];
  }

  assembleStreamText(raw: string): string {
    return raw
      .split('\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => {
        try {
          const json = JSON.parse(line.slice(6)) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          return json.choices?.[0]?.delta?.content ?? '';
        } catch {
          return '';
        }
      })
      .join('');
  }

  // ─── Server lifecycle ─────────────────────────────────────────────────────

  start(): void {
    if (this.server) return;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.server = Bun.serve({
      port: this.port,
      async fetch(req: Request): Promise<Response> {
        return self.handleRequest(req);
      },
    });
    logger.info('KIMI', `Proxy server started on port ${this.port}`);
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
    logger.info('KIMI', 'Proxy server stopped');
  }

  // ─── Request handling ─────────────────────────────────────────────────────

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      return this.handleChatCompletions(req);
    }
    // Transparent passthrough for all other endpoints (/v1/models, /v1/files, etc.)
    return fetch(new Request(`${MOONSHOT_BASE_URL}${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    }));
  }

  private async handleChatCompletions(req: Request): Promise<Response> {
    const body = await req.json() as {
      messages: KimiMessage[];
      model?: string;
      stream?: boolean;
      [key: string]: unknown;
    };

    const cwd = req.headers.get('X-Kimi-Cwd') ?? process.env.KIMI_CWD ?? process.cwd();
    const messages = this.injectKimiMdContext(body.messages ?? []);
    const sessionId = this.buildSessionId(messages);

    // Fire session-init for the first user turn
    void sessionInitHandler.execute({
      sessionId,
      cwd,
      prompt: messages.find((m) => m.role === 'user')?.content,
      platform: 'kimi',
    });

    const upstreamBody = { ...body, messages };
    const upstream = await fetch(`${MOONSHOT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(upstreamBody),
    });

    if (body.stream) {
      const [forClient, forCapture] = upstream.body!.tee();
      void this.captureAndNotify(forCapture, sessionId, cwd, body);
      return new Response(forClient, { status: upstream.status, headers: upstream.headers });
    }

    // Non-streaming
    const responseJson = await upstream.json() as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: unknown;
    };
    const content = responseJson.choices?.[0]?.message?.content ?? '';
    const finishReason = responseJson.choices?.[0]?.finish_reason;
    void this.sendObservation(sessionId, cwd, body, content);
    if (finishReason === 'stop') {
      void this.sessionCompleteAndRefreshContext(sessionId, cwd);
    }
    return new Response(JSON.stringify(responseJson), {
      status: upstream.status,
      headers: upstream.headers,
    });
  }

  private async captureAndNotify(
    body: ReadableStream,
    sessionId: string,
    cwd: string,
    requestBody: { messages: KimiMessage[]; model?: string },
  ): Promise<void> {
    const chunks: string[] = [];
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: !done }));
      }
    } catch {
      // Stream cancelled by client — still process what we received
    }
    const raw = chunks.join('');
    const content = this.assembleStreamText(raw);
    await this.sendObservation(sessionId, cwd, requestBody, content);
    // Refresh KIMI.md context after every completed streaming turn
    void this.sessionCompleteAndRefreshContext(sessionId, cwd);
  }

  private async sendObservation(
    sessionId: string,
    cwd: string,
    requestBody: { messages: KimiMessage[]; model?: string },
    content: string,
  ): Promise<void> {
    await observationHandler.execute({
      sessionId,
      cwd,
      toolName: 'KimiCompletion',
      toolInput: { messages: requestBody.messages, model: requestBody.model },
      toolResponse: { content },
      platform: 'kimi',
    });
  }

  private async sessionCompleteAndRefreshContext(sessionId: string, cwd: string): Promise<void> {
    await sessionCompleteHandler.execute({ sessionId, cwd, platform: 'kimi' });
    await this.refreshKimiMd(cwd);
  }

  private async refreshKimiMd(cwd: string): Promise<void> {
    try {
      const { primary } = getProjectContext(cwd);
      const response = await workerHttpRequest(
        `/api/context/inject?project=${encodeURIComponent(primary)}&platformSource=kimi`,
      );
      if (!response.ok) return;
      const content = (await response.text()).trim();
      if (!content) return;
      const kimiMdPath = resolveKimiMdPath();
      injectContextIntoMarkdownFile(kimiMdPath, content);
      logger.debug('KIMI', 'Refreshed KIMI.md context', { kimiMdPath, project: primary });
    } catch (error) {
      logger.debug('KIMI', 'KIMI.md refresh skipped', {}, error as Error);
    }
  }
}
```

- [ ] **Step 2.4 — Run tests**

```bash
bun test tests/kimi-proxy-pure.test.ts
```

Expected: all 13 tests pass.

- [ ] **Step 2.5 — Commit**

```bash
git add src/services/integrations/KimiProxyServer.ts tests/kimi-proxy-pure.test.ts
git commit -m "feat(kimi): add KimiProxyServer with proxy + context injection"
```

---

## Task 3: VSCode JSON→JSONL normaliser + kimi-vscode schema

**Files:**
- Create: `src/services/integrations/KimiVscodeNormalizer.ts`
- Modify: `src/services/transcripts/config.ts`
- Test: `tests/kimi-vscode-normalizer.test.ts`

- [ ] **Step 3.1 — Write failing tests**

```typescript
// tests/kimi-vscode-normalizer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { normalizeKimiVscodeFile, KIMI_VSCODE_SCHEMA } from '../src/services/integrations/KimiVscodeNormalizer.js';

describe('normalizeKimiVscodeFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `kimi-norm-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('converts a JSON array of messages to JSONL in sidecar', () => {
    const source = join(tmpDir, 'session.json');
    const sidecar = join(tmpDir, 'session.jsonl');
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    writeFileSync(source, JSON.stringify(messages), 'utf-8');

    normalizeKimiVscodeFile(source, sidecar);

    const lines = readFileSync(sidecar, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ role: 'user', content: 'Hello' });
    expect(JSON.parse(lines[1])).toEqual({ role: 'assistant', content: 'Hi there' });
  });

  it('handles { messages: [...] } envelope format', () => {
    const source = join(tmpDir, 'session.json');
    const sidecar = join(tmpDir, 'session.jsonl');
    writeFileSync(source, JSON.stringify({
      messages: [{ role: 'user', content: 'Test' }],
      title: 'Session 1',
    }), 'utf-8');

    normalizeKimiVscodeFile(source, sidecar);

    const lines = readFileSync(sidecar, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ role: 'user', content: 'Test' });
  });

  it('creates empty sidecar for empty messages array', () => {
    const source = join(tmpDir, 'session.json');
    const sidecar = join(tmpDir, 'session.jsonl');
    writeFileSync(source, '[]', 'utf-8');

    normalizeKimiVscodeFile(source, sidecar);

    expect(readFileSync(sidecar, 'utf-8')).toBe('');
  });

  it('silently skips non-JSON files', () => {
    const source = join(tmpDir, 'invalid.json');
    const sidecar = join(tmpDir, 'invalid.jsonl');
    writeFileSync(source, 'not json', 'utf-8');

    expect(() => normalizeKimiVscodeFile(source, sidecar)).not.toThrow();
    expect(existsSync(sidecar)).toBe(false);
  });

  it('silently skips JSON that is not an array or envelope', () => {
    const source = join(tmpDir, 'other.json');
    const sidecar = join(tmpDir, 'other.jsonl');
    writeFileSync(source, '{"unrelated": true}', 'utf-8');

    normalizeKimiVscodeFile(source, sidecar);
    expect(existsSync(sidecar)).toBe(false);
  });
});

describe('KIMI_VSCODE_SCHEMA', () => {
  it('has name kimi-vscode', () => {
    expect(KIMI_VSCODE_SCHEMA.name).toBe('kimi-vscode');
  });

  it('has user-turn event that matches role=user', () => {
    const userEvent = KIMI_VSCODE_SCHEMA.events.find((e) => e.name === 'user-turn');
    expect(userEvent?.match).toEqual({ path: 'role', equals: 'user' });
    expect(userEvent?.action).toBe('session_init');
  });

  it('has assistant-turn event that matches role=assistant', () => {
    const assistantEvent = KIMI_VSCODE_SCHEMA.events.find((e) => e.name === 'assistant-turn');
    expect(assistantEvent?.match).toEqual({ path: 'role', equals: 'assistant' });
    expect(assistantEvent?.action).toBe('assistant_message');
  });
});
```

- [ ] **Step 3.2 — Run tests to confirm they fail**

```bash
bun test tests/kimi-vscode-normalizer.test.ts
```

Expected: `Cannot find module '../src/services/integrations/KimiVscodeNormalizer.js'`

- [ ] **Step 3.3 — Create `src/services/integrations/KimiVscodeNormalizer.ts`**

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';
import type { TranscriptSchema } from '../transcripts/types.js';

export const KIMI_VSCODE_SCHEMA: TranscriptSchema = {
  name: 'kimi-vscode',
  version: '0.1',
  description: 'Schema for Kimi VSCode extension session JSON files (after JSON→JSONL normalisation).',
  events: [
    {
      name: 'user-turn',
      match: { path: 'role', equals: 'user' },
      action: 'session_init',
      fields: { prompt: 'content' },
    },
    {
      name: 'assistant-turn',
      match: { path: 'role', equals: 'assistant' },
      action: 'assistant_message',
      fields: { message: 'content' },
    },
  ],
};

/**
 * Convert a Kimi VSCode extension JSON session file to JSONL sidecar.
 *
 * Handles two source shapes:
 *   - Array: `[{ role, content }, ...]`
 *   - Envelope: `{ messages: [{ role, content }, ...], ... }`
 *
 * Silently no-ops for non-JSON or unrecognised shapes — the watcher
 * must not crash on unrelated files matched by the glob.
 */
export function normalizeKimiVscodeFile(sourcePath: string, sidecarPath: string): void {
  let raw: string;
  try {
    raw = readFileSync(sourcePath, 'utf-8');
  } catch {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.debug('KIMI', 'Skipping non-JSON file in VSCode normaliser', { sourcePath });
    return;
  }

  let messages: unknown[];
  if (Array.isArray(parsed)) {
    messages = parsed;
  } else if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'messages' in parsed &&
    Array.isArray((parsed as Record<string, unknown>).messages)
  ) {
    messages = (parsed as { messages: unknown[] }).messages;
  } else {
    return; // Unrecognised shape — skip silently
  }

  mkdirSync(dirname(sidecarPath), { recursive: true });
  const jsonl = messages.map((m) => JSON.stringify(m)).join('\n');
  writeFileSync(sidecarPath, jsonl, 'utf-8');
}
```

- [ ] **Step 3.4 — Add `kimi-vscode` schema to `src/services/transcripts/config.ts`**

After the `CODEX_SAMPLE_SCHEMA` const and before the `SAMPLE_CONFIG` export, add:

```typescript
import { KIMI_VSCODE_SCHEMA } from '../integrations/KimiVscodeNormalizer.js';
```

Then in `SAMPLE_CONFIG.schemas`, add the schema:

```typescript
export const SAMPLE_CONFIG: TranscriptWatchConfig = {
  version: 1,
  schemas: {
    codex: CODEX_SAMPLE_SCHEMA,
    'kimi-vscode': KIMI_VSCODE_SCHEMA,          // ← add this line
  },
  watches: [
    {
      name: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'codex',
      startAtEnd: true,
      context: {
        mode: 'agents',
        updateOn: ['session_start', 'session_end'],
      },
    },
    // kimi-vscode watch entry is added by KimiInstaller, not hardcoded here
    // to avoid watching when Kimi is not installed
  ],
  stateFile: DEFAULT_STATE_PATH,
};
```

- [ ] **Step 3.5 — Run tests**

```bash
bun test tests/kimi-vscode-normalizer.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 3.6 — Commit**

```bash
git add src/services/integrations/KimiVscodeNormalizer.ts src/services/transcripts/config.ts tests/kimi-vscode-normalizer.test.ts
git commit -m "feat(kimi): add VSCode JSON→JSONL normaliser and kimi-vscode schema"
```

---

## Task 4: KimiInstaller

**Files:**
- Create: `src/services/integrations/KimiInstaller.ts`
- Modify: `src/services/integrations/index.ts`
- Test: `tests/kimi-installer.test.ts`

- [ ] **Step 4.1 — Write failing tests**

```typescript
// tests/kimi-installer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We test the pure helpers exported from KimiInstaller
import {
  buildKimiWrapperScript,
  mergeKimiWatchConfig,
  KIMI_WATCH_NAME,
} from '../src/services/integrations/KimiInstaller.js';
import type { TranscriptWatchConfig } from '../src/services/transcripts/types.js';

describe('buildKimiWrapperScript', () => {
  it('substitutes __REAL_KIMI_PATH__ with provided path', () => {
    const script = buildKimiWrapperScript('/usr/local/bin/kimi');
    expect(script).toContain('REAL_KIMI="/usr/local/bin/kimi"');
    expect(script).not.toContain('__REAL_KIMI_PATH__');
  });

  it('exports KIMI_BASE_URL pointing to proxy port 11451', () => {
    const script = buildKimiWrapperScript('/usr/bin/kimi');
    expect(script).toContain('KIMI_BASE_URL="http://localhost:11451/v1"');
  });

  it('exports KIMI_CWD', () => {
    const script = buildKimiWrapperScript('/usr/bin/kimi');
    expect(script).toContain('KIMI_CWD=');
  });

  it('includes exec fallback message when binary not found', () => {
    const script = buildKimiWrapperScript('/missing/kimi');
    expect(script).toContain('claude-mem');
  });
});

describe('mergeKimiWatchConfig', () => {
  it('adds kimi-vscode watch when none exists', () => {
    const base: TranscriptWatchConfig = {
      version: 1,
      schemas: {},
      watches: [],
      stateFile: '/tmp/state.json',
    };
    const result = mergeKimiWatchConfig(base, '/tmp/sidecars');
    const kimiWatch = result.watches.find((w) => w.name === KIMI_WATCH_NAME);
    expect(kimiWatch).toBeDefined();
    expect(kimiWatch?.schema).toBe('kimi-vscode');
  });

  it('replaces existing kimi-vscode watch in-place', () => {
    const base: TranscriptWatchConfig = {
      version: 1,
      schemas: {},
      watches: [{ name: KIMI_WATCH_NAME, path: '/old/path', schema: 'kimi-vscode' }],
      stateFile: '/tmp/state.json',
    };
    const result = mergeKimiWatchConfig(base, '/tmp/sidecars');
    const kimiWatches = result.watches.filter((w) => w.name === KIMI_WATCH_NAME);
    expect(kimiWatches).toHaveLength(1);
    expect(kimiWatches[0].path).not.toBe('/old/path');
  });

  it('preserves non-kimi watches', () => {
    const base: TranscriptWatchConfig = {
      version: 1,
      schemas: {},
      watches: [{ name: 'codex', path: '~/.codex/**/*.jsonl', schema: 'codex' }],
      stateFile: '/tmp/state.json',
    };
    const result = mergeKimiWatchConfig(base, '/tmp/sidecars');
    expect(result.watches.find((w) => w.name === 'codex')).toBeDefined();
  });

  it('adds kimi-vscode schema entry', () => {
    const base: TranscriptWatchConfig = { version: 1, schemas: {}, watches: [], stateFile: '/s' };
    const result = mergeKimiWatchConfig(base, '/tmp/sidecars');
    expect(result.schemas?.['kimi-vscode']).toBeDefined();
  });
});
```

- [ ] **Step 4.2 — Run tests to confirm they fail**

```bash
bun test tests/kimi-installer.test.ts
```

Expected: `Cannot find module '../src/services/integrations/KimiInstaller.js'`

- [ ] **Step 4.3 — Create `src/services/integrations/KimiInstaller.ts`**

```typescript
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from '../../utils/logger.js';
import { injectContextIntoMarkdownFile } from '../../utils/context-injection.js';
import { replaceTaggedContent } from '../../utils/claude-md-utils.js';
import { KIMI_VSCODE_SCHEMA } from './KimiVscodeNormalizer.js';
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_PATH,
} from '../transcripts/config.js';
import type { TranscriptWatchConfig, WatchTarget } from '../transcripts/types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const KIMI_DIR           = path.join(homedir(), '.kimi');
const KIMI_MD_PATH       = path.join(KIMI_DIR, 'KIMI.md');
const KIMI_MEM_BIN_DIR   = path.join(homedir(), '.kimi-mem', 'bin');
const KIMI_WRAPPER_PATH  = path.join(KIMI_MEM_BIN_DIR, 'kimi');
const CLAUDE_MEM_DIR     = path.join(homedir(), '.claude-mem');
const KIMI_SIDECAR_DIR   = path.join(CLAUDE_MEM_DIR, 'kimi-vscode-transcripts');

export const KIMI_WATCH_NAME = 'kimi-vscode';

// macOS + Linux globalStorage globs for VSCode-family editors
function buildVscodeGlobs(): string[] {
  const base = homedir();
  return [
    path.join(base, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', '*kimi*', '**', '*.json'),
    path.join(base, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', '*moonshot*', '**', '*.json'),
    path.join(base, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', '*kimi*', '**', '*.json'),
    path.join(base, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', '*moonshot*', '**', '*.json'),
    path.join(base, '.config', 'Code', 'User', 'globalStorage', '*kimi*', '**', '*.json'),
    path.join(base, '.config', 'Code', 'User', 'globalStorage', '*moonshot*', '**', '*.json'),
  ];
}

// ─── Wrapper script ───────────────────────────────────────────────────────────

export function buildKimiWrapperScript(realKimiPath: string): string {
  return `#!/usr/bin/env bash
# claude-mem Kimi wrapper — auto-generated by \`npx claude-mem install --ide kimi\`
# Do not edit manually — re-run install to regenerate.
REAL_KIMI="${realKimiPath}"
export KIMI_BASE_URL="http://localhost:11451/v1"
export KIMI_CWD="$(pwd)"

if [ -x "$REAL_KIMI" ]; then
  exec "$REAL_KIMI" "$@"
else
  echo "[claude-mem] kimi binary not found at $REAL_KIMI — set KIMI_BASE_URL manually" >&2
  exec env KIMI_BASE_URL="$KIMI_BASE_URL" KIMI_CWD="$KIMI_CWD" "$@"
fi
`;
}

function findRealKimiBinary(): string {
  try {
    const result = execSync('which kimi', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (result && result !== KIMI_WRAPPER_PATH) return result;
  } catch { /* kimi not in PATH */ }
  return '';
}

function installWrapperScript(realKimiPath: string): void {
  mkdirSync(KIMI_MEM_BIN_DIR, { recursive: true });
  const script = buildKimiWrapperScript(realKimiPath || '/usr/local/bin/kimi');
  writeFileSync(KIMI_WRAPPER_PATH, script, 'utf-8');
  chmodSync(KIMI_WRAPPER_PATH, 0o755);
}

function patchShellRc(rcPath: string): void {
  if (!existsSync(rcPath)) return;
  const content = readFileSync(rcPath, 'utf-8');
  const pathEntry = `export PATH="${KIMI_MEM_BIN_DIR}:$PATH"`;
  if (content.includes(KIMI_MEM_BIN_DIR)) return;
  writeFileSync(rcPath, content.trimEnd() + `\n\n# claude-mem Kimi wrapper\n${pathEntry}\n`, 'utf-8');
}

// ─── Transcript watch config ──────────────────────────────────────────────────

export function mergeKimiWatchConfig(
  existing: TranscriptWatchConfig,
  sidecarDir: string,
): TranscriptWatchConfig {
  const merged = { ...existing };

  // Add/replace kimi-vscode schema
  merged.schemas = { ...merged.schemas, 'kimi-vscode': KIMI_VSCODE_SCHEMA };

  const kimiWatch: WatchTarget = {
    name: KIMI_WATCH_NAME,
    path: path.join(sidecarDir, '**', '*.jsonl'),
    schema: 'kimi-vscode',
    startAtEnd: false,
    context: { mode: 'agents', updateOn: ['session_start', 'session_end'] },
  };

  const existingIdx = merged.watches.findIndex((w) => w.name === KIMI_WATCH_NAME);
  if (existingIdx >= 0) {
    const watches = [...merged.watches];
    watches[existingIdx] = kimiWatch;
    merged.watches = watches;
  } else {
    merged.watches = [...merged.watches, kimiWatch];
  }

  return merged;
}

function loadTranscriptConfig(): TranscriptWatchConfig {
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    return { version: 1, schemas: {}, watches: [], stateFile: DEFAULT_STATE_PATH };
  }
  try {
    const raw = readFileSync(DEFAULT_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as TranscriptWatchConfig;
    if (!parsed.watches) parsed.watches = [];
    if (!parsed.schemas) parsed.schemas = {};
    if (!parsed.stateFile) parsed.stateFile = DEFAULT_STATE_PATH;
    return parsed;
  } catch {
    return { version: 1, schemas: {}, watches: [], stateFile: DEFAULT_STATE_PATH };
  }
}

function writeTranscriptConfig(config: TranscriptWatchConfig): void {
  mkdirSync(CLAUDE_MEM_DIR, { recursive: true });
  writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

// ─── KIMI.md ─────────────────────────────────────────────────────────────────

function setupKimiMd(): void {
  const placeholder = `# Memory Context from Past Sessions

*No context yet. Complete your first Kimi session and context will appear here.*`;
  mkdirSync(KIMI_DIR, { recursive: true });
  if (existsSync(KIMI_MD_PATH)) return; // preserve existing content
  injectContextIntoMarkdownFile(KIMI_MD_PATH, placeholder, '# Kimi Context');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function installKimi(): Promise<number> {
  console.log('\nInstalling Claude-Mem Kimi integration...\n');
  let allOk = true;

  // Step 1: Wrapper (Lane B)
  try {
    const realKimi = findRealKimiBinary();
    installWrapperScript(realKimi);
    patchShellRc(path.join(homedir(), '.zshrc'));
    patchShellRc(path.join(homedir(), '.bashrc'));
    console.log(`  Wrapper installed: ${KIMI_WRAPPER_PATH}`);
    if (realKimi) {
      console.log(`  Real kimi binary: ${realKimi}`);
    } else {
      console.log(`  Note: kimi binary not found in PATH — set KIMI_BASE_URL manually`);
    }
  } catch (error) {
    console.error(`  Wrapper install failed: ${(error as Error).message}`);
    allOk = false;
  }

  // Step 2: Transcript watch config (Lane C)
  try {
    mkdirSync(KIMI_SIDECAR_DIR, { recursive: true });
    const config = loadTranscriptConfig();
    const merged = mergeKimiWatchConfig(config, KIMI_SIDECAR_DIR);
    writeTranscriptConfig(merged);
    console.log(`  VSCode transcript watch configured: ${DEFAULT_CONFIG_PATH}`);
    console.log(`  Sidecar directory: ${KIMI_SIDECAR_DIR}`);
  } catch (error) {
    console.error(`  Transcript config failed: ${(error as Error).message}`);
    allOk = false;
  }

  // Step 3: KIMI.md context placeholder
  try {
    setupKimiMd();
    console.log(`  KIMI.md placeholder: ${KIMI_MD_PATH}`);
  } catch (error) {
    console.error(`  KIMI.md setup failed: ${(error as Error).message}`);
    allOk = false;
  }

  console.log(`
Installation ${allOk ? 'complete' : 'partial'}!

Lane A (Proxy): Start the claude-mem worker to activate the proxy on port 11451.
  Set in your shell: export KIMI_BASE_URL="http://localhost:11451/v1"

Lane B (Wrapper): Restart your shell or run: source ~/.zshrc
  The \`kimi\` command will now route through the proxy automatically.

Lane C (VSCode): Restart the claude-mem worker to pick up the new transcript watch.

Context injection: ${KIMI_MD_PATH}
`);

  return allOk ? 0 : 1;
}

export function uninstallKimi(): number {
  console.log('\nUninstalling Claude-Mem Kimi integration...\n');

  // Remove wrapper
  if (existsSync(KIMI_WRAPPER_PATH)) {
    const { rmSync } = require('fs');
    rmSync(KIMI_WRAPPER_PATH, { force: true });
    console.log(`  Removed wrapper: ${KIMI_WRAPPER_PATH}`);
  }

  // Remove kimi-vscode from transcript config
  if (existsSync(DEFAULT_CONFIG_PATH)) {
    const config = loadTranscriptConfig();
    config.watches = config.watches.filter((w) => w.name !== KIMI_WATCH_NAME);
    if (config.schemas) delete config.schemas['kimi-vscode'];
    writeTranscriptConfig(config);
    console.log(`  Removed kimi-vscode watch from ${DEFAULT_CONFIG_PATH}`);
  }

  // Remove claude-mem context from KIMI.md (preserve user content)
  if (existsSync(KIMI_MD_PATH)) {
    let content = readFileSync(KIMI_MD_PATH, 'utf-8');
    content = replaceTaggedContent(content, '');
    writeFileSync(KIMI_MD_PATH, content, 'utf-8');
    console.log(`  Removed context section from ${KIMI_MD_PATH}`);
  }

  console.log('\nUninstallation complete!\nRestart claude-mem worker and your shell to apply changes.\n');
  return 0;
}

export function checkKimiStatus(): number {
  console.log('\nClaude-Mem Kimi Integration Status\n');

  const wrapperInstalled = existsSync(KIMI_WRAPPER_PATH);
  console.log(`Wrapper (Lane B):  ${wrapperInstalled ? `Installed — ${KIMI_WRAPPER_PATH}` : 'Not installed'}`);

  const kimiMdExists = existsSync(KIMI_MD_PATH);
  const hasContext = kimiMdExists && readFileSync(KIMI_MD_PATH, 'utf-8').includes('<claude-mem-context>');
  console.log(`KIMI.md (Lane A):  ${hasContext ? `Active — ${KIMI_MD_PATH}` : kimiMdExists ? 'Exists, no context yet' : 'Not created'}`);

  if (existsSync(DEFAULT_CONFIG_PATH)) {
    const config = loadTranscriptConfig();
    const kimiWatch = config.watches.find((w) => w.name === KIMI_WATCH_NAME);
    console.log(`VSCode (Lane C):   ${kimiWatch ? `Configured — watching ${kimiWatch.path}` : 'Not configured'}`);
  } else {
    console.log(`VSCode (Lane C):   Not configured`);
  }

  console.log(`\nProxy (Lane A):    Start with: npx claude-mem start (port 11451)`);
  console.log('');
  return 0;
}

export async function handleKimiCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':   return installKimi();
    case 'uninstall': return uninstallKimi();
    case 'status':    return checkKimiStatus();
    default:
      console.log(`
Claude-Mem Kimi Integration

Usage: claude-mem kimi <command>

Commands:
  install     Install proxy wrapper, VSCode watcher, and KIMI.md placeholder
  uninstall   Remove Kimi integration (preserves user content)
  status      Check installation status

For docs: https://docs.claude-mem.ai/providers/kimi
      `);
      return 0;
  }
}
```

- [ ] **Step 4.4 — Add exports to `src/services/integrations/index.ts`**

```typescript
export * from './KimiInstaller.js';
```

- [ ] **Step 4.5 — Run tests**

```bash
bun test tests/kimi-installer.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 4.6 — Commit**

```bash
git add src/services/integrations/KimiInstaller.ts src/services/integrations/index.ts tests/kimi-installer.test.ts
git commit -m "feat(kimi): add KimiInstaller with wrapper, VSCode watcher, and KIMI.md setup"
```

---

## Task 5: Worker service — proxy lifecycle + kimi subcommand

**Files:**
- Modify: `src/services/worker-service.ts`

No new test file — changes are wiring only; existing worker lifecycle tests cover startup/shutdown paths.

- [ ] **Step 5.1 — Add import at top of `src/services/worker-service.ts`**

Find the block of integration imports (around line 65–72) and add:

```typescript
import { KimiProxyServer } from './integrations/KimiProxyServer.js';
import { handleKimiCommand } from './integrations/KimiInstaller.js';
```

- [ ] **Step 5.2 — Add class member to `WorkerService` (after `transcriptWatcher` member, ~line 161)**

```typescript
  // Kimi reverse proxy (Lane A — port 11451)
  private kimiProxyServer: KimiProxyServer | null = null;
```

- [ ] **Step 5.3 — Start proxy in `initializeBackground()` (after `startTranscriptWatcher()` call)**

Find the line `await this.startTranscriptWatcher(settings);` and add immediately after:

```typescript
      // Start Kimi proxy server (Lane A) — enabled unless explicitly disabled
      const kimiProxyEnabled = settings.CLAUDE_MEM_KIMI_PROXY_ENABLED !== 'false';
      if (kimiProxyEnabled) {
        this.kimiProxyServer = new KimiProxyServer();
        this.kimiProxyServer.start();
      }
```

- [ ] **Step 5.4 — Stop proxy in `shutdown()` (after `transcriptWatcher` stop, ~line 964)**

```typescript
      if (this.kimiProxyServer) {
        this.kimiProxyServer.stop();
        this.kimiProxyServer = null;
      }
```

- [ ] **Step 5.5 — Add `kimi` subcommand dispatch (alongside `cursor`/`gemini-cli` cases, ~line 1134)**

Find the `case 'cursor':` block and add a parallel case after it:

```typescript
      case 'kimi': {
        const kimiSubcommand = process.argv[3] ?? 'help';
        const kimiResult = await handleKimiCommand(kimiSubcommand, process.argv.slice(4));
        process.exit(kimiResult);
      }
```

- [ ] **Step 5.6 — Verify existing worker tests still pass**

```bash
bun test tests/worker-spawn.test.ts tests/hook-lifecycle.test.ts
```

Expected: all existing tests pass (no regressions from wiring changes).

- [ ] **Step 5.7 — Commit**

```bash
git add src/services/worker-service.ts
git commit -m "feat(kimi): wire KimiProxyServer into worker lifecycle + add kimi subcommand"
```

---

## Task 6: IDE detection + `install.ts` wiring

**Files:**
- Modify: `src/npx-cli/commands/ide-detection.ts`
- Modify: `src/npx-cli/commands/install.ts`

- [ ] **Step 6.1 — Add Kimi to `detectInstalledIDEs()` in `src/npx-cli/commands/ide-detection.ts`**

Find the closing `];` of the return array and add before it:

```typescript
    {
      id: 'kimi',
      label: 'Kimi (Moonshot AI)',
      detected: existsSync(join(home, '.kimi')) || isCommandInPath('kimi'),
      supported: true,
      hint: 'proxy + wrapper + VSCode transcript',
    },
```

- [ ] **Step 6.2 — Add `kimi` case to `setupIDEs()` in `src/npx-cli/commands/install.ts`**

Find the `case 'codex-cli':` block and add after it:

```typescript
      case 'kimi': {
        const { installKimi } = await import('../../services/integrations/KimiInstaller.js');
        const kimiResult = await installKimi();
        if (kimiResult === 0) {
          log.success('Kimi: proxy wrapper + VSCode watcher + KIMI.md installed.');
        } else {
          log.error('Kimi: integration setup partially failed (see output above).');
          failedIDEs.push(ideId);
        }
        break;
      }
```

- [ ] **Step 6.3 — Verify install command test still passes**

```bash
bun test tests/install-non-tty.test.ts
```

Expected: all existing tests pass.

- [ ] **Step 6.4 — Run the full test suite**

```bash
bun test
```

Expected: all tests pass. Fix any regressions before committing.

- [ ] **Step 6.5 — Commit**

```bash
git add src/npx-cli/commands/ide-detection.ts src/npx-cli/commands/install.ts
git commit -m "feat(kimi): add Kimi IDE detection and install.ts wiring"
```

---

## Task 7: Final smoke test + build verification

- [ ] **Step 7.1 — Build the project**

```bash
npm run build-and-sync
```

Expected: exits 0, `plugin/scripts/worker-service.cjs` updated.

- [ ] **Step 7.2 — Verify the adapter is reachable via the CLI**

```bash
echo '{"session_id":"test","cwd":"/tmp","tool_name":"KimiCompletion","tool_input":{"messages":[{"role":"user","content":"hello"}]},"tool_response":{"content":"hi"}}' \
  | bun plugin/scripts/worker-service.cjs hook kimi observation
```

Expected: exits 0, JSON `{"continue":true}` printed to stdout (worker may not be running — that's fine, the hook exits gracefully).

- [ ] **Step 7.3 — Verify IDE detection lists Kimi**

```bash
node -e "
const { detectInstalledIDEs } = require('./plugin/scripts/worker-service.cjs');
" 2>&1 || bun -e "
import { detectInstalledIDEs } from './src/npx-cli/commands/ide-detection.js';
console.log(detectInstalledIDEs().find(i => i.id === 'kimi'));
"
```

Expected: `{ id: 'kimi', label: 'Kimi (Moonshot AI)', detected: ..., supported: true, ... }`

- [ ] **Step 7.4 — Run full test suite one final time**

```bash
bun test
```

Expected: all tests pass, zero failures.

- [ ] **Step 7.5 — Commit**

```bash
git add .
git commit -m "feat(kimi): build verification and smoke test cleanup"
```

---

## Self-Review Checklist

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| KimiAdapter (PlatformAdapter) | Task 1 |
| `normalizePlatformSource('kimi')` | Task 1 |
| `getPlatformAdapter('kimi')` registered | Task 1 |
| KimiProxyServer — `buildSessionId` (SHA-256, no timestamp) | Task 2 |
| KimiProxyServer — `injectKimiMdContext` (KIMI.md prepend) | Task 2 |
| KimiProxyServer — streaming passthrough + capture | Task 2 |
| KimiProxyServer — fire-and-forget `notifyWorker` | Task 2 |
| KimiProxyServer — context refresh after `finish_reason: stop` | Task 2 |
| VSCode JSON→JSONL normaliser | Task 3 |
| `kimi-vscode` TranscriptSchema | Task 3 |
| KimiInstaller — wrapper script with `__REAL_KIMI_PATH__` | Task 4 |
| KimiInstaller — shell rc PATH patching | Task 4 |
| KimiInstaller — transcript watch config merge | Task 4 |
| KimiInstaller — KIMI.md placeholder | Task 4 |
| KimiInstaller — install/uninstall/status/handleCommand | Task 4 |
| Worker: proxy start on `initializeBackground()` | Task 5 |
| Worker: proxy stop on `shutdown()` | Task 5 |
| Worker: `kimi` subcommand dispatch | Task 5 |
| IDE detection: `~/.kimi` dir or `kimi` binary | Task 6 |
| `install.ts`: `'kimi'` case in `setupIDEs()` | Task 6 |

**Type consistency check:**
- `KimiMessage` defined in `KimiProxyServer.ts` — used only internally.
- `KIMI_WATCH_NAME` exported from `KimiInstaller.ts` — imported in tests as named export.
- `buildKimiWrapperScript` / `mergeKimiWatchConfig` exported from `KimiInstaller.ts` — match exact names in tests.
- `normalizeKimiVscodeFile` / `KIMI_VSCODE_SCHEMA` exported from `KimiVscodeNormalizer.ts` — match exact names in tests.
- `kimiAdapter` exported as named export from `kimi.ts`, re-exported from `index.ts`.

**No placeholder scan:** All steps contain complete code. No TBD/TODO in implementation steps.
