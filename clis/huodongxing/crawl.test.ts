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
  cmd = getRegistry().get('huodongxing/crawl')!;
  expect(cmd?.func).toBeTypeOf('function');
  expect(cmd?.columns).toEqual(['title', 'url', 'raw_id']);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('huodongxing/crawl', () => {
  it('stops early when verification (too frequent) page is encountered', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
      cache_status: 'hit',
      learning_method: 'cache_hit',
      dom_fingerprint: 'fp_test',
      llm_model: null,
      selector_plan: { plans: [] },
      used_snapshot_key: 's0',
      snapshot_summaries: {},
      core_schema: [],
      core_schema_sig: 'sig_test',
    } as any);

    const listUrl = 'https://www.huodongxing.com/events?orderby=n&d=t5&city=%E6%B7%B1%E5%9C%B3&page=1';

    const page = createPage([
      // list payload
      { authRequired: false, itemCount: 2, items: [{ title: 'E1', url: '/event/1' }, { title: 'E2', url: '/event/2' }] },
      // detail 1 snapshots + exec
      '<html><body>s0-1</body></html>',
      '<html><body>s1-1</body></html>',
      '<html><body>s2-1</body></html>',
      { values: { title: 'E1', raw_id: '1' }, provenance: {} },
      // detail 2 s0 verification page (should stop before executing)
      '<html><head><title>操作过于频繁</title></head><body><p class=\"ipUrl\">Client IP address: 1.2.3.4 (2026-4-19 18:08:00)</p><p>请滑动方块确认您是真人</p></body></html>',
    ]);

    const rows = (await cmd.func!(page, { query_or_url: listUrl, limit: 10 })) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ site: 'huodongxing', page_type: 'event_detail', title: 'E1', raw_id: '1' });

    expect(vi.mocked(page.goto).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('events list pagination: collects urls across multiple ?page= pages', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
      cache_status: 'hit',
      learning_method: 'cache_hit',
      dom_fingerprint: 'fp_test',
      llm_model: null,
      selector_plan: {
        plans: [
          { field: 'title', selectors: ['h1'], fallback_selectors: [], confidence: 0.9, reason: 't' },
          { field: 'raw_id', selectors: ['meta[property="og:url"]'], fallback_selectors: [], confidence: 0.8, reason: 'id' },
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

    const listUrl =
      'https://www.huodongxing.com/events?orderby=n&d=t5&city=%E6%B7%B1%E5%9C%B3&page=1';

    const page = createPage([
      // list page=1 payload
      {
        authRequired: false,
        itemCount: 1,
        items: [{ title: 'E1', url: '/event/1' }],
      },
      // list page=2 payload
      {
        authRequired: false,
        itemCount: 1,
        items: [{ title: 'E2', url: '/event/2' }],
      },
      // detail 1 snapshots + exec
      '<html><body>s0-1</body></html>',
      '<html><body>s1-1</body></html>',
      '<html><body>s2-1</body></html>',
      { values: { title: 'E1', raw_id: '1' }, provenance: {} },
      // detail 2 snapshots + exec
      '<html><body>s0-2</body></html>',
      '<html><body>s1-2</body></html>',
      '<html><body>s2-2</body></html>',
      { values: { title: 'E2', raw_id: '2' }, provenance: {} },
    ]);

    const rows = (await cmd.func!(page, { query_or_url: listUrl, limit: 2 })) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);

    expect(vi.mocked(page.goto).mock.calls[0]?.[0]).toMatch('page=1');
    expect(vi.mocked(page.goto).mock.calls[1]?.[0]).toMatch('page=2');
    expect(rows[0]).toMatchObject({ site: 'huodongxing', page_type: 'event_detail', title: 'E1', raw_id: '1' });
    expect(rows[1]).toMatchObject({ site: 'huodongxing', page_type: 'event_detail', title: 'E2', raw_id: '2' });
  });

  it('search list pagination: collects urls across multiple ?pi= pages', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
      cache_status: 'hit',
      learning_method: 'cache_hit',
      dom_fingerprint: 'fp_test',
      llm_model: null,
      selector_plan: {
        plans: [
          { field: 'title', selectors: ['h1'], fallback_selectors: [], confidence: 0.9, reason: 't' },
          { field: 'raw_id', selectors: ['meta[property="og:url"]'], fallback_selectors: [], confidence: 0.8, reason: 'id' },
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

    const listUrl = 'https://www.huodongxing.com/search?ps=12&pi=3&list=list&qs=AI';

    const page = createPage([
      // list pi=3 payload
      {
        authRequired: false,
        itemCount: 1,
        items: [{ title: 'E3', url: '/event/3' }],
      },
      // list pi=4 payload
      {
        authRequired: false,
        itemCount: 1,
        items: [{ title: 'E4', url: '/event/4' }],
      },
      // detail 3 snapshots + exec
      '<html><body>s0-3</body></html>',
      '<html><body>s1-3</body></html>',
      '<html><body>s2-3</body></html>',
      { values: { title: 'E3', raw_id: '3' }, provenance: {} },
      // detail 4 snapshots + exec
      '<html><body>s0-4</body></html>',
      '<html><body>s1-4</body></html>',
      '<html><body>s2-4</body></html>',
      { values: { title: 'E4', raw_id: '4' }, provenance: {} },
    ]);

    const rows = (await cmd.func!(page, { query_or_url: listUrl, limit: 2 })) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);

    expect(vi.mocked(page.goto).mock.calls[0]?.[0]).toMatch('pi=3');
    expect(vi.mocked(page.goto).mock.calls[1]?.[0]).toMatch('pi=4');
    expect(rows[0]).toMatchObject({ site: 'huodongxing', page_type: 'event_detail', title: 'E3', raw_id: '3' });
    expect(rows[1]).toMatchObject({ site: 'huodongxing', page_type: 'event_detail', title: 'E4', raw_id: '4' });
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
          { title: 'E1', url: '/event/1' },
          { title: 'E2', url: '/event/2' },
        ],
      },
      // detail 1 snapshots + exec
      '<html><body>s0-1</body></html>',
      '<html><body>s1-1</body></html>',
      '<html><body>s2-1</body></html>',
      { values: { title: 'E1', raw_id: '1' }, provenance: {} },
      // detail 2 snapshots + exec
      '<html><body>s0-2</body></html>',
      '<html><body>s1-2</body></html>',
      '<html><body>s2-2</body></html>',
      { values: { title: 'E2', raw_id: '2' }, provenance: {} },
    ]);

    const rows = (await cmd.func!(page, { query_or_url: 'AI', limit: 2 })) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ site: 'huodongxing', page_type: 'event_detail', title: 'E1', raw_id: '1' });
    expect(rows[1]).toMatchObject({ site: 'huodongxing', page_type: 'event_detail', title: 'E2', raw_id: '2' });
  });

  it('normalizes direct media urls from extracted values', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
      cache_status: 'hit',
      learning_method: 'cache_hit',
      dom_fingerprint: 'fp_test',
      llm_model: null,
      selector_plan: {
        plans: [
          { field: 'title', selectors: ['h1'], fallback_selectors: [], confidence: 0.9, reason: 't' },
          { field: 'raw_id', selectors: ['meta[property="og:url"]'], fallback_selectors: [], confidence: 0.8, reason: 'id' },
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
      { authRequired: false, items: [{ title: 'E1', url: '/event/1' }] },
      '<html><body>s0</body></html>',
      '<html><body>s1</body></html>',
      '<html><body>s2</body></html>',
      {
        values: {
          title: 'Media Demo',
          raw_id: '1',
          imageUrl: 'https://cdn.example.com/media/cover.webp',
          hero_video_url: 'https://cdn.example.com/media/master.m3u8?token=abc123',
        },
        provenance: {},
      },
    ]);

    const rows = (await cmd.func!(page, { query_or_url: 'AI', limit: 1 })) as Array<Record<string, unknown>>;

    expect(rows[0]).toMatchObject({
      primary_image_url: 'https://cdn.example.com/media/cover.webp',
      primary_video_url: 'https://cdn.example.com/media/master.m3u8?token=abc123',
    });
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
        { authRequired: false, items: [{ title: 'E1', url: '/event/1' }, { title: 'E2', url: '/event/2' }] },
        '<html><body>S0-1</body></html>',
        '<html><body>S1-1</body></html>',
        '<html><body>S2-1</body></html>',
        { values: { title: 'E1', raw_id: '1' }, provenance: {} },
        '<html><body>S0-2</body></html>',
        '<html><body>S1-2</body></html>',
        '<html><body>S2-2</body></html>',
        { values: { title: 'E2', raw_id: '2' }, provenance: {} },
      ]);

      await cmd.func!(page, { query_or_url: 'AI', limit: 2 });

      const hxDir = path.join(artifactsDir, 'artifacts', 'huodongxing');
      const runIds = await fs.readdir(hxDir);
      const runDir = path.join(hxDir, runIds[0]!);
      const pages = await fs.readdir(runDir);
      expect(pages.length).toBe(2);

      // Each page dir should have snapshots written
      for (const p of pages) {
        const pageDir = path.join(runDir, p);
        const snapshotsDir = path.join(pageDir, 'snapshots');
        await expect(fs.stat(path.join(snapshotsDir, 's0.html'))).resolves.toBeTypeOf('object');
        await expect(fs.stat(path.join(snapshotsDir, 's1.html'))).resolves.toBeTypeOf('object');
        await expect(fs.stat(path.join(snapshotsDir, 's2.html'))).resolves.toBeTypeOf('object');
      }
    } finally {
      await fs.rm(artifactsDir, { recursive: true, force: true });
    }
  });
});
