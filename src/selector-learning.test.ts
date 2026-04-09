import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { log } from '@jackwener/opencli/logger';
import { learnSelectorPlanFromSnapshot, learnSelectorsFromSnapshot, readSelectorLearningCache } from './selector-learning.js';

vi.mock('@jackwener/opencli/logger', () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    status: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    stepResult: vi.fn(),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('selector-learning', () => {
  it('writes a trace record when LLM learning is disabled', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opencli-selector-trace-'));
    const file = path.join(dir, 'trace.jsonl');
    vi.stubEnv('OPENCLI_DEBUG_LOG_FILE', file);

    const learned = await learnSelectorsFromSnapshot({
      site: 'huodongxing',
      fingerprint: 'fingerprint-disabled',
      snapshot: {
        url: 'https://www.huodongxing.com/event/1',
        title: 'A',
        candidates: [{ selector: '.hdx-details-title', text: 'A', tag: 'h1' }],
      },
    });

    expect(learned).toBeNull();

    const raw = await readFile(file, 'utf-8');
    expect(raw).toContain('"event":"llm-disabled"');
    expect(raw).toContain('"scope":"selector-learning"');
  });

  it('persists learned selectors in the home cache and reuses them', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'opencli-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('MKT_CRAWLER_LLM_ENDPOINT', 'https://example.com/v1/chat/completions');
    vi.stubEnv('MKT_CRAWLER_LLM_API_KEY', 'sk-test');
    vi.stubEnv('MKT_CRAWLER_LLM_MODEL', 'MiniMax-M2.5');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                plans: [
                  {
                    field: 'title',
                    selectors: ['.hdx-details-title'],
                    fallback_selectors: [],
                    confidence: 0.98,
                    reason: 'Primary title selector.',
                  },
                  {
                    field: 'organizer',
                    selectors: ['.hdx-organizer'],
                    fallback_selectors: [],
                    confidence: 0.91,
                    reason: 'Closest labeled organizer block.',
                  },
                  {
                    field: 'event_time',
                    selectors: ['.hdx-event-time'],
                    fallback_selectors: [],
                    confidence: 0.88,
                    reason: 'Event time block.',
                  },
                  {
                    field: 'location',
                    selectors: ['.hdx-address'],
                    fallback_selectors: [],
                    confidence: 0.87,
                    reason: 'Location block.',
                  },
                  {
                    field: 'fee',
                    selectors: ['.hdx-fee'],
                    fallback_selectors: [],
                    confidence: 0.86,
                    reason: 'Fee block.',
                  },
                  {
                    field: 'signup_text',
                    selectors: ['.signup'],
                    fallback_selectors: [],
                    confidence: 0.85,
                    reason: 'Signup button.',
                  },
                ],
              }),
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const selectors = await learnSelectorsFromSnapshot({
      site: 'huodongxing',
      fingerprint: 'fingerprint-1',
      snapshot: {
        url: 'https://www.huodongxing.com/event/1',
        title: 'A',
        candidates: [{ selector: '.hdx-details-title', text: 'A', tag: 'h1' }],
      },
    });

    expect(selectors?.title).toEqual(['.hdx-details-title']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[selector-learning] learn site=huodongxing'));

    const cached = await learnSelectorsFromSnapshot({
      site: 'huodongxing',
      fingerprint: 'fingerprint-1',
      snapshot: {
        url: 'https://www.huodongxing.com/event/2',
        title: 'B',
        candidates: [{ selector: '.hdx-details-title', text: 'B', tag: 'h1' }],
      },
    });

    expect(cached?.title).toEqual(['.hdx-details-title']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('[selector-learning] cache hit site=huodongxing'));

    const cache = await readSelectorLearningCache();
    expect(cache?.entries['fingerprint-1']).toMatchObject({
      title: ['.hdx-details-title'],
    });

    const raw = await readFile(path.join(home, '.opencli', 'selector-learning-cache.json'), 'utf-8');
    expect(raw).toContain('.hdx-details-title');
  });

  it('writes raw LLM response and cache metadata into trace logs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opencli-selector-trace-'));
    const file = path.join(dir, 'trace.jsonl');
    const cacheFile = path.join(dir, 'selector-cache.json');
    vi.stubEnv('OPENCLI_DEBUG_LOG_FILE', file);
    vi.stubEnv('OPENCLI_SELECTOR_CACHE_PATH', cacheFile);
    vi.stubEnv('MKT_CRAWLER_LLM_ENDPOINT', 'https://example.com/v1/chat/completions');
    vi.stubEnv('MKT_CRAWLER_LLM_API_KEY', 'sk-test');
    vi.stubEnv('MKT_CRAWLER_LLM_MODEL', 'MiniMax-M2.5');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                plans: [
                  {
                    field: 'title',
                    selectors: ['.hdx-details-title'],
                    fallback_selectors: [],
                    confidence: 0.98,
                    reason: 'Primary title selector.',
                  },
                  {
                    field: 'organizer',
                    selectors: ['.hdx-organizer'],
                    fallback_selectors: [],
                    confidence: 0.91,
                    reason: 'Closest labeled organizer block.',
                  },
                  {
                    field: 'event_time',
                    selectors: ['.hdx-event-time'],
                    fallback_selectors: [],
                    confidence: 0.88,
                    reason: 'Event time block.',
                  },
                  {
                    field: 'location',
                    selectors: ['.hdx-address'],
                    fallback_selectors: [],
                    confidence: 0.87,
                    reason: 'Location block.',
                  },
                  {
                    field: 'fee',
                    selectors: ['.hdx-fee'],
                    fallback_selectors: [],
                    confidence: 0.86,
                    reason: 'Fee block.',
                  },
                  {
                    field: 'signup_text',
                    selectors: ['.signup'],
                    fallback_selectors: [],
                    confidence: 0.85,
                    reason: 'Signup button.',
                  },
                ],
              }),
            },
          },
        ],
      }),
    }));

    const learned = await learnSelectorsFromSnapshot({
      site: 'huodongxing',
      fingerprint: 'fingerprint-trace',
      snapshot: {
        url: 'https://www.huodongxing.com/event/trace',
        title: 'Trace',
        candidates: [{ selector: '.hdx-details-title', text: 'Trace', tag: 'h1' }],
      },
    });

    expect(learned?.organizer).toEqual(['.hdx-organizer']);

    const raw = await readFile(file, 'utf-8');
    expect(raw).toContain('"event":"llm-response"');
    expect(raw).toContain('"rawResponse":"{\\"plans\\"');
    expect(raw).toContain('"event":"cache-write"');
  });

  it('preserves confidence and reason in learned selector plans', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opencli-selector-plan-'));
    const cacheFile = path.join(dir, 'selector-cache.json');
    vi.stubEnv('OPENCLI_SELECTOR_CACHE_PATH', cacheFile);
    vi.stubEnv('MKT_CRAWLER_LLM_ENDPOINT', 'https://example.com/v1/chat/completions');
    vi.stubEnv('MKT_CRAWLER_LLM_API_KEY', 'sk-test');
    vi.stubEnv('MKT_CRAWLER_LLM_MODEL', 'MiniMax-M2.5');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                plans: [
                  {
                    field: 'title',
                    selectors: ['.hdx-details-title'],
                    fallback_selectors: [],
                    confidence: 0.98,
                    reason: 'Primary title selector.',
                  },
                  {
                    field: 'organizer',
                    selectors: ['.hdx-organizer'],
                    fallback_selectors: ['.fallback-organizer'],
                    confidence: 0.91,
                    reason: 'Closest labeled organizer block.',
                  },
                  {
                    field: 'event_time',
                    selectors: ['.event-time'],
                    fallback_selectors: [],
                    confidence: 0.88,
                    reason: 'Event time block.',
                  },
                  {
                    field: 'location',
                    selectors: ['.address'],
                    fallback_selectors: [],
                    confidence: 0.87,
                    reason: 'Location block.',
                  },
                  {
                    field: 'fee',
                    selectors: ['.fee'],
                    fallback_selectors: [],
                    confidence: 0.86,
                    reason: 'Fee block.',
                  },
                  {
                    field: 'signup_text',
                    selectors: ['.signup'],
                    fallback_selectors: [],
                    confidence: 0.85,
                    reason: 'Signup button.',
                  },
                ],
              }),
            },
          },
        ],
      }),
    }));

    const plan = await learnSelectorPlanFromSnapshot({
      site: 'huodongxing',
      fingerprint: 'fingerprint-plan',
      snapshot: {
        url: 'https://www.huodongxing.com/event/plan',
        title: 'Plan',
        candidates: [{ selector: '.hdx-organizer', text: '主办方 亚马逊全球开店', tag: 'div' }],
      },
    });

    expect(plan?.organizer).toMatchObject({
      selectors: ['.hdx-organizer'],
      confidence: 0.91,
      reason: 'Closest labeled organizer block.',
    });
  });
});
