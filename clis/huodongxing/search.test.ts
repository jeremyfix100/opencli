import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import type { CliCommand } from '@jackwener/opencli/registry';
import { getRegistry } from '@jackwener/opencli/registry';
import type { IPage } from '@jackwener/opencli/types';
import { log } from '@jackwener/opencli/logger';
import './search.js';
import { parseLearnedSelectorSet } from '@jackwener/opencli/selector-learning';

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
  cmd = getRegistry().get('huodongxing/search')!;
  expect(cmd?.func).toBeTypeOf('function');
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('huodongxing/search', () => {
  it('writes learning artifacts + engine trace when OPENCLI_LEARNING_ARTIFACTS_DIR is set (LLM disabled)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opencli-learning-artifacts-'));
    vi.stubEnv('OPENCLI_LEARNING_ARTIFACTS_DIR', dir);

    const page = createPage([
      {
        authRequired: false,
        items: [{ title: '活动', url: '/event/1', author: null, published_at: null, raw_id: '1', engagement: {} }],
      },
      {
        url: 'https://www.huodongxing.com/event/1',
        title: '活动',
        candidates: [{ selector: 'h1', text: '活动', tag: 'h1' }],
      },
      {
        title: '活动',
        organizer: '主办方',
        author: '主办方',
        event_time: '2026-04-08 19:00',
        location: 'Shanghai',
        fee: '免费',
        published_at: '2026-04-08T19:00:00+08:00',
        raw_id: '1',
        signupCount: 1,
        provenance: {
          title: { strategy: 'detail_fallback', selector: 'h1', matched_text: '活动', confidence: null, reason: null },
          organizer: { strategy: 'detail_fallback', selector: '.org', matched_text: '主办方', confidence: null, reason: null },
          event_time: { strategy: 'detail_fallback', selector: 'time', matched_text: '2026-04-08 19:00', confidence: null, reason: null },
          location: { strategy: 'detail_fallback', selector: '.loc', matched_text: 'Shanghai', confidence: null, reason: null },
          fee: { strategy: 'detail_fallback', selector: '.fee', matched_text: '免费', confidence: null, reason: null },
          signup_text: { strategy: 'heuristic_regex', selector: 'body', matched_text: '1', confidence: null, reason: null },
        },
      },
    ]);

    await cmd.func!(page, { query_or_url: '活动', limit: 20 });

    const artifactsSiteDir = path.join(dir, 'artifacts', 'huodongxing');
    expect(existsSync(artifactsSiteDir)).toBe(true);

    const runs = await readdir(artifactsSiteDir);
    expect(runs.length).toBe(1);
    const runDir = path.join(artifactsSiteDir, runs[0]);
    const pages = await readdir(runDir);
    expect(pages.length).toBe(1);
    const pageDir = path.join(runDir, pages[0]);

    await expect(stat(path.join(pageDir, 'raw-page.json'))).resolves.toBeDefined();
    await expect(stat(path.join(pageDir, 'extraction-result.json'))).resolves.toBeDefined();
    await expect(stat(path.join(pageDir, 'quality-report.json'))).resolves.toBeDefined();
    await expect(stat(path.join(pageDir, 'trace', 'engine.trace.jsonl'))).resolves.toBeDefined();

    const traceRaw = await readFile(path.join(pageDir, 'trace', 'engine.trace.jsonl'), 'utf-8');
    expect(traceRaw).toContain('"event":"sample-start"');
    expect(traceRaw).toContain('"event":"completed"');
    expect(traceRaw).not.toContain('"event":"llm_succeeded"');
    expect(traceRaw).toContain('"event":"fallback_used"');
    expect(traceRaw).toMatch(/"event":"rule_execution_(succeeded|partial)"/);
  });

  it('writes selector-plan artifact and llm events when LLM is enabled', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opencli-learning-artifacts-'));
    vi.stubEnv('OPENCLI_LEARNING_ARTIFACTS_DIR', dir);
    vi.stubEnv('OPENCLI_SELECTOR_CACHE_PATH', path.join(dir, 'selector-cache.json'));
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
                  { field: 'title', selectors: ['h1'], fallback_selectors: [], confidence: 0.9, reason: 't' },
                  { field: 'organizer', selectors: ['.org'], fallback_selectors: [], confidence: 0.9, reason: 'o' },
                  { field: 'event_time', selectors: [], fallback_selectors: [], confidence: 0.1, reason: 'x' },
                  { field: 'location', selectors: [], fallback_selectors: [], confidence: 0.1, reason: 'x' },
                  { field: 'fee', selectors: [], fallback_selectors: [], confidence: 0.1, reason: 'x' },
                  { field: 'signup_text', selectors: [], fallback_selectors: [], confidence: 0.1, reason: 'x' },
                ],
              }),
            },
          },
        ],
      }),
    }));

    const page = createPage([
      {
        authRequired: false,
        items: [{ title: '活动', url: '/event/1', author: null, published_at: null, raw_id: '1', engagement: {} }],
      },
      {
        url: 'https://www.huodongxing.com/event/1',
        title: '活动',
        candidates: [{ selector: 'h1', text: '活动', tag: 'h1' }],
      },
      {
        title: '活动',
        organizer: '主办方',
        author: '主办方',
        event_time: '2026-04-08 19:00',
        location: 'Shanghai',
        fee: '免费',
        published_at: '2026-04-08T19:00:00+08:00',
        raw_id: '1',
        signupCount: 1,
        provenance: {
          title: { strategy: 'llm_selector', selector: 'h1', matched_text: '活动', confidence: 0.9, reason: 't' },
          organizer: { strategy: 'llm_selector', selector: '.org', matched_text: '主办方', confidence: 0.9, reason: 'o' },
          event_time: { strategy: 'detail_fallback', selector: 'time', matched_text: '2026-04-08 19:00', confidence: null, reason: null },
          location: { strategy: 'detail_fallback', selector: '.addr', matched_text: 'Shanghai', confidence: null, reason: null },
          fee: { strategy: 'detail_fallback', selector: '.fee', matched_text: '免费', confidence: null, reason: null },
          signup_text: { strategy: 'heuristic_regex', selector: 'body', matched_text: '1', confidence: null, reason: null },
        },
      },
    ]);

    await cmd.func!(page, { query_or_url: '活动', limit: 20 });

    const artifactsSiteDir = path.join(dir, 'artifacts', 'huodongxing');
    const runs = await readdir(artifactsSiteDir);
    const runDir = path.join(artifactsSiteDir, runs[0]);
    const pages = await readdir(runDir);
    const pageDir = path.join(runDir, pages[0]);

    await expect(stat(path.join(pageDir, 'selector-plan.json'))).resolves.toBeDefined();
    await expect(stat(path.join(pageDir, 'dom-distill.json'))).resolves.toBeDefined();

    const traceRaw = await readFile(path.join(pageDir, 'trace', 'engine.trace.jsonl'), 'utf-8');
    expect(traceRaw).toContain('"event":"cache-miss"');
    expect(traceRaw).toContain('"event":"llm_requested"');
    expect(traceRaw).toContain('"event":"llm_succeeded"');
    expect(traceRaw).toContain('"event":"rule_generated"');
    expect(traceRaw).toMatch(/"event":"rule_execution_(succeeded|partial)"/);
  });

  it('writes debug traces for the learning path when LLM is enabled', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'opencli-search-trace-'));
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
                    selectors: ['.hdx-signup'],
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

    const page = createPage([
      {
        authRequired: false,
        items: [
          {
            title: '精选推荐 首页 行业 生活 学习 找活动',
            url: '/event/5846805200111?utm_source=eventspage',
            author: '精选推荐 首页 行业 生活 学习 找活动',
            published_at: null,
            raw_id: '5846805200111',
            engagement: {},
          },
        ],
      },
      {
        url: 'https://www.huodongxing.com/event/5846805200111?utm_source=eventspage',
        title: '链动春耕 新启全球 —— 亚马逊全球开店2026春耕大会·厦门站',
        candidates: [{ selector: '.hdx-details-title', text: '链动春耕 新启全球 —— 亚马逊全球开店2026春耕大会·厦门站', tag: 'h1' }],
      },
      {
        title: '链动春耕 新启全球 —— 亚马逊全球开店2026春耕大会·厦门站',
        organizer: '亚马逊全球开店',
        author: '亚马逊全球开店',
        event_time: '2026-04-20 14:00-17:00',
        location: '厦门思明区',
        fee: '免费',
        published_at: '2026-04-20T14:00:00+08:00',
        raw_id: '5846805200111',
        signupCount: 923,
      },
    ]);

    const rows = await cmd.func!(page, { query_or_url: '电商', limit: 20 }) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);

    const raw = await readFile(file, 'utf-8');
    expect(raw).toContain('"scope":"huodongxing/search"');
    expect(raw).toContain('"event":"start"');
    expect(raw).toContain('"event":"learn-selectors-branch"');
    expect(raw).toContain('"event":"learn-selectors-start"');
    expect(raw).toContain('"event":"learn-start"');
    expect(raw).toContain('"event":"llm-request"');
    expect(raw).toContain('"event":"llm-response"');
    expect(raw).toContain('"event":"cache-write"');
    expect(raw).toContain('"event":"detail-result"');
  });

  it('returns event records with signup engagement', async () => {
    const page = createPage([
      {
        authRequired: false,
        items: [
          {
            title: null,
            url: '/event/123456789',
            author: null,
            published_at: null,
            raw_id: '123456789',
            engagement: {},
          },
        ],
      },
      {
        title: 'AI Meetup',
        organizer: 'Shanghai AI Club',
        author: 'Shanghai AI Club',
        event_time: '2026-04-08 19:00',
        location: 'Shanghai',
        fee: '免费',
        published_at: '2026-04-08T19:00:00+08:00',
        raw_id: '123456789',
        signupCount: 256,
      },
    ]);

    const rows = await cmd.func!(page, { query_or_url: 'AI', limit: 20 }) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[huodongxing/search] start url='));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[huodongxing/search] done rows=1'));
    expect(rows[0]).toMatchObject({
      title: 'AI Meetup',
      url: 'https://www.huodongxing.com/event/123456789',
      author: 'Shanghai AI Club',
      published_at: '2026-04-08T19:00:00+08:00',
      raw_id: '123456789',
      engagement: { signupCount: 256 },
      event_time: '2026-04-08 19:00',
      location: 'Shanghai',
      fee: '免费',
      organizer: 'Shanghai AI Club',
    });
  });

  it('throws AuthRequiredError on auth/risk signal', async () => {
    const page = createPage([{ authRequired: true, items: [] }]);
    await expect(cmd.func!(page, { query_or_url: '', limit: 20 })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('uses detail title/organizer/time/location/fee when list page is noisy', async () => {
    const page = createPage([
      {
        authRequired: false,
        items: [
          {
            title: '精选推荐 首页 行业 生活 学习 找活动',
            url: '/event/5846805200111?utm_source=eventspage',
            author: '精选推荐 首页 行业 生活 学习 找活动',
            published_at: null,
            raw_id: '5846805200111',
            engagement: {},
          },
        ],
      },
      {
        title: '链动春耕 新启全球 —— 亚马逊全球开店2026春耕大会·厦门站',
        organizer: '亚马逊全球开店',
        author: '亚马逊全球开店',
        event_time: '2026-04-20 14:00-17:00',
        location: '厦门思明区',
        fee: '免费',
        published_at: '2026-04-20T14:00:00+08:00',
        raw_id: '5846805200111',
        signupCount: 923,
      },
    ]);

    const rows = await cmd.func!(page, { query_or_url: '电商', limit: 20 }) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[huodongxing/search] start url='));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[huodongxing/search] done rows=1'));
    expect(rows[0]).toMatchObject({
      title: '链动春耕 新启全球 —— 亚马逊全球开店2026春耕大会·厦门站',
      author: '亚马逊全球开店',
      organizer: '亚马逊全球开店',
      event_time: '2026-04-20 14:00-17:00',
      location: '厦门思明区',
      fee: '免费',
      raw_id: '5846805200111',
      engagement: { signupCount: 923 },
    });
  });

  it('rejects noisy organizer text instead of persisting navigation copy', async () => {
    const page = createPage([
      {
        authRequired: false,
        items: [
          {
            title: '电商活动',
            url: '/event/5846805200111?utm_source=eventspage',
            author: null,
            published_at: null,
            raw_id: '5846805200111',
            engagement: {},
          },
        ],
      },
      {
        title: '电商活动',
        organizer: '精选推荐 首页 行业 生活 学习 找活动 找 专题精选 人气榜 下载App',
        author: '精选推荐 首页 行业 生活 学习 找活动 找 专题精选 人气榜 下载App',
        event_time: '2026-04-20 14:00-17:00',
        location: '深圳',
        fee: '免费',
        published_at: '2026-04-20T14:00:00+08:00',
        raw_id: '5846805200111',
        signupCount: 923,
      },
    ]);

    const rows = await cmd.func!(page, { query_or_url: '电商', limit: 20 }) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: '电商活动',
      organizer: null,
      author: null,
    });
  });

  it('includes field provenance when debug provenance mode is enabled', async () => {
    vi.stubEnv('OPENCLI_DEBUG_PROVENANCE', '1');
    const page = createPage([
      {
        authRequired: false,
        items: [
          {
            title: '精选推荐 首页 行业 生活 学习 找活动',
            url: '/event/123456789',
            author: null,
            published_at: null,
            raw_id: '123456789',
            engagement: {},
          },
        ],
      },
      {
        title: 'AI Meetup',
        organizer: 'Shanghai AI Club',
        author: 'Shanghai AI Club',
        event_time: '2026-04-08 19:00',
        location: 'Shanghai',
        fee: '免费',
        published_at: '2026-04-08T19:00:00+08:00',
        raw_id: '123456789',
        signupCount: 256,
      },
    ]);

    const rows = await cmd.func!(page, { query_or_url: 'AI', limit: 20 }) as Array<Record<string, unknown>>;

    expect(rows[0]).toMatchObject({
      title: 'AI Meetup',
      organizer: 'Shanghai AI Club',
      provenance: {
        title: { strategy: 'detail_fallback' },
        organizer: { strategy: 'detail_fallback' },
        event_time: { strategy: 'detail_fallback' },
        location: { strategy: 'detail_fallback' },
        fee: { strategy: 'detail_fallback' },
      },
    });
  });

  it('passes llm confidence and reason into final provenance', async () => {
    vi.stubEnv('OPENCLI_DEBUG_PROVENANCE', '1');
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
                organizer: {
                  selectors: ['.hdx-organizer'],
                  confidence: 0.93,
                  reason: 'Directly labeled organizer block beside the title',
                },
                title: ['.hdx-details-title'],
              }),
            },
          },
        ],
      }),
    }));

    const page = createPage([
      {
        authRequired: false,
        items: [
          {
            title: '精选推荐 首页 行业 生活 学习 找活动',
            url: '/event/123456789',
            author: null,
            published_at: null,
            raw_id: '123456789',
            engagement: {},
          },
        ],
      },
      {
        url: 'https://www.huodongxing.com/event/123456789',
        title: 'AI Meetup',
        candidates: [
          { selector: '.hdx-details-title', text: 'AI Meetup', tag: 'h1' },
          { selector: '.hdx-organizer', text: 'Shanghai AI Club', tag: 'div' },
        ],
      },
      {
        title: 'AI Meetup',
        organizer: 'Shanghai AI Club',
        author: 'Shanghai AI Club',
        event_time: '2026-04-08 19:00',
        location: 'Shanghai',
        fee: '免费',
        published_at: '2026-04-08T19:00:00+08:00',
        raw_id: '123456789',
        signupCount: 256,
        provenance: {
          organizer: {
            strategy: 'llm_selector',
            selector: '.hdx-organizer',
            matched_text: 'Shanghai AI Club',
            confidence: 0.93,
            reason: 'Directly labeled organizer block beside the title',
          },
        },
      },
    ]);

    const rows = await cmd.func!(page, { query_or_url: 'AI', limit: 20 }) as Array<Record<string, unknown>>;

    expect(rows[0]).toMatchObject({
      organizer: 'Shanghai AI Club',
      provenance: {
        organizer: {
          strategy: 'llm_selector',
          confidence: 0.93,
          reason: 'Directly labeled organizer block beside the title',
        },
      },
    });
  });

  it('parses learned selector json shape', () => {
    const learned = parseLearnedSelectorSet({
      title: {
        selectors: ['.hdx-details-title'],
        fallback_selectors: [],
        confidence: 0.95,
        reason: 'Primary title selector.',
      },
      organizer: {
        selectors: ['.hdx-organizer'],
        fallback_selectors: ['.hdx-organizer-alt'],
        confidence: 0.9,
        reason: 'Organizer block next to the title.',
      },
      event_time: {
        selectors: ['.hdx-event-time'],
        fallback_selectors: [],
        confidence: 0.88,
        reason: 'Event time block.',
      },
      location: {
        selectors: ['.hdx-address'],
        fallback_selectors: [],
        confidence: 0.87,
        reason: 'Address block.',
      },
      fee: {
        selectors: ['.hdx-fee'],
        fallback_selectors: [],
        confidence: 0.86,
        reason: 'Fee block.',
      },
      signup_text: {
        selectors: ['.hdx-signup'],
        fallback_selectors: [],
        confidence: 0.85,
        reason: 'Signup button.',
      },
    });
    expect(learned).toMatchObject({
      title: ['.hdx-details-title'],
      organizer: ['.hdx-organizer'],
      event_time: ['.hdx-event-time'],
      location: ['.hdx-address'],
      fee: ['.hdx-fee'],
      signup_text: ['.hdx-signup'],
    });
  });
});
