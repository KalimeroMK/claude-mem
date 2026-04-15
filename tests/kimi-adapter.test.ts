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
