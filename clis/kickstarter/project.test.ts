import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CliCommand } from '@jackwener/opencli/registry';
import { getRegistry } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';
import './project.js';

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
  cmd = getRegistry().get('kickstarter/project')!;
  expect(cmd?.func).toBeTypeOf('function');
  expect(cmd?.columns).toEqual(['title', 'url', 'raw_id']);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('kickstarter/project', () => {
  it('cache hit: uses schema-first learner selector_plan and returns title/url/raw_id top-level', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
      cache_status: 'hit',
      learning_method: 'cache_hit',
      dom_fingerprint: 'fp_test',
      llm_model: null,
      selector_plan: {
        plans: [
          { field: 'title', selectors: ['h1'], fallback_selectors: ['.title-alt'], confidence: 0.9, reason: 't' },
          { field: 'raw_id', selectors: ['meta[name="og:url"]'], fallback_selectors: [], confidence: 0.8, reason: 'id' },
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
      '<html><body>s0</body></html>',
      '<html><body>s1</body></html>',
      '<html><body>s2</body></html>',
      {
        values: { title: 'KS Project', raw_id: 'id_123', pledged_amount: '$100' },
        provenance: {
          title: { strategy: 'selector', selector: 'h1' },
          raw_id: { strategy: 'selector', selector: 'meta[name="og:url"]' },
        },
      },
    ]);

    const row = (await cmd.func!(page, {
      url: 'https://www.kickstarter.com/projects/demo/ks-project',
    })) as Record<string, unknown>;

    expect(page.evaluate).toHaveBeenCalledTimes(4);
    expect(vi.mocked(page.evaluate).mock.calls[0]?.[0]).toBe('document.documentElement.outerHTML');
    expect(vi.mocked(page.evaluate).mock.calls[1]?.[0]).toBe('document.documentElement.outerHTML');
    expect(vi.mocked(page.evaluate).mock.calls[2]?.[0]).toBe('document.documentElement.outerHTML');
    const execScript = String(vi.mocked(page.evaluate).mock.calls[3]?.[0] ?? '');
    expect(execScript).toContain("tag === 'img'");
    expect(execScript).toContain('currentSrc');
    expect(execScript).toContain("tag === 'a'");
    expect(execScript).toContain("getAttribute('href')");

    expect(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).toHaveBeenCalledTimes(1);
    const input = vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mock.calls[0]?.[0] as any;
    expect(input).toMatchObject({
      site: 'kickstarter',
      page_type: 'project_detail',
      url: 'https://www.kickstarter.com/projects/demo/ks-project',
      llm: null,
    });
    expect(input.html_snapshots.s0.html).toContain('s0');
    expect(input.html_snapshots.s1.html).toContain('s1');
    expect(input.html_snapshots.s2.html).toContain('s2');

    expect(row).toMatchObject({
      site: 'kickstarter',
      page_type: 'project_detail',
      title: 'KS Project',
      url: 'https://www.kickstarter.com/projects/demo/ks-project',
      raw_id: 'id_123',
    });
    expect(row.extra).toBeTypeOf('object');
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
          { field: 'raw_id', selectors: ['meta[name="og:url"]'], fallback_selectors: [], confidence: 0.8, reason: 'id' },
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
      '<html><body>s0</body></html>',
      '<html><body>s1</body></html>',
      '<html><body>s2</body></html>',
      {
        values: {
          title: 'Media Demo',
          raw_id: 'media-demo',
          image_url: 'https://cdn.example.com/media/cover.jpg',
          main_video_url: 'https://cdn.example.com/media/master.m3u8?token=abc123',
        },
        provenance: {},
      },
    ]);

    const row = (await cmd.func!(page, {
      url: 'https://www.kickstarter.com/projects/demo/media-demo',
    })) as Record<string, unknown>;

    expect(row.primary_image_url).toBe('https://cdn.example.com/media/cover.jpg');
    expect(row.primary_video_url).toBe('https://cdn.example.com/media/master.m3u8?token=abc123');
  });

  it('schema-first: passes schema_hint_prompt when provided', async () => {
    vi.stubEnv('OPENCLI_KICKSTARTER_SCHEMA_HINT_PROMPT', 'Prefer canonical ontology fields');
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
      cache_status: 'hit',
      learning_method: 'cache_hit',
      llm_model: null,
      dom_fingerprint: 'fp_schema_first',
      selector_plan: {
        plans: [
          { field: 'title', selectors: ['h1'], fallback_selectors: ['.title-alt'], confidence: 0.9, reason: 't' },
          { field: 'raw_id', selectors: ['meta[name="og:url"]'], fallback_selectors: [], confidence: 0.8, reason: 'id' },
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
      '<html><body>s0</body></html>',
      '<html><body>s1</body></html>',
      '<html><body>s2</body></html>',
      {
        values: { title: 'Schema First Title', raw_id: 'creator/slug-sf', pledged_amount: '$100' },
        provenance: {
          title: { strategy: 'selector', selector: 'h1' },
          raw_id: { strategy: 'selector', selector: 'meta[name="og:url"]' },
        },
      },
    ]);

    const row = (await cmd.func!(page, {
      url: 'https://www.kickstarter.com/projects/demo/schema-first-project',
    })) as Record<string, unknown>;

    expect(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).toHaveBeenCalledTimes(1);

    const input = vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mock.calls[0]?.[0] as any;
    expect(input).toMatchObject({
      site: 'kickstarter',
      page_type: 'project_detail',
      url: 'https://www.kickstarter.com/projects/demo/schema-first-project',
      schemaRegistryFilePath: path.join(os.homedir(), '.opencli', 'kickstarter-core-schema.json'),
      selectorCacheFilePath: expect.any(String),
      schema_version: 'v1',
      prompt_version: 'page_understanding_v1',
      llm: null,
      schema_hint_prompt: 'Prefer canonical ontology fields',
    });
    expect(input.core_schema).toBeUndefined();

    expect(row).toMatchObject({
      site: 'kickstarter',
      page_type: 'project_detail',
      title: 'Schema First Title',
      url: 'https://www.kickstarter.com/projects/demo/schema-first-project',
      raw_id: 'creator/slug-sf',
    });
  });

  it('schema-first miss + no llm: throws SchemaLlmUnavailableError (explicit failure)', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockRejectedValue(
      new (engine as any).SchemaLlmUnavailableError('schema cache miss and llm unavailable'),
    );

    const page = createPage([
      '<html><body>s0</body></html>',
      '<html><body>s1</body></html>',
      '<html><body>s2</body></html>',
    ]);

    await expect(
      cmd.func!(page, { url: 'https://www.kickstarter.com/projects/demo/ks-project' }),
    ).rejects.toMatchObject({
      name: 'SchemaLlmUnavailableError',
      code: 'schema_cache_miss_and_llm_unavailable',
    });
  });

  it('raw_id fallback: derives from url when missing in extracted values', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
      cache_status: 'hit',
      learning_method: 'cache_hit',
      llm_model: null,
      dom_fingerprint: 'fp_test',
      selector_plan: { plans: [{ field: 'title', selectors: ['h1'], fallback_selectors: [] }] },
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
      '<html><body>s0</body></html>',
      '<html><body>s1</body></html>',
      '<html><body>s2</body></html>',
      { values: { title: 'KS Project' }, provenance: {} },
    ]);

    const row = (await cmd.func!(page, {
      url: 'https://www.kickstarter.com/projects/1591274034/xdock-something',
    })) as Record<string, unknown>;

    expect(row.raw_id).toBe('1591274034/xdock-something');
  });

  it('when OPENCLI_LEARNING_ARTIFACTS_DIR is set: writes s0/s1/s2 html snapshots under artifacts snapshots/', async () => {
    const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencli-artifacts-'));
    vi.stubEnv('OPENCLI_LEARNING_ARTIFACTS_DIR', artifactsDir);

    try {
      const engine = await import('mkt-learning-engine');
      vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockResolvedValue({
        cache_status: 'hit',
        learning_method: 'cache_hit',
        llm_model: null,
        dom_fingerprint: 'fp_test',
        selector_plan: { plans: [{ field: 'title', selectors: ['h1'], fallback_selectors: [] }] },
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
        '<html><body>S0</body></html>',
        '<html><body>S1</body></html>',
        '<html><body>S2</body></html>',
        { values: { title: 'KS Project', raw_id: 'id_123' }, provenance: {} },
      ]);

      await cmd.func!(page, { url: 'https://www.kickstarter.com/projects/demo/ks-project' });

      const ksDir = path.join(artifactsDir, 'artifacts', 'kickstarter');
      const runIds = await fs.readdir(ksDir);
      expect(runIds.length).toBeGreaterThan(0);
      const runDir = path.join(ksDir, runIds[0]!);

      const pageKeys = await fs.readdir(runDir);
      expect(pageKeys.length).toBeGreaterThan(0);
      const pageDir = path.join(runDir, pageKeys[0]!);

      const snapshotsDir = path.join(pageDir, 'snapshots');
      await expect(fs.stat(path.join(snapshotsDir, 's0.html'))).resolves.toBeTypeOf('object');
      await expect(fs.stat(path.join(snapshotsDir, 's1.html'))).resolves.toBeTypeOf('object');
      await expect(fs.stat(path.join(snapshotsDir, 's2.html'))).resolves.toBeTypeOf('object');

      await expect(fs.stat(path.join(pageDir, 'engine-input.json'))).resolves.toBeTypeOf('object');
      await expect(fs.stat(path.join(pageDir, 'engine-output.json'))).resolves.toBeTypeOf('object');
    } finally {
      await fs.rm(artifactsDir, { recursive: true, force: true });
    }
  });

  it('cache miss + no llm: throws SchemaLlmUnavailableError (explicit failure)', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockRejectedValue(
      new (engine as any).SchemaLlmUnavailableError('schema cache miss and llm unavailable'),
    );

    const page = createPage([
      '<html><body>s0</body></html>',
      '<html><body>s1</body></html>',
      '<html><body>s2</body></html>',
    ]);

    await expect(
      cmd.func!(page, { url: 'https://www.kickstarter.com/projects/demo/ks-project' }),
    ).rejects.toMatchObject({
      name: 'SchemaLlmUnavailableError',
      code: 'schema_cache_miss_and_llm_unavailable',
    });
  });

  it('cache read error: passes through RuleCacheReadError', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.getOrLearnSelectorPlanSchemaFirstFromHtmlSnapshotsV1).mockRejectedValue(
      new engine.RuleCacheReadError('cache_read_failed', 'x'),
    );

    const page = createPage([
      '<html><body>s0</body></html>',
      '<html><body>s1</body></html>',
      '<html><body>s2</body></html>',
    ]);

    await expect(
      cmd.func!(page, { url: 'https://www.kickstarter.com/projects/demo/ks-project' }),
    ).rejects.toMatchObject({
      name: 'RuleCacheReadError',
      type: 'cache_read_failed',
    });
  });
});
