import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CliCommand } from '@jackwener/opencli/registry';
import { getRegistry } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';
import './project.js';

vi.mock('mkt-learning-engine', () => {
  return {
    buildDomFingerprintV1: vi.fn(() => 'fp_test'),
    runPageUnderstandingV1: vi.fn(async () => ({ fields: [] })),
    readRuleCacheDetailed: vi.fn(async () => ({ status: 'miss' })),
    writeRuleCache: vi.fn(async () => undefined),
    buildRuleCacheKey: vi.fn(() => 'key_test'),
    buildSelectorPlanFromUnderstanding: vi.fn(() => ({ plans: [] })),
    buildLearningArtifactPaths: vi.fn(() => ({
      root: '/tmp',
      rawPage: '/tmp/raw-page.json',
      domDistill: '/tmp/dom-distill.json',
      pageUnderstanding: '/tmp/page-understanding.json',
      selectorPlan: '/tmp/selector-plan.json',
      extractionResult: '/tmp/extraction-result.json',
      qualityReport: '/tmp/quality-report.json',
      engineTraceJsonl: '/tmp/trace/engine.trace.jsonl',
    })),
    writeArtifactJson: vi.fn(async () => undefined),
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
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('kickstarter/project', () => {
  it('cache hit: does not call runPageUnderstandingV1 and still returns core+extra object', async () => {
    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.readRuleCacheDetailed).mockResolvedValue({
      status: 'hit',
      entry: {
        created_at: '2026-04-10T00:00:00.000Z',
        selector_plan: {
          plans: [
            { field: 'title', selectors: ['h1'], fallback_selectors: ['.title-alt'], confidence: 0.9, reason: 't' },
            { field: 'creator_name', selectors: ['.creator'], fallback_selectors: [], confidence: 0.8, reason: 'c' },
          ],
        },
      },
    } as any);

    const page = createPage([
      {
        page_title: 'KS Project',
        candidates: [
          {
            node_id: '1',
            selector: 'h1',
            tag: 'h1',
            text: 'KS Project',
            href: null,
            datetime: null,
            title: null,
            aria_label: null,
            class_list: [],
            attributes: {},
            text_length: 10,
            depth: 1,
            sibling_index: 0,
          },
        ],
        selectorSignature: ['h1'],
      },
      {
        values: { title: 'KS Project', creator_name: 'KS Team' },
        provenance: {
          title: { strategy: 'selector', selector: 'h1' },
          creator_name: { strategy: 'selector', selector: '.creator' },
        },
      },
    ]);

    const row = await cmd.func!(page, { url: 'https://www.kickstarter.com/projects/demo/ks-project' }) as Record<string, unknown>;

    expect(engine.runPageUnderstandingV1).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      site: 'kickstarter',
      page_type: 'project_detail',
      url: 'https://www.kickstarter.com/projects/demo/ks-project',
    });
    expect(row.extra).toBeTypeOf('object');
  });

  it('cache miss: calls runPageUnderstandingV1 + buildSelectorPlanFromUnderstanding + writeRuleCache', async () => {
    vi.stubEnv('MKT_CRAWLER_LLM_ENDPOINT', 'https://example.com/v1/chat/completions');
    vi.stubEnv('MKT_CRAWLER_LLM_API_KEY', 'sk-test');
    vi.stubEnv('MKT_CRAWLER_LLM_MODEL', 'MiniMax-M2.5');

    const engine = await import('mkt-learning-engine');
    vi.mocked(engine.readRuleCacheDetailed).mockResolvedValue({ status: 'miss' } as any);
    vi.mocked(engine.runPageUnderstandingV1).mockResolvedValue({
      fields: [
        {
          field: 'title',
          selectors: ['h1'],
          fallback_selectors: [],
          confidence: 0.9,
          reason: 't',
        },
      ],
    } as any);
    vi.mocked(engine.buildSelectorPlanFromUnderstanding).mockReturnValue({
      plans: [{ field: 'title', selectors: ['h1'], fallback_selectors: [], confidence: 0.9, reason: 't' }],
    } as any);

    const page = createPage([
      {
        page_title: 'KS Project',
        candidates: [],
        selectorSignature: ['h1'],
      },
      {
        values: { title: 'KS Project' },
        provenance: { title: { strategy: 'selector', selector: 'h1' } },
      },
    ]);

    const row = await cmd.func!(page, { url: 'https://www.kickstarter.com/projects/demo/ks-project' }) as Record<string, unknown>;

    expect(engine.runPageUnderstandingV1).toHaveBeenCalledTimes(1);
    expect(engine.buildSelectorPlanFromUnderstanding).toHaveBeenCalledTimes(1);
    expect(engine.writeRuleCache).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({
      site: 'kickstarter',
      page_type: 'project_detail',
    });
  });
});

