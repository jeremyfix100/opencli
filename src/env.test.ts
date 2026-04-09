import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('opencli env loader', () => {
  it('loads dotenv values from the current working directory', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencli-env-'));
    const originalEndpoint = process.env.MKT_CRAWLER_LLM_ENDPOINT;
    const originalApiKey = process.env.MKT_CRAWLER_LLM_API_KEY;
    const originalModel = process.env.MKT_CRAWLER_LLM_MODEL;

    try {
      await writeFile(
        path.join(cwd, '.env'),
        [
          'MKT_CRAWLER_LLM_ENDPOINT=https://example.com/api',
          'MKT_CRAWLER_LLM_API_KEY=sk-test',
          'MKT_CRAWLER_LLM_MODEL=MiniMax-M2.5',
        ].join('\n'),
        'utf-8',
      );

      const { loadProjectEnv } = await import('./env.js');
      const loaded = loadProjectEnv({ cwd });

      expect(loaded).toBe(3);
      expect(process.env.MKT_CRAWLER_LLM_ENDPOINT).toBe('https://example.com/api');
      expect(process.env.MKT_CRAWLER_LLM_API_KEY).toBe('sk-test');
      expect(process.env.MKT_CRAWLER_LLM_MODEL).toBe('MiniMax-M2.5');
    } finally {
      if (originalEndpoint === undefined) delete process.env.MKT_CRAWLER_LLM_ENDPOINT;
      else process.env.MKT_CRAWLER_LLM_ENDPOINT = originalEndpoint;
      if (originalApiKey === undefined) delete process.env.MKT_CRAWLER_LLM_API_KEY;
      else process.env.MKT_CRAWLER_LLM_API_KEY = originalApiKey;
      if (originalModel === undefined) delete process.env.MKT_CRAWLER_LLM_MODEL;
      else process.env.MKT_CRAWLER_LLM_MODEL = originalModel;
    }
  });
});
