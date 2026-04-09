import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { learnSelectorPlanFromSnapshot } from './selector-learning.js';

const { learnSelectorPlanMock } = vi.hoisted(() => ({
  learnSelectorPlanMock: vi.fn(),
}));

vi.mock('mkt-learning-engine', () => ({
  learnSelectorPlan: learnSelectorPlanMock,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('selector-learning engine integration', () => {
  it('delegates selector plan learning to mkt-learning-engine', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opencli-selector-engine-'));
    vi.stubEnv('OPENCLI_SELECTOR_CACHE_PATH', path.join(dir, 'selector-cache.json'));
    vi.stubEnv('MKT_CRAWLER_LLM_ENDPOINT', 'https://example.com/v1/chat/completions');
    vi.stubEnv('MKT_CRAWLER_LLM_API_KEY', 'sk-test');
    vi.stubEnv('MKT_CRAWLER_LLM_MODEL', 'MiniMax-M2.5');
    learnSelectorPlanMock.mockResolvedValue({
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
    });
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

    const learned = await learnSelectorPlanFromSnapshot({
      site: 'huodongxing',
      fingerprint: 'fingerprint-engine',
      snapshot: {
        url: 'https://www.huodongxing.com/event/engine',
        title: 'Engine',
        candidates: [{ selector: '.hdx-organizer', text: 'Shanghai AI Club', tag: 'div' }],
      },
    });

    expect(learnSelectorPlanMock).toHaveBeenCalledTimes(1);
    expect(learned).toMatchObject({
      organizer: {
        selectors: ['.hdx-organizer'],
        fallback_selectors: ['.fallback-organizer'],
        confidence: 0.91,
        reason: 'Closest labeled organizer block.',
      },
    });
  });
});
