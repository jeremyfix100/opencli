import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { traceDebug } from './debug-trace.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('debug-trace', () => {
  it('writes jsonl trace records to OPENCLI_DEBUG_LOG_FILE', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opencli-trace-'));
    const file = path.join(dir, 'trace.jsonl');
    vi.stubEnv('OPENCLI_DEBUG_LOG_FILE', file);

    traceDebug('demo', 'start', { site: 'huodongxing', count: 1 });
    traceDebug('demo', 'finish', { ok: true });

    const raw = await readFile(file, 'utf-8');
    const lines = raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ scope: 'demo', event: 'start', site: 'huodongxing', count: 1 });
    expect(lines[1]).toMatchObject({ scope: 'demo', event: 'finish', ok: true });
  });
});
