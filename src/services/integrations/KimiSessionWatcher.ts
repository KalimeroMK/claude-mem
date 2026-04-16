import { createHash } from 'crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch as fsWatch,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../../utils/logger.js';
import { sessionInitHandler } from '../../cli/handlers/session-init.js';
import { observationHandler } from '../../cli/handlers/observation.js';
import { sessionCompleteHandler } from '../../cli/handlers/session-complete.js';
import { workerHttpRequest } from '../../shared/worker-utils.js';
import { injectContextIntoMarkdownFile } from '../../utils/context-injection.js';
import { getProjectContext } from '../../utils/project-name.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const KIMI_DIR         = join(homedir(), '.kimi');
const KIMI_SESSIONS_DIR = join(KIMI_DIR, 'sessions');
const KIMI_JSON_PATH   = join(KIMI_DIR, 'kimi.json');

function resolveKimiMdPath(): string {
  return process.env.KIMI_MD_PATH_OVERRIDE ?? join(KIMI_DIR, 'KIMI.md');
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface KimiJson {
  work_dirs?: Array<{ path: string }>;
}

interface WireMessage {
  message?: {
    type: string;
    payload: Record<string, unknown>;
  };
}

interface ActiveTurn {
  cwd: string;
  userInput: string;
  assistantText: string;
  assistantThinking: string;
}

// ─── KimiSessionWatcher ───────────────────────────────────────────────────────

/**
 * Watches ~/.kimi/sessions for new wire.jsonl entries.
 *
 * The kimi CLI writes all turns — from both standalone CLI and the VSCode
 * extension — into ~/.kimi/sessions/{workspaceHash}/{sessionId}/wire.jsonl.
 * This watcher tails those files and feeds captured conversations into the
 * claude-mem observation pipeline.
 *
 * Workspace paths are resolved via MD5 hash lookup in ~/.kimi/kimi.json,
 * so the correct project context is associated with each observation.
 */
export class KimiSessionWatcher {
  private dirWatcher:   ReturnType<typeof fsWatch> | null = null;
  private fileWatchers  = new Map<string, ReturnType<typeof fsWatch>>();
  private fileOffsets   = new Map<string, number>();
  private filePartials  = new Map<string, string>();
  private activeTurns   = new Map<string, ActiveTurn>(); // keyed by wire.jsonl path
  private hashToPath    = new Map<string, string>();     // MD5(workspacePath) → path

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  start(): void {
    if (this.dirWatcher) return;

    this.loadWorkDirMap();
    mkdirSync(KIMI_SESSIONS_DIR, { recursive: true });
    this.scanExistingFiles();

    this.dirWatcher = fsWatch(
      KIMI_SESSIONS_DIR,
      { recursive: true, persistent: true },
      (_, filename) => {
        if (!filename?.endsWith('wire.jsonl')) return;
        const fullPath = join(KIMI_SESSIONS_DIR, filename);
        if (!this.fileWatchers.has(fullPath) && existsSync(fullPath)) {
          // Reload workspace map in case a new project was opened
          this.loadWorkDirMap();
          this.watchWireFile(fullPath);
        }
      },
    );

    logger.info('KIMI', 'Session watcher started', { dir: KIMI_SESSIONS_DIR });
  }

  stop(): void {
    this.dirWatcher?.close();
    this.dirWatcher = null;
    for (const w of this.fileWatchers.values()) w.close();
    this.fileWatchers.clear();
  }

  // ─── Workspace map ───────────────────────────────────────────────────────

  /**
   * Builds a hash→path map from ~/.kimi/kimi.json.
   * The kimi CLI stores known workspaces there; their directory names under
   * ~/.kimi/sessions/ are the MD5 hashes of the absolute paths.
   */
  private loadWorkDirMap(): void {
    if (!existsSync(KIMI_JSON_PATH)) return;
    try {
      const data = JSON.parse(readFileSync(KIMI_JSON_PATH, 'utf-8')) as KimiJson;
      for (const wd of data.work_dirs ?? []) {
        if (!wd.path) continue;
        const hash = createHash('md5').update(wd.path).digest('hex');
        this.hashToPath.set(hash, wd.path);
      }
    } catch {
      logger.debug('KIMI', 'Could not load kimi.json for workspace map');
    }
  }

  /** Derives the workspace path from a wire.jsonl absolute file path. */
  private cwdFromWirePath(wirePath: string): string {
    const parts = wirePath.split('/');
    // …/sessions/{workspaceHash}/{sessionId}/wire.jsonl  →  parts[-3] is hash
    const hash = parts[parts.length - 3];
    return this.hashToPath.get(hash) ?? homedir();
  }

  // ─── File scanning & watching ─────────────────────────────────────────────

  /** Sets initial offsets at EOF for all pre-existing wire.jsonl files so we only tail new data. */
  private scanExistingFiles(): void {
    try {
      for (const wsHash of readdirSync(KIMI_SESSIONS_DIR)) {
        const wsDir = join(KIMI_SESSIONS_DIR, wsHash);
        try {
          for (const sessionId of readdirSync(wsDir)) {
            const wireFile = join(wsDir, sessionId, 'wire.jsonl');
            if (existsSync(wireFile)) {
              this.fileOffsets.set(wireFile, statSync(wireFile).size); // start at EOF
              this.watchWireFile(wireFile);
            }
          }
        } catch { /* skip unreadable session dirs */ }
      }
    } catch { /* sessions dir might not exist yet */ }
  }

  private watchWireFile(filePath: string): void {
    if (this.fileWatchers.has(filePath)) return;
    const watcher = fsWatch(filePath, { persistent: true }, () => {
      this.processNewLines(filePath).catch(() => undefined);
    });
    this.fileWatchers.set(filePath, watcher);
    logger.debug('KIMI', 'Watching wire.jsonl', { filePath });
  }

  // ─── Line processing ─────────────────────────────────────────────────────

  private async processNewLines(filePath: string): Promise<void> {
    if (!existsSync(filePath)) return;

    let size: number;
    try { size = statSync(filePath).size; } catch { return; }

    const offset = this.fileOffsets.get(filePath) ?? 0;
    if (size <= offset) return;

    const stream = createReadStream(filePath, { start: offset, end: size - 1, encoding: 'utf8' });
    let data = '';
    for await (const chunk of stream) data += chunk as string;
    this.fileOffsets.set(filePath, size);

    const partial   = this.filePartials.get(filePath) ?? '';
    const combined  = partial + data;
    const lines     = combined.split('\n');
    this.filePartials.set(filePath, lines.pop() ?? '');

    // Session ID: .../sessions/{wsHash}/{sessionId}/wire.jsonl → parts[-2]
    const pathParts = filePath.split('/');
    const sessionId = pathParts[pathParts.length - 2];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) await this.handleLine(filePath, sessionId, trimmed);
    }
  }

  private async handleLine(filePath: string, sessionId: string, line: string): Promise<void> {
    let obj: WireMessage;
    try { obj = JSON.parse(line) as WireMessage; } catch { return; }

    const inner = obj.message; // metadata line has no .message
    if (!inner) return;
    const { type, payload } = inner;

    switch (type) {
      case 'TurnBegin': {
        const userInput = (payload.user_input as string) ?? '';
        if (!userInput) return;
        const cwd = this.cwdFromWirePath(filePath);
        this.activeTurns.set(filePath, { cwd, userInput, assistantText: '', assistantThinking: '' });
        void sessionInitHandler.execute({ sessionId, cwd, prompt: userInput, platform: 'kimi' });
        break;
      }

      case 'ContentPart': {
        const turn = this.activeTurns.get(filePath);
        if (!turn) return;
        if (payload.type === 'text')  turn.assistantText      += (payload.text  as string) ?? '';
        if (payload.type === 'think') turn.assistantThinking  += (payload.think as string) ?? '';
        break;
      }

      case 'TurnEnd': {
        const turn = this.activeTurns.get(filePath);
        this.activeTurns.delete(filePath);
        if (!turn) return;

        const content = turn.assistantText || turn.assistantThinking;
        if (content) {
          await observationHandler.execute({
            sessionId,
            cwd: turn.cwd,
            toolName: 'KimiSession',
            toolInput:    { prompt: turn.userInput },
            toolResponse: { content },
            platform: 'kimi',
          });
        }

        await sessionCompleteHandler.execute({ sessionId, cwd: turn.cwd, platform: 'kimi' });
        void this.refreshKimiMd(turn.cwd);
        break;
      }
    }
  }

  // ─── Context refresh ─────────────────────────────────────────────────────

  private async refreshKimiMd(cwd: string): Promise<void> {
    try {
      const { primary } = getProjectContext(cwd);
      const response = await workerHttpRequest(
        `/api/context/inject?project=${encodeURIComponent(primary)}&platformSource=kimi`,
      );
      if (!response.ok) return;
      const content = (await response.text()).trim();
      if (!content) return;
      injectContextIntoMarkdownFile(resolveKimiMdPath(), content);
      logger.debug('KIMI', 'Refreshed KIMI.md', { cwd, project: primary });
    } catch {
      // Best-effort — never throw from a watcher callback
    }
  }
}
