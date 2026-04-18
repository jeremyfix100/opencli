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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let cmd: CliCommand;

beforeAll(() => {
  cmd = getRegistry().get('kickstarter/crawl')!;
  expect(cmd?.func).toBeTypeOf('function');
  expect(cmd?.columns).toEqual(['title', 'url', 'raw_id']);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('kickstarter/crawl', () => {
  it('normalizes limit up to 200', async () => {
    expect((cmd as any)).toBeDefined();
    const mod = await import('./crawl.js');
    expect(mod.__test__.normalizeLimit(60)).toBe(60);
    expect(mod.__test__.normalizeLimit(999)).toBe(200);
  });

  it('advances paginated list as soon as current page is exhausted', async () => {
    const mod = await import('./crawl.js');
    expect(
      mod.__test__.shouldAdvanceListPage({
        domItemCount: 18,
        newCount: 0,
        clickedLoadMore: false,
        seenOnCurrentPage: 18,
        roundsWithoutNew: 1,
      }),
    ).toBe(true);
  });

  it('does not advance while current page can still yield more items', async () => {
    const mod = await import('./crawl.js');
    expect(
      mod.__test__.shouldAdvanceListPage({
        domItemCount: 18,
        newCount: 0,
        clickedLoadMore: false,
        seenOnCurrentPage: 12,
        roundsWithoutNew: 1,
      }),
    ).toBe(false);
  });

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
          { title: 'P1', url: '/projects/a/p1', raw_id: 'a/p1' },
          { title: 'P2', url: '/projects/b/p2', raw_id: 'b/p2' },
        ],
      },
      // detail 1 snapshots + exec
      '<html><body>s0-1</body></html>',
      '<html><body>s1-1</body></html>',
      '<html><body>s2-1</body></html>',
      { values: { title: 'P1', raw_id: 'a/p1' }, provenance: {} },
      // detail 2 snapshots + exec
      '<html><body>s0-2</body></html>',
      '<html><body>s1-2</body></html>',
      '<html><body>s2-2</body></html>',
      { values: { title: 'P2', raw_id: 'b/p2' }, provenance: {} },
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
    expect(rows[0]).toMatchObject({ site: 'kickstarter', page_type: 'project_detail', title: 'P1', raw_id: 'a/p1' });
    expect(rows[1]).toMatchObject({ site: 'kickstarter', page_type: 'project_detail', title: 'P2', raw_id: 'b/p2' });
    const execScript = vi.mocked(page.evaluate).mock.calls
      .map(([arg]) => String(arg ?? ''))
      .find((script) => script.includes('valueFromElement') && script.includes("tag === '"));
    expect(execScript).toContain("tag === 'img'");
    expect(execScript).toContain('currentSrc');
    expect(execScript).toContain("tag === 'a'");
    expect(execScript).toContain("getAttribute('href')");
  });

  it('detail timeout: late goto resolution does not mutate returned rows', async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv('OPENCLI_KICKSTARTER_DETAIL_TIMEOUT_MS', '1');

      const engine = await import('mkt-learning-engine');
      vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
        cache_status: 'hit',
        learning_method: 'cache_hit',
        dom_fingerprint: 'fp_timeout_guard',
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
        core_schema_sig: 'sig_timeout_guard',
      } as any);

      const firstGoto = createDeferred<void>();
      const page: IPage = {
        goto: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(() => firstGoto.promise)
          .mockResolvedValueOnce(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({
            authRequired: false,
            items: [
              { title: 'P1', url: '/projects/a/p1', raw_id: 'a/p1' },
              { title: 'P2', url: '/projects/b/p2', raw_id: 'b/p2' },
            ],
          })
          .mockResolvedValueOnce('<html><body>s0-2</body></html>')
          .mockResolvedValueOnce('<html><body>s1-2</body></html>')
          .mockResolvedValueOnce('<html><body>s2-2</body></html>')
          .mockResolvedValueOnce({ values: { title: 'P2', raw_id: 'b/p2' }, provenance: {} }),
        autoScroll: vi.fn().mockResolvedValue(undefined),
      } as unknown as IPage;

      const rowsPromise = cmd.func!(page, {
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

      await vi.advanceTimersByTimeAsync(0);
      expect(page.goto).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      const rows = (await rowsPromise) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ title: 'P1', raw_id: 'a/p1' });
      expect(rows[1]).toMatchObject({ title: 'P2', raw_id: 'b/p2' });

      const beforeLateResolve = rows.length;
      firstGoto.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(rows).toHaveLength(beforeLateResolve);
    } finally {
      vi.useRealTimers();
    }
  });

  it('list pagination: clicks load more until limit is reached', async () => {
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
      // list round 1: only 2 items, indicates hasLoadMore
      {
        authRequired: false,
        hasLoadMore: true,
        items: [
          { title: 'P1', url: '/projects/a/p1', raw_id: 'a/p1' },
          { title: 'P2', url: '/projects/b/p2', raw_id: 'b/p2' },
        ],
      },
      // click load more returns true
      true,
      // list round 2: now 3 items
      {
        authRequired: false,
        hasLoadMore: false,
        items: [
          { title: 'P1', url: '/projects/a/p1', raw_id: 'a/p1' },
          { title: 'P2', url: '/projects/b/p2', raw_id: 'b/p2' },
          { title: 'P3', url: '/projects/c/p3', raw_id: 'c/p3' },
        ],
      },
      // detail 1 snapshots + exec
      '<html><body>s0-1</body></html>',
      '<html><body>s1-1</body></html>',
      '<html><body>s2-1</body></html>',
      { values: { title: 'P1', raw_id: 'a/p1' }, provenance: {} },
      // detail 2 snapshots + exec
      '<html><body>s0-2</body></html>',
      '<html><body>s1-2</body></html>',
      '<html><body>s2-2</body></html>',
      { values: { title: 'P2', raw_id: 'b/p2' }, provenance: {} },
      // detail 3 snapshots + exec
      '<html><body>s0-3</body></html>',
      '<html><body>s1-3</body></html>',
      '<html><body>s2-3</body></html>',
      { values: { title: 'P3', raw_id: 'c/p3' }, provenance: {} },
    ]);

    const rows = (await cmd.func!(page, {
      query_or_url: 'AI',
      limit: 3,
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
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.title)).toEqual(['P1', 'P2', 'P3']);
  });

  it('detail failure: one page times out but crawl continues', async () => {

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

    const evaluate = vi.fn()
      // list payload (2 items)
      .mockResolvedValueOnce({
        authRequired: false,
        items: [
          { title: 'P1', url: '/projects/a/p1', raw_id: 'a/p1' },
          { title: 'P2', url: '/projects/b/p2', raw_id: 'b/p2' },
        ],
      })
      // detail 2 snapshots + exec (detail 1 will fail at goto)
      .mockResolvedValueOnce('<html><body>s0-2</body></html>')
      .mockResolvedValueOnce('<html><body>s1-2</body></html>')
      .mockResolvedValueOnce('<html><body>s2-2</body></html>')
      .mockResolvedValueOnce({ values: { title: 'P2', raw_id: 'b/p2' }, provenance: {} });

    const page: IPage = {
      goto: vi
        .fn()
        .mockResolvedValueOnce(undefined) // list
        .mockRejectedValueOnce(new Error('navigation timed out')) // detail 1
        .mockResolvedValueOnce(undefined), // detail 2
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate,
      autoScroll: vi.fn().mockResolvedValue(undefined),
    } as unknown as IPage;

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
    })) as Array<Record<string, any>>;

    expect(rows).toHaveLength(2);
    expect(rows[0]?.title).toBe('P1');
    expect(rows[0]?.extra?.error?.value).toMatch(/timed out/i);
    expect(rows[1]?.title).toBe('P2');
  });

  it('advances to the next list page after the current page is exhausted', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
      cache_status: 'hit',
      learning_method: 'cache_hit',
      dom_fingerprint: 'fp_paged',
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
      core_schema_sig: 'sig_paged',
    } as any);

    let currentUrl = '';
    const listRoundsByUrl = new Map<string, number>();
    const page = {
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
      }),
      wait: vi.fn().mockResolvedValue(undefined),
      autoScroll: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn(async (script: string) => {
        if (script.includes('items: items')) {
          const round = listRoundsByUrl.get(currentUrl) ?? 0;
          listRoundsByUrl.set(currentUrl, round + 1);
          if (currentUrl.endsWith('?page=2')) {
            return {
              authRequired: false,
              itemCount: 2,
              clickedLoadMore: false,
              items: [
                { title: 'P3', url: '/projects/c/p3', raw_id: 'c/p3' },
                { title: 'P4', url: '/projects/d/p4', raw_id: 'd/p4' },
              ],
            };
          }
          return {
            authRequired: false,
            itemCount: 2,
            clickedLoadMore: false,
            items:
              round === 0
                ? [
                    { title: 'P1', url: '/projects/a/p1', raw_id: 'a/p1' },
                    { title: 'P2', url: '/projects/b/p2', raw_id: 'b/p2' },
                  ]
                : [
                    { title: 'P1', url: '/projects/a/p1', raw_id: 'a/p1' },
                    { title: 'P2', url: '/projects/b/p2', raw_id: 'b/p2' },
                  ],
          };
        }
        if (script === 'document.documentElement.outerHTML') {
          return `<html><body>${currentUrl}</body></html>`;
        }
        const rawId = currentUrl.match(/\/projects\/([^/?#]+\/[^/?#]+)/)?.[1] ?? null;
        const title = rawId ? rawId.split('/')[1]?.toUpperCase() : null;
        return { values: { title, raw_id: rawId }, provenance: {} };
      }),
    } as unknown as IPage;

    const rows = (await cmd.func!(page, {
      query_or_url: 'https://www.kickstarter.com/discover/categories/design/product%20design',
      limit: 4,
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

    expect(rows).toHaveLength(4);
    expect(page.goto).toHaveBeenCalledWith('https://www.kickstarter.com/discover/categories/design/product%20design');
    expect(page.goto).toHaveBeenCalledWith('https://www.kickstarter.com/discover/categories/design/product%20design?page=2');
  });

  it('adds non-blocking warning fields for suspicious sparse extraction', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
      cache_status: 'hit',
      learning_method: 'cache_hit',
      dom_fingerprint: 'fp_warn',
      llm_model: null,
      selector_plan: {
        plans: [
          { field: 'title', selectors: ['h1'], fallback_selectors: [], confidence: 0.9, reason: 't' },
          { field: 'creator_name', selectors: ['.creator'], fallback_selectors: [], confidence: 0.9, reason: 'c' },
          { field: 'category', selectors: ['.category'], fallback_selectors: [], confidence: 0.9, reason: 'cat' },
        ],
      },
      used_snapshot_key: 's1',
      snapshot_summaries: {
        s0: { ts: '2026-04-11T00:00:00.000Z', byte_len: 10, text_len: 100, blocked: false },
        s1: { ts: '2026-04-11T00:00:01.000Z', byte_len: 10, text_len: 120, blocked: false },
        s2: { ts: '2026-04-11T00:00:02.000Z', byte_len: 10, text_len: 110, blocked: false },
      },
      core_schema: [],
      core_schema_sig: 'sig_warn',
    } as any);

    const page = createPage([
      {
        authRequired: false,
        items: [{ title: 'Fallback Title', url: '/projects/a/p1', raw_id: 'a/p1' }],
      },
      '<html><body>s0-1</body></html>',
      '<html><body>s1-1</body></html>',
      '<html><body>s2-1</body></html>',
      { values: { raw_id: 'a/p1' }, provenance: {} },
    ]);

    const rows = (await cmd.func!(page, {
      query_or_url: 'AI',
      limit: 1,
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
    })) as Array<Record<string, any>>;

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Fallback Title');
    expect(rows[0].extra.warning.value).toBe(true);
    expect(rows[0].extra.warning_codes.value).toContain('low_visible_text');
    expect(rows[0].extra.warning_codes.value).toContain('no_detail_fields_extracted');
    expect(rows[0].extra.warning_codes.value).toContain('title_from_list_fallback');
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
        { authRequired: false, items: [{ title: 'P1', url: '/projects/a/p1', raw_id: 'a/p1' }, { title: 'P2', url: '/projects/b/p2', raw_id: 'b/p2' }] },
        '<html><body>S0-1</body></html>',
        '<html><body>S1-1</body></html>',
        '<html><body>S2-1</body></html>',
        { values: { title: 'P1', raw_id: 'a/p1' }, provenance: {} },
        '<html><body>S0-2</body></html>',
        '<html><body>S1-2</body></html>',
        '<html><body>S2-2</body></html>',
        { values: { title: 'P2', raw_id: 'b/p2' }, provenance: {} },
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

      const ksDir = path.join(artifactsDir, 'artifacts', 'kickstarter');
      const runIds = await fs.readdir(ksDir);
      const runDir = path.join(ksDir, runIds[0]!);
      const entries = await fs.readdir(runDir, { withFileTypes: true });
      const pageDirs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('project_detail_'));
      expect(pageDirs.length).toBe(2);
    } finally {
      await fs.rm(artifactsDir, { recursive: true, force: true });
    }
  });
});
