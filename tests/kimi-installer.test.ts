import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
