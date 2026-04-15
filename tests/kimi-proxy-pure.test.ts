import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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
