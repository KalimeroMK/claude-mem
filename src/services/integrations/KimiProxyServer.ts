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

// Primary API endpoint (new kimi.com API, used in config.toml base_url)
const KIMI_API_BASE_URL = 'https://api.kimi.com/coding/v1';
// Legacy moonshot.cn endpoint (kept for backward-compat with old CLI versions)
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

  /**
   * Derives a stable session ID from the first user message in the conversation.
   * Returns a random UUID when no user message is present (e.g. system-only context).
   */
  buildSessionId(messages: KimiMessage[]): string {
    const firstUser = messages.find((m) => m.role === 'user');
    if (!firstUser) return randomUUID();
    return createHash('sha256').update(firstUser.content).digest('hex').slice(0, 16);
  }

  /**
   * Prepends a system message sourced from KIMI.md when no system message already exists.
   * Skips injection if the file is missing, empty, or a system message is already present.
   */
  injectKimiMdContext(messages: KimiMessage[]): KimiMessage[] {
    if (messages.some((m) => m.role === 'system')) return messages;
    const kimiMdPath = resolveKimiMdPath();
    if (!existsSync(kimiMdPath)) return messages;
    const content = readFileSync(kimiMdPath, 'utf-8').trim();
    if (!content) return messages;
    return [{ role: 'system', content }, ...messages];
  }

  /**
   * Concatenates all `content` deltas from a raw SSE stream string into a single text result.
   * Skips malformed JSON lines and the `[DONE]` sentinel gracefully.
   */
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

  /** Starts the proxy server on {@link KIMI_PROXY_PORT}. No-op if already running. */
  start(): void {
    if (this.server) return;
    const self = this;
    this.server = Bun.serve({
      port: this.port,
      async fetch(req: Request): Promise<Response> {
        return self.handleRequest(req);
      },
    });
    logger.info('KIMI', `Proxy server started on port ${this.port}`);
  }

  /** Stops the proxy server and clears the internal reference. */
  stop(): void {
    this.server?.stop();
    this.server = null;
    logger.info('KIMI', 'Proxy server stopped');
  }

  // ─── Request handling ─────────────────────────────────────────────────────

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Match both /v1/chat/completions (KIMI_BASE_URL=http://localhost:11451/v1)
    // and /chat/completions (KIMI_BASE_URL=http://localhost:11451 or config.toml base_url redirect)
    const isChatCompletions = req.method === 'POST' &&
      (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions');
    if (isChatCompletions) {
      return this.handleChatCompletions(req);
    }
    // Forward everything else to the kimi API, trying both base URLs
    const upstreamBase = url.pathname.startsWith('/coding/') ? KIMI_API_BASE_URL.replace('/coding/v1', '') : KIMI_API_BASE_URL;
    return fetch(new Request(`${upstreamBase}${url.pathname}${url.search}`, {
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

    void sessionInitHandler.execute({
      sessionId,
      cwd,
      prompt: messages.find((m) => m.role === 'user')?.content,
      platform: 'kimi',
    });

    const upstreamBody = { ...body, messages };
    // Build filtered headers for upstream (strip internal claude-mem headers)
    const upstreamHeaders = new Headers(req.headers);
    upstreamHeaders.delete('x-kimi-cwd');

    const upstream = await fetch(`${KIMI_API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamBody),
    });

    if (body.stream) {
      if (!upstream.body) {
        return new Response('Upstream returned no body', { status: 502 });
      }
      const [forClient, forCapture] = upstream.body.tee();
      void this.captureAndNotify(forCapture, sessionId, cwd, body);
      return new Response(forClient, { status: upstream.status, headers: upstream.headers });
    }

    const responseJson = await upstream.json() as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: unknown;
    };
    const content = responseJson.choices?.[0]?.message?.content ?? '';
    const finishReason = responseJson.choices?.[0]?.finish_reason;
    void (async () => {
      await this.sendObservation(sessionId, cwd, body, content);
      if (finishReason === 'stop') {
        void this.sessionCompleteAndRefreshContext(sessionId, cwd);
      }
    })();
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
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode()); // flush any held multi-byte sequence
    } catch {
      // Stream cancelled by client — still process what we received
    }
    const raw = chunks.join('');
    const content = this.assembleStreamText(raw);
    await this.sendObservation(sessionId, cwd, requestBody, content);
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
