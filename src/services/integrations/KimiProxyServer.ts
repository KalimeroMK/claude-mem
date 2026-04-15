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
