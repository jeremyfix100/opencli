import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CliCommand } from '@jackwener/opencli/registry';
import { getRegistry } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';
import './crawl.js';

vi.mock('mkt-learning-engine', () => {
  class RuleCacheReadError extends Error {
    readonly type: string;
    constructor(type: string, message: string) {
      super(message);
      this.name = 'RuleCacheReadError';
      this.type = type;
    }
  }

  class SchemaLlmUnavailableError extends Error {
    readonly code = 'schema_cache_miss_and_llm_unavailable' as const;
    constructor(message: string) {
      super(message);
      this.name = 'SchemaLlmUnavailableError';
    }
  }

  return {
    getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1: vi.fn(async () => {
      throw new Error('unmocked getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1');
    }),
    SchemaLlmUnavailableError,
    RuleCacheReadError,
    buildLearningArtifactPaths: vi.fn(
      ({
        baseDir,
        site,
        runId,
        pageKey,
      }: {
        baseDir: string;
        site: string;
        runId: string;
        pageKey: string;
      }) => {
        const pageKeyFs = String(pageKey).replace(/[^\w.-]+/g, '_');
        const root = path.join(baseDir, 'artifacts', site, runId, pageKeyFs);
        return {
          root,
          rawPage: path.join(root, 'raw-page.json'),
          domDistill: path.join(root, 'dom-distill.json'),
          pageUnderstanding: path.join(root, 'page-understanding.json'),
          selectorPlan: path.join(root, 'selector-plan.json'),
          extractionResult: path.join(root, 'extraction-result.json'),
          qualityReport: path.join(root, 'quality-report.json'),
          engineTraceJsonl: path.join(root, 'trace', 'engine.trace.jsonl'),
        };
      },
    ),
    writeArtifactJson: vi.fn(async (filePath: string, payload: unknown) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }),
    createEngineTraceEvent: vi.fn((x) => ({ ts: new Date().toISOString(), ...x })),
    appendEngineTraceEvent: vi.fn(async () => undefined),
  };
});

function createPage(results: unknown[]): IPage {
  const evaluate = vi.fn();
  for (const r of results) {
    evaluate.mockResolvedValueOnce(r);
  }
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate,
    autoScroll: vi.fn().mockResolvedValue(undefined),
  } as unknown as IPage;
}

let cmd: CliCommand;

beforeAll(() => {
  cmd = getRegistry().get('indiegogo/crawl')!;
  expect(cmd?.func).toBeTypeOf('function');
  expect(cmd?.columns).toEqual(['title', 'url', 'raw_id']);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('indiegogo/crawl', () => {
  it('list -> detail: crawls 2 urls and returns 2 rows', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
      cache_status: 'hit',
      learning_method: 'cache_hit',
      dom_fingerprint: 'fp_test',
      llm_model: null,
      selector_plan: {
        plans: [
          { field: 'title', selectors: ['h1'], fallback_selectors: [], confidence: 0.9, reason: 't' },
          { field: 'raw_id', selectors: ['meta[property=\"og:url\"]'], fallback_selectors: [], confidence: 0.8, reason: 'id' },
        ],
      },
      used_snapshot_key: 's1',
      snapshot_summaries: {
        s0: { ts: '2026-04-11T00:00:00.000Z', byte_len: 1, text_len: 1, blocked: false },
        s1: { ts: '2026-04-11T00:00:01.000Z', byte_len: 1, text_len: 1, blocked: false },
        s2: { ts: '2026-04-11T00:00:02.000Z', byte_len: 1, text_len: 1, blocked: false },
      },
      core_schema: [],
      core_schema_sig: 'sig_test',
    } as any);

    const page = createPage([
      // list page payload
      {
        authRequired: false,
        items: [
          { title: 'P1', url: '/projects/p1' },
          { title: 'P2', url: '/projects/p2' },
        ],
      },
      // detail 1 snapshots + exec
      '<html><body>s0-1</body></html>',
      '<html><body>s1-1</body></html>',
      '<html><body>s2-1</body></html>',
      { values: { title: 'P1', raw_id: 'p1' }, provenance: {} },
      // detail 2 snapshots + exec
      '<html><body>s0-2</body></html>',
      '<html><body>s1-2</body></html>',
      '<html><body>s2-2</body></html>',
      { values: { title: 'P2', raw_id: 'p2' }, provenance: {} },
    ]);

    const rows = (await cmd.func!(page, {
      query_or_url: 'AI',
      limit: 2,
      concurrency: 1,
      min_interval_ms: 0,
      interval_jitter_ms: 0,
      after_each_ms: 0,
      after_each_jitter_ms: 0,
      cooldown_every: 0,
      cooldown_min_ms: 0,
      cooldown_jitter_ms: 0,
      max_retries: 0,
      retry_base_ms: 0,
      retry_jitter_ms: 0,
      random_seed: 1,
    })) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ site: 'indiegogo', page_type: 'project_detail', title: 'P1', raw_id: 'p1' });
    expect(rows[1]).toMatchObject({ site: 'indiegogo', page_type: 'project_detail', title: 'P2', raw_id: 'p2' });
  });

  it('when OPENCLI_LEARNING_ARTIFACTS_DIR is set: writes per-url artifacts with distinct page keys', async () => {
    const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencli-artifacts-'));
    vi.stubEnv('OPENCLI_LEARNING_ARTIFACTS_DIR', artifactsDir);

    try {
      const engine = await import('mkt-learning-engine');
      vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
        cache_status: 'hit',
        learning_method: 'cache_hit',
        dom_fingerprint: 'fp_test',
        llm_model: null,
        selector_plan: { plans: [{ field: 'title', selectors: ['h1'], fallback_selectors: [], confidence: 0.9, reason: 't' }] },
        used_snapshot_key: 's1',
        snapshot_summaries: {
          s0: { ts: '2026-04-11T00:00:00.000Z', byte_len: 1, text_len: 1, blocked: false },
          s1: { ts: '2026-04-11T00:00:01.000Z', byte_len: 1, text_len: 1, blocked: false },
          s2: { ts: '2026-04-11T00:00:02.000Z', byte_len: 1, text_len: 1, blocked: false },
        },
        core_schema: [],
        core_schema_sig: 'sig_test',
      } as any);

      const page = createPage([
        { authRequired: false, items: [{ title: 'P1', url: '/projects/p1' }, { title: 'P2', url: '/projects/p2' }] },
        '<html><body>S0-1</body></html>',
        '<html><body>S1-1</body></html>',
        '<html><body>S2-1</body></html>',
        { values: { title: 'P1', raw_id: 'p1' }, provenance: {} },
        '<html><body>S0-2</body></html>',
        '<html><body>S1-2</body></html>',
        '<html><body>S2-2</body></html>',
        { values: { title: 'P2', raw_id: 'p2' }, provenance: {} },
      ]);

      await cmd.func!(page, {
        query_or_url: 'AI',
        limit: 2,
        concurrency: 1,
        min_interval_ms: 0,
        interval_jitter_ms: 0,
        after_each_ms: 0,
        after_each_jitter_ms: 0,
        cooldown_every: 0,
        cooldown_min_ms: 0,
        cooldown_jitter_ms: 0,
        max_retries: 0,
        retry_base_ms: 0,
        retry_jitter_ms: 0,
        random_seed: 1,
      });

      const igDir = path.join(artifactsDir, 'artifacts', 'indiegogo');
      const runIds = await fs.readdir(igDir);
      const runDir = path.join(igDir, runIds[0]!);
      const pages = await fs.readdir(runDir);
      expect(pages.length).toBe(2);
    } finally {
      await fs.rm(artifactsDir, { recursive: true, force: true });
    }
  });
});

