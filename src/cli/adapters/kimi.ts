import type { PlatformAdapter } from '../types.js';

export const kimiAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as Record<string, any>;

    const messages: Array<{ role: string; content: string }> =
      r.tool_input?.messages ?? [];
    const prompt: string | undefined =
      r.prompt ?? messages.find((m) => m.role === 'user')?.content;

    const metadata: Record<string, unknown> = {};
    if (r.model)                     metadata.model = r.model;
    if (r.metadata?.finish_reason)   metadata.finish_reason = r.metadata.finish_reason;
    if (r.metadata?.kimi_request_id) metadata.kimi_request_id = r.metadata.kimi_request_id;

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
