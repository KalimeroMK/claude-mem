import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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
    logger.debug('PARSER', 'Could not read source file in VSCode normaliser', { sourcePath });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.debug('PARSER', 'Skipping non-JSON file in VSCode normaliser', { sourcePath });
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
  const jsonl = messages.length > 0
    ? messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
    : '';
  writeFileSync(sidecarPath, jsonl, 'utf-8');
}
