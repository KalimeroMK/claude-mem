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
